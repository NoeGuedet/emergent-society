# Chat & direction — the co-negotiation system

This document specifies how the direction of the system is negotiated, carried and
revised: the physical roles that make the negotiation possible, the artifact that
holds the direction, the act that makes a version authoritative, and the channel
that carries it. The technical realization of agent zero and of the heading
injection belongs to the kernel design (`kernel.md`); the seed-side consequences
are stated in `seed.md`.

## 1. Three physical roles, no mixing

- **The human** — the source. The idea, the thinking, the goal come from them. They speak only to agent zero.
- **Agent zero** — **translator co-orchestrator**. Its function: translate in both directions — human intent → system heading, and system state → human language. It does not work, it does not govern on its own initiative: it makes governance possible. Its output is the heading; its memory is the continuity of the intent.
  - **Reading equipment**: to perform the system → human translation (reports, chronology, who does what, analysis), it reads the **raw journal**, the **projections** (custody, authority) and the **workspace**, and it can **question the nodes**. The right to question is granted with full awareness of the influence bias; the trade-off is accepted because each question is a journal event, so the influence channel is traced and measurable as an intervention. Founding property: "model-visible means logged" makes its understanding possible *through the trace* — everything a node would say is already there.
  - **The anti-Goodhart line**: it reads the **raw facts**, never the **metrics** (the 3 sensors and their analyses remain the human's instrument — otherwise it would leak them into its heading drafts). Its own readings and questions are journaled: its mediation is itself auditable.
  - **Never the only window**: the human keeps direct access to the same raw projections (the cockpit); agent zero's reports are verifiable against the raw evidence ("explain this spike" pattern — and "audit by an agent independent of the population being audited": it is not part of the population that works).
- **The first node** (and all those after it) — standard nodes of the recursive graph. They receive the heading pinned by the kernel, **exactly like any future node**. Agent zero exists precisely so that the first node is not special: the same shape everywhere, from the start.

**Consequence for `speak`**: the human channel belongs only to agent zero. For any other node, `speak` **walks up the custody chain** — toward the parent, and therefore ultimately toward agent zero, which relays to the human whatever matters. Uniform and recursive: the root is the only node whose "parent" is the human. No direct human ↔ node channel. Corollary for the seed prompt: "the person talking to you" is not the human, it is agent zero.

This separation also settles the observation surface: everything nodes "say" to their parent is a journal event — the escalation of requests, reports and "I can no longer see the heading" (instincts I4/I5) becomes a free data point of the experiment.

## 2. The direction object — a double artifact

A constraint from the research: Constraint Pinning protects *literal* constraints (Governance Decay: 0% → 30-59% violation after compaction, pinning → 0%); a *rich and implicit* direction is not pinnable as is. Hence two linked forms, versioned together:

- **The heading** — a few verbatim lines, plus the **cycle's value proxy** ("how we will know it works"). Pinned outside compaction, reinjected at every turn, injected by the kernel into the context of every node. The proxy is **visible to the agents**: it is their work target — hiding it from them would divert them. The associated Goodhart risk is accepted: the measurement remains invisible, the proxy ↔ intention gap is read by the human.
- **The letter** — the rich text of the negotiation: the why, the intentions, the context. Versioned with the heading, stored in the workspace. Readable on demand by any node via its shell; never injected systematically (cost, cache, dilution).

Authority rule: **the current version is authoritative — not memory, not the last message** (already in the seed prompt).

## 3. The crystallization

- The conversation is **free and pure**: no probe, no measurement, no hidden protocol. The sycophancy question is not instrumented at first (see §5).
- **Initiative**: both sides can open a revision. The human whenever they want; agent zero via a simple chat message (consistent with v0's "any proposal is welcome" — no dedicated format, the proposal is an observable event like any other).
- **Drafting**: agent zero drafts the version proposals (heading + proxy + letter). It is the secretary of the negotiation — and its reformulation reveals for free what it has understood of the heading.
- **Activation**: a version becomes active only upon **explicit ratification by the human**. This is the effective single-writer: no ambiguity about "which is the current direction". It is not a guardrail — it is the constitutive act of the object.
- **The ratification event is dated and immutable in the journal.** It is the ground truth of the whole metrology: post-heading relaxation time, drift vs adaptation distinction, event studies. Without it, none of these measurements has a reference.
- **Cadence**: free, with a recorded recommendation — rare headings. Intervene only when viability demands it (Aubin's heavy solutions); headings that are too close together make relaxation unmeasurable (severe detection bounds on short series, Boettiger).

## 4. The channel

- **Continuous and asynchronous** chat: human messages enter agent zero's inbox like any other event — no channel priority, no forced interruption.
- Agent zero can **initiate**: propose a revision, relay a signal coming from the nodes, ask for clarification.
- The chat is a **projection of the journal**; the trajectory will be another (monitoring / the cockpit). One single truth, two readings.

## 5. Non-goals

- No measurement of sycophancy, whether active or passive, at first.
- No gates or approvals in the chat — the ratification of direction is the constitutive act of the object, not a barrier.
- No imposed cadence, no revision heartbeat.
- No direct human ↔ working-node channel.

## 6. Consequences for the bootstrap (`seed.md`)

1. `speak`: channel toward the custody parent (not "human channel") — §1 above.
2. Seed prompt: "the person talking to you" = agent zero, not the human.
3. The provisional-expiring v0 direction and the pinning are unchanged; the "first negotiation" that kills v0 takes place between the human and agent zero.

## 7. Points that belong to the kernel design (`kernel.md`)

- The technical nature of agent zero: a root node of the custody graph? Its loop, its exact tools (at minimum: `speak` toward the human + writing direction proposals).
- The kernel's heading injection mechanism (pinning outside compaction, injection into every child context).
- The event schema carrying direction versions and ratification.
- Agent zero's place in the two graphs (custody / authority).

## Main justifications (corpus)

- Direction = a first-class object, persistent, versioned, continuously revised — absent from the literature (`research/sota-autonomous-agents.md`, `research/value-adaptation-coupling.md`) — this is the contribution.
- Pinning outside compaction: documented counter to Governance Decay (arXiv:2606.22528); documented limit: rich direction not pinnable as is → double artifact (`research/value-measurement-long-horizon.md` §2.4).
- Dated ratification = ground truth of the metrology: heading change = timestamped ITS intervention (`research/value-adaptation-coupling.md`, `research/devils-advocate.md` §3.1).
- Single-writer on the direction artifact: unintegrated writes = conflicting implicit decisions (`research/devils-advocate.md` §2.7, Cognition).
- Cadence: Aubin's heavy solutions + short unmeasurable series (`research/value-adaptation-coupling.md`).
- Visible proxy / invisible measurement: the proxy is the work target (hiding it diverts the agent); the metrology stays out of reach (anti-Goodhart, unchanged project rule).
