# Kernel — technical design

This document specifies the kernel of the system: the behavior of its nodes, its stack, its journal, its context assembler, its driver, its sandbox and the hard physics it enforces. It defines the technical scope of checkpoint C1 in `ROADMAP.md` and links to `vision.md`, `seed.md` and `direction.md` for the concepts it builds on.

---

## Derivation — from research constraints to mechanisms

Every mechanism in this document exists to satisfy a research constraint stated in `vision.md` or `seed.md`. The rejected alternative is recorded because it is the choice a conventional engineering reading would make.

| Research constraint | Mechanism (section) | Rejected alternative |
|---|---|---|
| Provable provenance: every claim about the society must be checkable against a tamper-evident record | Append-only, hash-chained journal (§3) | Mutable database: an update rewrites history without trace |
| Facts must outlive their interpretation: the analysis will be revised as the research progresses | Raw event content; interpretation lives in disposable projections (§3) | Interpreted events: meaning frozen at write time cannot be revised without losing the facts |
| Metrics must stay invisible to the agents (anti-Goodhart, `vision.md` §3) | Only the kernel emits events, at boundaries the agents cannot avoid (§3) | Agent-side or in-tool instrumentation: rewritable by the observed |
| Observation must not perturb the observed system | Cockpit and sensors are read-side projections, outside the loop (§11) | Tracing-style instrumentation of agent code: sampling, expiry, and mutation of the measured system |
| Replay must be exact, because metrology depends on it | Byte-pinned assembler; replay serves recorded responses, never re-executes (§3, §4) | Reconstructed approximately-equal contexts: silent drift, unverifiable comparisons |
| Every effect an agent produces must be observable | A mutation gate in front of every model call and every tool effect (§1.6, §9) | Open shell or network paths: unlogged effects make claims unprovable |
| A perpetual system must survive interruption without losing a turn | Durability before effect (flush barrier), reader-side repair, synthetic closers (§3) | Truncate-on-crash: an interrupted turn becomes deniable |
| Direction changes must propagate without interrupting the society | Verbatim pinned heading in every context; the propagation delay is the measurement (§1.3-1.4, §4) | Forced interruption: destroys the relaxation signal it claims to enforce |

---

## 1. Behavior

1. **Async, event-native, non-blocking.** Everything is an event: human message, shell completion, LLM response, timer, Package activation, heading ratification. There is **no "waiting for the human" state** — raising a problem = emitting an event, life goes on; the human response, when it arrives, is an event absorbed along the way. (Documented counter-model: dsh's `ask_user_question` / `ctx.approval` path **blocks** a turn on the human — forbidden here.)
2. **Free loop per node + explicit wait, unbounded.** Each node chains its turns on its own initiative; it may choose to wait (suspended until the next event in its inbox). There is **no wake budget**: a perpetual loop equipped with tools is self-excitable without bound, and that is accepted — the only physical bounds are the upstream API ceiling (§8) and the kill switch. A node stuck in an obsessive loop is not a fault to prevent mechanically but a phenomenon to observe; the work/wait choice is observable in the journal. (Documented counter-model: dsh's `maxConsecutiveWakes` — rejected, in the design direction of the whole project: full freedom, observation over prevention.)
3. **Re-alignment without interruption.** A ratified heading propagates to the next turn of each node, via pinning. The propagation delay **is** the relaxation measure — any forced interruption would destroy it.
4. **Heading propagation in two layers.** The kernel injects the **reference** (verbatim heading + proxy, current version) into *every* context, without intermediary — inherited drift prevented, single point of drift eliminated, drift locally detectable. The **flow-down of meaning** (local translation, priorities) goes through the charters and delegation — emergent, observable. The cascade carries the interpretation, never the reference.
5. **Agent zero is the root custody node, subject to the same physics** (same loop, same inbox, same compaction, same journal). Its equipment is data: human channel, drafting of heading proposals, **reading of the raw journal and of projections**, **right to question nodes** (see `direction.md` §1: raw facts yes, metrics no; readings and questions journaled; never the human's only window). A single category of entity in the whole system.
6. **Physical / behavioral frontier.** The kernel is the *physics* of the world — immutable and invisible to the agents: journal + hash-chain, the mutation gate (journaling before every model call and every tool effect), kill switch, Landlock sandbox, upstream budget ceiling. Everything that makes a node's *phenotype* — its loop policy, context policy, compaction policy, tools, instincts — is mounted at boot as **behavior Packages**, introspectable and redefinable through `extend` (§6). The organism can rewrite what it is; it cannot rewrite the laws of its universe: every model call and every effect still crosses the gate, so the very act of self-rewriting stays journaled. An organism that could rewrite the measurement apparatus would destroy the observability the project exists for.

## 2. Stack

**TypeScript / Node 24 LTS + `cordis@4.0.0-rc.10` as a pinned library (exact version, no `^`).**

Three reasons, in order of weight:

1. **The entire reference corpus is in TS** (paper, Cordis, dsh): the implementation reads its references in the source language, with no translation layer.
2. **94% of compilation errors in LLM-generated code are type errors** (arXiv:2504.09246) — our invariants (event discriminated union extensible by merge, capability attenuation, `effect → disposer` gate, node state machine) are precisely what a type system makes mechanically unavoidable. In Python they would live in docstrings.
3. **The only operational precedent for transactional hot-reload is in TS**; in Python, `importlib.reload` is documented as unreliable and `jurigged` has disqualifying caveats for a perpetual system.

**Cordis usage rules:**
- **Core only.** Do not install `@cordisjs/plugin-loader` nor the HMR: all the verified instability lives there (Node ESM internals, native addon, documented deadlock). Our Plugin → Packages → Runs model maps onto `ctx.plugin()` + `fiber.dispose()` + `ctx.isolate()`, not the YAML loader.
- **The gate is wrapped**: the kernel exposes `node.effect(fn)` which checks capability + attenuation + journals, then delegates to `ctx.fiber.effect`. `ctx.intercept(name, config)` serves capability attenuation of service capabilities (ancestor→descendant merge).
- **The gate is not watertight from the inside** (the paper §6.3 says so: sandboxing untrusted code requires an *external* sandbox) → Packages written by agents run in `node:vm` with a **restricted `ctx` facade** (method allowlist, no `ctx.provide`), a pattern proven by dsh (`guard.ts`).
- **Known trap to test explicitly**: fiber unloading is *parallel* between sibling effects (LIFO guaranteed only *within* a `ctx.effect`) — upstream issue #26 / PR #144 open. If our reversibility depends on the order between sibling effects, we serialize ourselves.
- **Swallowed dispose errors** (logged, not propagated) → the kernel must capture these logs into the journal, otherwise cleanup failures are invisible.
- **Budgeted escape hatch**: spike reimplementing the useful subset (~700 lines: LIFO effect, stateful fiber, inject, isolate/intercept, emit+waterfall) — ready *before* we need it, since the API is an unstable RC.

Documented fallback (if TS becomes untenable): Python 3.14 + anyio, strict typing from the first line, hot-reload = clean shutdown + Package remount (never `importlib.reload`).

## 3. The journal (single truth)

Three rules decide what the journal contains and who writes it:

1. **An event type exists iff it records a fact that is not reconstructible from the rest of the journal.** What can be re-derived — intermediate computation inside a Package, recomputable state — is not an event. What cannot — the exact bytes of a model request and its response, the moment a message was delivered and when it woke its recipient, a crash boundary — is. **An event type also exists when it records a decision of a replaceable policy**: the batching policy that decides which messages a turn takes is phenotype, a Package may redefine it, and the journaled claim is what lets the decision outlive the policy that made it. Content is always raw; interpretation is always projection.
2. **Only the kernel emits.** Events are produced by the kernel and the driver at the boundaries an agent cannot avoid crossing: model calls, tool effects, message transport, lifecycle transitions. The agent has no write access to the recording apparatus. Thinking is calling the model, and calling the model crosses the gate, so deliberation is recorded regardless of whatever channels the agents build for themselves: their own protocols may become semantically opaque, their reasoning cannot.
3. **No unlogged effect channel exists.** Any path through which an agent can produce an effect crosses the mutation gate and is journaled. A capability that cannot be journaled is not a restricted capability — it is not provided at all.

**Storage schema** — one readable canonical log, everything else is a disposable index:

```
cell-home/
├── nodes/<node-uid>/
│   ├── journal.v0.jsonl.zstd        # CANONICAL — append-only, immutable
│   ├── journal.v0.head              # chain checkpoint {first_hash, last_hash, count, ts}
│   └── snapshots/<seq>.json         # projection checkpoints (disposable)
├── blobs/<2 hex>/<sha256>           # claim-check content-addressed
└── index.sqlite                     # DISPOSABLE INDEX (rebuildable: `cell reindex`)
```

**Event envelope (frozen before the first write):**

```jsonc
{
  "v": 0,                 // format version — reserved from the 1st write
  "type": "tool/result", // discriminated union, extensible by merge (never assertNever)
  "seq": 1042,            // contiguous, = log.length at append — INVARIANT
  "time": 1789000000123,  // epoch ms UTC
  "prev_hash": "a3f2…",   // 64 zeros for genesis
  "hash": "7bc1…",        // SHA-256(prev_hash || RFC8785(v, type, seq, time, ignorable, data))
  "ignorable": false,     // absent = required: a reader that does not know the type REFUSES to rebuild
  "data": { /* inline payload, or claim-check refs */ }
}
```

Rules:

- **Strict append-only**, made *enforced* by the hash-chain (per node, not global — a global chain would serialize all writers). Canonicalization **RFC 8785 (JCS)**, frozen before the first event.
- **File physics**: concatenation of independent checksummed zstd frames (one per durable batch) — header-only listing, torn-tail repair at a batch boundary, append cost independent of size. (dsh-session pattern.)
- **Claim-check** beyond a **format constant** threshold (~8-16 KB): content-addressed blob, reference in `data`; truncation of giant payloads marked `truncated: true` + original size — never silent.
- **Bounded write-behind**: fixed ~200 ms window triggered by the first event of a burst (no debounce), one `write`+`fsync` per batch. **Explicit flush barrier before each model request and each top-level tool effect** — otherwise a crash can produce an external effect that is not journaled (violation of "model-visible means logged"). The hot path never blocks on I/O. **The message path and the turn barrier are the deliberate exception**: a delivery, a send and the claim that opens a turn flush per event rather than waiting out the window — a `sent` whose `received` was lost to write-behind would be an effect without a trace — while the 200 ms window covers the remaining event flow (`turn/end`, `node/shutdown`).
- **A single writer per journal** (ownership handle; a second open for writing is rejected — `SessionAlreadyOwnedError` semantics).
- **Crash repair = the reader's job**: we never truncate an interrupted turn (its events are durable); resume appends the synthetic closers as an ordinary batch; only a physically torn fragment is discarded.
- **Disposable incremental projections**: watermark `readFrom(fromSeq)`, versioned checkpoints `{ver, seq, val}` (`ver` mismatch → row discarded), idempotence by key `(stream, seq)`. **Never any compaction of the canonical log**; "closing the books" rollover per node if a journal exceeds a hard threshold.
- **Disposable SQLite index**: WAL, `synchronous=NORMAL`, a single writer, `busy_timeout`, `user_version` refused if stale (no implicit migration). `PRIMARY KEY (node_uid, seq)` as a contiguity safety net.
- **Replay ≠ re-execution** (named contract): a replay makes **no** model call and no tool call — the recorded responses are served from the log; effects beyond the boundary are never replayed. Since the journal is wired to LLM calls, **deterministic replay is structurally free** — this is what makes metrology economically possible. Clock virtualized from the start (time reads go through the kernel, not through direct `Date.now()`) — much harder to retrofit.

**Sizing** (measured orders of magnitude): 1 M events ≈ 60-250 MB zstd; fold ~3.6 M ev/s; chain verification ~100k ev/s; batching is not an optimization but the condition of viability (fsync bounds at ~10²-10³ writes/s without group commit). The breaking point is not storage but the cost of a full replay toward ~10 M events — hence projection snapshots from the start.

## 4. The context assembler and pinning

**Three layers, a single network gate**:

1. **The assembler (pure, inside the kernel)** produces a request plan (ordered sections, tools, parameters, semantic cache boundaries `stable|advance|volatile`) and appends a `request/plan` event. "Every request is a pure function of the log" — tested at boot by replay-comparison (dsh's executable invariant, 65 lines, is the testable form of "model-visible means logged").
2. **The provider adapter** (the only network path) translates the plan into wire (canonical key order, markers), logs `request/wire` before sending + `request/usage` after (normalization of the 3 dialects: Anthropic `cache_read/creation_input_tokens`, OpenAI-compat `prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit/miss_tokens`). A cancelled call still logs its attempt (`assistant/attempt` pattern).
3. **Custom transport** (forensic safety net, activatable) — captures the raw wire. Never an external proxy in the path (it alters the body: documented LiteLLM bugs).

**Prefix layout (cache-aware, byte-stable):**

```
[0] tools        — frozen, fixed order, canonical JSON ─────┐
[1] system §0    — node charter (role, instincts, machine) │ inter-turn prefix
[2] system §1    — pinned heading verbatim + proxy, versioned │ ← breakpoint A
────────────────────────────────────────────────────────────┘
[messages] append-only surface (history, never rewritten)   ← breakpoint B
[queue]    runtime context + trigger message                ← NEVER before B
```

- **Absolute byte-stability of the prefix**: no timestamp, session id, counter, dated number in blocks 0-2 (cause #1 of caches written-never-read). A heading change invalidates the cache **once** — and the `cache_creation` spike becomes a free observable of the version change.
- **Identical tool offering for all working nodes.** `tools` is hashed first: varying the offering per node would destroy any cache sharing between nodes. Capability attenuation applies **to the mutation gate (at execution time), not to the offering** — and capability creep (rights requested vs granted) becomes a free observable. The trade-off, which is real, is resolved in favor of the cache and of measurement. Agent zero is the only assumed exception: its equipment (human channel, heading drafting) differs by function — a single node, hence no loss of sharing among peers.
- **Pinning is a kernel matter, not a provider one**: compaction operates on a *range of surface positions* that excludes node 0. Mechanism taken from dsh: `SurfaceOp = 'append' | {op:'replace', positions}`, `sourceEventSeqs` mandatory and verified, and the double protection of node 0 (a replace covering node 0 must be a `system/message` on exactly that node; compaction selection starts at index 1). **It is the same mechanism that provides both compaction AND pinning.**
- **Compaction: dsh's protocol, our own naive policy.** Protocol taken from dsh: `compaction/start|summary|end` (durable lock markers, released last), span stability re-checked after the await, tool/result pair balance at the boundaries, the replacement must be smaller than the shadow. Our own policy: naive (truncation + notice), visible (journal events), rare — the cost of re-prefill is journaled (it is the Hole's instrument). The log stays intact: the human transcript reads the original appends, the model sees the surface.

## 5. The node driver

Rewriting of the dsh loop (`agent.ts`, 619 lines → ~390 lines):

- **Single primitive** `send(message, target, wakeup)`; everything enters through the same inbox (human chat via agent zero, results, timers, completions).
- **Atomic claim** of the inbox into a durable projection — `inbox/claim` records the batching decision, which messages the turn took — plus an in-memory **wake latch**, armed by the transport and consumed by the loop. At resume the parked state is reconstructed, never replayed: the last `turn/end` outcome together with the inbox (the unclaimed remainder, or the mail an interrupted or errored turn gives back) says whether there is anything to wake for. `wakeupRequested` on `message/received` is the journaled *coalescence observation* — which delivery armed the latch — not replay state. `onMaintenance` runs background work outside turns.
- **A failed route is a journaled fact, not a death**: the sender's `sent` is durable before the transport is asked, so an unroutable message leaves `message/undeliverable` beside it and the turn goes on. Mail claimed by an interrupted or errored turn is re-presented at resume — the release is reconstructed from the claim and the outcome, so it needs no event of its own.
- **Non-blocking question/answer**: a question = emitted event + answer event that arrives later in the inbox; the node finishes its turn and wakes on the answer. Never an await on the human (§1.1).
- No `turn/step` vocabulary from a coding-harness: markers specific to the perpetual node ("waiting" / "active").
- **Frozen** (deep freeze) request before sending; complete envelope logged before the call.

## 6. Self-extension (`extend`)

- **Model**: Plugin → **immutable Packages** → Runs (taken from dsh: minted IDs never reused, `define` adds a Package, `run` activates an exact version, `stop` removes the Run, `undefine` deletes).
- **The behavior layer is made of Packages** (§1.6): the loop, context and compaction policies ship as seed Packages, so `extend` can redefine the node's own functioning — the gate and the journal stay in the kernel, below the reachable floor.
- **dsh's gap is filled for free**: `define` (name + code + purpose), `run`, `stop` and `undefine` are all **journal events** → the registry and each Package are rebuilt by replay at boot; only the live Run stays in memory. Package persistence = ~0 extra lines, since the journal exists. A destruction keeps its history: `undefine` removes the Package from the current registry, never from the journal or the blob store — which is what makes self-reorganization (turnover) measurable.
- **Package execution**: `node:vm` + restricted `ctx` facade (allowlist, no `ctx.provide`) — the mutation gate remains non-bypassable (§2). Assumed posture: containment, not a security boundary ("treat a dynamic package like bash access").
- **Composition traps documented by dsh, not to be rediscovered**: superseded generation never reclaimed (watcher leak); health audit ≠ importability; a change of tooling mid-conversation that orphans calls.

## 7. Sandbox, shell, workspace versioning

Verified empirically on the target machine (Ubuntu 24.04, kernel 7.0): **bubblewrap is broken by default** (AppArmor blocks userns — reproduced); **Landlock ABI 8 works immediately, without root** (ruleset tested: write refused in `/etc` and `~`, allowed in `/tmp`).

- **Containment: Landlock**, via a small launcher (~100 lines of C, modeled on the kernel's `samples/landlock/sandboxer.c`, industrialized by dsh as `landlock-run`) that self-restricts **before** `execve("/bin/bash")` — never an intermediate bash script (its interpreter runs before confinement). Landlock is conceptually our semantics: irreversible, inherited, can never widen = attenuation at the gate. **Precious corollary: the API key is physically unreadable from the agent's shell** — the upstream budget ceiling (`seed.md` §5.3) becomes a physical property, not an instruction.
- **Sandbox rules**: ABI probe at startup, **fail-closed** (never a silent unconfined passthrough), `enforcement: full|partial` field reported honestly, denials classified by dialect (EACCES under Landlock) with a conjunction of exit code + signature (never a shared stderr prefix — dsh postmortem 0004), and stderr remains a channel forgeable by the child.
- **Persistent PTY**: `node-pty` in-process, one per node; encapsulation by nonce markers **on a single physical line**; explicit typed statuses (`stdin_read` | `inferred_idle` | `timeout` | `session_exit` — a timeout never implies death); serialization per node (a single active send); bounded scrollback, never persisted. **The PTY does not survive a kernel restart** (the master's death kills the session — verified): assumed and consistent with the project's philosophy (shell state is ephemeral; what matters is externalized — Keep instinct, the Hole). Isolated behind a narrow `TerminalRuntime` interface (~6 methods) — replaceable without touching the kernel.
- **Workspace self-versioning**: git commit **driven by the kernel on return from each `execute`** (the mutation gate knows when a command ends — eliminates the whole class of watcher bugs); ~29-100 ms measured. Three mandatory safeguards (documented incidents): **refuse a workspace = `$HOME` or a broad root** (Codex incident: 200 GB); **`.git` masked read-only in the sandbox** (otherwise the agent can erase the trace of its own mutations); periodic gc. The workspace git repo is **distinct** from the project repo — the project's chronicle does not depend on the agent's workspace. `core.untrackedCache=true`, no FSMonitor (unavailable on Linux).

## 8. Kill switch and budget

- **Kill switch**: bounded, escalating shutdown (dsh's `process-shutdown.ts` pattern) — first signal → graceful disposal of the tree + **5 s backstop**; re-signal → immediate `process.exit`. The timeout is a **safety invariant, not a tunable**. (The documented original bug: a pending disposer + a boolean latch = unkillable process.)
- **Budget**: hard limit on the API key upstream (`seed.md` §5.3) — invisible to agents; the cost is journaled on the human side (`request/usage` per call, §4). Explicit `unhandledRejection` handler: journal and decide, never Node's default crash.

## 9. Hard physics — exhaustive list

Kill switch · upstream budget ceiling · journal — where "journal" includes the mutation gate: no effect channel exists that does not cross it (§3). Nothing else is kept; everything else is stated (in the direction, `direction.md`) and observed (in the journal).

## 10. Suggested implementation order (for plan C1)

1. Journal + envelope + hash-chain + zstd persistence (the foundation of everything).
2. Minimal node driver (inbox, claim, wake latch, free loop + wait).
3. Assembler + provider adapter + pinning (heading at node 0).
4. `execute` tool (PTY + Landlock + git commit); `speak`; `web_search`/`web_fetch`.
5. `extend` (Plugin/Package/Run registry + vm facade + persistence by replay).
6. Agent zero (root node, human channel, heading drafting/ratification).
7. Reconstructability invariant at boot + kill switch.

## 11. Deferred

- **Session monitoring/cockpit** (the 3 sensors + metronome, readable projections) — next item of `ROADMAP.md`.
- PTY daemon surviving restart (known path: daemon + Unix socket + restore) — non-blocking, do not build now.
- Effect-TS as infrastructure (if backpressure/durable execution become necessary) — v4 still in RC.

## Sources

- **Cordis**: npm tarball `cordis@4.0.0-rc.10` read line by line; `cordiverse/cordis` (core = 1,874 lines of TS, ~2,200 lines of tests); issues #26/#143/#144; README ("API not stable"). Traps retained: parallel teardown between sibling effects, gate not watertight from the inside, swallowed dispose errors, silent PENDING.
- **DeepSeek Harness** (master, snapshot 11/09/2026): `agent.ts`, `inbox.ts`, `invariant.ts`, `session/types.ts`, `surface.ts`, `compaction/region.ts`, `tool-bash-persistent`, `fs-sandbox`, `sandbox-local`, `extensions/registry.ts`, `guard.ts`, `process-shutdown.ts`, `scope/index.ts`, postmortems 0001-0004, Agent Notes (persistent PTY, bounded write batching, zstd frames, signal shutdown). ~4,000 lines of relevant machinery identified outside the product surface.
- **Stack**: arXiv:2504.09246 (94% type errors), arXiv:2504.08703 (SWE-PolyBench), arXiv:2609.00006 (11 harnesses: 0/11 import an agent framework), anyio/asyncio/node-pty/Effect docs.
- **Cache**: Anthropic docs (prompt caching, breakpoints, 20-block window), DeepSeek (context caching), Z.ai (`cache_control` accepted on an OpenAI-compatible endpoint; +16 pts of hits measured by dsh), OpenAI, Moonshot; LiteLLM bugs on body alteration by proxy.
- **Event sourcing**: dsh-session (envelope, zstd frames, bounded write-behind, repair at the reader), VOLT (IETF draft-cowles-volt-01: hash-chain, RFC 8785, claim-check, rolling bundles), Statefold (benchmarks), ESAA (replay = re-projection; 15→5 types), ActiveGraph (content-addressed cache, O(n) replay), Langfuse (immutable wide events), Codex (5 GB of JSONL + SQLite index), Cursor anti-patterns (O(n²)) and OpenClaw (WAL stall).
- **Sandbox/PTY/git**: kernel Landlock docs + man7 (ABI, caveats), bubblewrap README, Codex linux-sandbox, incident codex#19588 (200 GB), DSH persistent-pty + native-containment, Superset terminal-daemon, git measurements on the target machine (29-100 ms/commit; FSMonitor unavailable on Linux).
