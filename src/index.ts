/**
 * cf-dev-sandbox: one persistent Linux sandbox per key, for a Hermes terminal backend.
 *
 * Each key is a Durable Object that owns one container (durable_object scheduling policy). The
 * container keeps its files across stops with Container snapshots: an idle sandbox is saved and
 * stopped, and the next command starts a new instance from the snapshot. Snapshots expire 30 days
 * after they are created or last restored, so a sandbox nobody uses is woken briefly before then.
 *
 * Endpoints (header X-Sandbox-Key names the sandbox):
 *   POST /exec    {command, timeout_s?, stdin?} -> {stdout, stderr, exit_code}
 *   GET  /home    -> {home}
 *   GET  /status  -> lifecycle state, no command output
 *   POST /reset   discard the snapshot and stop: the next command starts from the image
 *
 * Reachability is the caller's job. Deployed with workers_dev: false and no routes, the only way in
 * is a service binding, and the binding owner decides the key. With SANDBOX_TOKEN set, every request
 * must also carry it as a bearer token, for deployments that add a route.
 */
import { DurableObject } from "cloudflare:workers";
import {
  CHECK_INTERVAL_MS,
  CHECKPOINT_INTERVAL_MS,
  IDLE_LIMIT_MS,
  INACTIVITY_TIMEOUT_MS,
  KEEPALIVE_HOLD_MS,
  MAX_COMMAND_BYTES,
  MAX_STDIN_BYTES,
  clampTimeout,
  decodeCapped,
  keepaliveDue,
  sameSecret,
  validKey,
} from "./schedule";

export interface Env {
  DEV_SANDBOX: DurableObjectNamespace<DevSandbox>;
  /** Optional. When set, requests must send `Authorization: Bearer <token>`. */
  SANDBOX_TOKEN?: string;
  /** "false" blocks outbound Internet from the sandbox. Default true. */
  ENABLE_INTERNET?: string;
  /** Instance size: lite, basic, standard-1 ... standard-4. Default lite. */
  SANDBOX_INSTANCE?: string;
}

/** Durable Object storage. Times are epoch milliseconds. */
interface State {
  snapshotId?: string;
  /** When the snapshot was created or last restored: its 30 days run from here. */
  snapshotAnchor?: number;
  /** When the files on disk last matched the snapshot (saved, or restored). */
  savedAt?: number;
  lastActivity?: number;
  /** Set while a keep-alive wake is running: stop at this time unless someone used it. */
  keepaliveUntil?: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

type Instance = NonNullable<ContainerStartupOptions["instance"]>;

export class DevSandbox extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  /** Commands in flight, counted before they wait for the lock, so a save never stops one. */
  private busy = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The inactivity timeout doesn't survive a Durable Object restart: set it again.
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  // --- state -------------------------------------------------------------------------------------
  private async state(): Promise<State> {
    const entries = await this.ctx.storage.get<number | string>([
      "snapshotId", "snapshotAnchor", "savedAt", "lastActivity", "keepaliveUntil",
    ]);
    return Object.fromEntries(entries) as State;
  }

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("no container is configured for DevSandbox");
    return container;
  }

  /** Start, save and stop run one at a time. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Set the alarm to `at` unless one is already due sooner. */
  private async alarmBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // --- lifecycle ---------------------------------------------------------------------------------
  /** Start the instance from the snapshot, or from the image when there is none. */
  private async boot(): Promise<void> {
    const container = this.container;
    if (container.running) return;
    const { snapshotId } = await this.state();
    const now = Date.now();
    container.start({
      ...(snapshotId ? { containerSnapshot: { id: snapshotId } } : { image: container.images.sandbox }),
      entrypoint: ["sleep", "infinity"],
      enableInternet: this.env.ENABLE_INTERNET !== "false",
      instance: (this.env.SANDBOX_INSTANCE || "lite") as Instance,
    });
    // A restore resets the snapshot's 30 days. With no snapshot, nothing is on disk worth saving yet.
    await this.ctx.storage.put(snapshotId ? { snapshotAnchor: now, savedAt: now } : { savedAt: now });
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
  }

  private async ensureRunning(): Promise<Container> {
    await this.exclusive(async () => {
      await this.boot();
      // Real use ends a keep-alive wake: the sandbox now follows the idle rules.
      await this.ctx.storage.delete("keepaliveUntil");
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    });
    await this.alarmBy(Date.now() + CHECK_INTERVAL_MS);
    return this.container;
  }

  private async save(): Promise<void> {
    const startedAt = Date.now();
    const snapshot = await this.container.snapshotContainer({ name: "dev-sandbox" });
    await this.ctx.storage.put({ snapshotId: snapshot.id, snapshotAnchor: startedAt, savedAt: startedAt });
  }

  /** Stopped with a snapshot: the next alarm is the keep-alive wake. */
  private async scheduleKeepalive(): Promise<void> {
    const { snapshotId, snapshotAnchor } = await this.state();
    if (snapshotId && snapshotAnchor) await this.ctx.storage.setAlarm(keepaliveDue(snapshotAnchor));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.exclusive(async () => {
      const container = this.container;
      const now = Date.now();
      const s = await this.state();

      if (!container.running) {
        await this.ctx.storage.delete("keepaliveUntil");
        if (s.snapshotId && s.snapshotAnchor && now >= keepaliveDue(s.snapshotAnchor)) {
          // Restore only to reset the snapshot's 30 days. Stop again shortly, with no new save.
          await this.boot();
          await this.ctx.storage.put("keepaliveUntil", now + KEEPALIVE_HOLD_MS);
          await this.ctx.storage.setAlarm(now + KEEPALIVE_HOLD_MS);
          console.log(JSON.stringify({ event: "keepalive.wake", snapshotAnchor: s.snapshotAnchor }));
          return;
        }
        await this.scheduleKeepalive();
        return;
      }

      if (s.keepaliveUntil) {
        if (this.busy === 0 && now >= s.keepaliveUntil) {
          await container.destroy("keepalive");
          await this.ctx.storage.delete("keepaliveUntil");
          console.log(JSON.stringify({ event: "keepalive.stop" }));
          await this.scheduleKeepalive();
          return;
        }
        await this.ctx.storage.setAlarm(Math.max(s.keepaliveUntil, now + CHECK_INTERVAL_MS));
        return;
      }

      const lastActivity = s.lastActivity ?? 0;
      const savedAt = s.savedAt ?? 0;
      const changed = lastActivity > savedAt;
      const idle = this.busy === 0 && now - lastActivity > IDLE_LIMIT_MS;
      const checkpoint = this.busy === 0 && changed && now - savedAt > CHECKPOINT_INTERVAL_MS;

      if ((idle && changed) || checkpoint) {
        try {
          await this.save();
        } catch (err) {
          // Keep the instance and try again at the next check.
          console.error(JSON.stringify({ event: "save.failed", error: String(err) }));
          await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
          await this.ctx.storage.setAlarm(now + CHECK_INTERVAL_MS);
          return;
        }
      }
      // A command that arrived during the save keeps the instance running.
      const usedDuringSave = this.busy > 0 || (await this.ctx.storage.get<number>("lastActivity")) !== s.lastActivity;
      if (idle && !usedDuringSave) {
        await container.destroy("idle");
        await this.scheduleKeepalive();
        return;
      }
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      await this.ctx.storage.setAlarm(now + CHECK_INTERVAL_MS);
    });
  }

  // --- endpoints ---------------------------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/exec" && request.method === "POST") return await this.exec(request);
      if (pathname === "/home" && request.method === "GET") return await this.home();
      if (pathname === "/status" && request.method === "GET") return await this.status();
      if (pathname === "/reset" && request.method === "POST") return await this.reset();
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  private async exec(request: Request): Promise<Response> {
    let body: { command?: unknown; timeout_s?: unknown; stdin?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const command = typeof body.command === "string" ? body.command : "";
    const stdin = typeof body.stdin === "string" ? body.stdin : "";
    if (!command) return json({ error: "command is required" }, 400);
    if (new TextEncoder().encode(command).length > MAX_COMMAND_BYTES) return json({ error: "command too large" }, 413);
    if (new TextEncoder().encode(stdin).length > MAX_STDIN_BYTES) return json({ error: "stdin too large" }, 413);
    const timeout = clampTimeout(body.timeout_s);

    this.busy++;
    try {
      const container = await this.ensureRunning();
      await this.ctx.storage.put("lastActivity", Date.now());
      // `timeout` stops the whole process group, so children of the bash script stop too.
      const argv = ["timeout", "--kill-after=5", String(timeout), "bash", "-lc", command];
      // Stop the command when the caller goes away. Never abort after it exits (docs: internal error).
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
      const proc = await container.exec(argv, {
        signal: controller.signal,
        ...(stdin ? { stdin: new Blob([stdin]).stream() } : {}),
      });
      void proc.exitCode.finally(() => request.signal.removeEventListener("abort", abort));
      const output = await proc.output();
      return json({
        stdout: decodeCapped(output.stdout),
        stderr: decodeCapped(output.stderr),
        exit_code: output.exitCode,
      });
    } finally {
      this.busy--;
      await this.ctx.storage.put("lastActivity", Date.now());
    }
  }

  private async home(): Promise<Response> {
    this.busy++;
    try {
      const container = await this.ensureRunning();
      const proc = await container.exec(["sh", "-c", "cd ~ && pwd"]);
      const output = await proc.output();
      return json({ home: new TextDecoder().decode(output.stdout).trim() || "/root" });
    } finally {
      this.busy--;
    }
  }

  private async status(): Promise<Response> {
    const s = await this.state();
    return json({
      running: this.ctx.container?.running ?? false,
      snapshot: Boolean(s.snapshotId),
      snapshot_anchor: s.snapshotAnchor ?? null,
      keepalive_due: s.snapshotAnchor ? keepaliveDue(s.snapshotAnchor) : null,
      keepalive_until: s.keepaliveUntil ?? null,
      last_activity: s.lastActivity ?? null,
      saved_at: s.savedAt ?? null,
      next_alarm: await this.ctx.storage.getAlarm(),
    });
  }

  /** A snapshot that can't be restored (expired, or gone) fails every start: this is the way out. */
  private async reset(): Promise<Response> {
    if (this.busy > 0) return json({ error: "a command is running" }, 409);
    await this.exclusive(async () => {
      if (this.container.running) await this.container.destroy("reset");
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    });
    return json({ reset: true });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.SANDBOX_TOKEN) {
      const auth = request.headers.get("Authorization") ?? "";
      if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), env.SANDBOX_TOKEN)) {
        return json({ error: "unauthorized" }, 401);
      }
    }
    const key = request.headers.get("X-Sandbox-Key");
    if (!validKey(key)) return json({ error: "X-Sandbox-Key must be 1-64 of A-Z a-z 0-9 _ -" }, 400);
    return env.DEV_SANDBOX.getByName(key).fetch(request);
  },
} satisfies ExportedHandler<Env>;
