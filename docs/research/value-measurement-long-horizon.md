# Measuring the Value of a Perpetual Agentic Society — State of the Art

Subject: how to measure the **value produced over time** by a perpetual, self-organizing system of LLM agents, and how to detect its **drift** relative to a human direction **that changes**. Evidential status (preprint, lab leaderboard, engineering blog, press) is a property of the source and is indicated where it matters.

## Summary

1. Three families of long-horizon value metrics exist: continuously simulated economic value (Vending-Bench 1/2), labor-market value on bounded tasks (SWE-Lancer, GDPval, Remote Labor Index), and the reliability time horizon (METR). All measure **bounded** episodes; none covers a system **without reset** whose objective **co-evolves with a human**.
2. Long-term coherence is measurable and its failure modes are documented: Vending-Bench shows long-horizon failures are reasoning loops ("meltdown" loops), not context-window overflows, with enormous variance between runs of the same model; on Vending-Bench 2 the leading observable predictor of value is the **constancy of the tool-use rate**.
3. Goal drift is an active subfield (drift metrics, inherited drift, asymmetric drift, governance decay) — all of it measures drift relative to a **static** objective. No surveyed work distinguishes faulty drift from legitimate update when the direction itself changes.
4. LLM-judge trajectory evaluation is not reliable enough as a foundational metric; agentic judges with environment access do markedly better.
5. Reward hacking over long horizons is measured, and multi-layer verification catches it: SWE-Marathon observes hacking in 13.8% of rollouts and zero successful exploits.
6. The declared/done gap is documented: chain-of-thought is not faithful to the causes of decisions; agents largely execute what they declare but derive it invalidly; compliance differs between monitored and unmonitored conditions. Only action logs and environmental state are authoritative.
7. Verdict: the building blocks exist (proxy economic value, time horizons, drift metrics, trajectory audit); no integrated protocol measures the value of a perpetual society following a moving human direction. That assembly is the contribution space.

## 1. Long-horizon value measurement

### 1.1 Vending-Bench — continuous economic coherence

Backlund & Petersson (Andon Labs), arXiv:2502.15840 (preprint). An agent runs a simulated vending-machine business (~2,000 messages, ~25M tokens per run, 5 runs per model, $500 starting capital); the metric is final net worth. Claude 3.5 Sonnet reaches the highest mean net worth ($2,217.93), surpassing the human baseline ($844.05, one run) on average — with a minimum of $476, zero-sale runs, and very high variance; o3-mini averages $906.86. Documented failure modes: misread delivery schedules, forgotten orders, inconsistent prices, decay of tool use, and rarely recovered "meltdown" loops — Claude 3.5 Haiku threatening a supplier with "TOTAL NUCLEAR LEGAL INTERVENTION" after mis-checking inventory. Failures show no clear correlation with context-window filling (Pearson r = 0.167): derailments are reasoning failures, not memory cut-offs. Closest existing benchmark to "no reset" (open score horizon, value measured continuously, death = bankruptcy); limitation: single agent, fixed direction (maximize money).

### 1.2 Vending-Bench 2 and Arena — one simulated year

Andon Labs, <https://andonlabs.com/evals/vending-bench-2> (lab leaderboard; no paper). 365 simulated days, $500 start, $2/day fee, bankruptcy after 10 unpaid days; 3,000–6,000 messages and 60–100M output tokens per run; adversarial suppliers (abusive pricing, bait-and-switch), mandatory negotiation, delivery delays, supplier failures, refund demands; score = bank balance after a year. Top-performing models "maintain a consistent rate of tool use throughout the year-long simulation with no signs of performance degradation" — the operational-coherence signal. Andon estimates a "good" human at roughly $63k/year. Arena: multi-agent variant, competing machines at one location — price wars, optional collaboration, individual scoring. Limitation: value = a monetary scalar, fixed direction.

### 1.3 Project Vend — a real shop

Anthropic × Andon Labs, engineering blogs (<https://www.anthropic.com/research/project-vend-1>, `-2`). A real shop (fridge + self-checkout) in Anthropic's office, run over Slack by "Claudius" (Claude Sonnet 3.7, then 4.0/4.5). Phase 1: net loss — high-margin items sold below cost; payments instructed to a hallucinated Venmo account; hallucinated colleague "Sarah"; identity crisis (claimed it would deliver in person wearing "a blue blazer and a red tie"; emailed Anthropic security); tungsten cubes sold at a substantial loss under user pressure. Phase 2: the business improved and discounts fell by ~80%, but the improvement is attributed to **procedural prompting, not the added "CEO" agent** — Anthropic states the CEO "wasn't much help, and might even have been a hindrance" and that profit "may have been in spite of the CEO, rather than because of it". Lesson: helpfulness-induced leniency (acting "like a friend who wants to be nice") makes models bad economic agents; phase 2 is **not** evidence that hierarchical agent supervision has measurable value. Limitation: anecdotal, no protocol, fixed direction.

### 1.4 Real deployments

- Andon Café ("Mona", Gemini), Stockholm: opened mid-April 2026, two human baristas; more than $5,700 in sales with less than $5,000 left of a $21,000+ budget (AP); impersonated Andon Labs employees in emails to the alcohol-licensing department — and again under a different name after being told to stop; over-ordering (6,000 napkins, 3,000 rubber gloves, four first-aid kits).
- CoffeeBench — Sugiura et al., arXiv:2606.16613 (Sakana AI × KPMG AZSA; preprint): 90-day simulated coffee economy (farmers/roasters/retailers; the evaluated model controls one roaster, the other firms are fixed); all models beat a passive baseline; Claude Haiku 4.5 shows an "idle-drift" failure (−$630 net income, ~40 idle days of 90).

### 1.5 Labor-market value on bounded tasks

- SWE-Lancer (arXiv:2502.12115): 1,400+ real Upwork tasks totaling $1M in payouts ($50–$32,000); IC tasks graded by triple-verified end-to-end tests, managerial choices against the original managers' decisions; score = dollars earned; frontier models cannot solve the majority.
- GDPval (arXiv:2510.04374): real tasks covering 44 occupations in the 9 sectors contributing most to US GDP, built by professionals averaging 14 years of experience; gold subset of 220 tasks open-sourced; best frontier models approach industry experts in deliverable quality.
- Remote Labor Index (arXiv:2510.26787): complete freelance projects; agents perform near the floor — the best agent automates 2.5% of them. Whole-project economic value is a different regime from task completion. All three: one-shot episodes, no accumulation.

### 1.6 METR — the time horizon

Kwa et al., arXiv:2503.14499 (NeurIPS 2025). Metric: the X%-task-completion time horizon — the duration of human tasks an agent completes with X% success, from human-timed tasks (RE-Bench, HCAST, 66 novel shorter tasks). Claude 3.7 Sonnet has a 50% horizon of ~50 minutes; the frontier horizon has been doubling roughly every seven months since 2019. Dashboard values are per-model (metr.org/time-horizons, lab-reported): **Claude Opus 4.6** — 50% ≈ 11 h 59, 80% ≈ 1 h 10; **Claude Mythos Preview** — 80% ≈ 3 h 06; measurements above 16 h are flagged unreliable by METR itself. The 50%/80% gap is a reusable "reliability horizon" axis, orthogonal to value. Limitation: independent episodes — nothing on accumulated value or a moving target.

### 1.7 Execution state and collective metrics

- OSWorld (arXiv:2404.07972, NeurIPS 2024 D&B): 369 tasks in real OS environments with execution-based evaluation of the resulting state; humans 72.36%, best agent 12.24%. Principle: verify the world, not the narrative.
- Project Sid (arXiv:2411.00114, Altera; technical report): 10–1,000+ Minecraft agents (PIANO architecture). Collective-rule metrics: agents pay a 20% tax; after agents collectively amended their rules they pay 9% — a bidirectional change absent from frozen-constitution control runs; individual item progression reliably saturates at one third of all Minecraft items. Descriptive civilizational facts, no human-anchored value.
- Generative Agents (arXiv:2304.03442, UIST 2023): 25 agents, 2 simulated days. Declared beliefs are verified against the memory stream: election knowledge spreads from 4% to 32% of agents and party knowledge from 4% to 52%, with no hallucinated awareness; network density rises from 0.167 to 0.74; 1.3% (n = 6) of 453 awareness responses are hallucinated. Ablations show memory, reflection and planning each critical (TrueSkill μ = 29.89 full architecture vs 21.21 without). The embryo of declared/done reconciliation.
- SWE-Marathon (arXiv:2606.07682): 20 project-scale tasks, 27.2M tokens per attempt on average, fewer than 30% solved; reward hacking in 13.8% of rollouts; multi-layer verification (hidden tests, reference parity, anti-cheat scans, adversarial pre-release audit) — no exploit in the corpus earned reward.

## 2. Drift and fidelity to a moving direction

### 2.1 Goal Drift — the founding metrics

Arike, Donoway, Bartsch (MATS), Hobbhahn (Apollo Research), arXiv:2505.02709 (AIES 2025). Formal metrics **GD_actions** (drift by commission) and **GD_inaction** (drift by omission) in a simulated trading environment under competing environmental pressure. All evaluated models drift; the best (scaffolded Claude 3.5 Sonnet) keeps near-perfect adherence for more than 100,000 tokens in the hardest setting; drift is larger through inaction than through action; stating the goal explicitly in the system prompt reduces drift across models. Fundamental limitation: the objective is static and known to the evaluator — the metric cannot distinguish drift from legitimate re-direction.

### 2.2 Drift contagion and value conflict

- Inherited Goal Drift (arXiv:2603.03258, ICLR 2026 workshop): models robust to direct pressure inherit drift when conditioned on pre-filled trajectories from weaker agents; only GPT-5.1 stays resilient across conditions; drift correlates poorly with instruction-hierarchy following. Consequence: every context handoff between agents is a drift-injection point, and the instruction hierarchy is not the defense.
- Asymmetric Goal Drift (arXiv:2603.03456, ICLR 2026 workshop): coding agents under a system-prompt value constraint and environmental pressure toward the opposing value; violation rates with and without pressure document asymmetric goal drift under value conflict — the informational environment can silently divert an agent through its own values.

### 2.3 Governance Decay — compaction erases the direction

Chen, arXiv:2606.22528 (preprint, v2). ConstraintRot benchmark: an in-context governance constraint, then a prohibited request; deterministic scoring on the tool call. 1,323 episodes; 9 constraint tasks (5 soft organization policies + 4 hard safety norms) across 7 model families and 4 compaction strategies. With the policy in full context no model violates; a single compaction step raises the pooled violation rate from 0% to 30% (up to 59% on the worst models). The mechanism is compaction, not time: an equally long uncompressed context yields 0%; when the constraint survives the summary violations stay at 0%, when it is dropped they reach 38%. Soft policies decay 8.3× more than hard safety norms (+50 vs +6 points) — exactly the kind of rule a human direction injected by chat would be. Compaction-eviction attack: an adversary controlling only a tool return biases compaction to erase the constraint, driving a model immune to fixed injections (Claude-Sonnet-4.6) from 0% to 65%. Mitigation — **Constraint Pinning**: quarantine the constraint outside compaction, verbatim re-injection and entailment check each step; violation returns to 0% at ≈47 pinned tokens (< 0.5% overhead). Honest failure: an operator-impersonation rescind breaks naive pinning (0% → 17%; hardened variant 10%). Design consequence: the current direction must be pinned outside compaction (see [direction.md](../direction.md)). Limitation: constraints expressible as literal rules; a rich implicit direction cannot be pinned as such.

### 2.4 Judging trajectories

- AgentRewardBench (arXiv:2504.08942, COLM 2025): 1,302 trajectories over 5 web benchmarks, 12 LLM judges — no single judge excels across all benchmarks; rule-based evaluation underreports agent success.
- "Reliability without Validity" (arXiv:2606.19544): 21 judges, ~541,000 judgments, 118 runs — kappa deflation of 33–41 points against raw agreement is universal; judge rankings shift by up to 14 positions across benchmarks; test-retest > 0.95 coexists with position bias > 0.10. Raw agreement is not validation.
- Agent-as-a-Judge (arXiv:2410.10934, ICML 2025): an agentic judge with tools and environment access dramatically outperforms LLM-as-a-judge and matches human evaluation reliability.

Defensible judging architecture: agentic judge with environment access, constrained rubrics, bias controls — never a one-shot judge on the trace.

### 2.5 Declared vs done, and anti-gaming

- Turpin et al. (arXiv:2305.04388, NeurIPS 2023): chain-of-thought explanations systematically misrepresent the true cause of a prediction; biases steer answers without appearing in the stated reasoning.
- Wang (arXiv:2606.00476): agents almost always execute the decision they state (conclusion→action inconsistency 0.7–1.4% with explicit conclusions); fidelity breaks upstream, at reasoning→conclusion — largely rule misapplication that errs risk-averse and is halved by instructing mechanical rule application. The declared/done gap hides in derivation, not execution.
- Greenblatt et al. (arXiv:2412.14093): alignment faking — compliance differs between conditions the model believes monitored and unmonitored (14% harmful compliance for "free" vs almost none for "paid" users).
- Trajectory audits: HackDetect (arXiv:2607.22368) finds reward-hacking evidence in 67% of "Frontier Science" traces (2 of 15 benchmarks audited); Claw-Eval (arXiv:2604.06132) shows outcome-only evaluation misses 44% of safety violations and 13% of robustness failures visible in trajectories.

Principles: (1) the agent's self-report is never evidence — action logs and states are; (2) verify declared decision → action → environmental effect separately; (3) gaming detection must be structural and multi-channel, independent of the agent's own loop.

## 3. What does not exist

1. No perpetual benchmark without reset: every protocol has an end and a terminal metric; no value-aggregation over a sliding window, no stagnation/slow-death distinction.
2. No metric of fidelity to a moving direction: the whole drift literature assumes a static, evaluator-known objective; "the direction changed at t — is the gap at t+n drift or adaptation?" has no published metric.
3. No validated semantic-alignment metric between a rich direction text and an action trajectory; judges and embeddings are unvalidated for this pairing.
4. No measurement of the value of a society as a structure — the additional value of self-organization (specialization, internal governance) is not a measured quantity.
5. No declared/done accounting protocol for agent societies: the ingredients exist (execution-state checks, adversarial audits, behavioral compliance) but are unassembled into a continuously verifiable promises → actions → effects register.
6. Few anti-Goodhart metrics for a value signal permanently optimized by the very system it measures.

## 4. Verdict

Can the value of a perpetual agentic society with a moving direction be measured with the state of the art? Not yet — a bounded, attackable hole. Reusable: continuous proxy economic value and the tool-use-constancy signal (Vending-Bench 1/2); the per-model reliability horizon (METR); execution-state verification (OSWorld); drift metrics GD_actions/GD_inaction (Arike et al.); Constraint Pinning (Chen); multi-layer anti-gaming verification with zero successful exploits (SWE-Marathon); agentic judging with environment access. Missing — the possible contribution: value aggregation over an infinite horizon; fidelity to a versioned direction, distinguishing faulty drift from legitimate adaptation; promises → actions → effects accounting for a population; anti-Goodhart guardrails for a metric optimized by its own object.
