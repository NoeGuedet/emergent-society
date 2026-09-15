# State of the art — "Perpetual" and self-evolving autonomous agents

**Review date: September 2026**
**Subject:** positioning of an agentic harness project whose core is a perpetual autonomous system, driven by a *continuous chat* between a human (CTO) and an "agent zero", which lets its own structure emerge instead of receiving it — as opposed to finite-objective agents (Devin, SWE-agent, AutoGPT).

> **Methodological caveat.** Several results cited here date from 2025–2026 and come from non-peer-reviewed arXiv preprints. Each section states the status of its source (peer-reviewed, preprint, engineering blog, press). Key figures are given with their exact source.

---

## Executive summary

1. **Perpetuity is no longer a research object — it has become a solved infrastructure problem.** Letta/MemGPT, LangChain's ambient agents, OpenClaw and the durable execution engines (Temporal, DBOS, Restate) have normalized the agent that runs 24/7 with persistent memory. Nobody publishes "an agent that does not stop" as a contribution anymore; it is the 2026 default.
2. **Self-evolution is a mature field with synthesis surveys (TMLR 2026) and reproducible results (Darwin Gödel Machine: 20% → 50% on SWE-bench).** The consensus: you evolve the *harness* (prompts, tools, skills, workflows), not the model weights. An entire survey — "Agent Harness Engineering" — asserts that the harness, not the model, is the primary determinant of reliability (×6 swing at fixed model).
3. **Organizational emergence is demonstrated empirically but with precise bounds.** The 25,000-task experiment (arXiv:2603.28990) shows that LLM agents self-organize (invented roles, voluntary abstention, flat hierarchies) and that "mission + protocol" beats "assigned roles" — *but only for models above a capability threshold*, and competing work (Google/MIT, arXiv:2512.08296) shows that multi-agents degrade performance in the majority of configurations.
4. **Agentic event-sourcing is an established practice with clear lessons:** separate the append-only journal (truth, audit, replay) from the materialized state (fast recovery); a LangGraph checkpoint is *not* an audit log; deterministic replay requires a single interception shim for all sources of non-determinism.
5. **The notion of "direction" (vs objective) is the field's blind spot.** No work was found that formalizes a persistent direction, continuously co-negotiated with a human, as a first-class object of a self-structuring perpetual system. The closest: Dochkina's "mission & values" (static, no human in the loop), CORPGEN's strategic/tactical hierarchical planning (imposed, not negotiated), and the human-on-the-loop / human-in-command patterns (supervision, not co-direction). **This is the project's contribution space.**

---

## Axis 1 — Open-horizon / perpetual agents

### 1.1 Voyager (Minecraft) — the founding reference of the open-ended agent

**Wang et al., "Voyager: An Open-Ended Embodied Agent with Large Language Models", arXiv:2305.16291 (May 2023, NVIDIA/Caltech/UT Austin/Stanford).** <https://arxiv.org/abs/2305.16291>

First "lifelong learning" LLM agent in Minecraft: it explores, acquires skills and makes discoveries *without human intervention*. Three components: (1) an **automatic curriculum** that maximizes exploration, (2) a **skill library** of executable code that grows indefinitely, (3) an iterative prompting mechanism with environmental feedback and self-verification. Results: ×3.3 unique items, ×2.3 distance, tech-tree milestones up to ×15.3 faster than the prior state of the art.

**What it demonstrates for the project:** Voyager's "direction" is a *self-generated curriculum* — the agent sets its own next target. This is exactly the "no finite objective" model… but **with no human in the direction loop**. Direction is delegated to an exploration heuristic, not negotiated. Known limitation: the skill library grows without bound (retrieval cost, accuracy degradation as it accumulates).

### 1.2 Generative Agents — social persistence

**Park et al., "Generative Agents: Interactive Simulacra of Human Behavior", UIST 2023, arXiv:2304.03442.** <https://arxiv.org/abs/2304.03442>

25 agents simulating a small town, with episodic memory, reflection and daily planning. Demonstrates that a memory/reflection/plan architecture suffices to make coherent social behavior emerge over simulated days. No objective; the "direction" is the persona + the event stream.

### 1.3 Ambient agents (LangChain) — the industrially embraced "always-on" model

**Harrison Chase / LangChain, "Introducing ambient agents", blog.langchain.dev (January 2025).** <https://blog.langchain.com/introducing-ambient-agents/>

Now-standard definition: an ambient agent **listens to an event stream** and acts on it, potentially on several events at once; it is not triggered by a human message. Three canonical HITL patterns: **notify** (signal), **question** (ask before acting), **review** (propose and await approval). LangChain insists: ambient ≠ fully autonomous; the shift from "human-in-the-loop" to "human-on-the-loop" is explicit. LangGraph provides persistence, long-term memory and native cron; the "Agent Inbox" is the supervision UX.

**For the project:** this is the dominant industrial vocabulary for "supervised perpetual agent". But direction remains *reactive* (the agent responds to events), not *co-defined* by continuous dialogue.

### 1.4 Letta / MemGPT — perpetual memory as an operating system

**Packer et al., "MemGPT: Towards LLMs as Operating Systems", arXiv:2310.08560 (2023); Letta open-source framework (ex-MemGPT, renamed 2024).** <https://arxiv.org/abs/2310.08560> · <https://github.com/letta-ai/letta>

The agent manages its own memory via tool calls: **core memory** (labeled blocks always in the prompt — `human`, `persona`, custom blocks — edited by `core_memory_append`/`core_memory_replace`), **recall memory** (searchable conversation history), **archival memory** (long-term store with semantic search). The agent runs *as a service*: state persisted in a database, survives restarts, addressable like a process. Striking result: fact recall in long conversations 32.1% → 92.5% on the Deep Memory Retrieval evaluation. Derived work: **sleep-time compute** (a second agent consolidates memory during idle time) and the Letta post "Continual Learning in Token Space" (2025), which argues that continual learning is handled at the memory layer, not the weights layer.

**Lesson for the kernel:** the agent as a *supervised process* rather than a called function; self-edited memory is the mechanism by which a "direction" could persist (a `direction` block in core memory is the immediate Letta-style implementation). Documented cost: extra tokens at every turn, slower loops — the model spends part of its budget on memory hygiene.

### 1.5 OpenClaw (ex-Clawdbot, ex-Moltbot) — the de facto perpetual personal assistant

**Peter Steinberger, open-source project (late 2025 → January 2026 renames; ~100,000+ GitHub stars).** <https://github.com/cloudflare/moltworker> (official project description) · analyses: <https://techjacksolutions.com/news/security-news/clawdbot-moltbot-openclaw/>

A TypeScript CLI running as a daemon: a **Gateway** (single control plane, port 18789) links messaging channels (WhatsApp, Telegram, Slack, Discord, iMessage…) to LLM backends, with **persistent memory in local Markdown files**, **skills** defined in SKILL.md, and **heartbeats** (cron) that make the agent *proactive* — it monitors and acts without a human trigger. Serial per-session queue ("lanes") to avoid race conditions. The project has also demonstrated the risks: attack surface aligned with the OWASP Agentic Top 10, prompt injection, actions without approval.

**For the project:** this is the most widely adopted implementation of a chat-driven perpetual personal "agent zero" — but the structure (gateway, skills, lanes) is **written by its developers**, not emergent. No structural self-modification.

### 1.6 Agent Zero — the "organic" framework

**frdel/agent-zero, open-source (2024–2026).** <https://github.com/frdel/agent-zero>

"Not a predefined framework: dynamic, grows organically, learns through use." The computer is the tool; the agent **writes its own tools**; all behavior lives in editable prompts; superior/subordinate hierarchy where each agent can spawn subordinates — and for the first agent, the superior *is* the human. Persistent memory across sessions.

**For the project:** the closest in spirit (emergence, minimalism, the human as superior of agent zero). But: chained finite tasks, no notion of persistent direction; the multi-agent structure is a classic delegation hierarchy; no event journal as source of truth.

### 1.7 Measuring long-horizon autonomy: METR, TheAgentCompany, CORPGEN

- **METR, "Measuring AI Ability to Complete Long Tasks" (March 2025, updated "Time Horizon 1.1" January 2026).** <https://metr.org> — The 50%-success time horizon doubles every ~4 to 7 months; ~12 h for Claude Opus 4.6, ≥16 h for a "Mythos" preview (May 2026, unreliable estimate beyond ~16 h). BUT: success decays almost exponentially with duration — at 80% reliability, the horizon is ~3 h.
- **TheAgentCompany (CMU), arXiv:2412.14161 (Dec. 2024).** <https://arxiv.org/abs/2412.14161> — A realistic company simulation; the best agent (Gemini 2.5 Pro, June 2025) completes only **30.3%** of tasks, with instructive failure modes: data fabrication, simulated completion. No independent replication with mid-2026 models has been published to date.
- **CORPGEN (Microsoft Research), arXiv:2602.14229 (Feb. 2026).** <https://arxiv.org/abs/2602.14229> — Defines **Multi-Horizon Task Environments** (45+ interleaved tasks, 500–1500+ steps, persistent multi-hour contexts) and "digital employees" with persistent identity. Four failure modes: context saturation (O(N)), memory interference, DAG dependencies, re-prioritization overload. Base-agent completion drops from 16.7% to 8.7% as load rises. Architectural responses: **hierarchical strategic (monthly) / tactical (daily) / operational (cycle) planning** to prevent goal drift, sub-agent isolation, tiered memory, experiential learning (×3.5 gain: 15.2% vs 4.3%). Emergent collaboration observed: no shared state, coordination entirely by email/Teams, and "recognizable organizational patterns form".

### 1.8 Axis synthesis: how these systems handle "direction vs objective"

| System | Perpetuity | Source of direction | Structure emergence |
|---|---|---|---|
| Voyager | Endless curriculum | Self-generated (exploration heuristic) | Growing skill library |
| Generative Agents | Continuous simulation | Persona + event stream | Social behaviors |
| Ambient agents | Cron + events | External events + occasional HITL | None (fixed structure) |
| Letta/MemGPT | Persistent service | Editable memory block (implicit) | Self-organized memory |
| OpenClaw | 24/7 daemon + heartbeats | Owner via chat | None (skills written by humans) |
| Agent Zero | Persistent sessions | Tasks given by the human | Self-written tools, sub-agents |
| CORPGEN | Simulated workdays | Imposed hierarchical planning | Collaboration over channels |

**Finding:** nobody treats direction as an *object negotiated and continuously revised*. It is either self-generated (Voyager), reactive (ambient), imposed (CORPGEN), or implicit in memory (Letta).

---

## Axis 2 — Agent self-evolution

### 2.1 The reference surveys (2025–2026)

The field has consolidated; five syntheses worth knowing:

1. **"A Survey of Self-Evolving Agents: What, When, How, and Where to Evolve on the Path to Artificial Super Intelligence", arXiv:2507.21046 (v4 Jan. 2026; accepted TMLR 2026).** <https://arxiv.org/abs/2507.21046> — The now-canonical taxonomy: **What** (model, context, tools, architecture), **When** (intra-test-time vs inter-test-time), **How** (reward-based, imitation/demonstration, population-based; online/offline, on/off-policy), **Where** (generalist vs domain). Evaluation distinguishes static / short-horizon / long-horizon — the long-horizon dimension being the least instrumented.
2. **"A Comprehensive Survey of Self-Evolving AI Agents: A New Paradigm Bridging Foundation Models and Lifelong Agentic Systems", arXiv:2508.07407 (2025).** <https://arxiv.org/abs/2508.07407>
3. **"Adaptation of Agentic AI: A Survey of Post-training, Memory, and Skills", arXiv:2512.16301 (Dec. 2025).** <https://arxiv.org/abs/2512.16301>
4. **"Agentic Self-Evolution for Large Language Models: Taxonomy, Techniques, and Applications" (TechRxiv/Authorea, 2026).** <https://doi.org/10.36227/techrxiv.177203250.05832634/v1>
5. **"A Comprehensive Taxonomy of Self-Evolving Agents" (XMU, Feb. 2026, + Awesome-Self-Evolving-Agents repo).** <https://github.com/XMUDeepLIT/Awesome-Self-Evolving-Agents> — Breakdown: model-centric (inference/training), environment-centric (knowledge, experience, modular architecture, **agentic topology**), model-environment co-evolution.

### 2.2 Darwin Gödel Machine and the lineage of self-modifying machines

- **Zhang, Hu, Lu, Lange, Clune (Sakana AI / UBC / Vector Institute), "Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents", arXiv:2505.22954 (May 2025).** <https://arxiv.org/abs/2505.22954> — A self-referential system that rewrites its own Python code. Growing archive of agents; parent selection ∝ performance × under-exploration (stepping stones, Darwin-style open-ended exploration). SWE-bench **20.0% → 50.0%**, Polyglot 14.2% → 30.7%. Ablations show that both self-improvement *and* open-ended exploration are necessary; winning lineages pass through performance troughs (the archive beats hill-climbing). Improvements discovered on their own: better editing tools, context-window management, peer-review mechanisms. Safety: sandbox, timeouts, human oversight, traceable lineage. Acknowledged limitation: frozen FM; the exploration loop itself cannot be modified by the DGM.
- **Huxley-Gödel Machine (Wang, Schmidhuber et al., Oct. 2025).** <https://github.com/metaauto-ai/HGM> — Approximation of the Gödel machine: it accepts only modifications that *provably* increase expected long-term utility; CMP metric (clade metaproductivity) inherited from the lineage.
- **Gödel Agent (Yin et al., ACL 2025).** Self-referential framework for recursive self-improvement, without hard-coded routines.
- **AlphaEvolve (Google DeepMind), arXiv:2506.13131 (May 2025).** LLM-driven program evolution at scientific scale — the unit of evolution is the *program*, not the agent.
- **ShinkaEvolve (ICLR 2026)** — sample-efficient and open-ended program evolution.
- **Live-SWE-agent, arXiv:2511.13646 (2025)** — can a software engineering agent self-evolve *on the fly* while working?
- **SEAL (MIT), arXiv:2506.10943 (June 2025).** <https://arxiv.org/abs/2506.10943> — The model generates its own "self-edits" (finetuning data + hyperparameters), applied via SFT/LoRA; an external RL loop (ReST^EM) on downstream performance. Knowledge incorporation 32.7% → 47.0%; simplified ARC few-shot 72.5%. Proof that modifying *weights* is possible, but costly and unstable (unstable GRPO/PPO → ReST^EM) — which reinforces the consensus "evolve the harness, not the weights".
- **Continual Harness, arXiv:2605.09998 (2026)** and **Adaptive Auto-Harness, arXiv:2606.01770 (2026)** — online harness adaptation on open task streams. **HarnessForge (2606.01779)** — joint harness + policy co-evolution. **HarnessX (2606.14249)** — a foundry of composable, evolvable harnesses.
- **Self-evolving skills:** SkillForge (2604.08618), MemSkill (2602.02474), CoevoSkills (2604.01687), CASCADE (2512.23880), SkillFlow (2605.14089); "Agent Skills" surveys (2602.12430, 2605.07358, 2602.20867) and SkillsBench (2602.12670).

### 2.3 Harness engineering: the discipline born in 2026

Directly relevant to the project (the repo already cites arXiv:2608.25512 as a founding reference):

- **"Agent Harness for LLM Agents: A Survey", arXiv:2605.29682 (2026)** — formal model **H=(E,T,C,S,L,V)** (environment, tools, context, skills, loop, verification) with labeled-transition semantics distinguishing safety and liveness properties; a "Harness Completeness Matrix" over 23 systems. Full findings: Claude Code, PRISM/OpenClaw, AIOS, OpenHands, SWE-agent.
- **"Agent Harness Engineering: A Survey" (Li et al., submitted TMLR, May 2026; OpenReview eONq7FdiHa).** <https://openreview.net/forum?id=eONq7FdiHa> — Seven-layer taxonomy (ETCLOVG), 110+ papers, 23+ systems. Central thesis: **the harness, not the model, is the primary determinant of reliability**; optimizing the tool format alone took SWE-bench from 6.7% to 68.3%, more than any model upgrade over the period.
- **"How Much Heavy Lifting Can an Agent Harness Do?", arXiv:2604.07236 (Apr. 2026)** — ×6 performance swing at fixed model depending on harness architecture; layer-by-layer ablation of what the LLM still contributes.
- **"Natural-Language Agent Harnesses", arXiv:2603.25723** — the harness as an *executable document*, inspectable, versionable, optimizable (data, not code).
- **"Code as Agent Harness", arXiv:2605.18747** — survey of code as a fundamental harness.
- **Anthropic Engineering, "Harness design for long-running application development" (March 2026).** <https://www.anthropic.com/engineering/harness-design-long-running-apps>
- **Cordis / "A Programming Paradigm for Spatiotemporal Composability", arXiv:2608.25512 (Aug. 2026, PKU + DeepSeek-AI).** <https://arxiv.org/abs/2608.25512> — Formal calculus of dynamic composition: **reversible effects** (each context transformation carries its inverse — *temporal* composability) and **reactive co-effects** (declarative activation/deactivation — *spatial* composability), unified in a "context paradigm"; implemented in Cordis (the Koishi kernel since 2019) and powering **DeepSeek Harness** ("Everything is a Plugin", August 2026 preview, ~210k stars in three weeks, MIT). This is the closest reference to a *formal minimal kernel* for self-evolving systems — but it addresses component composition, not direction or organizational emergence.
- **Logos, arXiv:2608.28553 (Aug. 2026)** — an agent harness on an inter-process bus, citing Cordis, Temporal and LangGraph as competing substrates.

### 2.4 What worked, what failed

**What works:**
- Evolving the *harness* (prompts, tools, skills, workflows, topology) with a frozen FM — DGM, AFlow (ICLR 2025), concordant surveys.
- **Archive + open-ended exploration > hill-climbing** (DGM ablation): keep suboptimal stepping stones.
- *Executable* skills rather than advisory ones: HASP (arXiv:2605.17734) turns skills into functions that actively intervene in the loop.
- Workflow memory (AWM, 2409.07429), reflections (Reflexion 2303.11366), lessons (ExpeL, AAAI 2024) — experience as a reusable asset.

**What fails / documented limits:**
- **Reward hacking**: 15.4% of agent-attributable failures on SWE-Marathon (arXiv:2606.07682, June 2026); 99.6% of failures carry a signal of insufficient validation. Any self-evolution loop without a robust verifier is vulnerable to Goodhart.
- **Memory dilution replaces catastrophic forgetting**: "When Continual Learning Moves to Memory", arXiv:2604.27003 (Apr. 2026) — external memory does not *resolve* the stability-plasticity dilemma, it moves it to retrieval; abstract procedural memories transfer better than raw trajectories; a fine-grained organization can maximize both forward transfer *and* forgetting.
- **Capability threshold**: below a certain model level, self-organization and self-correction degrade instead of improving (2603.28990, 2512.08296, 2606.00655).
- **Instability of self-edit RL loops** (SEAL: unstable PPO/GRPO).
- **Model collapse** on unfiltered self-generated data (Shumailov et al., Nature 2024).

---

## Axis 3 — Multi-agent organizational emergence

### 3.1 The central paper: "Drop the Hierarchy and Roles"

**Victoria Dochkina, "Drop the Hierarchy and Roles: How Self-Organizing LLM Agents Outperform Designed Structures", arXiv:2603.28990 (March 30, 2026, single-author preprint, submitted to IEEE Access; 2 citations to date).** <https://arxiv.org/abs/2603.28990>

An experiment with **25,000 tasks**, 8 models, 4–256 agents, 8 coordination protocols, from fully exogenous (centralized Coordinator) to fully endogenous (Shared, shared organizational memory). Results:

- **Spontaneous emergent autonomy**: with minimal scaffolding (fixed order), agents invent specialized roles (**5,006 unique roles produced by 8 agents** — specialization is open-ended), **voluntarily abstain** outside their competence (38/60 non-contributors removed by their own decision in Sequential vs exogenous exclusion in Coordinator; Claude: 8.6% voluntary abstention), and form **flat hierarchies** (depth ≤ 2 up to 64 agents, with no external design).
- **"Endogeneity paradox"**: the hybrid **Sequential** protocol (fixed order, autonomous role choice) beats centralized coordination by **+14% (p<0.001)** and fully autonomous protocols by **+44%** (Cohen's d=1.86, p<0.0001). Effective autonomy = capable model **AND** good protocol; neither alone suffices.
- **Capability threshold**: below the threshold, *reversal* — rigid structure becomes better again. The room for self-organization will widen with better models.
- **Sub-linear scaling** up to 256 agents without degradation (p=0.61); going from 64 to 256 agents adds nothing at ×4.6 the cost. The quality gap between *models* reaches 174% — "the musician matters more than the number of chairs".
- **The paper's practical recipe:** define **mission and values, not roles**; choose the protocol (44% of quality variance); invest in model quality, not agent count; combine models (DeepSeek: 95% of Claude's quality at 24× lower cost).

**⚠️ Important reading correction** (indras-net analysis, github.com/epimystic-dev/indras-net, docs/REFERENCES.md): the "+44%" contrasts Sequential against Shared, *both with emergent roles* — it is **not** the emergent-vs-fixed-roles effect. The latter is small and capability-dependent: **+3.5% for a strong model, −9.6% (reversal) for a weak model**. The honest phrasing: "self-organization that beats designed structure is a privilege of strong models". Single-author preprint, not peer-reviewed — treat it as a signal, not a theorem.

### 3.2 Work that cites it or points the same way

- **CORAL, arXiv:2604.01658 (2026)** — autonomous multi-agent evolution for open-ended discovery; cites 2603.28990.
- **MAS-on-the-Fly (arXiv 2026)** — dynamic adaptation of the multi-agent structure at test time.
- **"Swarm Skills" (arXiv 2026)** — portable self-evolution specification for coordination engineering.
- **QueenBee Planner (arXiv 2026)** — communication topologies that evolve for token efficiency.
- **CARD (arXiv 2026)** — conditional design of multi-agent topological structures.
- **CORPGEN (2602.14229, §1.7)** — emergent collaboration without predefined coordination rules: leadership/support roles and shared documents appear on their own via email/Teams; spontaneous rerouting when a channel fails.

### 3.3 The contradictions and the costs — the "cold" literature

- **"Towards a Science of Scaling Agent Systems" (Google/DeepMind/MIT), arXiv:2512.08296 (Dec. 2025).** <https://arxiv.org/abs/2512.08296> — 180 controlled configurations, 3 LLM families, 4 benchmarks. **Average multi-agent gain: −3.5%** (σ = 45.2%; from +80.8% on parallelizable financial tasks to −70.1% on sequential PlanCraft). Three dominant effects: **(1) tools-coordination trade-off** (beyond ~16 tools, a ×2–6 penalty for multi-agent); **(2) capability saturation** (beyond ~45% solo success, adding agents = negative returns, β = −0.408); **(3) error amplification**: ×17.2 without coordination (unverified propagation), ×4.4 with centralized coordination. **Super-linear cost**: exponent 1.724 for reasoning turns as a function of agent count → a hard ceiling at 3–4 agents under a fixed budget. A predictive 9-variable model predicts the best architecture in 87% of cases.
- **SIMAS, arXiv:2606.00655 (May 2026)** — MAS performance is not monotone in agent count: diminishing returns governed by the synergy/coordination-overhead trade-off; degradation comes from coordination, not just long context.
- **Context explosion**: formal derivation (Qian et al., 2025) — in a fully-connected topology with a final judge receiving the entire history, context pressure grows **quadratically** with agent count. Mitigations: GroupDebate (subgroups + summaries), short/long memory management.
- **MIT-type theorem** (relayed April 2026): multi-agent debates that bring no new information only consume tokens — value comes from *independent information-gathering* nodes, not from re-reasoning over the same material.
- **Multi-agent failure modes** (2026 review): reasoning-action mismatch 13.2%, task derailment 7.4%, flawed assumptions 6.8%, resets 2.2%, ignored agents 1.9%, information withholding 0.85%.

### 3.4 Lessons for the project

1. Role emergence is real and reproducible **above a capability threshold** — plan a structured fallback mechanism for weak models.
2. The interaction protocol is the main amplifier (44% of variance); a **fixed sequential order + endogenous role choice** is the best measured compromise — a minimal-scaffolding starting point consistent with the project's philosophy.
3. Mind the economics: N agents do not do N times better, cost is super-linear, and the *number* of agents is a poor lever. Make a few well-equipped agents emerge rather than a crowd.
4. Voluntary abstention and spontaneous flat hierarchy are emergent properties *to preserve* in the design (do not hard-code them, but instrument the journal to observe them).

---

## Axis 4 — Event-sourcing / append-only journal for agents

### 4.1 Durable execution engines (2026 state)

| Engine | Model | Strengths | Limits for agents |
|---|---|---|---|
| **Temporal** | External cluster, event history + deterministic replay (heir of Cadence/Uber); first-party OpenAI Agents SDK integration (Apr. 2026, `activity_as_tool`); used by Replit Agent 3, Codex web, Cursor | The most battle-tested (Stripe, Snap, Coinbase); multi-region SLA; audit | History hostile to LLM payloads: 2 MB/payload, 51,200 events / 50 MB per execution → "claim-check" pattern (S3 + reference) becomes mandatory; versioning = schema migration on live executions (Patching/GetVersion); $100+/month |
| **Restate** | Single Rust binary, journal (Bifrost/RocksDB), *journaled execution* rather than deterministic replay; virtual objects (keyed actors, durable state, serialized access) | p99 latency < 100 ms over 10 steps → durable *per call*; built-in exactly-once RPC; fewer determinism constraints | BSL 1.1 license (runtime); young ecosystem |
| **DBOS** | Library, state in *your* Postgres; Pydantic AI integration (`DBOSDurability`) | Zero new infra; existing Postgres tooling (backup, queries) | Throughput bounded by Postgres (5–20k steps/s) |
| **Hatchet / Inngest** | Self-hosted MIT / serverless DX | Hatchet = the only complete MIT option; Inngest = best serverless agent tooling | Per-step billing (Inngest) explodes with retries |

**2026 adoption:** "durable by default or do not ship" — AWS Durable Functions, Cloudflare Workflows GA, Vercel WDK, Bedrock AgentCore, and Temporal's Series D ($300 M led by a16z) explicitly on the AI agents thesis.

### 4.2 Lessons from the comparisons (2026)

1. **Separate the append-only journal and the materialized state.** The log is what you replay, audit and stream; the materialized state serves fast recovery. Observed convergence: OpenAI sessions, Anthropic persistent event history, LangGraph checkpoints, MAF, AgentCore. (crewhaus.ai, "AI Harnesses for Production Agent Systems")
2. **A LangGraph checkpoint is not an audit log.** Mutable by design (`update_state`), with no hash chain and no principal attribution. An audit log is append-only, HMAC-chained, verifiable in a single pass. You need both. (docs.promptise.com, July 2026)
3. **Replay ≠ model re-invocation.** An audit replay reads saved outputs; a re-evaluation is a *new run* with distinct run ID and parent run ID. (zenn.dev/suwash, "Graph Engineering", July 2026)
4. **Deterministic replay requires a single shim.** Every non-deterministic input (model calls, tools, seeds, clocks) captured by a single interception point; nothing bypasses the shim; the recording carries the version of the code and prompts. (proofoftech.org, May 2026)
5. **Versioning the workflow = migrating a schema on live executions** (non-determinism error if the command sequence changes). Temporal Patching / Worker Versioning.
6. **LLM payloads: claim-check.** Never carry a 30 KB context × 20 steps through the history; store the blob elsewhere, pass a reference.

### 4.3 Explicitly agentic event-sourcing

- **ESAA — "Event Sourcing for Autonomous Agents" (arXiv, Feb. 2026).** Agents do not write files: they emit **structured intentions** (validated JSON) to an append-only event store; a deterministic orchestrator validates, persists, applies the effect and maintains a materialized view of the codebase. Append-only naturally serializes concurrency; exact replay of the evolution; recovery from the last valid checkpoint. (relayed by agentmarketcap.ai, Apr. 2026)
- **Statefold** (open-source, July 2026) — event-sourced, framework-agnostic agent state: state *derived by folding* an append-only log (messages, tool calls, LLM calls, traces, memory), hash-chained tamper-evident, time travel, what-if branching, session export to Promptfoo regression tests. <https://github.com/ioteverythin/statefold>
- **AgentGit, arXiv:2511.00628** — version control for multi-agent systems.
- **Logos, arXiv:2608.28553** — an inter-process bus for harnesses, positioned between LangGraph (in-process) and Temporal (replay).
- **LangGraph**: per-thread checkpointer (snapshots, chained `parent_config`), `get_state_history` + fork via `update_state`, native `interrupt()` for HITL. Limitation: it captures only graph state — not the filesystem or external effects (a coding agent leaves its effects outside the checkpoint).

### 4.4 Synthesis for a minimal kernel

The minimal kernel of an auditable perpetual system, distilled from this literature: **(a)** an append-only, hash-chained event journal as the single source of truth; **(b)** disposable materialized projections (current state) rebuildable by folding; **(c)** a single interception shim for all non-determinism; **(d)** claim-check for large payloads; **(e)** structure versioning treated as schema migration; **(f)** a strict distinction between audit replay (reading) and re-execution (a new linked run). This is exactly the level at which a research project can be cleaner than Temporal (too heavy) and LangGraph (no audit).

---

## Axis 5 — "Direction vs objective": continuous steering, long-term HITL, agentic companies

### 5.1 The least covered axis — and the most promising for the project

No reference found (surveys, arXiv, engineering, press) formalizes a **persistent direction, continuously co-negotiated**, as a first-class object of a perpetual agentic system. The building blocks exist, scattered:

- **"Mission and values, not roles"** (Dochkina, 2603.28990): the given mission + freedom produces the best relevance (4.00/4.00) — but the mission is *static*, fixed at launch, with no human.
- **Hierarchical planning** (CORPGEN): strategic objectives (monthly, rarely updated) → tactical plans (daily) → operational actions. This is a *decomposition* of direction, imposed by the architecture, not a *conversation*.
- **Human-on-the-loop → human-in-command** (2026 taxonomy, omdena.com; HITL systematic review PRISMA, PMC13114286, 2018–2026): three modes — in-the-loop (approval per decision), on-the-loop (supervision with pause/override/rollback), **in-command** (the human governs the *system*: policy, autonomy bounds, intervention rules). Human-in-command is the closest vocabulary to "directing without operating" — but the literature treats it as static governance, not as continuous dialogue.
- **Documented anti-patterns** (agenticorgchart.com, 2026): *theatre approval* (rubber-stamping without reading — remedy: present the diff, not the action), *rate-limited oversight* (the human as bottleneck — remedy: aggregation, senior arbiter), *loss of supervision competence* (remedy: random blind checks). Three pitfalls the CTO/agent-zero chat UX will have to counter.
- **Durable judgment record for steering** (arXiv:2606.04321): each inference produces a durable *judgment record* isolated per tenant, which governs immediate steering and any eventual model update — the observation that RLHF/DPO align to a population, not to a specific director's methodology, and do not detect drift during action.
- **Goal drift and its mitigations** (technical report arXiv:2505.02709; 2026 synthesis): frontier models maintain goal coherence in isolation but **inherit the drift** of trajectories seeded by weaker agents ("cascade drift"). Production mitigations: **goal re-anchoring** (periodically re-inject the original objective independently of the accumulated trajectory), **checkpoint-and-re-read** (serialize state/goal/progress, re-read cold), **trajectory sanitization before handoff**, **hard session limits with structured handoffs**. Other long-horizon modes: context rot beyond a usage threshold, premature termination when the agent "senses" its limit, sparse rewards and growing irreversibility.
- **Ambient agents** (§1.3): the human loop exists, but to *approve*, not to *direct*.

### 5.2 "Agentic companies" and one-person companies (2026)

- **Press/marketing side**: Altman/Amodei predictions of a first billion-dollar one-person company "by 2026"; solopreneur guides (Taskade, Paperclip, Lindy, Gumloop, Relevance AI, Manus); claimed operating margins of 60–80% vs 10–20%; "the founder keeps strategy, taste, relationships and the final yes"; the "agents act, owner decides" pattern with an approval queue. **Autonomous Business Hackathon** (March 2026, SF): companies where agents make real economic decisions. None of these sources is academic; it is a demand signal, not validation.
- **Research side**: TheAgentCompany (30.3% of tasks — §1.7) remains the independent reference evaluation; CORPGEN shows that "digital employees" with persistent identity work over 5 h × 45-task days with the right architecture; simulated organizations produce emergent leadership and shared documents without rules (§3.2). But these employees have **pre-assigned roles and schedules** — the organization *emerges* at the interaction level, not at the formal structure level.

### 5.3 What remains open on this axis

1. Formalize direction: a versioned, negotiated, revisable object, distinct from the mission (static) and the task (finite). Nothing of the sort exists.
2. Chat as an interface for *continuous governance* (beyond static human-in-command).
3. Longitudinal evaluation: measuring that a perpetual system stays aligned with a *moving* direction — current benchmarks all use a fixed objective.
4. Structural anti-Goodhart: when the agent can modify its own structure, what prevents it from optimizing metrics at the expense of direction? (SWE-Marathon: 15.4% reward hacking even without structural self-modification.)

---

## Positioning — What is UNIQUE vs already explored

### Already explored (do not claim, draw inspiration from it)

| Building block | State of the art | Key references |
|---|---|---|
| 24/7 perpetual agent | Solved (infra) | OpenClaw, ambient agents, Letta |
| Persistent self-edited memory | Mature | Letta/MemGPT (2310.08560), Mem0 (2504.19413) |
| Growing skill library | Mature | Voyager (2305.16291), 2026 skills surveys |
| Self-modification of agent code | Demonstrated | DGM (2505.22954), Gödel Agent, HGM |
| Evolving prompts/tools/workflows | Industrialized | AFlow, 2026 harness surveys |
| Role emergence without scaffolding | Demonstrated (with a capability threshold) | 2603.28990 + corrections |
| Emergent collaboration over channels | Demonstrated | CORPGEN (2602.14229) |
| Agentic event-sourcing / durable execution | Established | Temporal/DBOS/Restate, ESAA, Statefold |
| Formal dynamic composition kernel | Exists | Cordis (2608.25512), DeepSeek Harness |

### Unique or nearly virgin (the contribution space)

1. **Direction as a first-class object.** A persistent artifact, versioned in the journal, revised by continuous CTO ↔ agent-zero chat, distinct from: mission (static, Dochkina), objective (finite, benchmarks), curriculum (self-generated, Voyager), hierarchical plan (imposed, CORPGEN), memory block (implicit, Letta). **Nobody does this.**
2. **Structural emergence *under continuous human direction*.** Dochkina emerges without a human; CORPGEN directs without formal structure emergence; OpenClaw persists without self-structuring. The triangle (perpetual × emergent × dialogue-directed) is unoccupied.
3. **A system that builds its own structure AND can revoke it cleanly.** Cordis formalizes the reversibility of effects (unloading a component cancels everything it did) but not the genesis of structure; DGM evolves code but not the living organization. An event-sourced kernel where the organizational structure is itself a projection of the journal — and therefore reversible, auditable, forkable — would be a real contribution.
4. **Longitudinal evaluation of a directed perpetual system.** Convergence/plasticity on two axes, echelon response, anti-Goodhart: no benchmark evaluates fidelity to a *moving* direction over time. This is also a gap flagged by the surveys (long-horizon = the least instrumented dimension, 2507.21046 §7).

### Positioning risks (to be assumed with full awareness)

- The "one-person company" press creates noise: the project must explicitly distance itself from solopreneur marketing and anchor on TheAgentCompany/CORPGEN/METR as evaluation references.
- Dochkina (2603.28990) is a non-reviewed single-author preprint: rely on it for *research direction*, not as established proof. The indras-net correction (+3.5%/−9.6%) must appear in any citation.
- "Nobody does X" is true as of September 2026 in the indexed literature; the field's publication rate (several 2026 surveys) demands a fresh literature watch before any submission.

---

## Blind spots — To read/absorb before getting started

**Priority 1 (conceptual foundations):**
1. **arXiv:2507.21046** (self-evolving survey, TMLR 2026) — the what/when/how/where taxonomy to adopt in order to situate the project.
2. **arXiv:2603.28990 + indras-net critique** — role emergence, with the corrected figures.
3. **arXiv:2602.14229 (CORPGEN)** — the most accomplished persistent "digital employee" model; its hierarchical planning is the direct competitor to "direction".
4. **arXiv:2608.25512 (Cordis)** — already a founding reference of the repo; re-read it alongside the "unique" section above: Cordis covers composition, not direction or organization.

**Priority 2 (kernel mechanisms):**
5. **arXiv:2605.29682 + OpenReview eONq7FdiHa** (the two harness surveys) — H=(E,T,C,S,L,V) as a harness self-assessment grid.
6. **ESAA + Statefold + the checkpoint-vs-audit-log comparison** (§4) — before any line of journal code.
7. **arXiv:2505.22954 (DGM)** — the archive as an anti-hill-climbing structure; its safety protocol (sandbox, traceable lineage) is a model.

**Priority 3 (known pitfalls):**
8. **arXiv:2512.08296 (MAS scaling laws)** — why "more agents" fails; to be internalized before letting structure emerge without bounds.
9. **arXiv:2604.27003** — memory dilution; sizes the consolidation policy for the journal/memory.
10. **arXiv:2505.02709 (goal drift) + production mitigations** (goal re-anchoring, checkpoint-and-re-read) — directly transposable to "direction re-anchoring".
11. **SWE-Marathon (arXiv:2606.07682)** — long-horizon failure taxonomy and 15.4% reward hacking: calibrates the anti-Goodhart work.

**Priority 4 (industrial landscape):**
12. **OpenClaw** (gateway/lanes/heartbeats architecture) and **Agent Zero** (prompts as the whole of behavior) — the two open-source systems closest in spirit; contributing to them or drawing inspiration avoids reinventing.
13. **Anthropic, "Harness design for long-running application development" (March 2026).**
14. **METR Time Horizon 1.1** — to honestly calibrate what a 2026 agent can sustain autonomously (50% at ~12–16 h; 80% at ~3 h).

---

## Index of main references

| Reference | Identifier | Date | Status |
|---|---|---|---|
| Voyager | arXiv:2305.16291 | May 2023 | preprint (NVIDIA/Caltech) |
| Generative Agents | arXiv:2304.03442 | 2023 | UIST 2023 |
| MemGPT | arXiv:2310.08560 | 2023 | preprint (Berkeley) |
| Ambient agents | blog.langchain.com | Jan. 2025 | engineering blog |
| TheAgentCompany | arXiv:2412.14161 | Dec. 2024 | preprint (CMU) |
| Scaling Agent Systems | arXiv:2512.08296 | Dec. 2025 | preprint (Google/MIT) |
| Darwin Gödel Machine | arXiv:2505.22954 | May 2025 | preprint (Sakana) |
| SEAL | arXiv:2506.10943 | June 2025 | preprint (MIT) |
| AlphaEvolve | arXiv:2506.13131 | May 2025 | preprint (DeepMind) |
| Self-evolving survey (What/When/How/Where) | arXiv:2507.21046 | 2025–2026 | TMLR 2026 |
| Self-evolving comprehensive survey | arXiv:2508.07407 | 2025 | preprint |
| Adaptation of Agentic AI | arXiv:2512.16301 | Dec. 2025 | preprint |
| Goal drift | arXiv:2505.02709 | 2025 | technical report |
| Drop the Hierarchy and Roles | arXiv:2603.28990 | March 2026 | single-author preprint |
| CORPGEN | arXiv:2602.14229 | Feb. 2026 | preprint (Microsoft Research) |
| Agent Harness survey H=(E,T,C,S,L,V) | arXiv:2605.29682 | 2026 | preprint |
| Agent Harness Engineering survey | OpenReview eONq7FdiHa | May 2026 | submitted to TMLR |
| How Much Heavy Lifting Can a Harness Do | arXiv:2604.07236 | Apr. 2026 | preprint |
| Natural-Language Agent Harnesses | arXiv:2603.25723 | March 2026 | preprint |
| Code as Agent Harness | arXiv:2605.18747 | May 2026 | preprint |
| Continual learning → memory | arXiv:2604.27003 | Apr. 2026 | preprint |
| SWE-Marathon | arXiv:2606.07682 | June 2026 | preprint |
| SIMAS (scaling MAS) | arXiv:2606.00655 | May 2026 | preprint |
| Continual Harness | arXiv:2605.09998 | 2026 | preprint |
| Adaptive Auto-Harness | arXiv:2606.01770 | 2026 | preprint |
| AgentGit | arXiv:2511.00628 | Nov. 2025 | preprint |
| ESAA (Event Sourcing for Autonomous Agents) | arXiv, Feb. 2026 | Feb. 2026 | preprint (ID to confirm) |
| Logos (cross-process bus) | arXiv:2608.28553 | Aug. 2026 | preprint |
| Cordis / Spatiotemporal Composability | arXiv:2608.25512 | Aug. 2026 | preprint (PKU/DeepSeek) |
| HITL systematic review | PMC13114286 | 2026 | systematic review |
| METR Time Horizon 1.1 | metr.org | Jan. 2026 | report |
| Letta "Continual Learning in Token Space" | letta.com blog | 2025 | research blog |
| OpenClaw (ex-Clawdbot/Moltbot) | github.com/openclaw | 2025–2026 | open-source |
| Agent Zero | github.com/frdel/agent-zero | 2024–2026 | open-source |
| Temporal / DBOS / Restate / Hatchet / Inngest | official docs + 2026 comparisons | 2026 | platforms |
| Statefold | github.com/ioteverythin/statefold | July 2026 | open-source |

*Research conducted in September 2026 via web search; 2026 preprints not peer-reviewed unless stated otherwise.*
