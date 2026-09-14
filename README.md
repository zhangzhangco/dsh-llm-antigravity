# dsh-llm-antigravity

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An **Antigravity route** for DeepSeek Harness: it registers one LLM provider
(`antigravity-local` by default) whose requests go to the Antigravity CLI
(`agy`) installed and signed in on this machine.

This plugin is not part of the published `@deepseek-ai/*` distribution. It lives
in the `web` profile and is mounted through that profile's patch layer, so the
DSH installation itself is untouched. It is the sibling of
[`dsh-llm-codex`](https://github.com/zhangzhangco/dsh-llm-codex) and follows the
same shape: one `LlmAdapter`, one route, mounted from `cordis.patch.yml`.

## What it is (and is not)

`agy` is a **complete agent** with its own tools, terminal sandbox, and approval
flow. This adapter therefore exposes it as a **text-generation route**:

- It forwards the conversation (system prompt, history, tool calls and tool
  results rendered as text) and returns the model's answer.
- Antigravity's own tool use is **not** reported as harness tool calls, and DSH
  tool calls are **not** executed by Antigravity. A DSH session on this route
  keeps its own tools; Antigravity answers from the text it was given.
- Because Antigravity *has* tools, it will try to use them on task-shaped
  prompts. See [Tool handling](#tool-handling-why-textonly-matters-default-on),
  which is the single most important thing to understand about this route.

Choose the MCP path instead if you want DSH tools driven by Antigravity, or
Antigravity's tools exposed as DSH tools.

## Authentication

The route uses the **existing sign-in of the `agy` CLI on this machine**. No API
key is required, and nothing is copied out of `~/.gemini`. Run `agy` once
interactively if the CLI is not signed in yet; headless runs reuse that session.

Two host facts matter:

- The credential lives in the macOS keychain. A headless `agy` that cannot read
  the keychain reports `You are not logged into Antigravity` and then
  `authentication failed or timed out`, which looks like a plugin bug but is not.
- `agy` refreshes its token through `oauth2.googleapis.com`. If that request
  cannot leave the machine, every call fails the same way. See
  [Network and proxy](#network-and-proxy).

## Model catalog

`agy models` asks the backend and prints one `<model-id>\t<display name>` pair
per line (the progress spinner goes to stderr). The adapter runs that command,
caches the parsed list, and advertises it:

```
gemini-3.8-flash-high	Gemini 3.8 Flash (High)
gemini-3.8-flash-medium	Gemini 3.8 Flash (Medium)
gemini-3.7-flash-high	Gemini 3.7 Flash (High)
gemini-3.1-pro-high	Gemini 3.1 Pro (High)
claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking	Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium	GPT-OSS 120B (Medium)
```

Notes:

- Discovery costs a network round trip (about six to ten seconds). The result is
  cached under `~/.cache/dsh-llm-antigravity/models.json` for 6 hours
  (`modelsCacheTtlMs`). A failed refresh keeps the previous list, so an
  unreachable backend cannot empty the picker.
- `agy models` reports **no context window**. Capacity comes from an explicit
  `contextWindows` entry, then a family hint (Gemini 1M, Claude 200k,
  GPT-OSS 128k), then `defaultContextWindow`. Nothing is rejected on a wrong
  guess; only token estimation is affected.
- `models` adds explicit ids, and `discover: false` keeps the plugin fully
  offline.

## Configuration

Mounted from `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: llm-antigravity
      name: dsh-llm-antigravity
      config:
        provider: antigravity-local
        discover: true
        textOnly: true
        skipPermissions: false
        effort: ''
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | `antigravity-local` | Route name shown to the model picker |
| `command` | discovered | `agy` to run; empty discovers it (`$AGY_COMMAND`, `PATH`, known installs) |
| `args` | `[]` | Extra argv appended before the prompt flag |
| `model` | empty | Pin one model; empty follows the catalog, then `models`, then the CLI default |
| `effort` | empty | Default reasoning level, `low`/`medium`/`high` |
| `agent` | empty | Antigravity agent; empty selects the built-in tool-less one when `textOnly` is on |
| `textOnly` | `true` | Select a tool-less agent so answers are text, not tool calls |
| `geminiConfigDir` | empty | Antigravity config root; empty uses `$GEMINI_CONFIG_DIR` or `~/.gemini/config` |
| `provisionAgent` | `true` | Create the built-in tool-less agent file when it is missing |
| `proxy` | empty | Proxy for the child, exported as `HTTP_PROXY`/`HTTPS_PROXY` |
| `noProxy` | `localhost,127.0.0.1,::1` | Hosts that bypass `proxy` |
| `cwd` | empty | CLI working root; empty uses the session workspace |
| `addDirs` | `[]` | Extra workspace roots, one `--add-dir` each |
| `sandbox` | `false` | Enable Antigravity's own terminal sandbox (`--sandbox`) |
| `skipPermissions` | `false` | Auto-approve every Antigravity tool request (`--dangerously-skip-permissions`) |
| `disableSlashCommands` | `true` | Keep slash-command and skill expansion out of print mode |
| `mode` | empty | `accept-edits` or `plan`; empty uses the CLI default |
| `timeoutMs` | `600000` | Wall-clock budget for one `agy` invocation |
| `printTimeout` | empty | `--print-timeout` (Go duration, e.g. `8m`); empty derives one just below `timeoutMs` |
| `modelsCachePath` | empty | Catalog cache path; empty uses `~/.cache/dsh-llm-antigravity/models.json` |
| `modelsCacheTtlMs` | `21600000` | Catalog freshness window (6 hours) |
| `discover` | `true` | Run `agy models` to discover models |
| `models` | `[]` | Extra ids to advertise, listed first |
| `contextWindows` | `{}` | Per-model capacity overrides, keyed by exact model id |
| `defaultContextWindow` | `200000` | Capacity fallback when no hint or override applies |

## Tool handling: why `textOnly` matters (default on)

This is the failure that shaped the plugin, so it is worth stating plainly.

`agy` decides on its own whether a prompt needs a tool. Ask it something
task-shaped — *"check whether this directory is writable"* — and it calls its own
`run_command`. In print mode there is nobody to answer the approval prompt, so
the call is **auto-denied**, the agent stops, and the turn ends with an empty
response. The CLI reports this honestly (`denied_actions:
[{"action":"command","display_name":"RunCommand"}]`), but the harness only sees
a model that produced no text.

With `textOnly: true` (the default) the adapter provisions a small custom agent
and selects it with `--agent`:

```
~/.gemini/config/agents/dsh-text/agent.md
```

That agent is instructed to answer from the conversation alone and never to
reach for tools, which turns the route into what the harness expects. The file
is created only when it is missing, so an agent you wrote yourself is never
overwritten; set `geminiConfigDir` to relocate it, or `provisionAgent: false` to
manage the file yourself.

If Antigravity still ends a turn on a denied tool call, the adapter raises an
actionable error naming the tool and the two fixes instead of a bare
"no assistant message":

```
Antigravity tried to use its own tools (RunCommand), the print-mode approval was
auto-denied, and it produced no answer text. Keep `textOnly: true` so the model
answers without tools, or set `skipPermissions: true` to let it act outside the
harness sandbox.
```

Set `textOnly: false` plus `skipPermissions: true` only when you actually want
Antigravity to act on the machine — and accept that its tools then run outside
the harness sandbox, with no DSH approval in front of them.

### What tool mode actually does

Measured on a real run with `textOnly: false` and `skipPermissions: true`:

- `agy`'s `init` event reports **57 tools** and `permission_mode:
  always-proceed`, so nothing is denied and no `denied_actions` come back;
- `run_command` executes **in the configured `cwd`** (or the session workspace
  when `cwd` is empty) — `pwd` returns that directory;
- file-producing tools may instead write into Antigravity's own scratch area,
  `~/.gemini/antigravity-cli/scratch/`, so an artifact the model reports as
  "created" can land outside the workspace you expected. Use `addDirs`
  (`agy --add-dir`) to bring another root into the session workspace, and check
  the reported path rather than assuming `cwd`;
- the harness still receives **text only**: Antigravity's tool traffic never
  becomes DSH tool calls, so nothing appears in the DSH transcript as a tool
  invocation and no DSH tool executes.

Because the last point surprises people, the two tool layers are worth keeping
apart: `textOnly` controls **Antigravity's** tools, while the harness's own tools
(bash, read, write, web) are never in play on this route whether `textOnly` is on
or off.

## Network and proxy

`agy` is a Go binary: it honours `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` and
**ignores the macOS system proxy settings**. On a host that reaches Google only
through a local proxy (Clash, Surge, and friends), set:

```yaml
        proxy: http://127.0.0.1:7890
```

The symptom without it is a login-looking failure:

```
Error: authentication failed: token exchange failed:
Post "https://oauth2.googleapis.com/token": dial tcp 173.194.43.95:443: i/o timeout
```

which the adapter classifies as a transport failure. Leaving `proxy` empty
inherits the harness environment unchanged, which is what you want when the
machine has direct access.

## Models, ids and effort

Antigravity encodes the reasoning level in the model id. Because
`--model <suffixed-id> --effort <level>` is rejected outright —

```
invalid model selection: --model gemini-3.1-pro-low conflicts with --effort=high
```

— the adapter omits `--effort` for any id that already ends in
`-low`/`-medium`/`-high`, and logs one warning if a session selected a different
level than the id pins.

## Streaming

`agy --output-format stream-json` emits NDJSON with three event kinds, which the
adapter maps onto the harness stream vocabulary:

| `agy` event | Adapter chunk |
|---|---|
| `step_update` with `text_delta` | `block-start` + `text-delta` (incremental) |
| `step_update`/`result` with `usage` | `usage` (cache reads reported disjointly from input) |
| `result` | `finish` (`stop`) |

The prompt itself is sent on stdin as one NDJSON `user` message
(`--input-format stream-json`), which keeps a long conversation off the command
line and away from `ARG_MAX`.

## Install / update

Local development installs this directory as a **link** dependency, so edits here
take effect on the next load with no reinstall:

```sh
dsh plugin --profile web add link:~/.dsh/profiles/web/plugins/dsh-llm-antigravity
```

Add the mount row to `~/.dsh/profiles/web/cordis.patch.yml` (see
[Configuration](#configuration)), then verify with
`dsh --profile web --dump-config`.

## Sharing with another machine

The plugin is **portable**: it discovers the `agy` CLI at load time, reads the
model catalog from that machine's backend, and resolves the harness packages
from the receiving DSH installation. Nothing here hard-codes this machine's
paths.

### Option A — the git repository

```sh
dsh plugin --profile web add git+ssh://git@github.com/zhangzhangco/dsh-llm-antigravity.git
```

Update later with `dsh plugin --profile web update dsh-llm-antigravity`.

### Option B — a tarball

Build the package, copy the `.tgz` over, then:

```sh
dsh plugin --profile web add /path/to/dsh-llm-antigravity-0.2.0.tgz
```

### Option C — a folder for development

```sh
dsh plugin --profile web add link:~/src/dsh-llm-antigravity
```

`dsh plugin` anchors a relative `file:`/`link:` spec to your **current
directory**, not the profile, so run it from outside the profile.

### What does not transfer

- **The credential.** Antigravity's sign-in is per machine — run `agy` there if
  it is not signed in yet.
- **`~/.gemini/config/agents/dsh-text/agent.md`.** The plugin recreates it on
  first load, as long as `provisionAgent` is left on.
- **The catalog cache.** It is refilled by the first `agy models` call.

## Verification

- `dsh --profile web --dump-config` — the `llm-antigravity` row is composed.
- Boot the profile; startup logs
  `dsh-llm-antigravity: route antigravity-local ready (transport=cli, command=…, agent=dsh-text, discover=true)`.
- The model picker lists the Antigravity models under **Antigravity (local)**.
- One call, bypassing the harness:

```sh
printf '{"event":"user","message":{"content":"Reply with exactly: pong"}}\n' \
  | agy --input-format stream-json --output-format stream-json \
        --agent dsh-text --model gemini-3.1-pro-low --print=
```

## Known limits

- **No reasoning deltas.** `stream-json` emits `step_update.text_delta` only;
  thinking surfaces as a `thinking_tokens` count.
- **Text only.** Image blocks are rendered as `[image attachment …]` placeholders.
- **`textOnly` is an instruction, not a sandbox.** Antigravity still advertises
  its tool list to the model; the built-in agent is told not to use it, and a
  denial is reported as an error rather than a silent empty turn.
- **Every call is a fresh conversation.** The history is replayed as prompt text;
  `--continue`/`--conversation` are not used, so Antigravity keeps no memory
  across turns (the same trade-off as `dsh-llm-codex` with `--ephemeral`).
- **The catalog needs the network.** Offline hosts should set `models` and
  `discover: false`.
- **Antigravity's tools run outside the harness sandbox** whenever
  `skipPermissions: true` is used.
