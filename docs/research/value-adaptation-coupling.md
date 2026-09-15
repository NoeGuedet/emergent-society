# Adaptation × value coupling — in-depth state of the art

**Review date:** September 11, 2026
**Subject:** a perpetual system of self-organizing LLM agents follows a shifting human *direction* (discrete heading changes, timestamped in an event journal). The goal is to **couple two families of metrics**: (a) adaptive dynamics (exploration/exploitation, plasticity, relaxation time after a shock, ossification) and (b) value produced — in order to know whether an agentic society "evolves correctly": it converges after each new heading, without ossification or chaos, while continuing to produce.
**Method:** 30 Google Scholar queries (scholar plugin), covering open-endedness, evolvability, viability theory, agent-based computational economics, LLM society benchmarks, event study / interrupted time series / change point detection, anomalies on temporal graphs, continual RL, dynamic alignment and oversight. Canonical references not returned by the queries but essential to the narrative thread are flagged **[canonical — from memory, to be re-verified]**; arXiv identifiers given from memory are flagged the same way.
**Sibling documents:** [State of the art on perpetual agents](./sota-autonomous-agents.md) (general positioning), [Refocusing the vision](../vision.md) (the perpetual × emergent × direction triangle).

---

## Executive summary and verdict

**Verdict 1 — The adaptation × value coupling, as the project intends it, does not exist anywhere in this form.** Three traditions each touch a piece of the problem, without ever joining them:

1. **Open-endedness / Quality-Diversity** (Lehman, Stanley, Clune, Mouret, Cully…) holds the only family of metrics *intrinsically coupled* to novelty × quality (QD-score, archive coverage) — but "quality" there is a **fixed** fitness function, not a shifting human direction, and the evolved objects are genotypes, not societies of conversational agents.
2. **LLM agent society evaluations** (2024-2026: Cooperate or Collapse, Project Sid, MultiAgentBench, Emergence World, The Social Laboratory…) measure cooperation, resource survival, emergent norms, civilization milestones — but they are **snapshots or end-of-game scores**, never longitudinal series coupling adaptive dynamics with value production, and never anchored on heading-change events.
3. **Intervention econometrics** (interrupted time series, Bayesian CausalImpact, change point detection) and **resilience theory** (critical slowing down, relaxation time) provide exactly the tools for measuring before/after a shock — but nobody has applied them to the behavior journals of an LLM agent society steered by a shifting direction.

**Verdict 2 — The event-study methodology for agents exists in spare parts, not as an assembled method.** Every component is published and mature: ITS (Bernal et al. 2017, 4,400+ citations), counterfactual causal inference on time series (Brodersen et al. 2015, CausalImpact), detection of behavioral regime changes (bcpa in ecology, Durstewitz et al. 2010 in neuroscience), anomaly detection on dynamic graphs (five surveys since 2015), early-warning signals of critical transitions (Scheffer et al. 2009 — where *the rate of recovery after perturbation is literally the resilience metric*). On the LLM side, CAMO (ACL 2026) performs micro→macro causal discovery in LLM agent simulations through interventions. **But no work found treats a human direction change as a timestamped intervention whose before/after effect on a population of agents is measured.** This is a clear gap, defensible as a contribution.

**Verdict 3 — "Direction" as a formal object (distinct from a static mission and from a finite objective) remains unformalized**, confirming the blind spot already identified in `sota-autonomous-agents.md`. The closest neighbors: non-stationary continual RL (the environment moves, but without a human), alignment on dynamic preferences (MAP 2025, ARCANE 2025 — human values move, but for a single model, not a society), and the oversight/governance literature (supervision, not co-steering). Nobody defines a versioned "direction" artifact, continuously revised, with a measurable re-anchoring protocol.

**Consequence for the project:** the targeted coupling is an original contribution. The most solid strategy is a triangular borrowing: (i) the coupled metrics of Quality-Diversity as a *grammar* (diversity × quality in a single score), (ii) ITS/CausalImpact protocols as the *experimental design* around each heading change, (iii) Aubin's viability theory as the unifying *formal framework* (a viability kernel = the set of states in which the society remains both adapted and productive — see §4.3).

---

## BLOCK 1 — Adaptation × value coupling: existing frameworks

### 1.1 Open-endedness, Novelty Search, Quality-Diversity

This is the richest tradition for the "novelty/adaptation × quality" coupling. Key point: **QD is the only family where the coupling is *native*** — a single algorithm simultaneously optimizes behavioral diversity and local quality, and its metrics (QD-score = sum of archive qualities; coverage = fraction of behavior space occupied) are quantities coupled by construction.

**Lehman, J. & Stanley, K.O. (2011). "Abandoning Objectives: Evolution through the Search for Novelty Alone."** *Evolutionary Computation* 19(2). <https://ieeexplore.ieee.org/abstract/document/6793380/>
- **Method:** replace the objective function with a behavioral novelty metric (distance to the behavior of other individuals and of the archive).
- **Key results:** in deceptive domains (mazes, locomotion), searching for novelty *alone* reaches the objective more often than searching for it directly — the famous "the objective is a trap."
- **Transferability:** conceptual. The novelty metric assumes an explicit *behavioral descriptor* and a distance — transferable to LLM agent trajectories (embedding of action traces) but non-trivial: the semantics of a conversation does not have the geometry of a Cartesian plane. It provides the project's theoretical anti-Goodhart argument: a pure value metric, optimized directly, destroys exploration.

**Mouret, J.-B. & Clune, J. (2015). "Illuminating search spaces by mapping elites" (MAP-Elites).** arXiv:1504.04909. <https://arxiv.org/abs/1504.04909>
- **Method:** discretize behavior space into a grid; keep only the best individual (*elite*) per cell; iterate.
- **Key results:** produces archives of thousands of diverse, locally optimal solutions; fast recovery after damage (an "injured" robot re-selects from the archive — the famous *damage recovery* of the companion Nature 2015 paper **[canonical — from memory]**).
- **Transferability: strong.** Two directly reusable ideas: (a) *damage recovery* is a proto-"relaxation time after shock" — the richness of the archive *is* the reserve of adaptability; (b) the QD-score is a model of a coupled metric. Limitation: the behavior space of an agentic society has yet to be defined (roles? communication topology? task distribution?) and "quality" should be replaced by alignment with the *current* direction.

**Wang, R., Lehman, J., Clune, J. & Stanley, K.O. (2019). "Paired Open-Ended Trailblazer (POET)."** arXiv:1901.01753. <https://arxiv.org/abs/1901.01753> — short version GECCO 2019: <https://dl.acm.org/doi/abs/10.1145/3321707.3321799>. Follow-up: **Enhanced POET** (ICML 2020, <https://proceedings.mlr.press/v119/wang20l.html>).
- **Method:** co-evolution of two coupled populations: environments (generated, diversified) and agents (optimized, transferred between environments). Minimal coevolution criterion (cf. Brant & Stanley 2017, <https://dl.acm.org/doi/abs/10.1145/3071178.3071186>): an environment survives only if it is neither too easy nor too hard for the current population.
- **Key results:** continuous production of environments of increasing complexity and of agents that solve them, where direct optimization fails; cross-environment transfers are the engine of capability jumps.
- **Transferability:** the *minimal criterion* is a viability-quality coupling device (neither chaos — too hard — nor ossification — too easy) that exactly prefigures the double threshold the project seeks. Agent transfer between niches is a measurable plasticity mechanism. But POET's "shock" is endogenous (generated), not an exogenous timestamped human heading.

**Hughes, E., Dennis, M., Parker-Holder, J., et al. (2024). "Open-Endedness is Essential for Artificial Superhuman Intelligence."** arXiv:2406.04268 (Google DeepMind). <https://arxiv.org/abs/2406.04268>
- **Method:** position paper with a formalization: a system is open-ended *relative to an observer* if it continuously produces artifacts that are both **novel** and **learnable/interesting** for that observer.
- **Key results:** moves the novelty × value coupling toward *the observer*; proposes that foundation models serve as "models of interestingness."
- **Transferability: very strong conceptually.** This is the formalization closest to "evolves correctly *in the eyes of the human who gives the heading*": value there is not objective but relational to an observer — exactly the human-direction/agentic-society structure. It nevertheless provides no temporal metric and no post-change measurement protocol.

**Zhang, J., Lehman, J., Stanley, K. & Clune, J. (2024). "OMNI: Open-endedness via Models of human notions of Interestingness."** ICML 2024. <https://proceedings.mlr.press> (conference link: <https://proceedings.iclr.cc/paper_files/paper/2024/hash/18b40f124256aa0dcbb3e2832cce252e-Abstract-Conference.html>). Follow-up: **Faldor, M., Zhang, J., Cully, A. & Clune, J. (2025). "OMNI-EPIC."** ICML 2025. <https://proceedings.iclr.cc/paper_files/paper/2025/hash/d40d7cbe7210f8a13ea0149eeae9c6de-Abstract-Conference.html>
- **Method:** a foundation model plays the role of "interestingness model": it scores the novelty *and* the interest of generated tasks, guiding an autotelic curriculum; OMNI-EPIC generates environments in code.
- **Transferability:** demonstrates that an LLM can *operationalize* the novelty × interest coupling judge — directly reusable to score the outputs of an agentic society. It remains a curriculum framework for a single agent/learner.

**Colas, C., Karch, T., Sigaud, O. & Oudeyer, P.-Y. (2022). "Autotelic agents with intrinsically motivated goal-conditioned reinforcement learning: a short survey."** JAIR. <https://www.jair.org/index.php/jair/article/view/13554>; **Colas et al. (2023). "Augmenting autotelic agents with large language models."** ICML 2023. <https://proceedings.mlr.press/v232/colas23a.html>; **Sigaud et al. (2023). "A definition of open-ended learning problems for goal-conditioned agents."** arXiv:2311.00344.
- **Transferability:** provides the formal vocabulary (autotelic agent, goal space, intrinsic motivation) to describe a society that sets goals for itself *under* a direction. The distinction between goals (self-generated, multiple, revisable) and external reward is a cousin of the project's direction/objective distinction.

**Clune, J. (2026). "Open-Ended, Quality Diversity, and AI-Generating Algorithms in the Era of Foundation Models."** *Artificial Life* (position paper). <https://direct.mit.edu/isal/article/doi/10.1162/ISAL.a.930/138320>; **Etcheverry, M., Chan, B.W.C., Moulin-Frier, C. & Oudeyer, P.-Y. (2023). "Meta-Diversity Search in Complex Systems."** arXiv:2312.00455.; **Faldor, M. & Cully, A. (2024). "Toward artificial open-ended evolution within Lenia using quality-diversity."** ALife 2024.; **Samvelyan, M. et al. (2024). "Rainbow Teaming."** NeurIPS 2024 (QD for adversarial LLM prompts).
- **Transferability:** this 2024-2026 work shows the active migration of QD toward foundation models — the ground is moving, which validates the timeliness of the project. Rainbow Teaming proves the technical feasibility of a QD whose "individuals" are linguistic artifacts.

**Agent self-evolution (2025-2026):** **Zhang, J., Hu, S., Lu, C., Lange, R. & Clune, J. (2026). "Darwin Gödel Machine."** ICLR 2026 (arXiv:2505.22954 **[ID from memory]**). <https://proceedings.iclr.cc/paper_files/paper/2026/hash/aa5f5e6eb6f613ec412f1d948dfa21a5-Paper-Conference.pdf>; **Lange, R., Imajuku, Y. & Cetin, E. (2026). "ShinkaEvolve."** ICLR 2026; **Wang, W. et al. (2026). "Huxley-Gödel Machine."** ICLR 2026; **Liu, C. et al. (2026). "Mendel Gödel Machine."** arXiv:2608.07645.
- **Method:** evolutionary archive of self-modifying coding agents; "fitness" is a benchmark score (SWE-bench etc.).
- **Transferability:** these are the only systems where a *population of LLM agents* evolves under a coupled metric (archive = diversity, score = value). But: a single agent in a lineage (no society), fixed benchmark objective, no human in the loop, no measurement of temporal dynamics. To be cited as the closest state of the art on the "agent evolution" side — and as proof of the gap: value there is a static benchmark score, not a shifting direction.

**Exploration/exploitation measured on LLM agents (2026):** **Schmied, T., Bornschein, J., Grau-Moya, J. et al. (2026). "LLMs are greedy agents."** ICLR 2026; **Zhang, Z. et al. (2026). "Comparing exploration–exploitation strategies of LLMs and humans."** *INFORMS JDS* (arXiv:2505.09901); **Lin, H. et al. (2026). "Rethinking Self-Evolution: A Constrained Exploration-Exploitation Process for Mitigating Skill Overfitting."** arXiv:2607.26643.
- **Key results:** LLMs systematically under-explore in bandits (humans do better); RL fine-tuning worsens greediness; unconstrained self-evolution leads to *skill overfitting* — a documented form of **agentic ossification**.
- **Transferability: direct.** "LLMs are greedy agents" provides the measurement protocol (multi-armed bandits as an exploration probe) and a baseline result: exploitation bias is the native defect of LLM agents — so ossification is the *expected* failure mode that the project's metrics must detect.

### 1.2 Measurable evolvability

**Reisinger, J., Stanley, K.O. & Miikkulainen, R. (2005). "Towards an empirical measure of evolvability."** GECCO 2005. <https://dl.acm.org/doi/abs/10.1145/1102256.1102315>; **Lehman, J. & Stanley, K.O. (2011). "Improving evolvability through novelty search and self-adaptation."** CEC 2011. <https://ieeexplore.ieee.org/abstract/document/5949955/>
- **Method:** measure the evolvability of an individual by the *behavioral diversity of its descendants* (number of distinct behaviors reachable by mutation).
- **Transferability: strong for the "plasticity" axis.** Immediate adaptation: sample N variations of an agent/subgroup (prompt, role, tool perturbations) and measure the range of reachable behaviors — a proxy for "capacity to respond to the next heading." Lehman & Stanley 2011 further show that novelty *increases* evolvability — an argument for maintaining novelty pressure as anti-ossification insurance.

**Hansen, T.F. & Houle, D. (2008). "Measuring and comparing evolvability and constraint in multivariate characters."** *J. Evolutionary Biology*. <https://academic.oup.com/jeb/article-abstract/21/5/1201/7324643>; **Hansen, T.F., Solvin, T.M. & Pavlicev, M. (2019). "Predicting evolutionary potential: a numerical test of evolvability measures."** *Evolution*.; **Wang, Y. & Wineberg, M. (2006). "Estimation of evolvability: genetic algorithm and dynamic environments."** *Genetic Programming and Evolvable Machines*.
- **Key results:** in quantitative genetics, evolvability = conditional *response to selection* (respondability) — measured as the slope of the response, not as static variance. Wang & Wineberg operationalize it in *dynamic* environments: the capacity to re-converge after a change of optimum.
- **Transferability: this is the definition most aligned with the project.** "Evolvability = speed and quality of re-convergence after the optimum shifts" is *exactly* the post-heading relaxation time. The gap: these measures assume a continuous fitness function and generations; they must be translated into clock time and discrete events.

### 1.3 Viability theory (Aubin)

**Aubin, J.-P. (1991). *Viability Theory*.** Birkhäuser **[canonical — from memory]**; **Aubin, J.-P. (2013). "Why Viability Theory?"** in *Viability Theory: New Directions*. <https://link.springer.com/chapter/10.1007/978-3-319-00005-3_8>; **Aubin, J.-P. (1985/2023). "Smooth and heavy viable solutions to control problems."**
- **Concepts:** instead of optimizing a trajectory, one defines **viability constraints** (the set of acceptable states) and characterizes the **viability kernel**: the set of states from which *at least one* evolution remains viable forever. **Heavy solutions** change control only when viability demands it — a principle of minimal change.
- **Transferability: ideal formal framework, never applied to agent societies.** The project's coupling can be stated elegantly: constraints = {deviation from the current heading < threshold} ∩ {value production > floor} ∩ {diversity/plasticity > anti-ossification floor}; the society "evolves correctly" if its state stays in the viability kernel after each heading change. Heavy solutions even provide a governance principle (re-steer only when viability demands it) that resonates with a shifting direction with discrete changes.

**Liniger, A. & Lygeros, J. (2017). "Real-time control for autonomous racing based on viability theory."** IEEE TCST. <https://ieeexplore.ieee.org/abstract/document/8167318/>; **Chapel, L. & Deffuant, G. (2007). "SVM viability controller active learning: application to bike control."** IEEE SMC.; **Kohn, W., Nerode, A., Remmel, J.B. & Yakhnis, A. (1995). "Viability in hybrid systems."** *Theoretical Computer Science*.
- **Key results:** the only operationalizations found: autonomous vehicles (track constraints), food-process control, kernel approximation by SVM. Notably: Deffuant is also a father of agent-based opinion models — a personal bridge viability ↔ ABM, but never exploited for society metrics.
- **Gap:** no application to social multi-agent systems, much less LLM ones. Major opportunity: viability is the only mathematical theory whose native object is "staying inside a set of shifting constraints forever" — that is, *precisely* the project's problem.

### 1.4 Simulated organizations: computational economics, organization theory

**March, J.G. (1991). "Exploration and Exploitation in Organizational Learning."** *Organization Science* **[canonical — from memory]**. Related NK-landscape research: **Uotila, J. (2018). "Exploratory and exploitative adaptation in turbulent and complex landscapes."** *European Management Review*; **Csaszar, F.A. (2018). "A note on how NK landscapes work."**; **Billinger, S., Stieglitz, N. et al. (2014). "Search on rugged landscapes: An experimental study."** *Organization Science*.
- **Key results:** the exploration/exploitation dilemma as a temporal trade-off (exploitation improves the short term and destroys the long term); on turbulent landscapes, sustained exploratory adaptation beats exploitation as soon as the environment moves fast enough.
- **Transferability:** March's model *implicitly* couples adaptation and performance over time (the organization that ossifies ends up underperforming). The NK tradition provides a language (a deforming landscape = a shifting direction) but its agents are binary vectors, without communication or emergent structure.

**Lant, T.K. (1994). "Computer simulations of organizations as experimental learning systems."** in *Computational Organization Theory*.
- **Key result (abstract):** organizations with accumulated learning "take longer to recover after an environmental shock" — the first mention found of a **post-shock recovery time as an organizational metric measured in simulation**.
- **Transferability:** historically validates the shock→recovery-measurement protocol in computational organization science; it remains at the level of the simple rule-based models of the 1990s.

**Pumpuni-Lenss, G., Blackburn, T. et al. (2017). "Resilience in complex systems: an agent-based approach."** *Systems Engineering*; **Madni, A.M. & Jackson, S. (2009). "Towards a conceptual framework for resilience engineering."** *IEEE Systems Journal*; **Bitterman, P. & Bennett, D.A. (2016). "Constructing stability landscapes to identify alternative states in coupled social-ecological agent-based models."** *Ecology & Society*.
- **Transferability:** resilience engineering distinguishes absorbing / recovering / adapting — a division directly reusable to characterize the post-heading response (absorption of the semantic shock, recovery of production, structural adaptation). Bitterman & Bennett show how to map the *basins of attraction* of an ABM — a method to formalize "converges after each heading" vs "tips into chaos."

**Agent-based computational economics (ACE):** **Napoletano, M., Dosi, G., Fagiolo, G. & Roventini, A. (2012).** *Revue de l'OFCE*; **Alkemade, F. (2004). "Evolutionary agent-based economics."** (thesis); **Brusatin, S. et al. (2024). "Simulating the economic impact of rationality through RL and ABM."** AAMAS-WS.
- **Transferability:** ACE permanently couples firms' adaptation with macro production — but its adaptation metrics are aggregate (growth, bankruptcies) and its "shocks" are scenarios compared *between* simulations, not events measured *within* a run. No fine-grained adaptation × value coupling at the micro level.

### 1.5 "Society scorecards" for LLM agent societies (2024-2026)

This is the most recent and closest corpus. Precise inventory:

**Piatti, G., Jin, Z., Kleiman-Weiner, M. et al. (2024). "Cooperate or Collapse: Emergence of Sustainable Cooperation in a Society of LLM Agents."** NeurIPS 2024 (GovSim). <https://proceedings.neurips.cc/paper_files/paper/2024/hash/ca9567d8ef6b2ea2da0d7eed57b933ee-Abstract-Conference.html>
- **Method:** LLM agents managing a common resource; metric = resource survival rate (collapse vs sustainability), correlated with reasoning tests.
- **Transferability: the closest to a "society health" scorecard coupling survival and production.** But: no human direction, no exogenous shock, end-of-run metric.

**Al, A., Ahn, A., Becker, N. et al. (2024). "Project Sid: Many-agent simulations toward AI civilization."** arXiv:2411.00114 (Altera). — 1,000+ Minecraft agents; civilization-progress metrics (tech milestones, roles, collective rules) over runs of several hours/days.
- **Transferability:** demonstrates longitudinal measurement of an agentic society (progress curves over time); the "PIANO" follow-up (parallel information aggregation via neural orchestration) addresses real-time coherence. Remaining: an implicit fixed objective (make progress), no shifting heading and no relaxation measurement.

**Park, J.S., O'Brien, J., Cai, C.J., Morris, M.R., Liang, P. & Bernstein, M. (2023). "Generative Agents: Interactive Simulacra of Human Behavior."** UIST 2023. — foundational reference (memory + retrieval + reflection + planning); evaluated through behavioral interviews, not through collective health metrics.

**Piao, J. et al. (2025). "AgentSociety."** SSRN 5954414; **Zhu, K. et al. (2025). "MultiAgentBench."** ACL 2025; **Akkil, D. et al. (2026). "Emergence World: A Platform for Evaluating Long-Horizon Multi-Agent Autonomy."** arXiv:2606.08367; **Reza, Z. (2025). "The Social Laboratory: A psychometric framework for multi-agent LLM evaluation."** arXiv:2510.01295.
- MultiAgentBench: milestones + coordination KPIs (per-task collaboration score) — the closest to a *processual* scorecard, but over finite tasks.
- Emergence World: an evaluation platform for *long-horizon* autonomy with a multi-dimensional score of how an agent society functions (AWI) — announces the need, still recent (1 citation).
- The Social Laboratory: psychometric metrics of emergent phenomena (persuasion, consensus, bias) — a toolbox of social metrics, with no value dimension and no shocks.

**Ashery, A.F., Aiello, L.M. & Baronchelli, A. (2025). "Emergent social conventions and collective bias in LLM populations."** *Science Advances*.; **Gupta, P. et al. (2025). "Social learning and collective norm formation in LLM multi-agent systems."** arXiv:2510.14401; **Ren, S. et al. (2024). "Emergence of social norms in generative agent societies."** arXiv:2403.08251; **Riedl, C. (2026). "Emergent coordination in multi-agent language models."** ICLR 2026.
- **Key results:** convention convergence in LLM populations (with measurable collective biases), norm formation via social learning.
- **Transferability:** they provide *collective convergence* metrics (agreement rate, convention entropy, population similarity) directly recyclable as "convergence after heading." Gupta et al. already propose a *population individual-similarity* metric.

**Chen, J., Badshah, S., Yu, X. & Han, S. (2025). "Static sandboxes are inadequate: Modeling societal complexity requires open-ended co-evolution in LLM-based multi-agent simulations."** arXiv:2510.13982; **Mou, X. et al. (2026). "From individual to society: A survey on social simulation driven by LLM-based agents."** *ACM Computing Surveys*; **Haase, J. & Pokutta, S. (2026). "Beyond static responses: Multi-agent LLM systems as a new paradigm for social science research."** *Nature HSSC*.
- **Diagnostic convergence:** the community itself declares (2025-2026) that static sandboxes are inadequate and that "evaluation remains the central challenge" (Mou et al.) — the project rides a need explicitly formulated by the field.

**Adaptability benchmarks for individual agents:** **Froger, R. et al. (2026). "GAIA2: Benchmarking LLM agents on dynamic and asynchronous environments."** ICLR 2026 ("adaptability" scenarios: the environment changes during the task); **Chen, J. et al. (2024). "LLMArena."** ACL 2024; **Liu, X. et al. (2024). "AgentBench."** ICLR 2024; **Yehudai, A. et al. (2026). "A Survey on Evaluation of LLM-based Agents."** ACL Findings.
- GAIA2 is the first benchmark to explicitly score adaptation to changes *during* execution — but for a single agent, with scripted changes and no dynamics measurement (no relaxation time, no overshoot).

**Block 1 summary:** novelty × quality coupling exists as a *metrics grammar* (QD), society health exists as a *snapshot* (LLM scorecards), post-shock recovery exists as a *concept* (resilience, March, Lant) — but **no framework couples the longitudinal adaptive dynamics of an agentic society to its value production, anchored on human heading changes**.

---

## BLOCK 2 — Event-study / interrupted time series methodology for agents

### 2.1 The econometric canon (ready to use)

**Bernal, J.L., Cummins, S. & Gasparrini, A. (2017). "Interrupted time series regression for the evaluation of public health interventions: a tutorial."** *Int. J. Epidemiology* (4,400+ citations). — the reference tutorial: before/after segmentation, level and slope effects, counterfactual.; **Penfold, R.B. & Zhang, F. (2013).** *Academic Pediatrics*; **McDowall, D., McCleary, R. & Bartos, B.J. (2019). *Interrupted Time Series Analysis*.** Oxford UP.; **Linden, A. (2018). "Combining synthetic controls and interrupted time series."** *J. Eval. Clin. Pract.*; **Zhang, W. & Ning, K. (2023). "Spatially interrupted time-series (SITS)."** *Annals AAG*.

**Brodersen, K.H., Gallusser, F., Koehler, J., Remy, N. & Scott, S.L. (2015). "Inferring causal impact using Bayesian structural time-series models."** *Annals of Applied Statistics* (CausalImpact, Google). <https://projecteuclid.org/journals/annals-of-applied-statistics/volume-9/issue-1/Inferring-causal-impact-using-Bayesian-structural-time-series-models/10.1214/14-AOAS788.short>
- **Method:** Bayesian structural model learned on the pre-intervention period (+ control series), post-intervention counterfactual prediction, effect = observed deviation − counterfactual, with intervals.
- **Transferability: direct and strong.** Each heading change = intervention date; the society's metrics (value produced, diversity, activity) = series; counterfactuals can rely on the model's latent components if there is no control group. This is the tool of choice for estimating "quality of the new plateau" and the duration of the transitory regime. 2026 applications to price announcements (Kyeni & Abille, SSRN) confirm the "timestamped event → series" usage.

### 2.2 Change point detection on behavioral series

**Gurarie, E. (2013). "Behavioral change point analysis in R: the bcpa package."** — detection of breakpoints in animal trajectories (speed/tortuosity): the same methodological gesture on agent trajectories.; **Durstewitz, D. et al. (2010). "Abrupt transitions between prefrontal neural ensemble states accompany behavioral transitions during rule learning."** *Neuron* — evidence that behavioral regime changes are *abrupt* and detectable as state transitions.; **Cabrieto, J. et al. (2018). "Detecting long-lived autodependency changes in a multivariate system."** *Scientific Reports* — CPD + regime-change models on multivariate psychological series.
- **Transferability:** CPD serves as *internal verification*: a timestamped heading change (journal) should induce a rupture detected *blindly* in the behavioral series — an elegant test of behavioral causality (does the heading actually "bite"?). The lag between the journal event and the detected change-point = a measure of propagation latency.

### 2.3 Relaxation time and resilience: the physics of critical transitions

**Scheffer, M. et al. (2009). "Early-warning signals for critical transitions."** *Nature* (6,500+ citations).; **Boettiger, C. & Hastings, A. (2012). "Quantifying limits to detection of early warning for critical transitions."** *JRS Interface*.; **Heßler, M. & Kamps, O. (2023).** *PNAS Nexus*.
- **Key concept:** **critical slowing down**: as a regime transition approaches, *the rate of recovery after perturbation decreases* — measurable by the lag-1 autocorrelation and the variance of the series. In other words, **relaxation time IS the dynamic health metric** in this tradition — exactly what the project wants to measure after each heading.
- **Transferability:** provides the statistical formalization of "relaxation time" (exponential return rate λ after perturbation) and of ossification/fragility signals (rising autocorrelation = a system that "sticks"). Never applied to LLM agent societies. Caution: Boettiger & Hastings show that detection limits are severe on short series — relevant for calibrating the number of events needed.

### 2.4 Anomalies on temporal communication graphs

Mature corpus: **Ranshous, S. et al. (2015). "Anomaly detection in dynamic networks: a survey."** *WIREs DMKD*; **Akoglu, L., Tong, H. & Koutra, D. (2015). "Graph based anomaly detection and description: a survey."** *DMKD*; **Ekle, O.A. & Eberle, W. (2024). "Anomaly detection in dynamic graphs: A comprehensive survey."** *ACM TKDD*; **Zhou, Y. et al. (2024). "A survey of change point detection in dynamic graphs."** IEEE; **Jin, M. et al. (2024). "A survey on graph neural networks for time series."** *IEEE TNNLS* (arXiv:2307.03759); **Ares-Robledo, F. et al. (2026). "GNN for anomaly detection: systematic review of dynamic temporal approaches."** *AIR*.
- **State of the art:** three families — (i) structural/per-snapshot score methods (MDL compressibility, graph distances), (ii) temporal embeddings + deviation detection, (iii) spatio-temporal GNNs with reconstruction/prediction (the anomaly = the error). Change-point detection on dynamic graphs is an identified subfield (Zhou 2024).
- **Transferability: direct.** The "who talks to whom" graph of an agentic society is a standard temporal graph; reorganizations after a heading should appear as unsupervised-detectable anomalies/ruptures. Project usage: (a) measure the *magnitude* of the post-heading reorganization (distance between pre/post graphs), (b) detect structural ossification (a frozen graph despite a heading change) — the graph becomes a sensor of organizational plasticity.

### 2.5 Interventions and causality *inside* agent simulations

**Kerr, C.C. et al. (2021). "Covasim."** *PLoS Comp. Biol.*; **Shastry, V. et al. (2022). "Policy and behavioral response to shock events."** *PLoS ONE*; **Vermeulen, B., Müller, M. & Pyka, A. (2021). "Social network metric-based interventions."** *JASSS*.
- **Dominant pattern in ABM:** interventions are compared *between scenarios* (counterfactual = another run), not measured as events *within* one continuous run. The event study in the econometric sense (a single series, a timestamped rupture) is not the practice of the field.

**On the LLM side (2025-2026):** **Yu, X., Guo, Y., Hou, Y., Xue, X. & Ma, Q. (2026). "CAMO: An Agentic Framework for Automated Causal Discovery from Micro Behaviors to Macro Emergence in LLM Agent Simulations."** *ACL Findings 2026*. <https://aclanthology.org/2026.findings-acl.1224/>; **Gyevnár, B., Lucas, C.G., Albrecht, S.V. et al. (2025). "Integrating counterfactual simulations with language models for explaining multi-agent behaviour."** arXiv:2505.17801; **Triantafyllou, S. et al. (2024). "Counterfactual effect decomposition in multi-agent sequential decision making."** arXiv:2410.12539; **Bazgir, A. et al. (2025). "Causal MAS: a survey."** arXiv:2509.00987.
- **CAMO is the most important result of block 2**: it *intervenes* on micro-behaviors of LLM agents and discovers micro→macro causal links in the simulation. This is proof that interventional experimentation on LLM societies is practicable — but CAMO discovers causal *structures*; it does not measure post-event dynamics (relaxation, overshoot, plateau).

**Block 2 summary:** the event-study methodology for agents **does not exist assembled**, but all its components are published, mature, and one of them (critical slowing down) elevates relaxation time to a central resilience metric. The assembly "heading event journal → ITS/CausalImpact on coupled metric series + blind CPD + communication-graph anomalies" is a free methodological contribution.

---

## BLOCK 3 — "Direction" as a formal object

### 3.1 Non-stationarity on the learning side (the objective moves, but without a human)

**Khetarpal, K., Riemer, M., Rish, I. & Precup, D. (2022). "Towards continual reinforcement learning: A review and perspectives."** *JAIR*.; **Xie, A., Harrison, J. & Finn, C. (2021). "Deep RL amidst continual structured non-stationarity."** ICML; **(2020)** arXiv:2006.10701.; **Feng, F. et al. (2022). "Factored adaptation for non-stationary RL."** NeurIPS.
- **Framework:** non-stationary MDP f(i,t); the agent must detect the change and re-adapt its policy. **Chandak, Y., Theocharous, G. et al. (2020). "Optimizing for the future in non-stationary MDPs."** ICML — the only work found that *anticipates* an unknown future objective instead of merely reacting.
- **Transferability:** provides the formalism (the objective as a stochastic process) but non-stationarity there is *environmental* (the world changes) — never *intentional* (a human revises a heading). The distinction is precisely the project's: a direction is not process noise, it is a semantic signal emitted by a principal.

**Documented ossification:** **Dohare, S. et al. (2024). "Loss of plasticity in deep continual learning."** *Nature*.; **Abbas, Z. et al. (2023).** ICML; **Kumar, S., Marklund, H. & Van Roy, B. (2023). "Regenerative regularization."** arXiv:2308.11958; **Prakash, A. et al. (2025). "Spectral collapse drives loss of plasticity."** arXiv:2509.22335.
- **Key results:** deep networks in continual learning *lose their learning capacity* (spectral collapse, unit death) — measurable, predictable, and mitigated by regeneration. This is **ossification in the strict sense, demonstrated at the level of the weights**.
- **Transferability: strong as a metrological analogy.** For an agentic society, the equivalent is not in the weights (frozen) but in the *emergent structures*: frozen roles, crystallized communication topology, saturated skill repertoire (cf. "skill overfitting," arXiv:2607.26643). The project must define plasticity probes *at the organizational level* — nobody has done so.

### 3.2 Dynamic human preferences/values (the human moves, but for a single model)

**Wang, X., Le, Q., Ahmed, A., Diao, E., Zhou, Y. et al. (2025). "MAP: Multi-human-value alignment palette."** ICLR 2025. — multi-value alignment whose weights *change dynamically*; **Masters, C. & Albrecht, S.V. (2025). "ARCANE: A multi-agent framework for interpretable and configurable alignment."** arXiv:2512.06196. — preferences that "evolve dynamically and are distributed" in a multi-agent system, with mechanisms for maintained shared alignment; **Shen, H. et al. (2024). "Towards bidirectional human-AI alignment."** arXiv:2406.09264.; **Cai, X. (2026). "IDPAD: Implicit and Dynamic Preference Alignment During Decoding."**
- **ARCANE is the closest**: multi-agent + shifting preferences + maintained alignment. But it is about *infusing* configurable values into the agents, not about measuring whether the society *converges* toward a new heading — the metric remains conformity, not dynamics.

### 3.3 Oversight, governance, principles

**Zhu, L., Lu, Q., Ding, M., Lee, S.U. & Wang, C. (2026). "Designing meaningful human oversight in AI."** *AI and Ethics*.; **Tallam, K. (2025). "Alignment, agency and autonomy in Frontier AI."** arXiv:2503.05748.; **Cihon, P. (2024). "Chilling autonomy: policy enforcement for human oversight of AI agents."**; **Montes, N., Osman, N., Sierra, C. & Slavkovik, M. (2023). "Value engineering for autonomous agents."** arXiv:2302.08759 (formalization values→goals); **Townsend, B. et al. (2022). "From pluralistic normative principles to autonomous-agent rules."** *Minds & Machines*; BDI tradition: **Castelfranchi, C. (1994)**; **Luck, M. & d'Inverno, M. (1995)**; **Agbemabiese, W.T. (2026). "Constitutional Autonomy in AI Systems."** IEEE.
- **Summary:** this literature is about *constraining* (oversight, constitutions, principles→rules) — never about *continuously steering* a perpetual system, and never about measuring the dynamic response to steering. The trichotomy mission (statutory, rarely revised) / objective (finite, verifiable) / direction (persistent, continuously revised, never "reached") **is formalized nowhere**. The BDI formalism distinguishes desires/goals/intentions but all are finite and internal. "Value engineering" (Montes) orders values→goals but freezes the values.

**Weak signal to follow:** **Mukherjee, J. (2026). "From autonomous value realization to constitutional enterprise intelligence."** (ResearchGate, not peer-reviewed) — "normative control, value adjudication, self-regulating autonomous systems" applied to the autonomous enterprise; **Prakki, R. (2024). "Active inference for self-organizing multi-LLM systems."** arXiv:2412.10425 (active inference / Bayesian thermodynamics for the adaptation of multi-LLM systems — speculative but conceptually adjacent).

---

## EXPLICIT GAPS — what DOES NOT EXIST (verified by absence across 30 targeted queries)

1. **No framework couples adaptive dynamics and value produced for an LLM agent society.** QD's coupled metrics assume a fixed fitness; LLM scorecards measure no dynamics; resilience engineering is not quantitative at the agent level. The product of the three does not exist.
2. **No event-study / ITS methodology applied to the event journals of an agentic society.** Neither in classical ABM (comparisons between scenarios) nor in LLM simulations (CAMO does structural causal discovery, not post-event measurement). "Relaxation time after a heading change," "overshoot/oscillation," "quality of the new plateau": zero occurrences found.
3. **"Direction" (a persistent, versioned artifact, continuously revised by a human, distinct from mission and objective) is formalized nowhere** — confirming the blind spot already identified in `sota-autonomous-agents.md`. The closest works (non-stationary RL, dynamic preferences, oversight) each cover one corner without the central notion, and "objective re-anchoring" is not an established term.
4. **Measured evolvability has never been carried over to collectives of LLM agents** (descendants = variations of prompts/roles/structures; response = post-heading re-convergence).
5. **Viability theory has never been operationalized for social multi-agent systems** — only vehicles, processes, differential games. Yet it is the only formalism whose native object is "staying under shifting constraints forever."
6. **Critical slowing down / relaxation rate has never been used as a health metric for an agent society** — loss of plasticity (Dohare 2024) is measured only at the level of the weights of a single network; organizational ossification (structures, roles, graphs) has no metrology.
7. **Anomaly detection on temporal graphs has not been applied to inter-agent LLM communication graphs** as a sensor of reorganization/ossification (the five surveys cite no agentic application).

## Synthesis table

| Tradition | "Adaptation" metric | "Value" metric | Coupled? | Anchored on an event? | LLM society? |
|---|---|---|---|---|---|
| Quality-Diversity (MAP-Elites, POET, OMNI) | coverage, novelty | elite quality | ✅ native | ❌ | ❌ (individuals/artifacts) |
| Evolvability (Reisinger, Hansen) | descendant diversity / response to selection | fixed fitness | ⚠️ sequential | ⚠️ (dynamic environments) | ❌ |
| Viability (Aubin) | membership in the kernel | arbitrary constraints | ✅ formally | ❌ (no protocol) | ❌ |
| March / NK / computational org. | exploration vs exploitation | performance | ⚠️ implicit | ⚠️ (turbulent landscapes) | ❌ |
| Resilience engineering / EWS | recovery time, critical slowing down | function maintained | ⚠️ | ✅ (perturbations) | ❌ |
| LLM scorecards (GovSim, Sid, MultiAgentBench, Emergence World) | norm convergence, coordination | resource survival, milestones | ⚠️ same run | ❌ | ✅ |
| Self-evolution (DGM, ShinkaEvolve) | archive, lineage diversity | benchmark score | ⚠️ | ❌ | ⚠️ (single agent in a lineage) |
| ITS / CausalImpact / CPD | — | — | tool, not framework | ✅ native | ❌ never applied |
| Continual RL / loss of plasticity | plasticity, re-adaptation | non-stationary reward | ⚠️ | ⚠️ | ❌ (single agent) |
| Dynamic alignment (MAP, ARCANE) | conformity to shifting values | — | ❌ | ❌ | ⚠️ (ARCANE: multi-agent) |
| **Project (targeted)** | relaxation, plasticity, E/E, ossification | production under the current heading | ✅ | ✅ event journal | ✅ |

## Operational consequences for the project

1. **Metrics grammar:** adopt the double QD axis (diversity × quality) with two substitutions: quality → *alignment measured against the current heading* (LLM judge in the OMNI style, cf. Hughes 2024 for the "observer-dependent" justification); coverage → diversity of emergent structures (roles, topologies, repertoires).
2. **Experimental design:** each heading change in the journal = an ITS intervention. Per-event measurements: latency (blind CPD vs timestamp), relaxation time λ (exponential fit post-shock, Scheffer tradition), overshoot (max deviation before stabilization), plateau quality (CausalImpact, cumulative effect vs counterfactual).
3. **Ossification sensor:** rising autocorrelation of the metrics (critical slowing down) + freezing of the communication graph (inter-snapshot distance → 0 despite new headings) + periodic exploration probe (bandits, cf. Schmied 2026) + evolvability by sampling variations (Reisinger).
4. **Formal framework:** formulate "evolves correctly" as persistent membership in the viability kernel {heading deviation, production floor, plasticity floor} — a free theoretical contribution (gap #5), with Aubin's heavy solutions as a minimal steering principle.
5. **Anti-Goodhart:** the lesson of Novelty Search (do not optimize the value metric directly) and the EWS detection bounds (Boettiger) must constrain the use of the metrics: observation, not reward.

## Complete bibliography (verified in this session unless otherwise noted)

See the corresponding sections for methods and transferability. List: Lehman & Stanley 2011 (novelty search); Mouret & Clune 2015 arXiv:1504.04909; Brant & Stanley 2017; Wang et al. 2019 arXiv:1901.01753; Wang et al. 2020 (Enhanced POET); Hughes et al. 2024 arXiv:2406.04268; Zhang et al. 2024 (OMNI); Faldor et al. 2025 (OMNI-EPIC); Colas et al. 2022, 2023; Sigaud et al. 2023 arXiv:2311.00344; Clune 2026; Etcheverry et al. 2023 arXiv:2312.00455; Samvelyan et al. 2024 (Rainbow Teaming); Aki et al. 2024 (LLM-POET); Zhang et al. 2026 (Darwin Gödel Machine); Lange et al. 2026 (ShinkaEvolve); Wang et al. 2026 (HGM); Liu et al. 2026 arXiv:2608.07645 (MGM); Schmied et al. 2026; Zhang et al. 2026 arXiv:2505.09901; Lin et al. 2026 arXiv:2607.26643; Reisinger et al. 2005; Lehman & Stanley 2011 (evolvability); Hansen & Houle 2008; Hansen et al. 2019; Wang & Wineberg 2006; Aubin 1991 **[memory]**, 2013, 1985; Liniger & Lygeros 2017; Chapel & Deffuant 2007; Kohn et al. 1995; March 1991 **[memory]**; Uotila 2018; Csaszar 2018; Billinger et al. 2014; Lant 1994; Pumpuni-Lenss et al. 2017; Madni & Jackson 2009; Bitterman & Bennett 2016; Napoletano et al. 2012; Alkemade 2004; Brusatin et al. 2024; Piatti et al. 2024 (GovSim); Al et al. 2024 arXiv:2411.00114 (Project Sid); Park et al. 2023 (Generative Agents); Piao et al. 2025 (AgentSociety); Zhu et al. 2025 (MultiAgentBench); Akkil et al. 2026 arXiv:2606.08367; Reza 2025 arXiv:2510.01295; Ashery et al. 2025; Gupta et al. 2025 arXiv:2510.14401; Ren et al. 2024 arXiv:2403.08251; Riedl 2026; Chen et al. 2025 arXiv:2510.13982; Mou et al. 2026; Haase & Pokutta 2026; Froger et al. 2026 (GAIA2); Chen et al. 2024 (LLMArena); Liu et al. 2024 (AgentBench); Yehudai et al. 2026; Bernal et al. 2017; Penfold & Zhang 2013; McDowall et al. 2019; Linden 2018; Zhang & Ning 2023; Brodersen et al. 2015; Gurarie 2013; Durstewitz et al. 2010; Cabrieto et al. 2018; Scheffer et al. 2009; Boettiger & Hastings 2012; Heßler & Kamps 2023; Ranshous et al. 2015; Akoglu et al. 2015; Ekle & Eberle 2024; Zhou et al. 2024; Jin et al. 2024 arXiv:2307.03759; Ares-Robledo et al. 2026; Kerr et al. 2021; Shastry et al. 2022; Vermeulen et al. 2021; Yu et al. 2026 (CAMO); Gyevnár et al. 2025 arXiv:2505.17801; Triantafyllou et al. 2024 arXiv:2410.12539; Bazgir et al. 2025 arXiv:2509.00987; Khetarpal et al. 2022; Xie et al. 2020 arXiv:2006.10701, 2021; Chandak et al. 2020; Feng et al. 2022; Dohare et al. 2024; Abbas et al. 2023; Kumar et al. 2023 arXiv:2308.11958; Prakash et al. 2025 arXiv:2509.22335; Wang et al. 2025 (MAP); Masters & Albrecht 2025 arXiv:2512.06196 (ARCANE); Shen et al. 2024 arXiv:2406.09264; Cai 2026 (IDPAD); Zhu et al. 2026; Tallam 2025 arXiv:2503.05748; Cihon 2024; Montes et al. 2023 arXiv:2302.08759; Townsend et al. 2022; Castelfranchi 1994; Luck & d'Inverno 1995; Agbemabiese 2026; Mukherjee 2026; Prakki 2024 arXiv:2412.10425.

*Raw data from the 30 queries: `./_scholar_tmp/q01…q30_*.csv`.*
