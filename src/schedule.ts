/**
 * Pure rules for the sandbox lifecycle, kept apart from the Durable Object so they can be tested
 * without a container.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How often a running sandbox is checked. */
export const CHECK_INTERVAL_MS = MINUTE;
/** A sandbox with no command for this long is saved and stopped. */
export const IDLE_LIMIT_MS = 10 * MINUTE;
/** A sandbox in use is saved at most this often, so a crash loses little. */
export const CHECKPOINT_INTERVAL_MS = 15 * MINUTE;
/** Backstop: the platform stops the instance if the checks themselves stop. Longer than a check. */
export const INACTIVITY_TIMEOUT_MS = 5 * MINUTE;

/**
 * Container snapshots expire 30 days after they are created or last restored. A sandbox that
 * nobody uses is woken (restored, which resets the 30 days) after this many days, at this hour UTC,
 * and stopped again this long later without a new save.
 */
export const KEEPALIVE_AFTER_DAYS = 25;
export const KEEPALIVE_HOUR_UTC = 9; // 4 AM EST / 5 AM EDT
export const KEEPALIVE_HOLD_MS = 5 * MINUTE;

export const MAX_COMMAND_BYTES = 1024 * 1024;
export const MAX_STDIN_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 3600;

/**
 * When to wake a stopped sandbox whose snapshot was created or last restored at `anchor`: the first
 * KEEPALIVE_HOUR_UTC on or after anchor + KEEPALIVE_AFTER_DAYS. Always inside the 30-day window.
 */
export function keepaliveDue(anchor: number): number {
  const earliest = anchor + KEEPALIVE_AFTER_DAYS * DAY;
  const due = new Date(earliest);
  due.setUTCHours(KEEPALIVE_HOUR_UTC, 0, 0, 0);
  if (due.getTime() < earliest) due.setUTCDate(due.getUTCDate() + 1);
  return due.getTime();
}

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A sandbox key names a Durable Object. Anything else is refused, not cleaned up. */
export function validKey(key: string | null): key is string {
  return key !== null && KEY_RE.test(key);
}

export function clampTimeout(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_S;
  return Math.min(n, MAX_TIMEOUT_S);
}

/** Decodes command output, cut at MAX_OUTPUT_BYTES with a note so the caller knows. */
export function decodeCapped(bytes: ArrayBuffer, limit = MAX_OUTPUT_BYTES): string {
  if (bytes.byteLength <= limit) return new TextDecoder().decode(bytes);
  const head = new TextDecoder().decode(bytes.slice(0, limit));
  return `${head}\n[cf-dev-sandbox: output cut at ${limit} bytes of ${bytes.byteLength}]\n`;
}

/** Constant-time comparison for the optional bearer token. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
