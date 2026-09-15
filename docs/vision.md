# Refocus — back to the heart of the experiment

**Date:** 2026-09-11
**Status:** validated — sessions 2–5 of the roadmap below have since been completed (see `../ROADMAP.md`); amended by `seed.md`, `direction.md` and `kernel.md`
**Partially supersedes:** an earlier long-term spec (not published at this stage) remains the reference for Parts II/III (long term), but its Part I is **amputated** of everything that is premature product work.

---

## 1. The shared observation

The spec drifted: starting from the minimal concept, it accumulated **product** mechanisms (graduation, promotion dossiers, constitutional gates, attenuated delegable rights…) that **impose a structure** precisely where the experiment wants to observe a structure that **emerges**.

The heart of the experiment, reformulated:

> **An autonomous system that follows a direction defined by a continuous chat between a human (CTO) and an agent zero, and that evolves over time. Not a finite objective, not a step-by-step loop that can be terminated.**

And the only two things that matter at the start:

1. **The chat with agent zero** (like the DeepSeek Harness) — the single interface.
2. **The kernel** — async, event-native, append-only journal, modules hot-reversible.

Everything else is either the expected emergence (structure, roles, process) or long term (the Loop, self-enterprise).

## 2. Verdict on the spec's 5 principles

| Spec principle | Verdict | New status |
|---|---|---|
| P1 Imposed physics, emergent org | ✅ KEPT — that is the project's discipline | The golden rule, reinforced: every mechanism of the kernel must be justified, otherwise it stays out |
| P2 Every effect reversible | ✅ KEPT — that is *the* concept of the engine | Cordis reversibility is what **makes operating live possible** |
| P3 Journal = truth | ⚠️ TO BE REDEFINED — Noé does not agree with the detailed operation | Dedicated session (see §4). The research brings concrete answers (dsh-session: "model-visible means logged", projections, contiguous seq) |
| P4 Autonomy must be earned | ❌ OUT of the kernel — that is a product feature | Replaced by bare physics: kill switch + budget ceiling. Graduation, if it is to exist, **will emerge as a request from agent zero to the human via the chat** |
| P5 Never live | ❌ OUT of the kernel — contradiction identified by Noé | Operating live **is the concept** (the Cordis kernel exists for that). The mirror/fork/benchmark is a methodology of **Part III** (development of the Engine by an Instance), not a law of the kernel |

Rights / authorizations / promotions system: **removed from scope**. If agent zero needs rights, it will ask for them, and we will observe *how* it asks — that is experiment data, not a spec.

## 3. What the research changes (2026-09-11)

### Positioning: the unoccupied triangle

The state-of-the-art research (`research/sota-autonomous-agents.md`) confirms:

- **Perpetual**: solved (Letta, ambient agents, OpenClaw, durable execution engines). Not a contribution in itself.
- **Emergent structure**: explored ("Drop the Hierarchy and Roles"), with a crucial correction: emergence beats fixed roles by +3.5% for a strong model but **loses −9.6% for a weak model** → our model-agnostic approach + cheap/smart models is the right one.
- **Direction co-negotiated through continuous chat**: **nobody does that**. Static mission (charters), finite objectives (benchmarks), self-generated curriculum (Voyager) all exist — the *direction* as a persistent, versioned artifact, continuously revised, exists nowhere.

**→ The triangle perpetual × emergent × direction is our contribution. Everything else must be minimal so as not to dilute it.**

### The pivot of the DeepSeek discussion (message 11 from Noé)

> "[…] create an organization capable of holding up over time, of self-evolving in order to adapt to its own evolution **by following a direction, not a finite task**."

Consequences settled in that discussion (msg 12) and adopted here:

- **The measure is not performance, it is viability**: drift, recovery, persistence, alignment. Checkpoint 3 ("org vs solo dividend") is rewritten: *at comparable budget per unit of time, does the org maintain a coherent trajectory where the solo drifts or collapses?*
- **The direction is a first-class object** — a memory of the direction that survives individual agents.
- **Agent zero = guardian of the direction** (and the human = the source of the direction).
- **The cockpit = a navigation instrument** (showing the trajectory), not a debug tool.
- The main risk = **ossification** (and its mirror: perpetual reorganization).

⚠️ **Reliability**: the small model's answers in that conversation contain massive hallucinations (invented models and benchmarks). Only the architectural reasoning is to be kept — the external factual material is to be thrown away.

### Technical lessons for the kernel (Harness/Cordis deep dive)

See `research/harness-deep-dive.md`. Salient points:

1. **A single mutation gate**: `effect(install) → disposer`, inverses composed in LIFO order. Cordis fits in ~2000 lines.
2. **Journal (dsh-session)**: log = the only truth, everything else is a projection; "model-visible means logged"; `{type, contiguous seq, time, data}`; extensibility with a required refusal to read an unknown type.
3. **Chat**: the Web UI is a second application on top of the same kernel; Chat and Trajectory = two projections of the same stream; human input enters through the same inbox as everything else.
4. **Identified gap we can fill**: in DeepSeek Harness, self-written plugins live in memory only (lost on restart) — ours must persist (the journal + persistent modules).
5. **Confluence (Th. 80)**: the final state depends only on the final config, not on the order — a decisive property for a self-modifying system.

### Models (no hardware constraint)

See `research/models-overview.md`. The "local Qwen on a 3090" constraint is **dropped as a prerequisite** (local remains available for free routing/summaries). Candidates to test (price per M tokens in/out):

- **GLM-5.3-Flash** ($0.075/$0.25) — best measured intelligence/price ratio → agents in volume
- **DeepSeek V4.1 Flash** ($0.15–0.30/$0.60–1.20, cache hit $0.003, MIT) — released on 10/09/2026, no independent eval yet
- **GLM-5.3** ($1.40/$4.40) — no. 1 open weights on the Intelligence Index → orchestrator
- **Kimi K2.7 Code** ($0.95/$4.00) — 12h+ sessions/4000 tool calls, ~30% fewer reasoning tokens

Cost lever no. 1: the **cache hit rate** (a ×30 spread at DeepSeek) → a design consequence for context assembly.

## 4. Roadmap of the brainstorm sessions

No code before the design is validated (unchanged rule). Each session produces a decision written into this file or a dedicated doc.

1. **✅ Session 1 (today)** — Refocus. Deliverable: this doc, validated/challenged by Noé.
2. **Session 2 — The journal.** This is THE open point of disagreement. Questions: what is written (physical trace vs declared events)? Who writes (the kernel alone? the modules?)? Minimal schema? "Model-visible means logged" — do we adopt it? Does the journal serve the agent (its memory) or only monitoring? Expected answer: the *smallest* definition that makes monitoring possible without imposing any organizational vocabulary.
3. **Session 3 — The kernel loop.** Concrete async event-native: what does agent zero see at each turn, where does its context come from, what is a triggering event (chat message, heartbeat, tool result), the scheduler, the loader of reversible effects. Stack: TS (native Cordis) vs Python (LLM ecosystem).
4. **Session 4 — The chat and the direction.** The human↔agent zero protocol; the direction as an object: a simple versioned document in the journal (minimalist position) vs a kernel primitive? Cadence: how does the direction change, who proposes?
5. **Session 5 — Minimal monitoring.** Which projections of the journal to see the trajectory (viability: drift/recovery/persistence/alignment) — invisible to the agents (anti-Goodhart). The smallest cockpit interface.
6. **Then**: implementation plan for the revised checkpoint 1.

### Revised checkpoints

1. **C1**: minimal kernel (async, events, reversible effects, journal) + agent zero + chat + a readable projection of the journal. *Criterion: we see everything the agent does, and we can talk to it.*
2. **C2**: agent zero extends the system live on its own initiative (installs a module, persists, survives restart) — **the successful live operation**. *Criterion: reversibility demonstrated (clean unload).*
3. **C3**: `spawn` + direction. At comparable budget per unit of time, does the org maintain a coherent trajectory where the solo drifts?

### Open questions raised by this refocus

- Q1: is `spawn` part of the minimal kernel from C1 onward, or is it the first hot extension (C3)? To be settled in session 3.
- Q2: the direction = a versioned document in the journal (minimal) or a kernel primitive? To be settled in session 4.
- Q3: what definition of the journal (session 2) — this is Noé's explicit disagreement with the spec.
- Q4: TS/Cordis vs Python stack (session 3).

---

## 5. Decisions of the 11/09 afternoon session (monitoring = the heart)

**Settled: monitoring precedes all software design.** The instrument defines the apparatus. We will not discuss the journal/memory/persistence/kernel until the conceptual instrument is validated.

**Settled: value is defined per cycle (option A).** Each change of direction crystallizes in the chat its own success proxy ("how we will know this works") + promises→actions→effects accounting on the journal. No universal value metric (that would reintroduce a disguised fixed objective).

**Settled: the conceptual model of the instrument = the cycle.** Change of heading (a timestamped event) → rising exploration → relaxation → exploitation plateau (value) → new heading. The two diseases: ossification (can no longer explore) and perpetual reorganization (can no longer exploit).

**The instrument battery (all computed on the journal, invisible to the agents — anti-Goodhart):**

| Family | Instruments | Key references |
|---|---|---|
| Explore/exploit phase | textual E/E ratio, behavioral novelty, deliberation diversity | Uotila 2009; Lehman & Stanley; OASIS |
| Post-heading convalescence | event study (delay, relaxation time, overshoot), critical slowing down | ITS/CausalImpact; Scheffer 2009 |
| Anatomy | RSI (role stability), Trophic Incoherence, March cascade (semantic distance, turnover, memory) | arXiv:2603.28990; March 1991 |
| Compass | drift via actions (GD_actions/GD_inaction), **drift-vs-adaptation detector via versioned history of the direction (unique contribution)**, constraint violation rate (Governance Decay) | arXiv:2505.02709; arXiv:2606.22528 |
| Value | proxy negotiated per cycle + promises→actions→effects accounting | decision option A |

**Feasibility verdict (11/09 research):** the metrics exist individually (~70%), the unified instrument is virgin territory = the contribution. Nobody has demonstrated the impossibility; the theorems constrain optimization, not observation. The self-evolution trilemma (Wang 2026) proves that external human steering is *necessary* = the concept of the project. Attacks to be handled by design: sycophancy (→ fidelity to actions), meltdown loops (→ measured time-to-meltdown), emergence theater (→ anti-imitation tests, out-of-corpus forms), variance/noise (→ experimental protocol).

**~~Next conceptual question:~~ RESOLVED (11/09 evening session) — the journal as the system's memory vs a measurement instrument.**

**Noé's decision: there are TWO memories, of different natures.**

1. **The observed memory (our instrument) = the journal.** Wired directly at the level of the LLM API calls (Langfuse-style): we capture EVERYTHING, we analyze and ratify everything. Consequence: the trace is *physical* (it exists because the system acted, not because an agent declared it acted) — that is the "model-visible means logged" invariant of dsh-session, adopted. Immutable, append-only, out of the agents' reach. The 3 sensors + the metronome (versioned direction) live on this side.
2. **The useful memory (theirs) = emergent.** Knowledge base or anything else: used and managed by the agents, it **emerges on its own, we do not touch it**. Its organization is experiment data (do we observe a librarian? rot? memory rituals?). Its *content* belongs to them, but its *usage* remains entirely visible in the journal (every read/write goes through a traced call) → observability without control.

Architectural consequence: the immutable/emergent boundary runs **between** these two memories. The journal is layer 1 (physical); the useful memory is layer 3 (emergent) — even if the kernel provides a minimal "private memory" tool in the starter kit.

**Question recorded for the bootstrap session (Noé's big doubt):** if we give a task with business value directly ("build me a SaaS"), the system will head into production without being aware that it must first *build itself* (tools, structure). **How do we provide a minimalist base (system prompt, tools, charter) that allows emergence without forcing it?** This is the cold-start question: what must the seed contain in order to become a tree without our drawing the tree in advance? To be handled BEFORE the kernel design, because it determines what the kernel and the starter kit must contain.

### Refinement of the instruments (11/09 evening session)

- **E/E by embeddings, not by dictionaries.** Uotila's textual ratio is abandoned (too fragile: synonyms, paraphrases). Method settled: journal windows → embeddings → trajectory in semantic space; exploration/exploitation = two reference poles (prototype texts), the phase = the trajectory's position between the poles. Embedding model **frozen** at the start; fine-tuning only if the noise is excessive (YAGNI). Published precedents: SemNovel (2025, novelty = distance to the past in a "semantic universe", validated), semantic drift by cosine distance on agent logs (arXiv:2601.17617). Honest limitation: embeddings measure movement, not intention → mandatory cross-checking with the versioned direction.
- **Temporal novelty (Noé's correction, settled).** Novelty = "an action never seen before" OR "an old action in a new world" (world = org + direction + current knowledge). Old action + unchanged world = repetition; old action + changed world = legitimate re-exploration. This makes cycles measurable without a false "non-explorer" diagnosis.
- **Structurally organizing reduction: 3 sensors + 1 metronome, not 20 instruments.** Sensor 1: semantic trajectory (→ phase, novelty, diversity, drift). Sensor 2: structure graph (→ RSI, hierarchical coherence, turnover, March). Sensor 3: value registry promises→actions→effects (→ value per cycle, cost, promises kept). Metronome: versioned direction (labels adaptation vs drift). The catalog of ~20 metrics becomes a diagnostic manual — a posteriori queries on the sensors, recomputable retroactively (the journal's superpower). Day-1 minimum: phase + relaxation + value.
