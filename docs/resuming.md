# Resuming — zero-context checklist

This file is procedural: it reconstructs the working context of a session without chat
history. It reports no progress. Status, the validation checkpoint, the proposed lots, the
open decisions and the next safe action exist only in [ROADMAP.md](../ROADMAP.md); read that
file first and do not infer status from this checklist.

## 1. Orient the checkout

1. `pwd` — the result must be this engine repository (`emergent-society`). It is not the
   DeepSeek Harness GUI checkout and not a cell home; never run a cell command from the wrong
   tree.
2. `git status --short` and `git log --oneline -5` — know the worktree state and the recent
   commits before touching anything.
3. `git rev-parse HEAD origin/main` — compare the local head and the pushed baseline when the
   task depends on it.
4. Read [AGENTS.md](../AGENTS.md) for commands, conventions, gates and the durable execution
   protocol.
5. Read [ROADMAP.md](../ROADMAP.md) for the current position, validation checkpoint, proposed
   lots, open decisions and next safe action.
6. Read the concept and code documents below, then inspect the tree.

## 2. Reading map

| Need | Read |
|---|---|
| Current position, validation, proposed lots, open decisions, next safe action | [ROADMAP.md](../ROADMAP.md) — the only status |
| Commands, scripts, conventions, gates, what does not exist | [AGENTS.md](../AGENTS.md) |
| Concepts → implemented code, module map | [docs/architecture.md](architecture.md) |
| Runtime specification and residuals | [docs/kernel.md](kernel.md) |
| Human↔overlay chat, direction, ratification | [docs/direction.md](direction.md) |
| Observation concept and analysis pipeline | [docs/research/monitoring-architecture.md](research/monitoring-architecture.md) |
| Substrate as a treatment | [docs/substrate.md](substrate.md) — design challenge, not current-state authority; several claims predate the implemented host, wake, direction and attribution layers. Verify against the code map and ROADMAP. |
| Historical live-run record | [docs/first-light.md](first-light.md) — dated history, not status |
| Gateway overlay role template | [docs/gateway-charter.md](gateway-charter.md) |

## 3. Boundaries to keep in mind

- **Nonsecret config** — headings, model ids and endpoints are config, not secrets.
- **Secrets** — a provider secret lives only in `providers.json`: a regular file, mode `0600`
  (or `0400`), owned by the process uid. It must not be placed in argv, the environment,
  ordinary logs, the world or the journal. A hostile provider can reflect a credential into a
  response body that the kernel captures in the frontier; that is an accepted residual, not an
  absolute no-leak promise.
- **Capabilities** — a capability is a declared, attenuated grant (for example `spawn`), not a
  secret and not ordinary config.
- **No broker** — the generic credential broker does not exist; the loader supports only `llm`
  and `tavily`. The agent environment must not hold real secrets. Endpoint-bound placeholders,
  broker-side injection and per-node attenuation are target design
  ([docs/kernel.md](kernel.md) §Credential store and broker).
- **Confinement scope** — the `execute` shell and package Runs are Landlock-confined on
  filesystem content. Egress is currently open by decision; this is not network mediation.
- **Observation boundary** — the frontier records only kernel-mediated HTTP exchanges; it
  does not record shell syscalls, direct shell/Run egress or individual intra-turn filesystem
  effects. The world's git observes committed changes at commit granularity: the author is the
  node whose turn closed the commit, not necessarily the writer of each file.
- **Host path pin** — every operator file read (the reply/ratification `--file`, `--charter-file`,
  `--gateway-charter`, the `--nodes-file` declaration and every entry charter) is fd-anchored
  through `src/node/world-fs.ts`: all ancestors and the leaf are no-follow, with only the
  configured legacy world-root alias trusted. The `--nodes-file` DECLARATION is external-only
  (a world-addressed one is refused); entry charters may stay world-addressed. `src/node/world.ts`
  stays protected and the world pair's historical symlink is still accepted.
- **The gateway is not a node** — the overlay is a host-side digest service. It has no cell,
  turn, world write or `extend` capability.

## 4. Code ownership (entry points)

The canonical module map is [docs/architecture.md](architecture.md) §2; this is only the
fast path.

| Area | Entry point |
|---|---|
| CLI, host lifetime, composition | [src/host/main.ts](../src/host/main.ts), [src/host/cli.ts](../src/host/cli.ts), [src/host/host.ts](../src/host/host.ts) |
| Status and human write acts | [src/host/status.ts](../src/host/status.ts), [src/host/chat.ts](../src/host/chat.ts), [src/host/direct.ts](../src/host/direct.ts) |
| Turn ritual, park and wake | [src/node/driver.ts](../src/node/driver.ts) |
| Trusted handler, plan and compaction | [src/node/loop.ts](../src/node/loop.ts), [src/context/assembler.ts](../src/context/assembler.ts), [src/context/compaction.ts](../src/context/compaction.ts), [src/context/meter.ts](../src/context/meter.ts) |
| Provider boundary | [src/provider/adapter.ts](../src/provider/adapter.ts), [src/provider/transport.ts](../src/provider/transport.ts) |
| Frontier truth | [src/frontier/journal.ts](../src/frontier/journal.ts), [src/journal/](../src/journal/) |
| World | [src/node/world.ts](../src/node/world.ts) — **protected; never modify without Lead approval** — and the `world-*.ts` family |
| Tools and `extend` | [src/node/tools/dispatch.ts](../src/node/tools/dispatch.ts), [src/node/tools/extend.ts](../src/node/tools/extend.ts) |
| Per-node history | [src/node/history.ts](../src/node/history.ts) |
| Gateway overlay | [src/overlay/service.ts](../src/overlay/service.ts), [src/overlay/cycle.ts](../src/overlay/cycle.ts) |
| Credential store | [src/host/credentials.ts](../src/host/credentials.ts), [src/node/tools/providers.ts](../src/node/tools/providers.ts) |
| Tests | `src/**/__tests__/` |

## 5. Safe fresh home without a real secret

Use Node 24, a fresh cell home and a fake or loopback provider. Choose a new absolute path
outside this checkout and outside any existing cell world. `init` creates a missing home
`0700`; the host refuses a relative path, a home inside the checkout, and a home with a
foreign owner or group/other permission bits. Do not reuse an existing world. `init` never
writes `providers.json`; the operator writes it.

The sample below starts a **nodes-only** host. `<port>` is an OpenAI-compatible loopback
server that the operator runs before the start; the CLI does not start one. The
self-contained setup is in the smoke scripts below.

```sh
unset npm_config_prefix && source ~/.nvm/nvm.sh && nvm use 24
npm run build
node dist/host/main.js init --home <abs-home>
# write <abs-home>/providers.json yourself (regular file, 0600, same uid):
# {"llm":{"key":"<fake-key>","endpoint":"http://127.0.0.1:<port>/v1/chat/completions"}}
node dist/host/main.js status --home <abs-home>
node dist/host/main.js start --home <abs-home> --model <id> --heading "<text>" --heartbeat-seconds 3600
```

Then `status`, `pause` and `resume` operate the home. `chat` also runs without an overlay, but
then it saves only the human record: no overlay is present to answer. To run the overlay, start
a fresh home with `--gateway-charter <abs-adapted-charter>` (and optional `--gateway-model
<id>`, which defaults to the catalog's first entry and is required when no catalog is
declared) after copying and adapting [docs/gateway-charter.md](gateway-charter.md). The pair
is persisted; a later `resume` takes the persisted pair, while a start without the charter
stays nodes-only even when a pair exists ([AGENTS.md](../AGENTS.md)). Do not launch it
automatically. `--no-sandbox` is the explicit confinement opt-out; the default is Landlock.

The executable references for a no-key boot are
[scripts/first-light-smoke.mjs](../scripts/first-light-smoke.mjs) (scenarios A–E against a
loopback provider) and [scripts/wake-policy-smoke.mjs](../scripts/wake-policy-smoke.mjs) (the
smallest compiled start/park/resume/cadence example); both start their own loopback server.

Wake notes:

- A fresh start journals the modern quota-free wake policy. Explicit timers and cadence carry
  no count or cost quota; cadence `0` disables only the cadence, not quota-free explicit
  waits.
- A positive cadence, for example `--heartbeat-seconds 3600` on a fresh home, creates hourly
  wake opportunities. It does not guarantee progress, work or a turn with output.
- Legacy cells keep their journaled old policy with no migration.
- No price, spending ceiling or monetary economy exists in the kernel. The optional start-only
  `--token-limit N` is an operational node response-token stop: it aggregates provider-reported
  node usage, leaves the gateway uncapped, and is not an exact provider bill. Without it, cost is
  deployment policy; a local GPU or sponsored credits is a supported deployment.

Never launch an experiment or make a paid model call as part of orientation. The live wrapper
is gated by `ES_LIVE_LLM=1`, but that variable gates only
[scripts/first-light-live.mjs](../scripts/first-light-live.mjs), not `npm start`, the compiled
smokes or the fresh-home flow.

## 6. Gates and validation

The exact sequential gates and the four compiled smokes are in [AGENTS.md](../AGENTS.md).
A prior checkpoint is not a current gate run: report explicitly which checks were rerun. Do
not present the numbers in ROADMAP as a current pass. Never run suites concurrently.

A documentation-only handoff does not authorize source implementation, an experiment launch
or an API call. It also does not change the existing commit/push gate rules. The next safe
action is in [ROADMAP.md](../ROADMAP.md).
