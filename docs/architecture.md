# Architecture — the current-code map

This document is the single map between the design's concepts and the code that implements
them, regenerated from the tree. The specification is [kernel.md](kernel.md); progress and
checkpoints are [../ROADMAP.md](../ROADMAP.md); commands, scripts and toolchain are
[../AGENTS.md](../AGENTS.md). Status appears only as **implemented** /
**specified, not implemented**.

## 1. The system in one picture

Three mechanisms carry the design:

1. **The frontier journal is the only truth** — every kernel-mediated exchange (model
   calls, web-tool calls) is an event in one append-only, hash-chained log per cell home,
   written by the kernel at the HTTP boundary, durable before the effect. The world's git
   history is the second observation surface; everything else — dashboards, metrics, agent
   memory, the per-node `log.v0.*` local logs — is a disposable projection or a cold-start
   artifact.
2. **The world is the filesystem** — one git repository; nodes communicate only by
   writing files; the kernel commits the world per turn, git author = the node's uid.
3. **Wake-on-change** — the kernel watches the world's git HEAD; a node wakes when HEAD
   carries a commit it did not author. A static world spends no tokens.

What is recorded is the boundary fact, not an exhaustive trace: the frontier holds the
mediated call and its terminal response, the local log the top-level tool invocation and
result, the world's git history the observed diff; the shell's syscalls inside a turn are
not individually logged.

## 2. Module map

### `src/host/` — the operator surface

| Module | Role |
|---|---|
| `main.ts` | Entry point: `runCli(argv)`, escaped errors exit 1 with a bounded label |
| `cli.ts` | Command dispatch and exit codes ([AGENTS.md](../AGENTS.md)); `--no-sandbox` is the explicit confinement opt-out |
| `options.ts` | Strict `parseArgs` parsing: five commands plus `--help` (`init`, `start`, `resume`, `pause`, `status`), no positionals, no unknown flags; relative `--home` and bad `--uid` are usage errors |
| `host.ts` | Host lifetime: boots a cell (frontier journal, runtime, terminal, sandbox) and owns stop/pause delivery |
| `status.ts` | The read-only status report; degradation is reported, not thrown |
| `credentials.ts` | The `providers.json` read side: regular file, mode 0600 (0400 accepted; group/other bits refused), owned by the process uid |
| `owner.ts` | Pause delivery to the host owning a home; owner records |
| `observe.ts` | Operator diagnostics: one bounded JSON object per line on stderr — never model text, tool output, headers or credentials |
| `layout.ts` | Cell-home path layout |
| `errors.ts` | The host error family |

### `src/node/` — a node's engine

| Module | Role |
|---|---|
| `driver.ts` | `NodeDriver`: the turn ritual, lifecycle states (`booting/active/waiting/stopping/stopped`), watermark, resume, park/wake, shutdown; hands the handler a narrow `TurnContext` (`{turn, trigger, world, gate, signal, now}` — no journal, no commit) so only the kernel emits |
| `loop.ts` | `createAgentRuntime`: the trusted handler — folds the local log, presents one bounded world perception per turn, assembles exactly one plan per logical request, sends it through the adapter, dispatches the resulting tool calls |
| `gate.ts` | The trusted local effect boundary: chunking, artifact manifests, the claim-check inline threshold; `flush()` re-reads and digest/size-verifies every pending claim-check before the effect |
| `world.ts` | `WorldRepo` — the façade the engine speaks to (author = uid policy) |
| `world-git.ts` / `world-trust.ts` / `world-commit.ts` / `world-history.ts` / `world-diff.ts` / `world-types.ts` | The git process layer (git as an external process, one controlled environment); the trust layers `open` runs; the plumbing commit (CAS ref update, interrupted-turn reconciliation); the history reads; the hermetic patch renderer; the shared shapes. No module outside the `world-*` family imports a sibling directly |
| `watcher.ts` / `latch.ts` | `HeadWatcher` (watches git HEAD, poke + unref'd interval) and `WakeLatch` (in-memory coalescing wake signal) |
| `events.ts` | The node vocabulary: `node/boot`, `node/shutdown`, `turn/start`, `turn/end` — four types only |
| `errors.ts`, `index.ts` | The node error family; package exports |

### `src/node/tools/` — the mounted tools

| Module | Role |
|---|---|
| `terminal.ts` | `TerminalRuntime` (`run`/`dispose`, optional `sandboxStatus`): one persistent PTY session per node, nonce markers on one physical line, typed statuses, one active write, bounded per-command capture, reset-on-timeout |
| `sandbox.ts` | The Landlock policy: grants, scratch leaf, env ownership, the functional probe; builds the vendored launcher's argv |
| `proc.ts` | The Linux x86-64 stdin-wait proof (`/proc`) |
| `sanitize.ts` | PTY output sanitization for the model-facing render |
| `web.ts` | `web_search`/`web_fetch`: the Tavily client, renderers, `webToolsFromProviders`; every invocation crosses the frontier |
| `providers.ts` | `loadProviders`: the kernel-side `providers.json` store (see §7) |
| `dispatch.ts` | `dispatchCalls`: completes tool dialogues through the gate; owns the six extend verbs' recognition |
| `extend.ts` | The extend executor: the verbs, the verb facts, the funnel's kernel-side schema validation, the honest inspect catalogue |
| `text.ts` | `boundToolText`: the model-visible tool-text bound |

### `src/node/packages/` — the Package layer

| Module | Role |
|---|---|
| `store.ts` | The definition store: fd-first define, content-addressed identity, write-once persistence under `nodes/<uid>/packages/`, the deleting re-mount scan and the read-only listing |
| `protocol.ts` | The Run facade protocol codec: the eight-frame vocabulary, per-line byte accounting, the one-in-flight guards, drain-aware writes |
| `run-bootstrap.ts` | The child half: verify-then-use (inline sha256 before any guest byte), the inlined canonical encoder in lockstep with the journal's, bounded capture, the serial handler chain |
| `registry.ts` | The live tool registry: transactional registration, the safe schema dialect, the frozen caps |
| `supervisor.ts` | The Run supervisor: the confined spawn, injected-clock deadlines, the drain rule, kernel-side disposal, svc routing through the node's own ports |
| `constants.ts` / `errors.ts` / `index.ts` | The one-home frozen caps; the typed error family; the barrel |

### `src/journal/` — one storage module, two layouts

The append-only, hash-chained, framed zstd event log — one module serving the frontier
layout (`journal.v0.*`, one chain per cell home) and the node layout (`log.v0.*`, one
chain per node). Pure core: `envelope.ts` (format + hash chain), `canon.ts` (RFC 8785 +
SHA-256). Storage: `framing.ts` (zstd frames, torn/corrupt scan), `blobs.ts` (claim-check
store), `lock.ts` + `lock-guard.mjs` (flock single-writer ownership with the durable
owner record), `fsutil.ts` (fsync, atomic writes, durable directories), `layout.ts`
(paths + head shape), `errors.ts`. Actors: `writer.ts` (`JournalWriter`: append, 200 ms
timer, flush barrier, watermark, rollback, poison), `reader.ts` (+ `repair()`), `verify.ts`
(`verifyChain`, shared reader↔writer). `index.ts` re-exports the public surface.

### `src/context/` — the durable context

`config.ts` (default config + strict validation), `events.ts` (the boundary event
vocabulary), `artifacts.ts` (canonical bytes + artifact resolution), `loader.ts` (the
verified claim-check read), `fold.ts` (`ContextFold`: config, committed surface, open
turn, recovery), `surface.ts` (committed surface + transactional compaction),
`compaction.ts`/`groups.ts` (policy + neutral group rules), `diff.ts` (`presentWorld`:
the bounded pinned git perception), `assembler.ts` (`assemble()`: the one canonical plan,
pure, never journaled), `snapshots.ts` (disposable projection checkpoints, retention 2),
`validate.ts` (shared gate/snapshot schema dialects), `contracts.ts` (the shared JSON
contracts of the assembler), `parameters.ts` (the one model-parameter contract — the
permitted provider dialect and each key's bound — shared by config validation and wire
serialization).

### `src/provider/` — the only kernel-mediated LLM path

`wire.ts` (`serializeWire`: the canonical non-streaming body), `adapter.ts`
(`ProviderAdapter`: plan → wire → `begin` → send → `complete`, with classified, bounded
retries), `transport.ts` (`OpenAITransport`: exact wire bytes, bounded body),
`policy.ts` (the production timing port for the adapter's retry delay).

### `src/frontier/` — the truth

`events.ts` (the `http/request` / `http/response` / `http/incomplete` vocabulary,
validators, header allowlist, `FRONTIER_MAX_BODY_BYTES`), `journal.ts`
(`openFrontierJournal(home, { worldHead, now })`: the gate whose `begin` is durable and
read-back verified before the send and whose `complete` is durable before the caller
proceeds, plus boot reconciliation), `index.ts` (exports).

### The rest of the tree

- `src/net/bounded-body.ts` — `readBoundedBody`: the single cap-and-prefix streamed-body
  read, shared by the provider transport and the web tools so the two captures cannot
  drift apart.
- `src/errors.ts` — the typed-error root (`KernelError`): every family roots here, `name`
  taken once from `new.target`. `src/text.ts` (`utf8Prefix`, `decodeToolText`,
  `truncationNotice`) and `src/util.ts` are the shared text/util helpers.
- `native/es-landlock/` — the vendored C11 Landlock launcher (source tracked, binary
  git-ignored), built by `scripts/build-native.mjs`.
- `scripts/` — `build.mjs` (compile + runtime assets + launcher verification),
  `vitest-global-setup.mjs` (builds the launcher once per run),
  `first-light-smoke.mjs` (scenarios A–E; the confinement scenario needs Landlock ABI ≥ 3
  and skips when unavailable), `first-light-live.mjs` (the live wrapper; refuses and
  exits 2 unless `ES_LIVE_LLM=1`).

## 3. Concept ↔ code

| Concept | Where it lives |
|---|---|
| Frontier journal = the only truth | `src/frontier/` over `src/journal/`; the hash-chained stream and its payload blobs are the canonical record, everything else disposable |
| Append-only / hash chain | `src/journal/envelope.ts`; one chain per cell home (frontier), one per node (local) |
| Canonical bytes | `src/journal/canon.ts` (RFC 8785, refusal of lossy values, data-only copy) |
| "Model-visible means logged" | `begin`/`complete` in `src/frontier/journal.ts`, each flushed and read-back verified; the `flush()` barrier in `writer.ts` at `turn/start`/`turn/end` and around every gate capture |
| Durability batching | `framing.ts` + the 200 ms timer in `writer.ts` |
| Never lose an event silently | watermark + rollback + poison in `writer.ts`; frontier boot reconciliation appends `http/incomplete` for an open call |
| Crash repair | `repair()` in `reader.ts` + the zstd-magic test in `framing.ts`, both layouts |
| Claim-check | `blobs.ts` + `writer.ts` (local payloads; frontier bodies never claim-check-truncated); verified reads in `src/context/loader.ts`, the gate's flush, the frontier gate's read-back |
| One writer per stream | `src/journal/lock.ts` (flock sidecar + durable `{pid, startedAt, token}` owner record) |
| The world is the filesystem | `src/node/world.ts` (`WorldRepo`) over `world-git.ts`/`world-commit.ts` |
| Wake-on-change | `src/node/watcher.ts` + `driver.ts`, asking `WorldRepo.hasForeignCommit` (`world-history.ts`) |
| Perception is a diff | the watermark in `driver.ts` + `commitsIn`/`firstParent`/`diff` on `WorldRepo`, consumed by `presentWorld` (`src/context/diff.ts`); `WorldRepo.commitsSince` is a test seam |
| Empty turn | `ignorable: true` on `turn/end` (`driver.ts`) — a local-log fact, modeled by the context assembler, seen by no observer |
| An effect is never unattributed | synthetic closers and reconciliation at resume (`driver.ts`); the plumbing commit returns its own hash (`world-commit.ts`) |
| Verified provenance at the boundary | `src/context/loader.ts` + `src/context/artifacts.ts` |
| The durable context | `fold.ts`, `surface.ts`, `compaction.ts` + `groups.ts` |
| The one canonical request | `src/context/assembler.ts` (never journaled) → `src/provider/wire.ts` |
| The frontier exchange | `src/frontier/events.ts` + `src/frontier/journal.ts` |
| The mediated LLM path | `src/provider/adapter.ts` + `transport.ts`; `src/node/tools/web.ts` is the second mediated path (no model request); the shell's egress is unmediated — open by decision |
| Bounded response bodies | `src/net/bounded-body.ts`, shared by both mediated paths |
| Bounded model-visible text | `src/text.ts` + `src/node/tools/text.ts` |
| Shared schema validation | `src/context/validate.ts` (`GATE_DIALECT` / `SNAPSHOT_DIALECT`) |
| Kernel-mediated web tools | `src/node/tools/web.ts`, dispatched by `dispatch.ts`; each invocation crosses the frontier |
| Kernel-side credential store | `src/node/tools/providers.ts` (see §7) |
| The trusted local effect boundary | `src/node/gate.ts` + the runtime `src/node/loop.ts` |
| Persistent terminal `execute` | `src/node/tools/terminal.ts` + `sandbox.ts` + `native/es-landlock/` + `dispatch.ts`; `sanitize.ts` renders PTY output for the model |
| Linux stdin-wait proof | `src/node/tools/proc.ts` |
| Disposable projection cache | `src/context/snapshots.ts` |
| Package definition store | `src/node/packages/store.ts` — fd-first define, content-addressed identity, write-once persistence under `nodes/<uid>/packages/` |
| Run facade protocol | `src/node/packages/protocol.ts` (kernel side) + `run-bootstrap.ts` (child side, self-contained, verify-then-use) |
| Live tool registry | `src/node/packages/registry.ts` — transactional registration, the safe schema dialect, the frozen caps |
| Confined Run supervisor | `src/node/packages/supervisor.ts` + the Run policy in `sandbox.ts` (`buildRunSandboxSpec`) — deadlines, the drain rule, kernel-side disposal |
| The `extend` tool and the funnel | `src/node/tools/extend.ts` (executor) + the `decide()` arm in `dispatch.ts`; the offering is frozen at the factory (`config.ts`) |
| Package lifecycle | the boot scan and host-stop disposal in `src/node/loop.ts`; composition in `src/host/host.ts` |
| Only the kernel emits | the narrow `TurnContext` (`driver.ts`) for the local log; the frontier gate (`src/frontier/journal.ts`) for the exchanges |
| The provider-parameter contract | `src/context/parameters.ts` (bounds) + `src/context/contracts.ts` (payload shapes) |
| The two observation surfaces joined | `world_head` on every `http/request` (`src/frontier/events.ts`) + the commit hash in `turn/end` (`src/node/events.ts`) |
| The typed-error root | `src/errors.ts` |

## 4. The two records in the code

Every event is an envelope with a frozen field set; the chain rule and the four frozen
constants (16 KiB / 4 MiB / 64 MiB / 32 MiB), the 200 ms write-behind window and the
ownership protocol are specified in [kernel.md](kernel.md) and enforced here:
`envelope.ts` computes and verifies the chain; `framing.ts` frames and discriminates;
`writer.ts` batches, flushes, rolls back and poisons; `lock.ts` owns; `reader.ts` repairs;
`verify.ts` is the meeting point — a stream valid for the writer is valid for the reader,
both layouts. The runtime (`loop.ts`) and the driver are the only writers' clients: the
handler never touches a journal, and replay refuses an incomplete vocabulary up front
(`readHistory`, `readBlob`, `acknowledgedWorld` present; `knownTypes` covering the node
lifecycle and registry types).

## 5. The node driver in the code

Each turn: open on the world range `{from: watermark, to: HEAD}`, append `turn/start` and
flush, run the handler with the narrow `TurnContext`, commit the world with the node's uid
as author, append `turn/end` with the commit hash and flush, then chain or park. A crash
is the absence of `node/shutdown`; resume closes an interrupted turn synthetically and
reconciles it against the world's commits (subject `turn N`, bounded walk). The watcher
announces HEAD movement, each parked node evaluates its own predicate, and the latch
coalesces the wake; read failures on the wake path delay a wake, durability failures are
fatal. With the hooks bundle the watermark advances only from a verified durable
perception acknowledgement naming the current turn and its exact opening range — a turn
that failed before recording a perception is re-presented after a restart, never skipped.
The git layer stages, writes a tree, commits it and moves the branch by compare-and-swap
(never `git commit`), under one controlled environment and the trust layers of
`world-trust.ts`; attribution is commit-granular — the git author names the node whose
turn closed the commit, not every file inside it.

## 6. Mechanism and policy

Everything implemented is mechanism (journal, frontier, gate, watcher, commit-per-turn,
ritual, sandbox) except one deliberate exception: the assembler and compaction policies
decide what a wake's diff presents and what is retained — implemented, but as trusted
kernel-side behavior, not replaceable Packages. The `extend` Package layer is
**implemented**: mechanism and tool Packages — content-addressed definitions persisted
under `nodes/<uid>/packages/`, Runs as Landlock-confined children behind a JSON-lines
facade, a live runtime registry, the frozen five-tool offering with the `extend call`
funnel, the boot scan and the host-stop disposal (`src/node/packages/`). Policies stay
kernel-side: the replacement seam (a policy Package arrives through the same facade,
never in-kernel trust) is **specified, not implemented**, opened when C2 demonstrates
the need.

## 7. The credential store and the hostile-provider disclosure

The `providers.json` schema is enforced in `src/node/tools/providers.ts`: exactly two
named entries — `llm` (`{key, endpoint}`, no defaults, the model endpoint) and the
optional `tavily` (the web tools: `key` required nonempty, sent only in the
`Authorization` header; `baseUrl` optional, `https`-only unless the host is loopback, no
embedded credentials, query or fragment; `timeoutMs` 1–120000, default 20000;
`maxResults` 1–20, default 8; `maxResponseBytes` 1024–8388608, default 1 MiB). Unknown
providers and fields are refused; the file is capped at 1 MiB; a missing file is an empty
registry (web calls resolve `denied`); validation errors name positions and never quote
values. The kernel interpolates a key into no event, artifact, world write or model
request. The spec (confinement, broker target) is [kernel.md](kernel.md).

Hostile-provider disclosure: a provider response body is captured verbatim up to its cap
and journaled at the frontier (`complete: false` when the cap stops the read), so a
hostile provider can reflect the key into its response body; that body is rendered
(bounded) into the local tool result and can reach a later model request through the
context projection — accepted residual for the experiment phase, pinned by test.
