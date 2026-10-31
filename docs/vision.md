# Vision — the conceptual triangle

*Research hypothesis. The perpetual × emergent × co-negotiated-direction triangle names a gap: no surveyed work treats the direction of an LLM agent system as a persistent, versioned artifact continuously revised through human–agent chat co-negotiation (closest works: arXiv:2605.04264, human-ratified agent memory; "Large Language Fields", human-authored versioned mission packages). This is the project goal, not an established result.*

This document states what the project sets out to demonstrate, the design discipline it commits to, and the measurement concept behind the claim. It is the entry point of the design corpus: [seed.md](seed.md) (cold start), [direction.md](direction.md) (chat and direction), [kernel.md](kernel.md) (the runtime), [substrate.md](substrate.md) (the substrate as a treatment), [ROADMAP.md](../ROADMAP.md) (status and checkpoints), and [research/](research/) (the evidence base).

## 1. The heart of the experiment

An autonomous system that follows a direction defined by a continuous chat between a human and an agent zero, and that evolves over time — not a finite objective, not a loop that can be terminated. Only two things exist at the start:

1. **The chat with agent zero** — the single interface.
2. **The kernel** — async, event-native, one append-only frontier journal (plus each node's local cold-start log), effects hot-revertible.

Everything else is either the expected emergence (structure, roles, process) or long-term scope. A specification that accumulates **product** mechanisms — graduation, promotion dossiers, constitutional gates, attenuated delegable rights — imposes a structure exactly where the experiment wants to observe an emergent one; all of them are out of scope. If agent zero needs rights, it asks for them, and how it asks is experiment data, not specification.

## 2. The contribution: perpetual × emergent × co-negotiated direction

- **Perpetual** — solved in the state of the art (Letta, ambient agents, OpenClaw, durable execution engines). Not a contribution in itself.
- **Emergent structure** — explored. Dochkina (arXiv:2603.28990, single-author preprint, 25,000+ task runs) measures full autonomy as the worst protocol and minimal scaffolding — fixed order, self-chosen roles — beating the Coordinator by **+14%** (p<0.001); the best-to-worst spread is **44%** Sequential vs Shared (Cohen's d=1.86); the effect is capability-dependent: emergence helps a strong model (**+3.5%**) and hurts a weak one (**−9.6%**). This is why the design is model-agnostic and targets cheap/smart models rather than one tier of intelligence.
- **Co-negotiated direction** — the unclaimed leg: static missions (charters), finite objectives (benchmarks) and self-generated curricula (Voyager, arXiv:2305.16291) all exist; a persistent, versioned direction continuously revised through chat does not (see header).

**The triangle is the contribution; everything else stays minimal so as not to dilute it.**

## 3. The golden rules

- **Imposed physics, emergent organization.** Every kernel mechanism must be justified; otherwise it stays out. No organizational structure is coded — no roles, no workflow, no hierarchy vocabulary.
- **Every effect revertible.** Cordis-style revertibility (`effect → disposer`, inverses in LIFO order) is what makes operating live possible.
- **The frontier journal is the only truth.** Everything else — dashboards, metrics, agent memory, the per-node local log — is a disposable projection or a cold-start artifact; the world's git history is the second observation surface.
- **Metrics are invisible to the agents** (anti-Goodhart). Instrumentation lives outside the graph.
- **Fidelity is measured on acts, never on declarations.**
- **Autonomy is not a kernel concept.** The implemented physics is the frontier journal and the filesystem-confinement boundary. The kill switch is specified, not implemented; the budget ceiling is an upstream property of the API key, not a kernel mechanism. Graduation, if it exists, emerges as a request from agent zero through the chat.
- **Operating live is the concept.** The kernel exists for it; the mirror/fork/benchmark is a development methodology, not a law of the kernel.

## 4. What is measured: viability, not performance

The measure is viability — drift, recovery, persistence, alignment — not performance: at comparable budget per unit of time, does the society hold a coherent trajectory where a solo agent drifts or collapses. The direction is a first-class object that survives individual agents; agent zero is its guardian, the human its source; the cockpit is a navigation instrument (the trajectory), not a debug tool. The main risks are **ossification** and its mirror, **perpetual reorganization**.

Two memories, one boundary between them. The **observed memory** — the frontier journal plus the world's history — is physical: wired at the LLM-API and mediated-tool-call level, immutable, append-only, out of the agents' reach; a trace exists because the system acted, not because an agent declared it acted. The **useful memory** — whatever knowledge base the agents build — is emergent: its organization is experiment data (is a librarian observed? rot? memory rituals?), its content belongs to the agents, and its recorded effects remain visible through the journal and the world. No managed memory mechanism is provided; [seed.md](seed.md) gives the raw filesystem means and any memory emerges on its own.

## 5. The monitoring concept

Monitoring precedes all software design: the instrument defines the apparatus. The conceptual model is the **cycle**: heading change (a timestamped event) → rising exploration → relaxation → exploitation plateau (value) → new heading; the two diseases are ossification and perpetual reorganization. **Value is defined per cycle** — each heading crystallizes its own success proxy in the chat plus promises→actions→effects accounting on the journal and the world; there is no universal value metric.

| Family | Instruments | Key references |
|---|---|---|
| Explore/exploit phase | behavioral novelty, deliberation diversity, E/E by embeddings | Lehman & Stanley 2011; OASIS arXiv:2411.11581; Uotila, Maula, Keil & Zahra 2009 (SMJ 30(2)) |
| Post-heading convalescence | event study (delay, relaxation time, overshoot), critical slowing down | ITS/CausalImpact; Scheffer et al. 2009 (Nature 461) |
| Anatomy | role stability, trophic coherence (incoherence parameter q), March cascade (semantic distance, turnover, memory) | arXiv:2603.28990; March 1991; Johnson et al. 2014 (PNAS) |
| Compass | drift via actions vs inaction, drift-vs-adaptation detector via the versioned direction (the unique contribution), constraint violation rate | arXiv:2505.02709; arXiv:2606.22528 |
| Value | proxy negotiated per cycle + promises→actions→effects | — |

Structural reduction: three sensors — semantic trajectory (phase, novelty, drift), structure graph (role stability, coherence, turnover), value registry (promises→actions→effects) — plus the metronome: the versioned direction that labels adaptation versus drift. All instruments are computed on the frontier journal + the world, invisible to the agents, recomputable retroactively. E/E is measured by embeddings over journal windows against two reference poles (prototype texts), embedding model frozen at the start; precedents: SemNovel (J Biomed Inform 172:104952, 2025 — validated on biomedical literature) and cosine-distance trajectory metrics over agentic search logs (arXiv:2601.17617). Embeddings measure movement, not intention — the versioned direction is the mandatory cross-check. Temporal novelty: "an action never seen before" or "an old action in a changed world" (org + direction + knowledge); an old action in an unchanged world is repetition.

The instrument is specified, not implemented. Each family exists individually in the literature; no surveyed work combines the four families into one instrument for LLM agent societies (nearest neighbor: "Relational Cognitive Telemetry") — that unification is the intended contribution, and nobody has demonstrated impossibility: the theorems constrain optimization, not observation. The self-evolution trilemma (Wang et al., arXiv:2602.09877) shows that isolated self-evolution irreversibly erodes safety, and motivates **external oversight or novel safety-preserving mechanisms** — the concept of this project. Attacks handled by design: sycophancy (→ fidelity to acts), meltdown loops (→ measured time-to-meltdown), emergence theater (→ anti-imitation tests, out-of-corpus forms), variance and noise (→ experimental protocol).

## 6. Research backing

- **Kernel mechanics** — [research/harness-deep-dive.md](research/harness-deep-dive.md): the dsh-session journal protocol (log = the only truth; "model-visible means logged"; refusal to interpret unknown event types) is the reference ours keeps, with truth moved to the frontier journal and the per-node stream demoted to a cold-start log; the gap ours fills — in DeepSeek Harness, self-written plugin definitions are process-local and lost on restart, ours must persist. Confluence (Cordis, arXiv:2608.25512, Theorem 80): the quiescent state is a function of the final configuration alone — decisive for a self-modifying system.
- **Cache-aware context assembly** — model prices and cache-hit pricing vary across vendors and over time; the durable consequence is a kernel property: the context assembler produces byte-stable, cache-friendly requests.
