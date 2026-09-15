# Vision — the unoccupied triangle

This document specifies what the project sets out to demonstrate, the design discipline it commits to, and the measurement apparatus that backs the claim. It is the entry point to the design corpus: [seed.md](seed.md) (the cold start), [direction.md](direction.md) (chat and direction), [kernel.md](kernel.md) (the runtime), [ROADMAP.md](../ROADMAP.md) (checkpoints and next steps), and [research/](research/) (the evidence base).

## 1. The heart of the experiment

An autonomous system that follows a direction defined by a continuous chat between a human (CTO) and an agent zero, and that evolves over time. Not a finite objective, not a step-by-step loop that can be terminated.

Only two things exist at the start:

1. **The chat with agent zero** — the single interface.
2. **The kernel** — async, event-native, append-only journal, modules hot-reversible.

Everything else is either the expected emergence (structure, roles, process) or long-term scope (the Loop, self-enterprise).

A specification that accumulates **product** mechanisms — graduation, promotion dossiers, constitutional gates, attenuated delegable rights — imposes a structure exactly where the experiment wants to observe an emergent one. All of them are out of scope. If agent zero needs rights, it asks for them, and *how* it asks is experiment data, not a specification.

## 2. The contribution: perpetual × emergent × co-negotiated direction

The state of the art ([research/sota-autonomous-agents.md](research/sota-autonomous-agents.md)) settles the positioning:

- **Perpetual** — solved (Letta, ambient agents, OpenClaw, durable execution engines). Not a contribution in itself.
- **Emergent structure** — explored ("Drop the Hierarchy and Roles"), with one crucial correction: emergence beats fixed roles by **+3.5%** for a strong model but **loses −9.6% for a weak model**. This is why the design is model-agnostic and targets cheap/smart models rather than assuming one tier of intelligence.
- **Direction co-negotiated through continuous chat** — nobody does this. Static missions (charters), finite objectives (benchmarks) and self-generated curricula (Voyager) all exist; the *direction* as a persistent, versioned artifact, continuously revised, exists nowhere.

**The triangle perpetual × emergent × direction is the contribution. Everything else must be minimal so as not to dilute it.**

## 3. The golden rules

- **Imposed physics, emergent organization.** Every mechanism of the kernel must be justified; otherwise it stays out. No organizational structure is coded — no roles, no workflow, no hierarchy vocabulary.
- **Every effect reversible.** Cordis-style reversibility (`effect → disposer`, inverses composed in LIFO order) is what makes operating live possible.
- **The journal is the only truth.** Everything else — dashboards, metrics, agent memory — is a disposable projection.
- **Metrics are invisible to the agents** (anti-Goodhart). Instrumentation lives outside the graph.
- **Fidelity is measured on acts, never on declarations.**
- **Autonomy is not a kernel concept.** The kernel provides bare physics only: kill switch + budget ceiling. Graduation, if it is to exist, emerges as a request from agent zero to the human through the chat.
- **Operating live is the concept.** The Cordis kernel exists for it; the mirror/fork/benchmark is a methodology for developing the engine by an instance, not a law of the kernel.

## 4. What is measured: viability, not performance

The measure is viability — drift, recovery, persistence, alignment — not performance. At comparable budget per unit of time, the question is whether the org maintains a coherent trajectory where a solo agent drifts or collapses.

- **The direction is a first-class object** — a memory of the direction that survives individual agents.
- **Agent zero is the guardian of the direction**; the human is its source.
- **The cockpit is a navigation instrument** (showing the trajectory), not a debug tool.
- The main risk is **ossification**, and its mirror, **perpetual reorganization**.

A preliminary exploration conversation provided the architectural reasoning retained here. It contained hallucinated external facts (invented models and benchmarks): only its architectural reasoning was retained, and none of its factual claims are used.

## 5. The two memories

There are two memories of different kinds, and the immutable/emergent boundary runs between them.

1. **The observed memory (the instrument) = the journal.** Wired directly at the level of the LLM API calls (Langfuse-style): everything is captured, analyzed and ratified. The trace is therefore *physical* — it exists because the system acted, not because an agent declared it acted. This is the "model-visible means logged" invariant of dsh-session. Immutable, append-only, out of the agents' reach. The 3 sensors + the metronome live on this side.
2. **The useful memory (theirs) = emergent.** Knowledge base or anything else: used and managed by the agents, it **emerges on its own** and is not designed. Its organization is experiment data (is a librarian observed? rot? memory rituals?). Its *content* belongs to the agents, but its *usage* remains entirely visible in the journal — every read and write goes through a traced call — giving observability without control.

The journal is layer 1 (physical); the useful memory is layer 3 (emergent), even though the kernel ships a minimal "private memory" tool in the starter kit. The cold-start constraint — what the seed must contain to become a tree without drawing the tree in advance — is specified in [seed.md](seed.md).

## 6. The monitoring instrument

**Monitoring precedes all software design.** The instrument defines the apparatus: the journal, memory, persistence and kernel are designed *after* the conceptual instrument.

### The cycle

The conceptual model of the instrument is the **cycle**: change of heading (a timestamped event) → rising exploration → relaxation → exploitation plateau (value) → new heading. The two diseases are **ossification** (can no longer explore) and **perpetual reorganization** (can no longer exploit).

**Value is defined per cycle.** Each change of direction crystallizes its own success proxy in the chat ("how we will know this works") plus promises→actions→effects accounting on the journal. There is no universal value metric — that would reintroduce a disguised fixed objective.

### The battery

All instruments are computed on the journal and are invisible to the agents (anti-Goodhart):

| Family | Instruments | Key references |
|---|---|---|
| Explore/exploit phase | textual E/E ratio, behavioral novelty, deliberation diversity | Uotila 2009; Lehman & Stanley; OASIS |
| Post-heading convalescence | event study (delay, relaxation time, overshoot), critical slowing down | ITS/CausalImpact; Scheffer 2009 |
| Anatomy | RSI (role stability), Trophic Incoherence, March cascade (semantic distance, turnover, memory) | arXiv:2603.28990; March 1991 |
| Compass | drift via actions (GD_actions/GD_inaction), **drift-vs-adaptation detector via versioned history of the direction (unique contribution)**, constraint violation rate (Governance Decay) | arXiv:2505.02709; arXiv:2606.22528 |
| Value | proxy negotiated per cycle + promises→actions→effects accounting | — |

### Structural reduction: 3 sensors + 1 metronome

- **Sensor 1 — semantic trajectory** (→ phase, novelty, diversity, drift).
- **Sensor 2 — structure graph** (→ RSI, hierarchical coherence, turnover, March).
- **Sensor 3 — value registry** promises→actions→effects (→ value per cycle, cost, promises kept).
- **Metronome — versioned direction** (labels adaptation versus drift).

The catalogue of ~20 metrics becomes a diagnostic manual: a posteriori queries on the sensors, recomputable retroactively — the journal's central property. Day-1 minimum: phase + relaxation + value.

**E/E by embeddings, not by dictionaries.** Uotila's textual ratio is abandoned as too fragile (synonyms, paraphrases). The method is: journal windows → embeddings → trajectory in semantic space; exploration and exploitation are two reference poles (prototype texts), and the phase is the trajectory's position between the poles. The embedding model is **frozen** at the start; fine-tuning only if the noise is excessive (YAGNI). Published precedents: SemNovel (2025, novelty = distance to the past in a "semantic universe", validated) and semantic drift by cosine distance on agent logs (arXiv:2601.17617). Honest limitation: embeddings measure movement, not intention → mandatory cross-checking with the versioned direction.

**Temporal novelty.** Novelty is "an action never seen before" OR "an old action in a new world", where the world is the org + direction + current knowledge. An old action in an unchanged world is repetition; an old action in a changed world is legitimate re-exploration. This makes cycles measurable without a false "non-explorer" diagnosis.

### Feasibility and attack handling

The metrics exist individually (~70%); the unified instrument is virgin territory, and that is the contribution. Nobody has demonstrated the impossibility: the theorems constrain optimization, not observation. The self-evolution trilemma (Wang 2026) proves that external human steering is *necessary* — which is the concept of the project.

Attacks handled by design: **sycophancy** (→ fidelity to actions), **meltdown loops** (→ measured time-to-meltdown), **emergence theater** (→ anti-imitation tests, out-of-corpus forms), **variance and noise** (→ experimental protocol).

## 7. Research backing

- **Kernel mechanics** — [research/harness-deep-dive.md](research/harness-deep-dive.md): a single mutation gate (`effect(install) → disposer`, inverses composed in LIFO order; Cordis fits in ~2000 lines); the dsh-session journal (log = the only truth, everything else is a projection; "model-visible means logged"; `{type, contiguous seq, time, data}`; extensibility with a required refusal to read an unknown type); the chat as a second application on top of the same kernel (Chat and Trajectory are two projections of the same stream, and human input enters through the same inbox as everything else); the identified gap we fill — in DeepSeek Harness self-written plugins live in memory only and are lost on restart, whereas ours must persist (journal + persistent modules); **confluence (Th. 80)** — the final state depends only on the final config, not on the order, a decisive property for a self-modifying system.
- **Models** — [research/models-overview.md](research/models-overview.md). No hardware constraint: the "local Qwen on a 3090" prerequisite is dropped (local inference remains available for free routing and summaries). Candidates to test (price per M tokens in/out):
  - **GLM-5.3-Flash** ($0.075/$0.25) — best measured intelligence/price ratio → agents in volume
  - **DeepSeek V4.1 Flash** ($0.15–0.30/$0.60–1.20, cache hit $0.003, MIT) — no independent eval yet
  - **GLM-5.3** ($1.40/$4.40) — no. 1 open weights on the Intelligence Index → orchestrator
  - **Kimi K2.7 Code** ($0.95/$4.00) — 12h+ sessions / 4000 tool calls, ~30% fewer reasoning tokens
  
  Cost lever no. 1 is the **cache hit rate** (a ×30 spread at DeepSeek) → a design consequence for context assembly.
