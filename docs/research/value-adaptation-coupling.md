# Adaptation × value coupling — state of the art

**Subject.** The project runs a perpetual society of self-organizing LLM agents under a shifting human *direction* (a versioned direction artifact; heading changes are discrete, timestamped events in the world's git history). It needs a coupled measurement of (a) adaptive dynamics — exploration/exploitation, plasticity, relaxation time after a heading change, ossification — and (b) value produced, so that "evolves correctly" (converges after each heading, without ossification or chaos, while continuing to produce) is decidable from records. This file states what exists in the literature that the design uses, and what does not exist.
**Siblings.** [Perpetual agents](./sota-autonomous-agents.md) (general positioning); [Vision](../vision.md) (the perpetual × emergent × direction triangle).

## The coupling does not exist assembled

Three traditions each hold one piece:

1. **Quality-Diversity (QD)** is the only family with natively coupled metrics (behavioral diversity × local quality in a single algorithm), but its "quality" is a fixed fitness function, not a shifting human direction, and its objects are genotypes, not societies of conversational agents.
2. **LLM agent society evaluations** (GovSim, Project Sid) measure cooperation, resource survival and milestones — snapshots or end-of-game scores, never longitudinal series anchored on heading-change events.
3. **Intervention econometrics and resilience theory** provide exactly the before/after-a-shock tools (interrupted time series, counterfactual causal inference, critical slowing down), but no work applies them to the behavior journal of a steered agent society.

Consequently the project borrows triangularly: QD's coupled metrics as the *grammar*, ITS/CausalImpact protocols as the *experimental design* around each heading change, and Aubin's viability theory as the *formal framework* (a viability kernel = the set of states in which the society stays both adapted and productive).

## Quality-Diversity — the coupled-metrics grammar

- **Novelty search.** Lehman & Stanley, "Abandoning Objectives: Evolution through the Search for Novelty Alone", *Evolutionary Computation* 19(2):189–223 (2011): in deceptive domains, searching for behavioral novelty alone reaches the objective more often than searching for the objective. The design's anti-Goodhart argument — a pure value metric, optimized directly, destroys exploration.
- **MAP-Elites.** Mouret & Clune, arXiv:1504.04909: a grid of elites over behavior space, yielding an archive of diverse, locally optimal solutions. The archive *is* the reserve of adaptability. Its companion demonstrates damage recovery: Cully, Clune, Tarapore & Mouret, "Robots that can adapt like animals", *Nature* 521(7553):503–507 (2015) — adaptation to damage in minutes from a pre-computed diverse archive, a proto-"relaxation time after a shock".
- **POET.** Wang, Lehman, Clune & Stanley, arXiv:1901.01753 (short version: GECCO 2019): co-evolves generated environments with the agents that solve them; the minimal criterion (an environment survives only if it is neither too easy nor too hard for the current population; Brant & Stanley, "Minimal Criterion Coevolution", GECCO 2017) prefigures the chaos/ossification double threshold the project seeks. LLM-POET (Aki et al., GECCO '24 Companion, arXiv:2406.04663) mutates the environments with an LLM.
- **Observer-relative open-endedness.** Hughes et al., "Open-Endedness is Essential for Artificial Superhuman Intelligence", arXiv:2406.04268: open-endedness defined *relative to an observer* — artifacts continuously novel and learnable for that observer. Value is relational to the observer, which is exactly the human-direction/agentic-society structure; it provides no temporal metric and no post-change protocol.
- **LLM-as-judge of novelty and interest.** OMNI (Zhang, Lehman, Stanley & Clune, ICLR 2024, arXiv:2306.01711) and OMNI-EPIC (Faldor, Zhang, Cully & Clune, ICLR 2025, arXiv:2405.15568): a foundation model scores the novelty and interest of generated tasks — the pattern the project reuses to score society outputs against the current heading.
- **Agent self-evolution.** The Darwin Gödel Machine (Zhang, Hu, Lu, Lange & Clune, arXiv:2505.22954, ICLR 2026) evolves an archive of self-modifying coding agents and raises SWE-bench from 20.0% to 50.0% — the closest agent-evolution state of the art: a lineage under a coupled metric (archive = diversity, score = value), but a single agent per lineage, a static benchmark objective, no human in the loop, no temporal dynamics.

## Exploration/exploitation and measured evolvability

- **LLM agents under-explore.** Schmied et al., "LLMs are Greedy Agents: Effects of RL Fine-tuning on Decision-Making Abilities", arXiv:2504.16078: greediness, frequency bias and the knowing-doing gap measured across multi-armed bandits, contextual bandits and Tic-tac-toe; RL fine-tuning on self-generated CoT rationales *increases* exploration and narrows the knowing-doing gap. Bandits are the design's exploration probe; exploitation bias is the expected failure mode the metrics must detect.
- **Evolvability is measurable.** Reisinger, Stanley & Miikkulainen, "Towards an Empirical Measure of Evolvability", GECCO 2005 — an empirical measure of a representation's evolvability. The design's plasticity probe follows: sample N variations of an agent (prompt, role, tool perturbations) and measure the range of reachable behaviors.
- **Loss of plasticity.** Dohare et al., "Loss of Plasticity in Deep Continual Learning", *Nature* 632:768–774 (2024): continual learners measurably lose their capacity to learn (mitigated by continual backpropagation) — ossification demonstrated at the weights. The organizational analogue (frozen roles, crystallized communication topology, saturated skill repertoires) has no metrology; that absence is the project's opening.
- **The trade-off is temporal in organizations.** March, "Exploration and Exploitation in Organizational Learning", *Organization Science* 2(1):71–87 (1991): short-run gains from exploitation are paid for in long-run competence — the coupling of adaptation and performance over time, in implicit form.

## Viability theory — the formal framework

Aubin, *Viability Theory*, Birkhäuser Basel (1991): viability constraints (the acceptable states), the viability kernel (the states from which at least one evolution remains viable forever), and heavy solutions (change control only when viability demands it). The project states "evolves correctly" as persistent membership in a kernel {deviation from the current heading < threshold} ∩ {value production > floor} ∩ {plasticity > anti-ossification floor}, with heavy solutions as the minimal steering principle. Operationalizations remain the classical applications (autonomous racing, hybrid systems, process control); none exists for social multi-agent systems.

## LLM society evaluations — snapshots, not series

- **GovSim.** Piatti et al., "Cooperate or Collapse", NeurIPS 2024: agents manage a common pool resource; the metric is resource survival — an end-of-run scorecard, with no exogenous shock and no human direction.
- **Project Sid.** Al et al., arXiv:2411.00114 (Altera): many-agent Minecraft simulations with civilization-progress metrics over runs of hours/days; the PIANO architecture maintains real-time coherence. Progress curves exist, but the objective is implicit and fixed — no heading changes, no relaxation measurement.
- **CAMO.** Yu et al., "CAMO: An Agentic Framework for Automated Causal Discovery from Micro Behaviors to Macro Emergence in LLM Agent Simulations", ACL Findings 2026: causal discovery from micro behaviors to macro emergence in LLM agent simulations — proof that interventional analysis of LLM societies is practicable. It discovers causal structure; it does not measure post-event dynamics (relaxation, overshoot, plateau).

## Event-study tooling — mature, unassembled

- **Interrupted time series (ITS).** Bernal, Cummins & Gasparrini, *Int. J. Epidemiology* 46(1):348–355 (2017), the canonical tutorial: segmented regression around an intervention date, level and slope effects against a counterfactual.
- **CausalImpact.** Brodersen et al., *Annals of Applied Statistics* (2015; Google's R package): Bayesian structural time-series counterfactual on the pre-intervention period — the tool of choice for "quality of the new plateau" and the duration of the transitory regime.
- **Change point detection (CPD).** E.g. behavioral change point analysis (Gurarie et al. 2009; R package *bcpa*): identifying hidden shifts in the underlying parameters of a behavioral time series. Blind CPD against the journaled heading timestamp is the test that a heading actually bites; the lag between the two is the propagation latency.
- **Critical slowing down (CSD).** Scheffer et al., "Early-warning signals for critical transitions", *Nature* 461:53–59 (2009): as a regime transition approaches, the rate of recovery after perturbation decreases — measurable as rising lag-1 autocorrelation and variance. Relaxation time *is* the dynamic health metric in this tradition. Boettiger & Hastings, *J. R. Soc. Interface* (2012): detection limits are severe on short series — the calibration for how many events a measurement needs.
- **Temporal-graph anomaly detection.** Mature field, now applied to inter-agent LLM communication: GUARDIAN (NeurIPS 2025) models multi-agent collaboration as a discrete-time temporal attributed graph and flags anomalous nodes and edges; SAGA (arXiv:2607.17288) generates temporal agentic graphs with ground-truth anomaly labels. These flag anomalies for safety; they do not measure reorganization or ossification — anomaly flagging is not health metrology.

## "Direction" as a formal object

No surveyed work treats direction as a persistent, versioned artifact continuously revised through human-agent co-negotiation, distinct from a static mission and a finite objective. The nearest neighbors each cover one corner: non-stationary continual RL formalizes a moving *environment*, never an intentional human signal; human-ratified persistence exists for agent *memory* (arXiv:2605.04264) and for human-authored versioned mission packages ("Large Language Fields"), and versioned artifacts appear in workflow governance (arXiv:2609.35149) — never direction itself. The trichotomy mission / objective / direction is formalized nowhere.

## Gap scorecard

1. **Adaptive dynamics × value produced** — the coupling remains unclaimed in the produced-value sense; narrowed by CIVA (arXiv:2604.05339), which varies value interventions in an LLM-agent community and measures their propagation into macro-level dynamics — normative values, not value produced.
2. **Event-study methodology on agentic behavior journals** — absent for behavioral series after direction changes; narrowed on the operational side: a preprint applies ITS to production agent-system metrics, claiming "the first quasi-experimental methodology for measuring the operational impact of architectural changes" (Zenodo 19433217). "Relaxation time after a heading change", "overshoot", "quality of the new plateau" — still zero occurrences.
3. **Direction formalized nowhere** — holds.
4. **Measured evolvability for LLM-agent collectives** — no peer-reviewed work; narrowed by a preprint measuring behavioral inheritance and erosion in adversarially selected LLM-agent populations (Zenodo 20174100).
5. **Viability theory for social multi-agent systems** — holds (classical applications only).
6. **CSD / relaxation rate as an agent-society health metric** — holds; organizational ossification has no metrology.
7. **Temporal-graph anomaly detection on LLM communication graphs** — applied (GUARDIAN, SAGA), for anomaly flagging, not health metrology.

## Operational consequences

1. **Metrics grammar.** The double QD axis with two substitutions: quality → alignment with the current heading (an LLM judge in the OMNI style; observer-dependence per Hughes et al.); coverage → diversity of emergent structures (roles, topologies, repertoires).
2. **Experimental design.** Each heading change is an ITS intervention — latency (blind CPD vs the journal timestamp), relaxation time λ (exponential fit post-shock, Scheffer tradition), overshoot (max deviation before stabilization), plateau quality (CausalImpact vs counterfactual).
3. **Ossification sensor.** Rising autocorrelation of the metrics (CSD) + freezing of the communication graph (inter-snapshot distance → 0 despite new headings) + a periodic bandit probe (Schmied et al.) + evolvability by sampling variations (Reisinger et al.).
4. **Formal framework.** "Evolves correctly" = persistent membership in the viability kernel {heading deviation, production floor, plasticity floor}, with Aubin's heavy solutions as the minimal steering principle.
5. **Anti-Goodhart.** The novelty-search lesson (do not optimize the value metric directly) and the detection bounds (Boettiger & Hastings) constrain the metrics to observation, never reward.
