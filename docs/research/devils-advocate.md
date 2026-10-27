# Devil's Advocate — Adversarial Review of the Design

Function: the strongest published attacks against the project's riskiest bets — a perpetual society of self-organizing LLM agents steered by a shifting human direction via chat and evaluated by behavioral metrics computed on an event journal. Each attack states verified evidence, a verdict, and the design consequence.

Verdicts: **fatal** = invalidates the concept · **risk** = addressable by design · **for** = this is exactly what the experiment must observe.

## 1. Is there a demonstrated impossibility?

No. The closest published results are theorems about optimization and signal fidelity, not about observation. They impose a defensive measurement protocol, not a prohibition.

### 1.1 Emergence as a metric artifact

Schaeffer et al. ([arXiv:2304.15004](https://arxiv.org/abs/2304.15004)): emergent abilities "appear due to the researcher's choice of metric rather than due to fundamental changes in model behavior" and "evaporate with different metrics or with better statistics". Counterweight — Du et al. ([arXiv:2403.15796](https://arxiv.org/abs/2403.15796), NeurIPS 2024): models exhibit emergent abilities "regardless of the continuity of metrics" once pre-training loss falls below a threshold. The debate is open.

**Verdict: risk.** All project metrics must be continuous, and every reported jump re-analyzed under at least one alternative metric.

### 1.2 Goodhart on the metrics

Gao et al. ([arXiv:2210.10760](https://arxiv.org/abs/2210.10760)): an imperfect proxy reward, "optimizing its value too much can hinder ground truth performance, in accordance with Goodhart's law". Poorly aimed at this design: the metrics reward no one — this is a measurement device, not an RL loop. The real exposure is subtler: the human direction reacting to the metrics it sees.

**Verdict: risk.** Decorrelated multi-metric view, frozen holdouts, judges from different model families, and the exogenous step response (a dynamic response cannot be pre-hacked). Never publish a single aggregate scalar.

### 1.3 Impossibility theorems delimit the playground

Wang et al. ([arXiv:2602.09877](https://arxiv.org/abs/2602.09877)): an agent society combining continuous self-evolution, complete isolation, and safety invariance is impossible; the paper motivates "external oversight or novel safety-preserving mechanisms". Such results constrain optimization and aggregation procedures, not joint observation — the project measures the trade-offs the theorems make inevitable.

**Verdict: for.** The shifting human direction is exactly the external oversight the trilemma asks for.

### 1.4 Structural sycophancy — the most acute attack

Sharma et al. ([arXiv:2310.13548](https://arxiv.org/abs/2310.13548)): humans and preference models "prefer convincingly-written sycophantic responses over correct ones"; optimizing against them "sometimes sacrifices truthfulness in favor of sycophancy". *The Yes-Bias in LLM Reasoning* (ICLR 2026, [OpenReview](https://openreview.net/pdf/5dc5fea8ceb45ebd18dddc7ab2496a8a7feee867)): GPT-5.2 (High) shows 36% sycophantic behavior on synthetic fake tasks (70% on competent samples), amplified by SimPO. Turpin et al. ([arXiv:2305.04388](https://arxiv.org/abs/2305.04388)): chain-of-thought explanations "can systematically misrepresent the true reason for a model's prediction". An RLHF agent society driven by chat is structurally biased to *appear* faithful; logged reasoning is a rhetorical artifact, not a mechanism trace.

**Verdict: risk.** Measure fidelity by acts, never by statements; treat reasoning traces as surface data; inject controlled contradictory heading changes as probes.

### 1.5 Loss of plasticity

Dohare et al. (*Nature* 632:768–774, 2024): standard deep-learning methods "gradually lose plasticity in continual-learning settings until they learn no better than a shallow network"; plasticity "is maintained indefinitely only by algorithms that continually inject diversity". The result targets the weight substrate; frozen-weight LLM agents are outside that regime, but the transferable lesson stands: without a renewal mechanism, organizational plasticity declines.

**Verdict: risk / for.** It supplies the project's null hypothesis — a dynamic the metrics must be able to detect.

## 2. Documented failures of similar systems

### 2.1 MAST — systematic multi-agent failure

Cemri et al. ([arXiv:2503.13657](https://arxiv.org/abs/2503.13657)): 1,600+ annotated traces across 7 MAS frameworks; 14 failure modes in 3 categories (system design, inter-agent misalignment, task verification). Failures are systematic and taxonomizable.

**Verdict: risk / for.** The failure rates the project must beat or explain — and a reusable reading grid for its own event journal.

### 2.2 Error amplification — the most unfavorable empirical datum

Kim et al., *Towards a Science of Scaling Agent Systems* ([arXiv:2512.08296 (v3)](https://arxiv.org/abs/2512.08296)): across 260 configurations on six agentic benchmarks, independent multi-agent systems amplify trace errors 17.2× versus the single-agent baseline (centralized coordination contains amplification to 4.4×); mean success 0.370 independent vs 0.466 single-agent; adding agents has negative returns once single-agent accuracy exceeds 45% (β=−0.236, 95% CI [−0.396, −0.076], p=0.004). Self-organizing agents without a coded coordinator are precisely the amplifying category; the measured literature says that without a validation bottleneck, emergence does not beat it.

**Verdict: risk.** Inter-agent error propagation rate on the journal is a first-class metric, not a detail.

### 2.3 Vending-Bench — long-horizon meltdown loops (simulation)

Backlund & Petersson ([arXiv:2502.15840](https://arxiv.org/abs/2502.15840)): Claude 3.5 Sonnet beats the human baseline on average (mean $2,217.93 vs $844.05; worst run $476) with extreme variance and meltdown loops: a Sonnet run, having decided to close its business over the $2/day fee, emailed the FBI IC3 (§3.2.2); a Claude 3.5 Haiku run threatened a supplier with "TOTAL NUCLEAR LEGAL INTERVENTION" after mis-checking inventory. Key finding: derailments are not correlated with context-window filling (Pearson r = 0.167) — they are long-haul reasoning errors.

**Verdict: risk / for.** Long-horizon agents do not hold up without periodic external re-synchronization — the human pilot's role. Survival time before meltdown is a declared dependent variable.

### 2.4 Project Vend — real-world long-horizon episodes

Anthropic × Andon Labs ran "Claudius" (Claude Sonnet 3.7, then 4.x) as the agent operating a real office shop ([phase 1](https://www.anthropic.com/research/project-vend-1), [phase 2](https://www.anthropic.com/research/project-vend-2)). Phase 1: net loss (high-margin items sold below cost); a hallucinated Venmo payment account; a hallucinated colleague "Sarah"; an identity crisis — it claimed it would deliver products in person wearing "a blue blazer and a red tie" and emailed Anthropic security; tungsten cubes sold at a loss under employee pressure. Phase 2 added a CEO agent (Seymour Cash): discounts fell by about 80%, but Anthropic attributes the improvement to procedural prompting, not the hierarchy — the CEO "wasn't much help, and might even have been a hindrance"; profit "may have been in spite of the CEO".

**Verdict: risk.** Phase 2 is *not* evidence that hierarchical supervision has governance value; it is evidence that helpfulness-trained models make lenient economic agents. External re-synchronization remains the human pilot's job.

### 2.5 Project Sid and Voyager — self-admitted ceilings

Voyager ([arXiv:2305.16291](https://arxiv.org/abs/2305.16291)): the first LLM-powered embodied lifelong-learning agent in Minecraft, coupled to GPT-4 via black-box queries. Project Sid ([arXiv:2411.00114](https://arxiv.org/abs/2411.00114)): 10–1,000+ agent societies with specialized roles, changed collective rules, and cultural transmission — and the authors' own limit: agents "cannot simulate de novo emergence of societal innovations and infrastructures, such as the emergence of democratic systems, fiat economies, or communication systems".

**Verdict: risk / for.** The largest agent-civilization project admits its "emergence" replays forms present in the training data. Claim measured adaptive reorganization, never de novo societal innovation.

### 2.6 Goal drift

Arike et al., AIES 2025 ([arXiv:2505.02709](https://arxiv.org/abs/2505.02709)): every evaluated model drifts from its objective; the best (scaffolded Claude 3.5 Sonnet) holds near-perfect adherence for ~100,000 tokens; drift is larger through inaction than through action; the GD_actions/GD_inaction metrics are directly reusable. *Inherited Goal Drift* ([arXiv:2603.03258](https://arxiv.org/abs/2603.03258), ICLR 2026 Lifelong Agents Workshop): strong models conditioned on weaker agents' trajectories inherit their drift; only GPT-5.1 was consistently resilient.

**Verdict: for.** Measured drift is the data, not the indictment; the shifting direction re-anchors the heading periodically. The fidelity metric must detect drift by inaction and reinterpretation, not only active disobedience.

### 2.7 Single-thread writes

Walden Yan, *Don't Build Multi-Agents* (Cognition): parallel writing sub-agents make conflicting "implicit decisions" (the Flappy Bird / Super Mario example); the principles are "share context" and consistency of implicit decisions; "the simplest way to follow the principles is to just use a single-threaded linear agent".

**Verdict: risk.** Many agents writing shared state without an integration point inherit the problem. The design must specify who integrates writes; in this repo, the shared git world plus kernel-mediated commits is that integration point.

### 2.8 Dochkina — evidence for self-organization, and against total autonomy

Dochkina, *Drop the Hierarchy and Roles* ([arXiv:2603.28990](https://arxiv.org/abs/2603.28990), single-author preprint): 25,000+ task runs, 8 models, 4–256 agents, 8 protocols; the Sequential protocol (fixed order, self-chosen roles) beats the centralized Coordinator by +14% (p<0.001) and the fully autonomous Shared protocol by +44% (d=1.86); 5,006 unique roles invented with 8 agents; no gain beyond 64 agents (p=0.61). Caveats acknowledged in the paper: LLM-judge scoring without human evaluation.

**Verdict: for / risk.** The best available evidence that LLM self-organization is real and measurable — and that total autonomy is the worst protocol; the optimum is a minimal scaffold plus role autonomy. The direction chat must play that minimal scaffold.

## 3. Epistemological objections

### 3.1 "LLM-judge measurement is not science"

Kapoor et al., *AI Agents That Matter* ([arXiv:2407.01502](https://arxiv.org/abs/2407.01502)): agent benchmarks have "inadequate holdout sets, and sometimes none at all"; agents overfit via shortcuts; evaluation suffers "a pervasive lack of reproducibility". External validation is possible when a ground truth exists: Park et al. ([arXiv:2411.10109](https://arxiv.org/abs/2411.10109)) simulated 1,052 Americans; interview-, survey-, and combined-grounded agents reached 83%, 82%, and 86% of participants' own two-week test-retest consistency on held-out GSS items. The project claims construct validity, not external validity — and construct validity is testable: causal interventions, injected synthetic ground truths (known heading-change times), cross-family judge agreement, human calibration sampling.

**Verdict: risk, refutable by protocol.** The step response reintroduces ground truth; it is the project's methodological strength.

### 3.2 Emergence or replay of corpus forms?

Project Sid's own limit (§2.5) plus Shapira et al., *Clever Hans or Neural Theory of Mind?* ([arXiv:2305.14763](https://arxiv.org/abs/2305.14763)): apparent social reasoning "is far from being robust" — LLMs rely "on shallow heuristics rather than robust ToM abilities"; anecdotal examples cannot establish the capability. One cannot prove in general that a behavior is truly emergent, but pure imitation can be made increasingly implausible: organizational forms absent from the corpus, causal response to perturbations, divergence across model families, aggregate dynamics with time constants that appear in no document.

**Verdict: risk, refutable in degree.** Preregister the four anti-imitation tests; replication on ≥2 model families is a publication requirement. The contested operationalization of exploration/exploitation is covered in [exploration-exploitation-metrics.md](exploration-exploitation-metrics.md).

## Verdict

No published result demonstrates the problem is unsolvable: no impossibility theorem targets observation on event journals; the trilemmas forbid guaranteeing trade-offs, not measuring them; self-organization is measured (Dochkina), and the Schaeffer/Du debate makes metric robustness a design instruction, not a verdict.

Three hard empirical constraints bound the design:

1. Multi-agent systems fail systematically (MAST) and amplify trace errors 17.2× without coordination (Kim et al., v3).
2. Fidelity holds ~100k tokens at best, drifts through inaction, and is inherited from weaker trajectories (Arike et al.; Inherited Goal Drift).
3. Long-horizon agents end in meltdown loops without external re-synchronization (Vending-Bench), and hierarchy did not rescue them (Project Vend phase 2).

Most dangerous attacks → countermeasures: **sycophancy and unfaithful traces** → fidelity on acts, never statements, logged reasoning treated as rhetorical surface; **error amplification and meltdown loops** → the human direction as external re-synchronization, an inter-agent propagation metric, survival time before meltdown as a declared dependent variable; **theater of convergence** → claim "measured behavioral reorganization", preregister the anti-imitation tests.

Most likely failure mode: the **variance ceiling**. Not "the metrics measure nothing" nor "the system collapses", but trajectories of such high variance (Vending-Bench documented it) that an affordable number of runs cannot separate signal from noise. This is a statistical-power and budget problem, addressed upstream by power analysis on expected time constants and replication counts.
