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
| `cli.ts` | Command dispatch and exit codes ([AGENTS.md](../AGENTS.md)); `--no-sandbox` is the explicit confinement opt-out. Exit 2 covers configuration refusals, including a live owner record and the world open/trust family (their bounded message is logged); `status` exits 1 for a produced degraded report, including a running host that requested confinement but carries `fence=unavailable` (an explicit `sandbox=off` opt-out and the normal `storage=unquoted` fact do not degrade the exit) |
| `options.ts` | Strict `parseArgs` parsing: six commands plus `--help` (`init`, `start`, `resume`, `pause`, `status`, `chat`), no positionals, no unknown flags; relative `--home` and bad `--uid` are usage errors, and `chat`'s `--tail` takes a positive integer |
| `host.ts` | Host lifetime: acquires the owner record BEFORE the config fold (so a pause targets a booting host), composes one cell or a declared node set (`composeCellSet`: one world/doctor/frontier/attribution shared, one runtime, driver, local log, scratch leaf and cgroup leaf per node), and runs the flat node pool (`NodePool`: the declared grant, a monotonic kernel-minted uid reserved synchronously before composing, the requester's offering/budget inherited, the home's 16-node ceiling as the only cap; two-phase boot registers every booted node before any run starts, the pool owns and observes every run and is the host's lifetime anchor — its drain resolves when no live node remains and rejects at the first booted rejection; a node's end removes only that node and `host/spawned`/`host/ended` name birth and death; spawned nodes in-memory), boots (world doctor, frontier journal, runtime, terminal, sandbox, commit fence), builds the production `FencePort` from the attached cell root, annotates the owner record's fence and storage facts after the cgroup attach and before composition, reports a boot leaf it could not thaw or an unreadable storage probe on `host/degraded`, replays the durable degraded-world sidecar into the `host/boot` `world` field, starts and stops the gateway overlay service (a host-side service, never a pool member; its model exchange crosses the same frontier through the gateway's attribution view), and owns stop/pause delivery. The C3 doctor runs between `WorldRepo.open` and the frontier open; its report is passed to `NodeDriver.open`, and a doctor failure is a bounded `world/doctor-failed` diagnostic. The storage seam (`resolveStorage`: production policy + `statfsProbe`, no quota; the `HostDeps.freeSpace`/`storageQuota`/`storagePolicy` test seams) is composed once and passed to the frontier and the driver |
| `status.ts` | The read-only status report; degradation is reported, not thrown. `host.sandbox`/`host.fence` (and the bounded `fenceReason`) are surfaced while a host holds the record; the `host.storage` fact is host-lifetime and survives a stale record (the fence does not). The overlay field reports the persisted gateway configuration — `overlay: configured (<model>)` or `overlay: none` (a damaged pair prints `unknown` inside the configured shape). The human host line prints `fence=unavailable` and `storage=unquoted` only; an unintended fence is the degradation (a running host that requested confinement but carries `fence=unavailable` makes the produced report exit 1), while an explicit `sandbox=off` opt-out and `storage=unquoted` are not degradations |
| `credentials.ts` | The `providers.json` read side: regular file, mode 0600 (0400 accepted; group/other bits refused), owned by the process uid |
| `nodes.ts` | `--nodes-file`: strict JSON node-set parsing (≤ 16 entries, unique safe uids, start requires model/heading, resume takes only the uid and the declared `spawn` grant, optional absolute charter file and `spawn` flag; a non-boolean `spawn` is refused); refusals are `HostConfigError` (exit 2) |
| `chat.ts` | The human channel's chat log (`chat.v0.jsonl`, 0600, append-only, outside the world): the human↔overlay surface's records, `uid` under the conversation actor rule; the torn tail repaired at the host's boot open under the log's own lock; the bounded tolerant tail reads (the overlay's chat window, the session's history, the wait's response read). The node `speak` verb that once wrote it is removed. All THREE cross-process writers — the overlay cycle's `ChatLog`, the interactive session's `ChatWriter`, `direct`'s future batch twin — append under `<home>/.es/chat.lock` with the shared termination-first discipline (`src/locked-append.ts`), and the cycle delivers exactly one `uid: gateway` response record per cycle. The interactive `chat` session lives here: the history render (both sides, ISO-8601 UTC, `--tail`), the prompt loop (a typed message → the human record → the overlay's cycle → the response renders; the bounded 60 s wait; the absent-overlay notice; Ctrl-C aborting the wait only; EOF exiting 0), the non-TTY scripted read, the `--conversation` raw-stream render and the `--json` one-shot read. `direct` remains specified, not implemented |
| `owner.ts` | Pause delivery to the host owning a home; owner records. The optional `fence`/`fenceReason` and `storage` host facts are annotated after the cgroup attach and before composition by a token/pid-checked atomic tmp+rename; records predating either field stay valid |
| `observe.ts` | Operator diagnostics: one bounded JSON object per line on stderr — never model text, tool output, headers or credentials |
| `layout.ts` | Cell-home path layout: the home/world-pair checks and `initHome`; a legacy in-world `world/.git` with no `world.git` is refused with the sanitizing migration recipe and exit 2 (never "remove the world") |
| `errors.ts` | The host error family |
| `fence.ts` | The production commit fence: a host-built `FencePort` that freezes the node leaf (created first if absent) plus every existing `run-*` leaf around one commit attempt, maps every failure to `freeze-failed` after thawing, thaws on release, and logs one bounded `host/fence` line per acquire — never a path. A vanished leaf (ENOENT/ENOTDIR) is re-enumerated and retried once; any other readdir/lstat failure — in the first enumeration or the retry — is a freeze failure, never `fenced: true` |
| `cgroups.ts` | The per-cell cgroup tree: `attachCell` (self-move into `svc/`, verified), `cellHash`/`cellUnitName`, the capability probes, `bootHygiene` (thaw then kill every `node-*`/`run-*` leaf, never `svc/`; an unreadable listing is a bounded `listError`, not "nothing to do"), `freezeSet`/`thawSet`/`killLeaves`/`listLeaves` (only ENOENT/ENOTDIR means gone), `reapRunLeaf` (kill a Run leaf and remove it, descendants included), and `LIMITS` |

### `src/node/` — a node's engine

| Module | Role |
|---|---|
| `driver.ts` | `NodeDriver`: the turn ritual, lifecycle states (`booting/active/waiting/stopping/stopped`), watermark, resume, park/wake, shutdown; hands the handler a narrow `TurnContext` (`{turn, trigger, world, gate, signal, now}` — no journal, no commit) so only the kernel emits. Holds the `FencePort` seam: one `acquire`/`release` wraps ONE `commitWorld` attempt (outside the queue and the git retries), `release` in `finally`, and any non-fenced outcome or a throwing acquire is the typed refusal `freeze-timeout` (only the absence of a port is the unfenced host). The storage home: the effective `StorageConfig` (injected or `DEFAULT_STORAGE`) is shared by the local writer and the turn start; a low probe defers the turn (one bounded diagnostic, `waiting`, a cancellable `storageRetryMs` wait, default 5 s), and the boot barriers tolerate a storage refusal so a low disk never refuses the boot. The optional `doctor` report is validated with the report's own replay validator before it is written as the ignorable local event `world/doctor` after `node/boot`; an invalid report is a named `InvalidDoctorReportError` on the error channel and writes NO event (a write failure is otherwise diagnostic). A `wait {until}` arms one timer (the driver's `schedule` seam) that requests the wake latch; a commit wake cancels it in the park's exit, the next turn then carries `trigger: 'timer'`, and the sliding-hour `wakeBudgetPerHour` budget (default 12, absent reads as 12) refuses an excess fire with the named `WakeBudgetExhaustedError` label. A storage refusal at the closer's flush keeps the `world/commit-refused` carrier attempt, arms the bounded self-retry even when the carrier also refuses, and does not end the run |
| `loop.ts` | `createAgentRuntime`: the trusted handler — folds the local log, presents one bounded world perception per turn, assembles exactly one plan per logical request, sends it through the adapter, dispatches the resulting tool calls |
| `gate.ts` | The trusted local effect boundary: chunking, artifact manifests, the claim-check inline threshold; `flush()` re-reads and digest/size-verifies every pending claim-check before the effect |
| `world.ts` | `WorldRepo` — the façade the engine speaks to (author = uid policy) |
| `world-git.ts` / `world-trust.ts` / `world-commit.ts` / `world-history.ts` / `world-diff.ts` / `world-types.ts` | The git process layer (git as an external process, one controlled environment, per-call deadlines, the world flock around mutating children, proven-stale `index.lock` cleanup); the trust layers `open` runs; the plumbing commit (CAS ref update, interrupted-turn reconciliation, the pre-add walk and post-add staged budgets); the history reads and the hermetic patch renderer (both bounded by their own read deadline); the shared shapes. No module outside the `world-*` family imports a sibling directly — with one named exception: the pure refusal helpers in `world-commit.ts` (`CommitRefusal`, `classifyCommitFailure`, `commitAllRefused`, `renderCommitRefusal`, `isCommitRefusal`) are imported by `driver.ts`, `context/fold.ts` and `node/events.ts`. They are pure shapes/predicates, not a consumer of the commit ritual |
| `world-state.ts` | The durable degraded-world sidecar (`<home>/world-state.json`): an atomic 0600 projection written before a refused turn's closer, read at host composition and by `status` (the second named layering exception: host, status and driver import this pure projection directly), and cleared only when a commit is known to have succeeded — a commit that moved HEAD, never a no-op attempt; a missing/malformed/oversized/non-regular file reads healthy, and the read re-bounds the reason |
| `world-doctor.ts` | The C3 boot doctor: the non-blocking world-lock probe and the age+flock `index.lock` removal, the structural-only index validation (unmerged stages, missing named blobs), the bounded dirty/tracked-unreadable report, and the bounded free-space-gated quarantine of untracked unstageable paths. Returns a serializable `DoctorReport` (counts, bounded relative names, no absolute path) that it validates with `parseDoctorReport` before returning (a report the fold would reject is a programming error, reported as `world/doctor-failed`); it never opens a writer and never repairs divergence. The replay validator `parseDoctorReport` has exactly three consumers: the doctor itself (its own self-check before returning), the driver (validation before the `world/doctor` event is journaled, an invalid payload being a named `InvalidDoctorReportError` with no event), and the fold (replay/render). Its 20 GiB `MIN_FREE_BYTES` is the REPORTED storage-health floor, not the enforcement breaker |
| `limits.ts` | The node-side bounds: git deadlines, the walk entry/size/path budgets and its 30 s wall-clock budget (`MAX_WALK_MS`, checked between completed filesystem calls; typed `walk-timeout`; a single stalled syscall is the residual), the staged budgets, the doctor's quarantine/scan/age/free-space bounds, and `CommitLimits` with production defaults (injected parameters for tests; no environment switch). `MIN_FREE_BYTES = 20 GiB` here is the doctor's REPORT floor; the enforcement floors live in `src/storage.ts` |
| `watcher.ts` / `latch.ts` | `HeadWatcher` (watches git HEAD, poke + unref'd interval) and `WakeLatch` (in-memory coalescing wake signal) |
| `conversation.ts` | The conversation stream (`conversation.v0.jsonl`): the kernel-stamped `{v, at, from, to, text}` record, the cross-process flock append (`<home>/.es/conversation.lock`, the blocking wait, the torn-tail termination first, the `O_APPEND` write + `fsync`, the create-from-either-opener) through the shared locked-append primitive (`src/locked-append.ts`; the short-lived `conversation-append.mjs` helper under `flock -F`; the chat log uses the same primitive with its own `chat.lock`), the host-only boot repair under the same lock, the bounded last-n thread read AND the whole-stream read the human's `chat --conversation` window uses (the leading partial line dropped, the trailing torn fragment dropped, a degraded complete line skipped, the `at` finite guard) and the two renderers (the `get_messages` framing and the pending-notice aggregate). `MAX_SPEAK_BYTES` becomes the conversation record cap; `assertConversationActor` (node uids plus the reserved `human`/`gateway`) is the shared actor rule |
| `conversation-watcher.ts` | `ConversationWatcher`: one per stream, process-lifetime, keyed on the stream's path; a size poll on the 250 ms class running only while subscribed, an in-process `poke` for host-side appends (it fires with no subscribers, because arming matters for a running recipient), a grow-or-shrink watermark (a shrink resets), a bounded arm of the newly appended records' `to` recipients, and the per-recipient pending notice (`noticeFor`/`consume`/`armBoot` from the thread's bounded tail). Its notifications wake only the drivers whose notice is pending, through the second park subscription |
| `events.ts` | The node vocabulary: `node/boot`, `node/shutdown`, `turn/start`, `turn/end`, the ignorable `world/commit-refused`, and the ignorable `world/doctor` — six types only |
| `errors.ts`, `index.ts` | The node error family; package exports |

### `src/node/tools/` — the mounted tools

| Module | Role |
|---|---|
| `terminal.ts` | `TerminalRuntime` (`run`/`dispose`, optional `sandboxStatus`): one persistent PTY session per node, nonce markers on one physical line, typed statuses, one active write, bounded per-command capture, reset-on-timeout |
| `sandbox.ts` | The Landlock policy: grants, scratch leaf, env ownership, the functional probe; builds the vendored launcher's argv |
| `proc.ts` | The Linux x86-64 stdin-wait proof (`/proc`) |
| `sanitize.ts` | PTY output sanitization for the model-facing render |
| `direction.ts` | `readRatifiedDirection`: `DIRECTION.md` at the latest human-authored commit (two bounded git reads; ≤ 8 KiB pinned, truncation notice, empty/unborn → null); `HUMAN_AUTHOR` is reserved and can never be a node uid |
| `web.ts` | `web_search`/`web_fetch`: the Tavily client, renderers, `webToolsFromProviders`; every invocation crosses the frontier |
| `providers.ts` | `loadProviders`: the kernel-side `providers.json` store (see §7) |
| `dispatch.ts` | `dispatchCalls`: completes tool dialogues through the gate; `wait` takes `{}` or an ISO-8601 `{until}` (1 s–7 days ahead, carried back as `wakeAt`); owns the extend verbs' recognition (eleven verbs; `run`/`undefine` take name or id; `stop` takes name, id or nothing — the bare stop names THE live Run; `spawn` takes optional model/heading/charter/spawn; `request_death` takes only `verb` and runs the capture-free synchronous departure branch; `send_message` takes `text` and an optional `to` that is absent or the reserved `gateway` — any other addressee is the explicit node-to-node teaching refusal; `get_messages` takes an optional positive integer `n`) and the native-call bridge — a live-registered package tool called by its bare name runs through the funnel |
| `extend.ts` | The extend executor: the verbs, the verb facts, the funnel's kernel-side schema validation, the honest inspect catalogue. The conversation's two branches run over the runtime-bound `ConversationPort` (`send_message` appends and names the resolved addressee; `get_messages` renders the caller's thread self-bounded under `maxToolResultBytes`, oldest-first, with the kernel framing sentence and an "older records exist" line); the port-less composition answers the honest denial. `speak` and its `SpeakPort` are gone |
| `text.ts` | `boundToolText`: the model-visible tool-text bound |

### `src/node/packages/` — the Package layer

| Module | Role |
|---|---|
| `store.ts` | The definition store: fd-first define, content-addressed identity, write-once persistence under `nodes/<uid>/packages/`, the deleting re-mount scan, the read-only listing and the name channel (run resolves the newest verifying version; undefine resolves the newest attributable and refuses one that does not verify) |
| `protocol.ts` | The Run facade protocol codec: the eight-frame vocabulary, per-line byte accounting, the one-in-flight guards, drain-aware writes |
| `run-bootstrap.ts` | The child half: verify-then-use (inline sha256 before any guest byte), the inlined canonical encoder in lockstep with the journal's, bounded capture, the serial handler chain |
| `registry.ts` | The live tool registry: transactional registration, the safe schema dialect, the frozen caps |
| `supervisor.ts` | The Run supervisor: the confined spawn, injected-clock deadlines, the drain rule, kernel-side disposal (including the Run's cgroup leaf: `cgroup.kill` then remove, descendants included), svc routing through the node's own ports |
| `constants.ts` / `errors.ts` / `index.ts` | The one-home frozen caps; the typed error family; the barrel |

### `src/journal/` — one storage module, two layouts

The append-only, hash-chained, framed zstd event log — one module serving the frontier
layout (`journal.v0.*`, one chain per cell home) and the node layout (`log.v0.*`, one
chain per node). Pure core: `envelope.ts` (format + hash chain), `canon.ts` (RFC 8785 +
SHA-256). Storage: `framing.ts` (zstd frames, torn/corrupt scan), `blobs.ts` (claim-check
store), `lock.ts` + `lock-guard.mjs` (flock single-writer ownership with the durable
owner record), `fsutil.ts` (fsync, atomic writes, durable directories), `layout.ts`
(paths + head shape), `errors.ts`. Actors: `writer.ts` (`JournalWriter`: append, 200 ms
timer, flush barrier, watermark, rollback, poison, the optional storage circuit breaker at
`flushOnce`), `reader.ts` (+ `repair()`), `verify.ts` (`verifyChain`, shared reader↔writer).
`index.ts` re-exports the public surface.

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
serialization). `snapshots.ts` is **specified, not implemented**: no host wires the
checkpoint hook, so no `snapshots/` artifact is produced; the tests that exercise it
inject the hook themselves.

### `src/provider/` — the only kernel-mediated LLM path

`wire.ts` (`serializeWire`: the canonical non-streaming body), `adapter.ts`
(`ProviderAdapter`: plan → wire → `begin` → send → `complete`, with classified, bounded
retries), `transport.ts` (`OpenAITransport`: exact wire bytes, bounded body),
`policy.ts` (the production timing port for the adapter's retry delay).

### `src/frontier/` — the truth

`events.ts` (the `http/request` / `http/response` / `http/incomplete` vocabulary,
validators, header allowlist, `FRONTIER_MAX_BODY_BYTES`), `journal.ts`
(`openFrontierJournal(home, { worldHead, now, storage })`: the gate whose `begin` checks
the storage floor before the world-head stamp/blob/event, is durable and read-back
verified before the send, and whose `complete` is durable before the caller proceeds,
plus boot reconciliation), `attribution.ts` (the per-node gate view and the
`{v, call, uid}` sidecar: one line per begun exchange, written after the durable request
and before the send, a torn tail dropped at open), `index.ts` (exports).

### The rest of the tree

- `src/storage.ts` — the pure storage circuit breaker (W0-d, lite): `StorageFree`,
  `StorageQuota`, `StoragePolicy`, the enforcement floors + kernel reserve
  (`STORAGE_MIN_FREE_BYTES`/`_INODES` + `KERNEL_RESERVE_*`), `DEFAULT_STORAGE_POLICY`,
  `assertStorage`/`checkStorage`, the typed `StorageError` and the `storageFact`. No
  imports, so `journal/` and `frontier/` can depend on it without a node-side import.
  `src/node/storage-probe.ts` — `statfsProbe` (`bsize * bavail` bytes, `ffree` inodes,
  clamped; `null` on a probe error) and `DEFAULT_STORAGE`.
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
  and skips when unavailable), `first-light-packages-smoke.mjs` (scenario F: define → run →
  funneled/native call → newer same-name define → stop → crash → resume → pause),
  `first-light-live.mjs` (the live wrapper; refuses and exits 2 unless `ES_LIVE_LLM=1`),
  `start-service.mjs` (the delegated systemd launch), and the three manual survival-core
  acceptance smokes `w0-refusal-smoke.mjs`, `w0-fence-smoke.mjs`, `w0-reap-smoke.mjs`
  (compiled; run by path, no npm script — see AGENTS.md for the prerequisites and the
  known transient-systemd sensitivity).

## 3. Concept ↔ code

| Concept | Where it lives |
|---|---|
| Frontier journal = the only truth | `src/frontier/` over `src/journal/`; the hash-chained stream and its payload blobs are the canonical record, everything else disposable |
| Append-only / hash chain | `src/journal/envelope.ts`; one chain per cell home (frontier), one per node (local) |
| Every exchange attributable to its node | `src/frontier/attribution.ts`; one `{v, call, uid}` line per begun exchange in `<home>/frontier/attribution.v0.jsonl`, written after the durable request and before the send |
| Canonical bytes | `src/journal/canon.ts` (RFC 8785, refusal of lossy values, data-only copy) |
| "Model-visible means logged" | `begin`/`complete` in `src/frontier/journal.ts`, each flushed and read-back verified; the `flush()` barrier in `writer.ts` at `turn/start`/`turn/end` and around every gate capture |
| Durability batching | `framing.ts` + the 200 ms timer in `writer.ts` |
| Storage circuit breaker (lite) | `src/storage.ts` (policy/quota/`StorageError`) + `src/node/storage-probe.ts` (`statfs`), enforced at three homes before the effect: `writer.ts` `flushOnce`, `src/frontier/journal.ts` `begin`, and `driver.ts` turn start (deferral, no fail-closed boot); the `unquoted`/`quoted` fact on the owner record, `host/boot` and `status` |
| Never lose an event silently | watermark + rollback + poison in `writer.ts`; frontier boot reconciliation appends `http/incomplete` for an open call |
| Crash repair | `repair()` in `reader.ts` + the zstd-magic test in `framing.ts`, both layouts |
| Claim-check | `blobs.ts` + `writer.ts` (local payloads; frontier bodies never claim-check-truncated); verified reads in `src/context/loader.ts`, the gate's flush, the frontier gate's read-back |
| One writer per stream | `src/journal/lock.ts` (flock sidecar + durable `{pid, startedAt, token}` owner record) |
| N nodes on one home | `src/host/host.ts` `composeCellSet` + `src/host/nodes.ts`: one world/doctor/frontier/attribution, one runtime, driver, local log, scratch leaf and cgroup leaf per node; the fence freezes every `node-*` and `run-*` leaf |
| Spawn (flat roster) | `src/host/host.ts` `NodePool` + `src/node/tools/extend.ts` `SpawnPort`: the declared grant (a nodes-file `spawn: true`; a solo boot grants nobody), the composer sentence ` You are <uid>, composed by <requester>.`, a node's end removes only that node, the home's 16-node ceiling as the only cap, monotonic race-free uid minting; a spawned node is in-memory (its local log survives) |
| Ratified direction | `src/node/direction.ts`: the heading pin is `DIRECTION.md` at the latest human-authored commit, cited by `direction/pinned`; a node draft is history, not authority |
| The human channel | `src/host/chat.ts` (the kernel-owned chat log, the human's `ChatWriter` and the interactive `chat` session: the prompt loop, `--conversation`, `--json`) + `src/overlay/` (the gateway's native delivery: exactly one `uid: gateway` response record per cycle, appended by the cycle itself); the node `speak` verb and its `SpeakPort` are removed. The `direct` batch act is specified, not implemented |
| The gateway overlay (agent zero) | `src/overlay/`: `service.ts` (the serialized cycle loop, one dirty flag across both surfaces, the one boot cycle) + `cycle.ts` + `context.ts` (the two bounded windows) + `tools.ts`/`world-read.ts` (the three tools: `send_message`, `read_world`, `world_log`) + `gate.ts` (the synthetic no-op gate) + `charter.ts` (the config home: `<home>/gateway.charter.md` + `<home>/gateway.json`); its triggers are `ConversationWatcher`'s gateway-arrival count and `src/host/chat-watcher.ts`; its exchanges are ordinary frontier events attributed to the reserved `gateway` actor, and it holds no world-write capability |
| The conversation interface | `src/node/conversation.ts` + `conversation-watcher.ts` + `src/node/tools/extend.ts` `ConversationPort`: the kernel-owned stream, the two node verbs, the per-participant thread, the pending notice and the `'conversation'` trigger; `gateway` is reserved in `assertNodeUid` |
| The world is the filesystem | `src/node/world.ts` (`WorldRepo`) over `world-git.ts`/`world-commit.ts` |
| Wake-on-change | `src/node/watcher.ts` + `driver.ts`, asking `WorldRepo.hasForeignCommit` (`world-history.ts`) |
| Perception is a diff | the watermark in `driver.ts` + `commitsIn`/`firstParent`/`diff` on `WorldRepo`, consumed by `presentWorld` (`src/context/diff.ts`); `WorldRepo.commitsSince` is a test seam |
| Empty turn | `ignorable: true` on `turn/end` (`driver.ts`) — a local-log fact, modeled by the context assembler, seen by no observer |
| An effect is never unattributed | synthetic closers and reconciliation at resume (`driver.ts`); the plumbing commit returns its own hash (`world-commit.ts`) |
| Bounded git failure and the world doctor | per-child deadlines, the world flock and the stale-`index.lock` cleanup in `world-git.ts`; the walk entry/size/path budgets, its cooperative 30 s `walk-timeout` (a single stalled syscall is the residual) and the staged budgets in `world-commit.ts` over `limits.ts`; `world-doctor.ts`'s report (validated with `parseDoctorReport`) carried as the ignorable `world/doctor` event (`driver.ts`), validated and non-rendered by `context/fold.ts` |
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
| Disposable projection cache (specified, not implemented — no host hook) | `src/context/snapshots.ts` |
| Per-cell cgroup tree, fence and reaper | `src/host/cgroups.ts` (attach, boot hygiene, freeze/thaw/kill, `reapRunLeaf`, `LIMITS`), `src/host/fence.ts` (the commit-fence port), the launcher's join-before-restrict in `native/es-landlock/`, and the delegated launch in `scripts/start-service.mjs` |
| Package definition store | `src/node/packages/store.ts` — fd-first define, content-addressed identity, write-once persistence under `nodes/<uid>/packages/` |
| Run facade protocol | `src/node/packages/protocol.ts` (kernel side) + `run-bootstrap.ts` (child side, self-contained, verify-then-use) |
| Live tool registry | `src/node/packages/registry.ts` — transactional registration, the safe schema dialect, the frozen caps |
| Confined Run supervisor | `src/node/packages/supervisor.ts` + the Run policy in `sandbox.ts` (`buildRunSandboxSpec`) — deadlines, the drain rule, kernel-side disposal |
| The `extend` tool and the funnel | `src/node/tools/extend.ts` (executor) + the `decide()` arm and the native-call bridge in `dispatch.ts`; the offering is frozen at the factory (`config.ts`) |
| Package lifecycle | the boot scan and host-stop disposal in `src/node/loop.ts`; composition in `src/host/host.ts` |
| Only the kernel emits | the narrow `TurnContext` (`driver.ts`) for the local log; the frontier gate (`src/frontier/journal.ts`) for the exchanges |
| The provider-parameter contract | `src/context/parameters.ts` (bounds) + `src/context/contracts.ts` (payload shapes) |
| The two observation surfaces joined | `world_head` on every `http/request` (`src/frontier/events.ts`) + the commit hash in `turn/end` (`src/node/events.ts`) when the turn's commit succeeded; a refused or empty closer carries no hash |
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
as author, append `turn/end` with the commit hash when the commit succeeded (a refused
commit writes the closer without one, sets the degraded sidecar and records
`world/commit-refused` after it) and flush, then chain or park. A crash
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
funnel (`src/node/packages/`; the boot scan and the host-stop disposal live in
`src/node/loop.ts`). Policies stay
kernel-side: the replacement seam (a policy Package arrives through the same facade,
never in-kernel trust) is **specified, not implemented**, opened when C2 demonstrates
the need.

## 7. The credential store and the hostile-provider disclosure

The `providers.json` schema is enforced in `src/node/tools/providers.ts`: exactly two
named entries — `llm` (`{key, endpoint, models?}`, no defaults, the model endpoint;
`models`, when present, is the operator-declared served-model catalog — at most 64
unique one-line printable ASCII ids of at most 256 characters each (0x20–0x7E; no
control characters, newlines, DEL or non-ASCII), operator-declared, unverified,
not a routing table; the kernel lists it in `inspect`, projects it as the
third kernel-owned system block, and validates every start, every spawn that names a
model and every `update_self` that names a model against it) and the optional `tavily` (the web tools: `key` required nonempty, sent only in the
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
