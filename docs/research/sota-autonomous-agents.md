# State of the art — perpetual and self-evolving autonomous agents

Positioning survey for this project. Every external fact carries an inline citation at point
of use; evidential status is a property of the source (a preprint is cited as a preprint).
Design conclusions live in [kernel.md](../kernel.md), progress in [ROADMAP.md](../../ROADMAP.md).

## Perpetual operation is infrastructure

- Voyager (arXiv:2305.16291): the founding open-ended agent — an LLM-driven Minecraft
  agent with an automatic curriculum and an ever-growing skill library, no human-set objective.
- Generative Agents (arXiv:2304.03442): 25 agents populate a small-town sandbox;
  observation, memory, reflection and planning alone produce believable individual and
  emergent social behavior.
- MemGPT (arXiv:2310.08560): OS-inspired tiered memory the agent edits itself to sustain
  long-term interactions; its lineage is Letta, a persistent-memory agent platform
  (letta.com).
- Ambient agents (blog.langchain.com/introducing-ambient-agents): event-stream-triggered,
  not prompt-triggered, with three human-in-the-loop patterns: notify, question, review.
- OpenClaw (github.com/openclaw/openclaw, MIT): open-source, self-hosted persistent agents.
- Durable execution engines — Temporal, Restate, DBOS — provide journaled, resumable
  execution for long-running agent workloads.

None of these treats *direction* as a first-class object: persistence is solved;
continuous human steering of a perpetual system is not.

## Measured long-horizon capability

METR time horizons (metr.org/time-horizons) — task length completed at a given success
rate, per model. A horizon figure is meaningless without its model:

| Model | 50% horizon | 80% horizon |
|---|---|---|
| Claude Opus 4.6 | ≈ 11 h 59 | ≈ 1 h 10 |
| Claude Mythos Preview | ≈ 17.4 h | ≈ 3 h 06 |
| GPT-5 | ≈ 2 h 17 | — |
| GPT-5.4 | 5 h 42 | 54 min |

METR flags measurements above ~16 h as unreliable with the current task suite.

## Self-evolution

- Darwin Gödel Machine (arXiv:2505.22954, ICLR 2026): an agent rewrites its own code
  under archive-based open-ended search; SWE-bench 20.0% → 50.0%, Polyglot 14.2% → 30.7%.
- A Survey of Self-Evolving Agents (arXiv:2507.21046, TMLR): organizes the field by what,
  when and how to evolve; long-horizon operation is among the open challenges it names.

## Multi-agent emergence and its bounds

- Dochkina (arXiv:2603.28990, single-author preprint): 25,000+ task runs, 8 models,
  4–256 agents, 8 coordination protocols. With minimal scaffolding — fixed turn order,
  roles chosen by the agents — agents invent specialized roles (5,006 unique role names at
  8 agents), voluntarily abstain outside their competence, and form flat hierarchies.
  Minimal scaffolding beats the central Coordinator by +14% (p<0.001); Sequential vs
  Shared is +44% (Cohen's d=1.86, p<0.0001); the emergent-vs-fixed-roles effect is small
  and capability-dependent (+3.5% strongest model, −9.6% reversal weakest); no quality
  gain past 64 agents (p=0.61).
- Kim et al. (arXiv:2512.08296, v3): 260 configurations, six agentic benchmarks, three LLM
  families, five architectures. Multi-agent configurations often fail to beat a single
  agent: a capability ceiling β=−0.236 (95% CI [−0.396, −0.076], p=0.004) — tasks where
  single-agent accuracy already exceeds 45% see negative returns; mean success 0.370
  (independent) vs 0.466 (single agent); independent configurations amplify trace errors
  17.2× (centralized coordination contains this to 4.4×).
- Shared lesson: role emergence is real but bounded by a capability threshold; below it, rigid structure wins.

## Direction, drift, and constraint retention

- Goal drift (arXiv:2505.02709, AIES 2025): every evaluated model drifts from its goal —
  more through inaction than through action; the best scaffolded agent holds near-perfect
  adherence for ~100k tokens.
- Governance decay (arXiv:2606.22528): one compaction step raises constraint violations
  from 0% to 30% (up to 59% per model) when the constraint is dropped from the summary;
  re-injecting a pinned policy restores 0% at <0.5% token overhead; soft organization
  policies decay 8.3× faster than hard safety norms.

Both results bear on a persistent *direction*: the context window is the medium, and it
leaks — a direction that lives only in context will not survive.

## Event-sourcing for agents

ESAA (arXiv:2602.23193): agents emit structured intentions (validated JSON) to an
append-only event store; a deterministic orchestrator persists and applies them; replay
re-derives state from the log; the event vocabulary was consolidated from 15 to 5 types.
The durable execution engines above supply the same journal/state separation.

## Contribution space — gap scorecard

- Gap 1 — adaptive dynamics coupled to value *produced* for the society: **narrowed**.
  CIVA (arXiv:2604.05339) couples human values to collective dynamics; no work couples
  adaptation to value produced.
- Gap 2 — event-study / interrupted-time-series methods on agent-society behavioral
  journals: **narrowed**. A quasi-experimental ITS design exists for production
  agent-system *operational* metrics (Zenodo 19433217); behavioral event studies after a
  direction change remain absent.
- Gap 3 — direction as a persistent, versioned artifact continuously co-negotiated with a
  human: **holds**. Nearest neighbors: human-ratified memory persistence
  (arXiv:2605.04264); versioned, human-authored mission-intent packages ("Large Language
  Fields", Zenodo); the NorthStar MCP goal store (github.com/HolyWill90/North-Star-MCP).
  None co-negotiates direction.
- Gap 4 — measured evolvability carried over to collectives of LLM agents: **narrowed**.
  Behavioral inheritance/erosion is quantitatively measurable in adversarially selected
  LLM-agent populations (Zenodo 20174100, non-peer-reviewed preprint); no peer-reviewed work.
- Gap 5 — viability theory operationalized for social multi-agent systems: **holds**; the
  literature remains classical applications.
- Gap 6 — critical slowing down / relaxation rate as a *society health* metric: **holds**.
  Nearest neighbor: CSD-consistent early-warning signals for single-model inferential
  stability (Zenodo 19100756). No unified instrument combines explore/exploit phase, drift,
  organizational anatomy and value accounting (nearest: "Relational Cognitive Telemetry",
  Zenodo 20234606).
- Gap 7 — anomaly detection on temporal graphs of inter-agent communication: the "never
  applied" claim is **refuted**. GUARDIAN (NeurIPS 2025) and SAGA (arXiv:2607.17288) model
  multi-agent collaboration as temporal graphs and flag anomalous nodes and edges. What
  remains open is different in kind: anomaly flagging is not health metrology — no work
  measures society health from communication-graph dynamics.

## Where this project sits

Perpetuity is infrastructure, self-evolution and emergence are demonstrated with
capability bounds, journaling is established. The unoccupied cell: a perpetual system
whose structure emerges under a direction continuously co-negotiated with a human, with
society health measured on its journal. Gaps 3 and 6 are the contribution space; gaps
1, 2, 4 and 7 define the neighbors and what they do not do.