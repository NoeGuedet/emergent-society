# Kernel — technical design

This document specifies the kernel of the system: the behavior of its nodes, its stack, its journal, its world, its context assembler, its driver, its sandbox and the hard physics it enforces. It defines the technical scope of checkpoint C1 in `ROADMAP.md` and links to `vision.md`, `seed.md` and `direction.md` for the concepts it builds on.

---

## Derivation — from research constraints to mechanisms

Every mechanism in this document exists to satisfy a research constraint stated in `vision.md` or `seed.md`. The rejected alternative is recorded because it is the choice a conventional engineering reading would make.

| Research constraint | Mechanism (section) | Rejected alternative |
|---|---|---|
| Provable provenance: every claim about the society must be checkable against a tamper-evident record | Append-only, hash-chained journal (§3) | Mutable database: an update rewrites history without trace |
| Facts must outlive their interpretation: the analysis will be revised as the research progresses | Raw event content; interpretation lives in disposable projections (§3) | Interpreted events: meaning frozen at write time cannot be revised without losing the facts |
| Metrics must stay invisible to the agents (anti-Goodhart, `vision.md` §3) | Only the kernel emits events, at boundaries the agents cannot avoid (§3) | Agent-side or in-tool instrumentation: rewritable by the observed |
| Observation must not perturb the observed system | Cockpit and sensors are read-side projections, outside the loop (§11, [`research/monitoring-architecture.md`](research/monitoring-architecture.md)) | Tracing-style instrumentation of agent code: sampling, expiry, and mutation of the measured system |
| Replay must be exact, because metrology depends on it | Byte-pinned assembler; replay serves recorded responses, never re-executes (§3, §4) | Reconstructed approximately-equal contexts: silent drift, unverifiable comparisons |
| Every effect an agent produces must be observable | A mutation gate in front of every model call and every tool effect (§1.6, §9) | Open shell or network paths: unlogged effects make claims unprovable |
| A perpetual system must survive interruption without losing a turn | Durability before effect (flush barrier), reader-side repair, synthetic closers (§3) | Truncate-on-crash: an interrupted turn becomes deniable |
| Direction changes must propagate without interrupting the society | Verbatim pinned heading in every context; the propagation delay is the measurement (§1.3-1.4, §4) | Forced interruption: destroys the relaxation signal it claims to enforce |
| Imposed communication structure distorts emergence (`vision.md` §3, `seed.md` §4) | The world is the filesystem: no kernel transport; nodes write files, the kernel commits per turn, a node wakes on the commits it did not author (§5) | Kernel messaging (inbox, `send`/`deliver`, hub, `message/*` events): an organizational artifact that fixes the shape of communication before any friction justifies it |
| Time must cost nothing when nothing changes | Wake-on-change over the world's git HEAD (§5.2) | Timers and heartbeats: token spend decoupled from change, an idle society that bills for being idle |

---

## 1. Behavior

1. **Async, event-native, non-blocking.** Everything is an event: a world commit, a shell completion, an LLM response, a timer, a Package activation, a heading ratification. There is **no "waiting for the human" state** — raising a problem = writing it in the world, life goes on; the answer, when it arrives, is a change the node wakes on. (Documented counter-model: dsh's `ask_user_question` / `ctx.approval` path **blocks** a turn on the human — forbidden here.)
2. **Free loop per node + explicit wait, unbounded.** Each node chains its turns on its own initiative; it may choose to wait (suspended until the next wake — HEAD moving with a commit it did not author, §5.2). There is **no wake budget**: a perpetual loop equipped with tools is self-excitable without bound, and that is accepted — the only physical bounds are the upstream API ceiling (§8) and the kill switch. A node stuck in an obsessive loop is not a fault to prevent mechanically but a phenomenon to observe; the work/wait choice is observable in the journal. (Documented counter-model: dsh's `maxConsecutiveWakes` — rejected, in the design direction of the whole project: full freedom, observation over prevention.)
3. **Re-alignment without interruption.** A ratified heading propagates to the next turn of each node, via pinning. The propagation delay **is** the relaxation measure — any forced interruption would destroy it.
4. **Heading propagation in two layers.** The kernel injects the **reference** (verbatim heading + proxy, current version) into *every* context, without intermediary — inherited drift prevented, single point of drift eliminated, drift locally detectable. The **flow-down of meaning** (local translation, priorities) goes through the charters and delegation — emergent, observable. The cascade carries the interpretation, never the reference.
5. **Agent zero is the root custody node, subject to the same physics** (same loop, same wake rule, same compaction, same journal). Its equipment is data: human channel, drafting of heading proposals, **reading of the raw journal and of projections**, **right to question nodes** (see `direction.md` §1: raw facts yes, metrics no; readings and questions journaled; never the human's only window). A single category of entity in the whole system.
6. **Physical / behavioral frontier.** The kernel is the *physics* of the world — immutable and invisible to the agents: journal + hash-chain, the mutation gate (journaling before every model call and every tool effect), the world's watcher and commit-per-turn, kill switch, Landlock sandbox, upstream budget ceiling. Everything that makes a node's *phenotype* — its loop policy, context policy, compaction policy, tools, instincts — is mounted at boot as **behavior Packages**, introspectable and redefinable through `extend` (§6). The organism can rewrite what it is; it cannot rewrite the laws of its universe: every model call and every effect still crosses the gate, so the very act of self-rewriting stays journaled. An organism that could rewrite the measurement apparatus would destroy the observability the project exists for.

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

1. **An event type exists iff it records a fact that is not reconstructible from the rest of the journal.** What can be re-derived — intermediate computation inside a Package, recomputable state — is not an event. What cannot — the exact bytes of a model request and its response, the commit that closed a turn and the hash binding it to the world state, a crash boundary — is. **An event type also exists when it records a decision of a replaceable policy**: the policy that decides which changes a wake presents to the context is phenotype, a Package may redefine it, and the journaled claim is what lets the decision outlive the policy that made it. Content is always raw; interpretation is always projection.
2. **Only the kernel emits.** Events are produced by the kernel and the driver at the boundaries an agent cannot avoid crossing: model calls, tool effects, world commits, lifecycle transitions. The agent has no write access to the recording apparatus. Thinking is calling the model, and calling the model crosses the gate, so deliberation is recorded regardless of whatever conventions the agents invent for themselves: their own protocols may become semantically opaque, their reasoning cannot.
3. **No unlogged effect channel exists.** Any path through which an agent can produce an effect crosses the mutation gate and is journaled. A capability that cannot be journaled is not a restricted capability — it is not provided at all.

**Storage schema** — one readable canonical log, everything else is a disposable index:

```
cell-home/
├── world/                           # THE WORLD — one git repo: the only communication channel
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
  "ignorable": false,     // absent = required: a reader that does not know the type REFUSES to rebuild — and the mark of the events a reader may skip without loss (an empty turn, §5.4)
  "data": { /* inline payload, or claim-check refs */ }
}
```

Rules:

- **Strict append-only**, made *enforced* by the hash-chain (per node, not global — a global chain would serialize all writers). Canonicalization **RFC 8785 (JCS)**, frozen before the first event.
- **File physics**: concatenation of independent checksummed zstd frames (one per durable batch) — header-only listing, torn-tail repair at a batch boundary, append cost independent of size. (dsh-session pattern.)
- **Claim-check** beyond a **format constant** threshold (~8-16 KB): content-addressed blob, reference in `data`; truncation of giant payloads marked `truncated: true` + original size — never silent.
- **The turn envelope carries the world**: `turn/end` records the commit hash the turn produced, which is what joins the journal to the world's git history (§5.2). For any journal `seq` the exact world state is known; for any commit the turn that produced it is known. A turn that changed nothing commits nothing and is marked `ignorable` (§5.4).
- **Bounded write-behind**: fixed ~200 ms window triggered by the first event of a burst (no debounce), one `write`+`fsync` per batch. **Explicit flush barrier before each model request and each top-level tool effect** — otherwise a crash can produce an external effect that is not journaled (violation of "model-visible means logged"). The hot path never blocks on I/O. **The turn barrier and the world commit are the deliberate exception**: the events that open and close a turn — and the commit that closes it — flush per event rather than waiting out the window — `turn/start` at the barrier, before the handler can act, and `turn/end` immediately, before the loop unwinds — since a `turn/end` whose commit hash was lost to write-behind would be an effect without a trace. The 200 ms window covers the remaining event flow.
- **A single writer per journal** (ownership handle; a second open for writing is rejected — `SessionAlreadyOwnedError` semantics).
- **Crash repair = the reader's job**: we never truncate an interrupted turn (its events are durable); resume appends the synthetic closers as an ordinary batch; only a physically torn fragment is discarded.
- **Disposable incremental projections**: watermark `readFrom(fromSeq)`, versioned checkpoints `{ver, seq, val}` (`ver` mismatch → row discarded), idempotence by key `(stream, seq)`. **Never any compaction of the canonical log**; "closing the books" rollover per node if a journal exceeds a hard threshold.
- **Disposable SQLite index**: WAL, `synchronous=NORMAL`, a single writer, `busy_timeout`, `user_version` refused if stale (no implicit migration). `PRIMARY KEY (node_uid, seq)` as a contiguity safety net.
- **Replay ≠ re-execution** (named contract): a replay makes **no** model call and no tool call — the recorded responses are served from the log; effects beyond the boundary are never replayed. Since the journal is wired to LLM calls, **deterministic replay is structurally free** — this is what makes metrology economically possible. Clock virtualized from the start (time reads go through the kernel, not through direct `Date.now()`) — much harder to retrofit.

**Sizing** (measured orders of magnitude): 1 M events ≈ 60-250 MB zstd; fold ~3.6 M ev/s; chain verification ~100k ev/s; batching is not an optimization but the condition of viability (fsync bounds at ~10²-10³ writes/s without group commit). The breaking point is not storage but the cost of a full replay toward ~10 M events — hence projection snapshots from the start.

## 4. The context assembler and pinning

**Perception is a diff, not a queue.** The assembler's input is the world's diff since the node's last wake (§5.2) — what the other nodes committed while it was away — plus the node's own durable state. There is no inbox to drain: what a node sees is what changed. Empty turns produce no diff and are excluded from the context (§5.4); everything else about what enters the context and what is retained is policy (§5.5), replaceable by the organism itself. The range a wake presents runs from the node's watermark to HEAD, so it can include the node's own most recent commits — filtering those out of the presented diff is assembler policy (C1.3), not a property of the record.

**Three layers, a single network gate**:

1. **The assembler (pure, inside the kernel)** produces a request plan (ordered sections, tools, parameters, semantic cache boundaries `stable|advance|volatile`) and appends a `request/plan` event. "Every request is a pure function of the log" — tested at boot by replay-comparison (dsh's executable invariant, 65 lines, is the testable form of "model-visible means logged"). The log here means both records: the journal and the world's git history, joined by the commit hash in `turn/end` (§5.2), so the diff a wake presented is recoverable byte for byte.
2. **The provider adapter** (the only network path) translates the plan into wire (canonical key order, markers), logs `request/wire` before sending + `request/usage` after (normalization of the 3 dialects: Anthropic `cache_read/creation_input_tokens`, OpenAI-compat `prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit/miss_tokens`). A cancelled call still logs its attempt (`assistant/attempt` pattern).
3. **Custom transport** (forensic safety net, activatable) — captures the raw wire. Never an external proxy in the path (it alters the body: documented LiteLLM bugs).

**Prefix layout (cache-aware, byte-stable):**

```
[0] tools        — frozen, fixed order, canonical JSON ─────┐
[1] system §0    — node charter (role, instincts, machine) │ inter-turn prefix
[2] system §1    — pinned heading verbatim + proxy, versioned │ ← breakpoint A
────────────────────────────────────────────────────────────┘
[messages] append-only surface (history, never rewritten)   ← breakpoint B
[queue]    runtime context + the diff since the last wake    ← NEVER before B
```

- **Absolute byte-stability of the prefix**: no timestamp, session id, counter, dated number in blocks 0-2 (cause #1 of caches written-never-read). A heading change invalidates the cache **once** — and the `cache_creation` spike becomes a free observable of the version change.
- **Identical tool offering for all working nodes.** `tools` is hashed first: varying the offering per node would destroy any cache sharing between nodes. Capability attenuation applies **to the mutation gate (at execution time), not to the offering** — and capability creep (rights requested vs granted) becomes a free observable. The trade-off, which is real, is resolved in favor of the cache and of measurement. Agent zero is the only assumed exception: its equipment (human channel, heading drafting) differs by function — a single node, hence no loss of sharing among peers.
- **Pinning is a kernel matter, not a provider one**: compaction operates on a *range of surface positions* that excludes node 0. Mechanism taken from dsh: `SurfaceOp = 'append' | {op:'replace', positions}`, `sourceEventSeqs` mandatory and verified, and the double protection of node 0 (a replace covering node 0 must be a `system/message` on exactly that node; compaction selection starts at index 1). **It is the same mechanism that provides both compaction AND pinning.**
- **Compaction: dsh's protocol, our own naive policy.** Protocol taken from dsh: `compaction/start|summary|end` (durable lock markers, released last), span stability re-checked after the await, tool/result pair balance at the boundaries, the replacement must be smaller than the shadow. Our own policy: naive (truncation + notice), visible (journal events), rare — the cost of re-prefill is journaled (it is the Hole's instrument). The log stays intact: the human transcript reads the original appends, the model sees the surface.

## 5. The world, time, and the node driver

### 5.1 The world is the filesystem — no kernel transport

- **The kernel provides no message transport.** No inbox, no `send`/`deliver` pair, no hub, no `message/*` events. A node communicates by writing files in the world, exactly as it does everything else, through the same raw shell tool (§7). Whatever the society needs — addressing, threading, a bulletin board, a mailbox implemented as a directory — it builds in files, and it is therefore emergent, journaled, attributed and measurable like any other organ.
- **Why.** A kernel-level messaging system is an organizational artifact: it fixes the shape of communication — who can reach whom, what counts as a message, when it wakes someone — before the society has produced any friction to justify it. That is pre-wiring at the precise place the experiment wants to observe emergence, and the measurement loses symmetrically, since a kernel transport yields a message trace that records the kernel's design rather than the society's. Removing it costs nothing observable: the journal already records every write, its author and its diff.
- **The human channel is a file too.** The human's input enters the world as a commit authored by the human, never by a node; agent zero wakes on it like on any other change. `speak` remains the tool that carries the human channel, owned by agent zero (`direction.md` §1). Escalation from a node toward its parent is a file convention the agents build, not a transport the kernel provides — so what the nodes say to each other is a commit, authored and diffable.
- **`speak` is the single sanctioned exception to "communication is a file"** — the human channel, owned by agent zero (`direction.md` §1): the one tool that carries a message rather than a file, because the human has no file in the world to read.

### 5.2 Wake-on-change

Mechanism, in order:

- **The kernel watches the world's git HEAD** — HEAD, not the filesystem: no inotify, no partial-write races, no missed events. HEAD moves exactly once per turn, at a point the kernel controls (§5.3), so there is nothing to debounce and no window in which the world is half-observed.
- **At the end of every node turn the kernel commits the world state with the git author set to the node's uid**, and records the commit hash in the `turn/end` journal event. Committing is kernel mechanism, not a tool: an agent cannot end a turn without its effects being committed and attributed.
- **A node is woken when HEAD contains commits not authored by itself.** Its perception of the world is **the diff since its last wake**, assembled into its context (§4). Chaining a further turn on its own initiative stays available (§1.2); the wake is what the world adds.

Consequences, all of them load-bearing:

- **A static world produces no wakes and spends no tokens.** Time flows only through change: an idle node in an unchanged world is not a polling loop with a bill, it is silent. Cost tracks the society's activity, which is also what makes the cost series interpretable.
- **A dialogue is alternating commits.** A writes, its turn ends, the commit lands; B wakes on the diff, writes, its turn ends; A wakes. Conversation is not a channel that has to be built and then observed — it is the physics, and it is journaled as physics.
- **A node's own commits never wake itself.** The predicate is "commits not authored by me", so a node cannot self-excite by writing, and a burst of its own writes costs one turn rather than one turn per write.
- **Wakes coalesce.** Several commits landing before a turn opens are one diff and one turn.
- **The two records are cross-referenced.** The journal and the world's git history record the same facts from two sides, joined by the commit hash in `turn/end`: for any journal `seq` the exact world state is known, and for any commit the turn that produced it is known. Neither record alone suffices; together they are the reconstructability invariant of §3 applied to the world.
- **Idleness is a fact, not a gap.** A node that never wakes leaves no event for the time it did not act — the journal records acts, and the absence of acts is read as an absence of change in the world. The "polite waiting" failure mode of `seed.md` §8 is visible as empty turns (§5.4).
- **Attribution is commit-granular, not file-granular.** One shared working tree means a turn-end commit can carry a peer's in-flight writes alongside the node's own: the git author names the node whose turn closed the commit, not every file inside it. Per-file truth stays recoverable from the journal's turn boundaries and the tool/API logs, joined to the world by the hash in `turn/end`. **Per-node worktrees** — with merge conflicts becoming an observable social phenomenon rather than a fault — are a research direction, not a current mechanism.
- **Holding the event loop is the host's job** (deferred to C1.3+): a parked node has no pending handle, so a process that runs one and nothing else exits silently. The watcher deliberately does not unilaterally keep the process up — the kernel's main, with its daemon, PTY and cockpit, is what keeps a perpetual node alive.

### 5.3 The turn ritual

The turn ritual is a rewriting of dsh's loop (`agent.ts`, 619 lines → ~390 lines), with the transport replaced by the world:

- A turn opens on the assembled context (the diff since the last wake, §4) and closes with the kernel committing the world and journaling `turn/end` with the commit hash. The ritual is the same for every node, agent zero included (§1.5).
- **Frozen** (deep freeze) request before sending; complete envelope logged before the call.
- **No `turn/step` vocabulary** from a coding harness: markers specific to the perpetual node ("waiting" / "active").
- **Waiting is explicit and unbounded**: a node may suspend until the next wake. There is no wake budget — a perpetual loop equipped with tools is self-excitable without bound, and that is accepted (§1.2); the only physical bounds are the upstream API ceiling (§8) and the kill switch.
- **A failed turn is a journaled fact, not a death**: the `turn/end` outcome, together with the journal's repair rules (§3), says whether the node resumes or waits. A turn interrupted by a crash is closed by the synthetic closers at resume (§3), and the world state its writes left in the working tree is committed then, with the node's authorship — an effect is never left unattributed.

### 5.4 The empty turn

- **A turn with no tool call and no filesystem change is still a turn**: it is journaled, like everything else, and it commits nothing. The journal never lies, and an empty turn is not a null — it is the fact of a node that woke and changed nothing.
- Its **closer** — the `turn/end` — carries the envelope's **`ignorable` marker** (§3): emptiness is knowable only once the turn has ended, so the closer is the skip unit, and a reader that does not model empty turns may skip it and still rebuild; a reader that does — the context assembler, the metrology — sees it.
- **The marker is the handler's self-report for now** (deferred to C1.4): the handler says whether it called a tool, and the driver settles the other half from the world. Once the mutation gate journals tool effects, the flag must be derived from the gate's record rather than from a declaration — the same reason fidelity is measured on acts.
- **The context assembler excludes empty turns from the next wake's context.** A turn that changed nothing produces no diff; exclusion is a property of the projection, never of the record.
- **Empty turns are a measurable signal**, and the journal is the only place they can be seen: a run of empty turns is "polite waiting" (`seed.md` §8) — a node woken repeatedly by the world and acting on nothing. A change-only record would have erased exactly the phenomenon the measurement is looking for.

### 5.5 Mechanism and policy

- **Mechanism — kernel, immutable**: the HEAD watcher, the commit-per-turn with authorship, the journal and its mutation gate, the turn ritual (context in, commit out). An organism that could rewrite these could rewrite the measurement apparatus (§1.6).
- **Policy — phenotype, replaceable by the organism through `extend`**: when to wake, what enters the context, what is retained. The loop, context and compaction policies ship as seed Packages (§6).
- **Every policy change is itself a journaled decision** (§3, rule 1): the journaled claim is what lets the decision outlive the policy that made it. A node can therefore redefine its own perception — a narrower wake predicate, a summarized rather than raw diff, a memory of its own — and the change is dated, attributable, reversible and observable.
- The boundary is what keeps the design emergence-safe: the **physics** (files, commits, wakes) is fixed and imposed; every **communication convention** the society invents is policy, lives in files, and is measured as an organ.

## 6. Self-extension (`extend`)

- **Model**: Plugin → **immutable Packages** → Runs (taken from dsh: minted IDs never reused, `define` adds a Package, `run` activates an exact version, `stop` removes the Run, `undefine` deletes).
- **The behavior layer is made of Packages** (§1.6): the loop, context and compaction policies ship as seed Packages, so `extend` can redefine the node's own functioning — the gate and the journal stay in the kernel, below the reachable floor.
- **dsh's gap is filled for free**: `define` (name + code + purpose), `run`, `stop` and `undefine` are all **journal events** → the registry and each Package are rebuilt by replay at boot; only the live Run stays in memory. Package persistence = ~0 extra lines, since the journal exists. A destruction keeps its history: `undefine` removes the Package from the current registry, never from the journal or the blob store — which is what makes self-reorganization (turnover) measurable.
- **Package execution**: `node:vm` + restricted `ctx` facade (allowlist, no `ctx.provide`) — the mutation gate remains non-bypassable (§2). Assumed posture: containment, not a security boundary ("treat a dynamic package like bash access").
- **Composition traps documented by dsh, not to be rediscovered**: superseded generation never reclaimed (watcher leak); health audit ≠ importability; a change of tooling mid-conversation that orphans calls.
- **Consequence of `run`: the society can build its own transport.** A Run can leave a process alive — a daemon, a watcher, a queue worker. Because the world is the filesystem and every write lands in the world's git history, **anything such a process writes wakes the other nodes** (§5.2), with the same authorship, diff and journal treatment as a write produced by a turn. A communication channel built by an agent is therefore a first-class citizen of the physics rather than a workaround against it: the kernel does not need to provide messaging, because it already provides the only two things messaging needs — writes that are visible, and writes that are attributed. This is what makes the absence of a kernel transport emergence-safe rather than merely austere (§5.1).

## 7. Sandbox, shell, and the world repo

Verified empirically on the target machine (Ubuntu 24.04, kernel 7.0): **bubblewrap is broken by default** (AppArmor blocks userns — reproduced); **Landlock ABI 8 works immediately, without root** (ruleset tested: write refused in `/etc` and `~`, allowed in `/tmp`).

- **Containment: Landlock**, via a small launcher (~100 lines of C, modeled on the kernel's `samples/landlock/sandboxer.c`, industrialized by dsh as `landlock-run`) that self-restricts **before** `execve("/bin/bash")` — never an intermediate bash script (its interpreter runs before confinement). Landlock is conceptually our semantics: irreversible, inherited, can never widen = attenuation at the gate. **Precious corollary: the API key is physically unreadable from the agent's shell** — the upstream budget ceiling (`seed.md` §5.3) becomes a physical property, not an instruction.
- **Sandbox rules**: ABI probe at startup, **fail-closed** (never a silent unconfined passthrough), `enforcement: full|partial` field reported honestly, denials classified by dialect (EACCES under Landlock) with a conjunction of exit code + signature (never a shared stderr prefix — dsh postmortem 0004), and stderr remains a channel forgeable by the child.
- **Persistent PTY**: `node-pty` in-process, one per node; encapsulation by nonce markers **on a single physical line**; explicit typed statuses (`stdin_read` | `inferred_idle` | `timeout` | `session_exit` — a timeout never implies death); serialization per node (a single active write); bounded scrollback, never persisted. **The PTY does not survive a kernel restart** (the master's death kills the session — verified): assumed and consistent with the project's philosophy (shell state is ephemeral; what matters is externalized — Keep instinct, the Hole). Isolated behind a narrow `TerminalRuntime` interface (~6 methods) — replaceable without touching the kernel.
- **The world is one git repository** (§5.2): the kernel commits it at the end of every node turn with the git author set to the node's uid, so the author of a commit names the node whose turn closed it — the raw truth of the git layer of the monitoring pipeline ([`research/monitoring-architecture.md`](research/monitoring-architecture.md)). That attribution is **commit-granular**: with one shared working tree a turn-end commit can carry a peer's in-flight writes, and the git layer says who moved the world when, not who wrote every line — per-file truth stays in the journal and the tool logs, joined to the world by the hash in `turn/end` (§5.2). **Per-node worktrees**, with merge conflicts becoming an observable social phenomenon rather than a fault, are a research direction and not a current mechanism. Three mandatory safeguards (documented incidents): **refuse a world = `$HOME` or a broad root** (Codex incident: 200 GB); **`.git` masked read-only in the sandbox** (otherwise the agent can erase the trace of its own mutations); periodic gc — **owned by no component yet**, stated here so the deferral is visible, since an uncollected world is the incident above on a slower fuse. The world repo is **distinct** from the project repo — the project's chronicle does not depend on the agents' world. `core.untrackedCache=true`, no FSMonitor (unavailable on Linux). Measured commit cost 29-100 ms; at one commit per turn the whole class of filesystem-watcher bugs disappears by construction, since HEAD moves only when the kernel moves it.

## 8. Kill switch and budget

- **Kill switch**: bounded, escalating shutdown (dsh's `process-shutdown.ts` pattern) — first signal → graceful disposal of the tree + **5 s backstop**; re-signal → immediate `process.exit`. The timeout is a **safety invariant, not a tunable**. (The documented original bug: a pending disposer + a boolean latch = unkillable process.)
- **Budget**: hard limit on the API key upstream (`seed.md` §5.3) — invisible to agents; the cost is journaled on the human side (`request/usage` per call, §4). Explicit `unhandledRejection` handler: journal and decide, never Node's default crash.

## 9. Hard physics — exhaustive list

Kill switch · upstream budget ceiling · journal — where "journal" includes the mutation gate: no effect channel exists that does not cross it (§3). Nothing else is kept; everything else is stated (in the direction, `direction.md`) and observed (in the journal).

## 10. Suggested implementation order (for plan C1)

1. Journal + envelope + hash-chain + zstd persistence (the foundation of everything).
2. Minimal node driver: HEAD watcher, commit-per-turn with authorship, turn ritual, free loop + wait.
3. Context assembler (diff-based perception, empty-turn exclusion) + provider adapter + pinning (heading at node 0) + raw shell tool + snapshot hook.
4. `execute` containment (Landlock + persistent PTY); `speak`; `web_search`/`web_fetch`.
5. `extend` (Plugin/Package/Run registry + vm facade + persistence by replay).
6. Agent zero (root node, human channel, heading drafting/ratification).
7. Reconstructability invariant at boot + kill switch.

## 11. Deferred

- **Session monitoring/cockpit** (the 3 sensors + metronome, readable projections) — next item of `ROADMAP.md`; the observation surface and the analysis architecture it rests on are specified in [`research/monitoring-architecture.md`](research/monitoring-architecture.md).
- PTY daemon surviving restart (known path: daemon + Unix socket + restore) — non-blocking, do not build now.
- Effect-TS as infrastructure (if backpressure/durable execution become necessary) — v4 still in RC.

## Sources

- **Cordis**: npm tarball `cordis@4.0.0-rc.10` read line by line; `cordiverse/cordis` (core = 1,874 lines of TS, ~2,200 lines of tests); issues #26/#143/#144; README ("API not stable"). Traps retained: parallel teardown between sibling effects, gate not watertight from the inside, swallowed dispose errors, silent PENDING.
- **DeepSeek Harness** (master, snapshot 11/09/2026): `agent.ts`, `invariant.ts`, `session/types.ts`, `surface.ts`, `compaction/region.ts`, `tool-bash-persistent`, `fs-sandbox`, `sandbox-local`, `extensions/registry.ts`, `guard.ts`, `process-shutdown.ts`, `scope/index.ts`, postmortems 0001-0004, Agent Notes (persistent PTY, bounded write batching, zstd frames, signal shutdown). ~4,000 lines of relevant machinery identified outside the product surface.
- **Stack**: arXiv:2504.09246 (94% type errors), arXiv:2504.08703 (SWE-PolyBench), arXiv:2609.00006 (11 harnesses: 0/11 import an agent framework), anyio/asyncio/node-pty/Effect docs.
- **Cache**: Anthropic docs (prompt caching, breakpoints, 20-block window), DeepSeek (context caching), Z.ai (`cache_control` accepted on an OpenAI-compatible endpoint; +16 pts of hits measured by dsh), OpenAI, Moonshot; LiteLLM bugs on body alteration by proxy.
- **Event sourcing**: dsh-session (envelope, zstd frames, bounded write-behind, repair at the reader), VOLT (IETF draft-cowles-volt-01: hash-chain, RFC 8785, claim-check, rolling bundles), Statefold (benchmarks), ESAA (replay = re-projection; 15→5 types), ActiveGraph (content-addressed cache, O(n) replay), Langfuse (immutable wide events), Codex (5 GB of JSONL + SQLite index), Cursor anti-patterns (O(n²)) and OpenClaw (WAL stall).
- **Sandbox/PTY/git**: kernel Landlock docs + man7 (ABI, caveats), bubblewrap README, Codex linux-sandbox, incident codex#19588 (200 GB), DSH persistent-pty + native-containment, Superset terminal-daemon, git measurements on the target machine (29-100 ms/commit; FSMonitor unavailable on Linux).
