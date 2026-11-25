# cf-dev-sandbox

Persistent Linux sandboxes on Cloudflare Containers, with a terminal backend plugin for
[Hermes Agent](https://hermes-agent.nousresearch.com/).

Each sandbox is one container that belongs to one key. An agent runs its shell commands there, keeps its
files there, and can drive a headless browser there. A sandbox nobody is using is saved to a snapshot and
stopped; the next command restores it with its files where they were.

- [How it works](#how-it-works)
- [What's in the repository](#whats-in-the-repository)
- [Deploy the Worker](#deploy-the-worker)
- [Who can reach it](#who-can-reach-it)
- [HTTP API](#http-api)
- [Use it from Hermes Agent](#use-it-from-hermes-agent)
- [Lifecycle and limits](#lifecycle-and-limits)
- [The sandbox image](#the-sandbox-image)
- [Develop and test](#develop-and-test)
- [Troubleshooting](#troubleshooting)

## How it works

```
Hermes Agent ── plugin ──HTTP──▶ Worker ──▶ Durable Object "DevSandbox" (one per key) ──▶ its container
                                              │
                                              └─ alarm every minute: checkpoint, idle save and stop,
                                                 keep-alive wake before the snapshot expires
```

- **One key, one sandbox.** Every request carries an `X-Sandbox-Key` header. The Worker routes it to the
  Durable Object of that name, and that object owns exactly one container (`durable_object` scheduling).
- **Commands run with `container.exec`.** There is no agent or daemon inside the container: its only
  process is `sleep infinity`, and each command is started from outside.
- **Files persist through Container snapshots.** When a sandbox goes idle the whole container disk is
  snapshotted and the instance is stopped. The next request starts a new instance from that snapshot.
  Processes do not survive a stop; files do.
- **Nothing secret goes in.** The plugin forwards no environment variables into the sandbox, so commands an
  agent writes there can't read the agent's credentials.

## What's in the repository

| Path | What it is |
|---|---|
| `src/index.ts` | The Worker and the `DevSandbox` Durable Object: endpoints, lifecycle, interactive shells |
| `src/schedule.ts` | The pure rules: idle and checkpoint timing, keep-alive date, limits, input checks |
| `tests/schedule.test.ts` | Unit tests for those rules |
| `Dockerfile` | The sandbox image: Debian, Node, Python, git, build tools, Chromium and Playwright |
| `wrangler.jsonc` | Deploy config, Worker name `cf-dev-sandbox` |
| `wrangler.prod.jsonc` | A second deployment of the same code under another name, with its own sandboxes |
| `plugin/cloudflare_sandbox/` | The Hermes Agent plugin: terminal backend, file browser and git support, and the `sandbox` shell client |

## Deploy the Worker

You need a Cloudflare account with Containers available, Node 20 or later, and Docker running locally
(Wrangler builds the image and pushes it to Cloudflare's registry).

```bash
npm install
npx wrangler login
npx wrangler deploy
```

The first deploy builds the image, which takes several minutes because of Chromium. Later deploys reuse it
unless the `Dockerfile` changes.

Settings, in `wrangler.jsonc` under `vars`:

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_INSTANCE` | `lite` | Instance size: `lite`, `basic`, `standard-1` … `standard-4`. The config in this repository sets `standard-3` |
| `ENABLE_INTERNET` | `true` | `false` blocks outbound Internet from the sandboxes. `npm install` and `git clone` need it on |

Optional secret:

```bash
npx wrangler secret put SANDBOX_TOKEN     # required only if you give the Worker a public address
```

To run a second, separate set of sandboxes from the same code, deploy under another name
(`npx wrangler deploy --name my-other-sandboxes`) or with its own config file, as `wrangler.prod.jsonc` does.
Sandboxes and their snapshots belong to the deployment that made them.

## Who can reach it

As shipped, the Worker has **no public address** (`workers_dev: false`, no routes). There are two ways to
give callers a way in.

**Behind another Worker (service binding).** Bind this Worker as a service in a Worker you control and
forward requests to it. That Worker decides the `X-Sandbox-Key`, typically from an identity it has verified,
so a caller can never name someone else's sandbox. No token is needed.

**On a public address (token).** Add a route or custom domain to the config and set the `SANDBOX_TOKEN`
secret. Every request must then send `Authorization: Bearer <token>`. You can put Cloudflare Access in front
as well and use a service token.

> In token mode the key comes from the caller. Anyone who holds the token can open **any** sandbox on that
> deployment by naming its key. That suits one person or one trusted team. For separate users, give each
> their own deployment, or use the service-binding arrangement.

## HTTP API

Every request needs `X-Sandbox-Key`: 1 to 64 characters of `A-Z a-z 0-9 _ -`. Anything else is refused
with 400, not cleaned up.

| Request | Does | Returns |
|---|---|---|
| `POST /exec` | Runs a command with `bash -lc`, starting the sandbox if needed | `{stdout, stderr, exit_code}` |
| `GET /home` | Starts the sandbox if needed and reports the home folder | `{home}` |
| `GET /status` | Reports lifecycle state. Never starts a sandbox and returns no command output | see below |
| `POST /reset` | Throws away the snapshot and stops the sandbox. The next command starts from the image | `{reset: true}` |
| `GET /pty` | WebSocket: an interactive shell | see below |

### `POST /exec`

```json
{ "command": "ls -la /workspace", "timeout_s": 120, "stdin": "optional text for the command's stdin" }
```

- The result arrives whole when the command ends. Output is not streamed.
- `timeout_s` defaults to 120 and is capped at 3600. At the deadline the command and its children are
  stopped. A command also stops if the caller disconnects.
- Each of `stdout` and `stderr` is cut at 1 MiB, with a note appended saying so.
- 413 if the command is over 1 MiB or `stdin` over 8 MiB.

```bash
curl -s https://sandbox.example.com/exec \
  -H "Authorization: Bearer $SANDBOX_TOKEN" -H "X-Sandbox-Key: alice" \
  -H "Content-Type: application/json" -d '{"command":"uname -a && pwd"}'
```

### `GET /status`

```json
{
  "running": true, "snapshot": true, "shells": 0,
  "last_activity": 1764100000000, "saved_at": 1764099000000,
  "snapshot_anchor": 1764099000000, "keepalive_due": 1766221200000,
  "keepalive_until": null, "next_alarm": 1764100060000
}
```

Times are epoch milliseconds. `snapshot_anchor` is when the snapshot was created or last restored, which is
where its 30 days run from.

### `GET /pty`

A WebSocket that carries one interactive `bash -l` on a pseudo-terminal.

- Query: `cols`, `rows` (default 80×24) and `cwd` (an absolute path, default `/workspace`; a folder that no
  longer exists falls back to `/workspace`).
- **Binary frames** are the terminal's bytes, in both directions.
- **Text frames** are control. Client to server: `{"resize":[cols,rows]}`. Server to client, just before it
  closes: `{"exit":code}` when the shell ended, or `{"error":"reason"}` when the sandbox ended it.
- Closing the socket hangs up everything on that shell's terminal, as closing a real terminal does.
- At most 8 shells per sandbox; the ninth gets 429.
- The prompt is `sandbox:/workspace#` unless the user's own shell files set one.

## Use it from Hermes Agent

The plugin makes the sandbox Hermes' terminal backend, so the agent's `terminal` and `execute_code` tools and
its file tools all work there.

### Install

Copy the plugin into Hermes' plugin folder and turn it on:

```bash
mkdir -p ~/.hermes/plugins
cp -r plugin/cloudflare_sandbox ~/.hermes/plugins/
hermes plugins enable cloudflare-sandbox
hermes config set terminal.backend cloudflare_sandbox
```

The plugin's name is `cloudflare-sandbox`; the backend's name is `cloudflare_sandbox`.

### Configure

Set these in Hermes' environment, usually `~/.hermes/.env`:

| Variable | Needed | Meaning |
|---|---|---|
| `CF_DEV_SANDBOX_URL` | always | The Worker's address, e.g. `https://sandbox.example.com` |
| `CF_DEV_SANDBOX_TOKEN` | token mode | The Worker's `SANDBOX_TOKEN` |
| `CF_DEV_SANDBOX_KEY` | recommended | Names your sandbox. Without it the name is `default`, shared by everyone using that token. Use something long and random |
| `CF_DEV_SANDBOX_ACCESS_CLIENT_ID`, `CF_DEV_SANDBOX_ACCESS_CLIENT_SECRET` | if Access is in front | A Cloudflare Access service token |

The plugin builds the sandbox key from `CF_DEV_SANDBOX_KEY` and Hermes' task id (`<key>--<task>`), each part
limited to 24 characters. Behind a service binding, the Worker in front replaces whatever key the plugin
sends.

### What you get

- **Commands and files in the sandbox.** The agent works in `/workspace`. Files a user attaches, and
  skills, are copied in under `/root/.hermes` before a command runs; credential files never are.
- **Hermes' file browser, previews and downloads show the sandbox**, not the machine Hermes runs on.
- **Git in the web UI** (branches, worktrees, the review pane) runs in the sandbox too.
- **Files the agent makes reach the user**: a screenshot or PDF written in the sandbox is delivered as it
  would be from a local terminal.
- **A browser.** `chromium`, and Playwright for both Node and Python, are on the image.

### A shell of your own: `sandbox`

Hermes' terminal pane always opens a shell on the machine Hermes runs on. `shell_client.py` attaches that
terminal to a shell in the sandbox instead, over `GET /pty`. Run it with Hermes' own Python, which has the
`websockets` library it needs:

```bash
python ~/.hermes/plugins/cloudflare_sandbox/shell_client.py
```

Most people wrap it in a command called `sandbox`. The prompt changes to `sandbox:/workspace#`, and `exit`
returns to the local shell with the remote shell's exit status. It reads the same `CF_DEV_SANDBOX_*`
settings, from the environment or else from `~/.hermes/.env`, and it opens the sandbox named
`<CF_DEV_SANDBOX_KEY>--default`. A terminal opened in a folder of Hermes' workspace (`terminal.cwd`) starts
in the same folder under `/workspace`.

### Compatibility

The terminal backend uses Hermes' plugin interface. The file browser and git support go further and replace
functions inside Hermes' web server, so they are tied to the Hermes version they were written against
(commit `31ce88f`, v0.23.2). On another version, expect the terminal backend to keep working and check the
file browser and git panes.

## Lifecycle and limits

A running sandbox is checked once a minute.

| Rule | Value |
|---|---|
| Idle save and stop | After 10 minutes with no command and no shell activity |
| Checkpoint while in use | At most every 15 minutes, between commands, so a crash loses little |
| A shell counts as in use | When it had input or output in the last minute |
| Snapshot lifetime | 30 days from when it was created or last restored (a Cloudflare limit) |
| Keep-alive | A sandbox untouched for 25 days is restored at 09:00 UTC, which resets the 30 days, and stopped again 5 minutes later without a new save |
| Backstop | The platform stops an instance after 5 minutes if the checks themselves stop running |

A save never lands in the middle of a command: commands in flight are counted, and the save waits. An
interactive shell left open with nothing happening does not keep the sandbox up. When the sandbox stops
under it, the shell is closed with the reason, and the files are kept.

| Limit | Value |
|---|---|
| Command size | 1 MiB |
| `stdin` size | 8 MiB |
| Output returned, per stream | 1 MiB |
| Command timeout | 120 s by default, 3600 s at most |
| Interactive shells per sandbox | 8 |

Billing follows Cloudflare Containers pricing for the instance size, for the time each sandbox is running.
A stopped sandbox uses no instance time.

## The sandbox image

`Dockerfile` builds on `node:24-trixie-slim`, pinned by digest, and adds:

- bash, coreutils, curl, git, openssh-client, procps
- Python 3 with pip and venv, and build-essential
- Chromium and Playwright (Node and Python), with `chromium`, `chromium-browser` and `google-chrome` on the
  path, already set to run without its own sandbox inside the container
- `/workspace`, the working folder

There is no text editor, pager or process viewer on the image. Each user is root with Internet access, so
`apt-get update && apt-get install -y vim` works and is kept, because the sandbox's whole disk is what gets
saved.

**A changed image only reaches new sandboxes.** An existing sandbox starts from its own snapshot, not from
the image. To move one onto a new image, `POST /reset` it, which discards its files.

## Develop and test

```bash
npm test          # unit tests for the rules in src/schedule.ts
npm run check     # type-check
npx wrangler dev  # the Worker and a real container locally; needs Docker
```

Under `wrangler dev` the Worker listens on localhost with no token, so the API can be called directly:

```bash
curl -s localhost:8787/exec -H 'X-Sandbox-Key: test' -H 'Content-Type: application/json' \
  -d '{"command":"echo hello from $(hostname)"}'
```

Local containers are a development aid. Idle timing, snapshots and restores only behave as described above
on Cloudflare, so check anything about the lifecycle on a deployed copy.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `400 X-Sandbox-Key must be 1-64 of A-Z a-z 0-9 _ -` | The header is missing or has other characters |
| `401 unauthorized` | `SANDBOX_TOKEN` is set on the Worker and the request's bearer token is missing or wrong |
| Every command fails with a 500 after a long gap | The snapshot expired or can't be restored. `POST /reset` starts the sandbox again from the image |
| `409 a command is running` from `/reset` | Wait for the command to finish, then reset |
| `429` opening a shell | 8 shells are already open in that sandbox |
| A shell closes saying the sandbox stopped | It sat idle for 10 minutes. Open it again; the files are there |
| A program left running is gone | Processes don't survive an idle stop, only files do |
| The first command after a stop is slow | The instance is being restored from its snapshot |
| Hermes still runs commands locally | Check `terminal.backend` is `cloudflare_sandbox`, the plugin is enabled, and `CF_DEV_SANDBOX_URL` is set |
