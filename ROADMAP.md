# Roadmap

References: [Vision](docs/vision.md) — what the project is; [Architecture](docs/architecture.md) — the concepts→code map; [Kernel](docs/kernel.md) — the technical spec; [Research](docs/research/) — the evidence base.

## Resume here

**Position.** The engine exists and runs: kernel, node driver, host, seven-command CLI,
gateway overlay and Package layer. The validated runtime code is `50290c5`: it carries the
bounded 120 s fresh-node/gateway request defaults ([config.ts](src/context/config.ts),
[policy.ts](src/overlay/policy.ts)) and the cockpit's fixed 300 s launch heartbeat
([manager.ts](src/host/cockpit/manager.ts)); the nine Node 24 gates are green at that code
(148 files / 2,510 tests, 0 skips; 4 mutants killed; counter audit accepted). The system is
operated through the CLI; an optional start-only operator node response-token stop
(input+output) is available. A local loopback cockpit (gateway-only observer and vanilla page)
is implemented; browser rendering was not validated (the installed Firefox is snap
single-instance), and there is no remote cockpit or cockpit frontier viewer. The
engine/provider-only three-world acceptance and its caveats are recorded once in the Validation
checkpoint below.

The cockpit's 300 s heartbeat is source-compiled; an existing cockpit process must be restarted,
and the operator must confirm that restart, before any live-deployment claim. Source presence
alone is not a deployment claim.

**Gaps.** No generic credential broker (the loader supports only `llm` and `tavily`), no
research observation/analysis pipeline and no cockpit frontier viewer, no full escalating kill
switch (pause, cooperative stop and the delegated reaper exist), no C3 coherence result.
Operational projections exist; raw frontier and world/git data are not a research reading.

**Boundary.** A documentation-only handoff does not authorize source implementation, an
experiment launch or an API call; the existing commit/push gate rules are unchanged. Shell and
Run egress is currently open; Landlock confines filesystem content, not network. The agent
environment must not carry real secrets. A zero-context session starts with
[docs/resuming.md](docs/resuming.md); status lives only in this file.

## Current state

**Implemented and tested.** The C1.1–C1.4 lots: journal module, node driver, context and provider boundary, web tools, persistent terminal, Landlock confinement, frontier journal and its per-call attribution sidecar, the multi-node host (`--nodes-file`: several drivers on one home sharing the world and the frontier), the wake physics (fresh host starts compose the modern `policy.wake` with the start-only `--heartbeat-seconds` and a `wait` surface of `{}`/`{until}`/`{after_seconds}`; a relative wait is anchored at the actual park, cadence is a per-uid wall-clock grid, and explicit timers/cadence carry no count or cost quota — legacy cells keep their exact `wakeBudgetPerHour` counter with no migration; a modern ordinal-0 request carries the bounded opening receipt), the kernel spawn capability (`extend {verb:"spawn"}`: declared grants, a flat roster, the composer sentence, the 16-node ceiling and monotonic race-free uid minting), the model manifest (`providers.json`'s `llm.models` — both the ids-only form and the object form declaring each model's context window, projected into every request as ids and validated at start, spawn and `update_self`, with a fresh start on a windowless entry refused), the token trigger (the wire's own chars/4 price, the eighty-percent threshold `floor(min(0.80·W, W − O − headroom))` with our `[16,000, 64,000]` headroom clamp, the effective percent published operator-side, the one forced compaction and re-price per request, the typed uncompactable escape, and the adapter's typed context-window refusal answered by one forced maximal reduction and one resend), the meter's accounting (the provider's usage and its anchor sample journaled on the assistant record; the decision numbers on `compaction/start`), the authored survival (`extend {verb:"remember"}` under the start-only `--memory-remember` gate: a gated cell's node writes the pending, bounded text that replaces the fixed notice at its next compaction when the strict-smaller rule admits it — the pending slot runtime-only; one compaction of reprieve, the typed outcome journaled, the factory arm staying notice-only), the self rewrite (`extend {verb:"update_self"}`: a node's own heading, charter and model, journaled as its identity history and admitted under the derived identity budget), the node's own clean end (`extend {verb:"request_death"}`, granted unless it is the last live node), the conversation interface (`extend {verb:"send_message", to?, text}` / `extend {verb:"get_messages", n?}`: the kernel-owned `conversation.v0.jsonl` stream, per-participant threads, the kernel-stamped record, the pending-notice wake under `trigger: 'conversation'`, and `gateway` reserved as its addressee), the node's own history (`extend {verb:"history", n?}`: a per-node read of its own timeline — the last n entries oldest-first, default 16, at most 64, stateless and self-bounded — its identity versions as facts (charter bytes + digest, never the past text), its turns with the paths their commits changed, its perceptions of the world's patches verbatim as it saw them, its lifecycle and compaction markers, and its pinned directions; never another node's record, no metric, and a read is journaled as an ordinary tool result that never appears in the next read), and the world-ratified direction pin (`DIRECTION.md` at the latest human-authored commit, moved by the human's `direct --path` ratification). The host layer: the seven-command CLI (`init`, `start`, `resume`, `pause`, `status`, the interactive `chat` session and the human's `direct` write acts — the batch chat reply and the world ratification), the first-light smoke (scenarios A–E), the live wrapper. The live path is verified against a real model: boot, live-model turns with tool calls, park, wake on a foreign commit, reply in the world, graceful stop — every frontier exchange journaled, zero errors. **The gateway overlay (agent zero) is implemented and tested.** A host-side, single-tenant digest service — never a node: no pool membership, cell, cgroup leaf, scratch, local log, sandbox, world grant or turn. Its config home (`<home>/gateway.charter.md` + `<home>/gateway.json`, written atomically 0600 at start from `--gateway-charter`/`--gateway-model`, the model validated against the catalog and defaulting to its first entry) governs one event-driven cycle per coalesced arrival on either surface (a gateway-addressed conversation record, or a `uid: human` chat record — both filtered, so the overlay's own sends and deliveries never re-trigger), serialized behind one dirty flag and bounded by `OVERLAY_CYCLE_STEPS`. The cycle assembles the charter, the fixed data-not-instructions framing line and the two bounded windows, dispatches the overlay's three tools (`send_message` through the kernel-owned stream; `read_world`/`world_log` as bounded, framed, kernel-mediated reads of the committed world), and, on a successful cycle, delivers exactly one chat record natively — its final prose, or the kernel's bounded no-reply notice. A start without `--gateway-charter` runs a nodes-only host; `status` reports `overlay: configured (<model>)` or `overlay: none`; the overlay's frontier exchanges are ordinary events attributed to the reserved `gateway` actor.

C1.5 `extend` (the Package layer) is also implemented and tested: the twelve-verb tool, the confined Run supervisor, the persistent content-addressed store, the frozen five-tool offering with the funnel, the boot scan and the host-stop disposal — the C2 criterion path (install → persist → survive restart → clean unload) rehearsed in the Vitest acceptance spine and proven compiled in the scenario F packages smoke. The C1.5 friction pass is implemented on top of it, from the first live run's evidence: Packages addressable by name (`run` and `undefine` take name or id, a name resolving to the newest stored version under it; `stop` addresses the live Run by its package's name or id), a native call to a live-registered tool bridged to the funnel (the offering stays frozen), the source contract taught in the tool description, the honest no-provider web denial, and the shell's `openssl.cnf` grant; the scenario F smoke exercises the name path, the version skew and the bridge compiled-side. The friction pass 2 is implemented on top of the audit wave's findings: the Hole facts shipped in the charter (plus the operator `--charter-file`), the node identity composed into every freshly composed charter, the shell and wait contracts taught (the real read/write set with the mode qualifier, the external git, the full wait contract), the Package contract taught (the svc facade with its resolve/reject channels, the Run's file reach and lifetime, the define/run split), the wake perception budgeted newest-first under the byte cap with the dropped count and the oldest omitted commit named (renderer policy v2; v1 journals replay unchanged), the refusals that teach (a detail per nameable rule, the frozen codes intact, the documented bare exceptions) and the bare stop for the singleton Run. The live phase is checkpointed: the friction acceptance run measured the pass (52 model requests where the founding run spent 97, every remaining error a teaching refusal corrected in one call); the founder panel — ten isolated first nodes under one mission prompt — demanded the same two kernel primitives by unanimity (a timer; a kernel-written events log) while inventing mail, claims, ADRs, trust classes and the data-is-not-instruction clause before peers existed; the events-log ask is answered PER NODE by `history` — each node's own record, at the perception's recorded bounds, with the panel's events+author+paths in per-node form — while the world's whole history stays unreadable to nodes and the global history remains the society's to build (or the researcher's projection over the two raw truths), never a kernel record; and the duo session verified the two-node time-sharing mechanics (per-uid config gate, wake on the other's commits, one shared frontier) while its machine incident demonstrated the isolation findings empirically — one well-intentioned node's unbounded test activity survived its own kernel and OOM'd the host — making the isolation wave the blocking one before any further live runs. The sessions are recorded in [first-light.md](docs/first-light.md); the research harvest is in [founder-panel.md](docs/research/founder-panel.md). **The isolation wave's survival core is implemented and tested.** A per-cell cgroup tree (the kernel in `svc/`, one leaf per shell and Run), freeze/kill, and a delegated launch that reaps the cell and bounds its leaves. A commit-path failure is a typed refusal the kernel survives — the walk's raw errno, a git exit/spawn/timeout, an output cap, a detached HEAD — rendered as one bounded line, projected to `status` through a durable degraded sidecar that only a real commit clears, with a bounded self-retry. The commit's critical section runs with the cell's shell and Run leaves frozen (a host-built fence port, thawed in `finally`, a stop never aborting the commit), and a boot without a fence is a durable operator-visible fact. Git children carry per-subcommand deadlines, the mutating ones run under a world flock with a lock derived from the call (a timed-out stager's own index/ref locks removed by inode, under the flock), the commit path bounds its walk and its turn's staged delta, and a boot world doctor validates the index structurally, reports dirty and unreadable paths, and quarantines the bounded untracked-unstageable set. A storage circuit breaker now refuses an effect before a full disk can lose the journal's record: the journal writer, the frontier gate and the turn start each check an injected free-space/inode probe (2 GiB + 512 MiB reserve, 100,000 + 10,000 inodes), the boot proceeds degraded rather than refusing, a missing quota is the visible `unquoted` fact, and the agent keeps first-line repair for its own files. The survival core of the isolation wave is complete; its remaining items (network policy and per-node resource containment — not API spending quotas) remain open — the ordered proposal is in Proposed next lots — the kernel events log is delivered per node by `history`, not as a kernel-level global record. **Specified, not implemented.** The `history` messages kind (the erased texts, gated); agent zero's remaining capabilities (the versioned proposal — heading, proxy and letter — and raw-frontier reading), the rich versioned direction letter (including the ratification event beyond the pin), the chat co-negotiation's measurement, the disposable SQLite index and projections, the daemon and cockpit; C1.7 the escalating kill switch. The full placeholder↔endpoint credential broker remains a documented target.

**B1 execution marker (shared-VM preparatory brick).** Fresh homes record an immutable
`<home>/.es/execution.json` `landlock` backend before the world pair; an existing markerless
both-valid home is left unchanged (the exclusive `.es/init.lock` metadata is the only effect),
and `init` serializes its whole classification and completion on that lock. `start`/`resume`
read the marker after the home permission
checks and before opening the world, the frontier, the chat log, the owner record, the config
fold or any runtime: a `vm-qemu` marker is recognized and refused as unavailable, and a
marker-less home carrying actual VM evidence (a `.es/vm-network.json` record in any form, a
non-pristine `vm` entry, or a journaled VM offering) is refused rather than run as host
Landlock. A valid marker with a missing or one-sided world pair is an uncertain partial and is
never rebuilt. A fresh-root `lost+found` counts as pristine only when it is the real root:root
0700 directory and is itself proven empty; a non-empty or unreadable one is damaged/evidence,
never adopted. A valid `vm-qemu` marker re-init compares the requested image path with the
immutable pin before any completion and, when an inspector is supplied, re-pins the bytes and
refuses a changed identity without rewriting the marker; it also refuses a post-init
`lost+found` at either volume root. A non-regular marker or network record (symlink, FIFO,
directory) is refused typed without being opened, and an unreadable evidence scan refuses
instead of falling back to Landlock. The strict VM network-record parser, the image pin and
the VM volume/fresh-root checks exist behind internal seams only; no VM process, image,
volume, mount or network setup and no `--execution`/`--vm-image` CLI flag exists. B1's ordered
nine-check run is green under Node 24 (138 test files / 2,443 tests, no skips; typecheck,
build, first-light A–E, packages F and the refusal, fence, reap and wake-policy smokes); that
is development evidence for B1, not a checkpoint. B2 is split: B2a (the host path pin — operator
reads, ratification materialization, doctor IO) is implemented and validated: four fresh
independent audits returned READY and its ordered nine-check run is green under Node 24 (140 test
files / 2,477 tests, no skips; typecheck, build, first-light A–E, packages F and the refusal,
fence, reap and wake-policy smokes). That is development evidence for B2a, not a checkpoint. B2b
(the one commit lease) remains design-not-ready. B3+ remain hard-gated on a real B0c KVM proof.

## Validation checkpoint

The current validation record is the validated runtime code `50290c5` with the nine Node 24
gates green (148 files / 2,510 tests, 0 skips; 4 mutants killed; counter audit accepted). This
is the validation record for that code, not a new gate run by a later session.

**Engine/provider-only campaign acceptance.** Three sequential worlds (w01–w03) each exhausted a
fresh shared 5,000,000 provider-reported node input+output budget with exact accounting. The
three worlds used 15,144,540 provider-reported node tokens (144,540 over the three shared caps).
Gateway usage is 497,160 / 510,719 / 229,486, total 1,237,365, known separately and not a money
ceiling. All three had zero frontier-recorded provider HTTP/network/timeout errors, zero
retries, and zero engine faults. Across the worlds: 5/3/3 nodes, 3/2/2 spawns, 17/14/14 commits;
all spawned models were `deepseek-flash`. Post-cap gateway work created no new node calls; world
services stopped and owners released; four historical empty transient slices remain active with
0 tasks and 0 active child units; the runs slot is empty. Teardown used 0 backstop stops. The
literal actor-command-clean streak is 0/3: 17/5/3 unintended non-cap actor/tool errors are
retained, and the old actor-strict result is preserved as false. Under the Lead's clarified
criterion, the acceptance is met; this is not a claim of universal task quality, security, or
production readiness. Paid worlds stopped at 3/10; no w04.

**Remaining risks.** All three missions are partial. w01's mission was partial at cap (12 valid
digests; MANIFEST/CONFLICTS/STRESS/INJECT missing) and its external verifier failed on those
missing artifacts. w02's operator-executed confined independent canonical check was 15/15 PASS;
much hardening is not fully proven. w03's mission was partial (EVIDENCE/HARDENING missing; no
live external probe; only post-stop PID/port-gone). The earlier usage gap was a reader artifact,
not engine drift: exact reconciliation uses `JournalReader` with `resolveBlobs` and the full
source-known event union. The 120 s source default is intentional headroom; the largest observed
response was 36.075 s (operator measurement), one bounded sample, not a provider SLA. The initial
Bug Bounty stop was two 30 s provider timeouts, not a Run leak. No engine source fix is
demonstrated by the actor/tool errors. The cockpit 300 s heartbeat is compiled in source; an
existing cockpit process must be restarted and the operator must confirm that restart before any
live-deployment claim. Source presence alone is not a deployment claim.

## Proposed next lots (proposal only)

Not a Lead-approved implementation plan; each lot needs its own design, audits and acceptance
before code. The order is a proposal.

1. **Credential broker v0 and the first real connector.** Keep nonsecret config, secrets and
   capabilities distinct. The node environment carries endpoint-bound placeholders, never a
   real secret; the broker injects the credential only for the bound endpoint; each mediated
   exchange is journaled without credential values; rights are attenuated per node.
   *Acceptance:* a real connector completes through the broker; an endpoint mismatch is
   refused and recorded without leaking secret, placeholder or variable name; the kernel never
   interpolates a credential value into a recorded field, and a controlled non-reflecting test
   scans the environment, argv, logs, world and journal for leaks. A hostile provider can still
   reflect a credential into a journaled response body — that accepted residual is not silently
   promised solved, and no absolute no-leak property is claimed. The design choices below are
   settled in a written spec. Shell and Run egress is currently open; the broker alone does not
   make all external traffic mediated or journaled. Direct-egress policy remains an open design
   choice below.
2. **Bounded escalating kill switch.** First signal: graceful disposal of the tree with the
   5-second backstop; re-signal: immediate exit. *Acceptance:* both behaviors demonstrated on
   a running cell, the existing pause/cooperative stop and delegated reaper unchanged, no
   spending quota introduced, and a compiled smoke. Until then, pause is not the switch.
3. **Minimal read-only observation of the frontier and world/git, with provenance.**
   *Acceptance:* the first projection is derived from the two raw truths, carries provenance
   and an EXTRACTED/INFERRED tag on every reading, can be rebuilt, writes nothing to the world
   and wakes no node. Advanced graphs, embeddings and sensors stay deferred. Raw logs exist;
   the pipeline does not — neither "no monitoring data" nor "the pipeline is built" is true.
4. **Operator cockpit.** Launch, pause, resume, roster, accesses, chat, ratification, traces
   and export. *Acceptance:* every write act maps to an existing kernel act and adds no new
   authority; the cockpit shows no secret; traces and export remain projections with
   watermarks; a compiled or manual acceptance demonstrates the acts. No cockpit exists today.
5. **Real model and the first controlled experiment with restart.** *Acceptance:* a real
   endpoint (local RTX3090 and/or sponsored credits) runs a controlled restart; both raw
   truths record the session; the report states what was observed, with provenance and limits.
   No price/cost admission quota is reintroduced; the optional operator node response-token stop
   is operational, gateway-uncapped and not a money ceiling. Legacy cells keep their old policy
   with no migration. C1/C3 are claimed only if their criteria are demonstrated.

## Checkpoints

A checkpoint is reached when its criterion is demonstrated on a running system, not when its parts are coded.

- **C1 — minimal kernel + agent zero + chat + a readable projection of the frontier journal.** *Criterion: we can see everything the agent does, and we can talk to it.* The interface is the one deliberate pre-wired artifact — a Lead product decision whose genesis finding is forfeited by design ([seed.md](docs/seed.md) §1); its adoption, traffic and recap are what it measures. Current status: the kernel, gateway overlay and chat exist; the readable projection of the frontier journal is not delivered — raw logs are not a projection. C1 is not closed by the mechanics.
- **C2 — agent zero hot-extends the system on its own initiative.** *Criterion: reversibility demonstrated — clean unload.* The label is historical checkpoint vocabulary: the implemented gateway overlay is not a node and holds no `extend`; the Package-layer evidence is node-side. Treat the actor/wording as design debt (Open decisions), never as a current gateway capability.
- **C3 — `spawn` + direction.** *Criterion: at comparable budget per unit of time, the organization maintains a coherent trajectory where a solo agent drifts or collapses.* No coherence result exists: the spawn and direction mechanics are implemented; the criterion has not been demonstrated.

## Open decisions

- **Node 26 upgrade.** Node 24 is in its maintenance-LTS phase and the runtime floor is `>=24 <25`; decide when to move to Node 26.
- **Broker v0 surface.** TLS/transport, supported clients, methods/path rights, response
  reflection handling, direct egress, storage schema and migration, and revocation are
  unresolved. Do not invent a settled API from the target prose in [docs/kernel.md](docs/kernel.md);
  design and acceptance must settle them.
- **C2 checkpoint actor.** The historical label says "agent zero hot-extends the system on its
  own initiative", but the implemented gateway overlay is not a node and holds no `extend`; the
  demonstrated evidence is the node-side Package layer. Treat the wording/actor as design debt,
  not a current capability.
- **Cockpit form and authority.** The local V0 cockpit exists and must not become a new
  authority; remote/multi-user access, export format and additional write authority remain
  unresolved and proposed.

## Next safe action

A new session starts at [docs/resuming.md](docs/resuming.md), confirms the current HEAD and the
required gates, and does not start source work from a status document. Await the Lead-defined
next scope; run the cross-brick nine sequential gates before any next push. VM/B2b work remains
paused. The existing GUI/cockpit restart remains an operator step before any live-deployment
claim; no live-fixed claim is made.

## Framing rules

- No code before the design is validated.
- No organizational structure is coded; no metric is GIVEN to the agents (the node's own derivations from its records are its behavior, measured like any other); fidelity is measured on acts, never self-reports.
- The frontier journal is the only truth; replay is not re-execution.
- Hard physics: the kill switch, the frontier journal and its gate, the mutation gate, the confinement boundary, the storage circuit breaker and the per-child deadlines. Spending is deployment policy (an optional upstream key limit), not a kernel-installed quota or a prerequisite: a local GPU or sponsored credits is a supported deployment. The optional start-only operator node response-token stop is an operational node cap, not a price or spending ceiling; the gateway is uncapped.
- Git history is the project's chronicle.
