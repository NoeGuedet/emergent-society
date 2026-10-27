# Chat & direction — the co-negotiation system

This document specifies how the direction is negotiated, carried and revised: the physical roles, the artifact that holds the direction, the act that makes a version authoritative, and the channel that carries it. Current state: the kernel pins a heading outside compaction and re-injects it verbatim on every request (implemented). Agent zero, the versioned letter, the ratification event and the chat itself are specified, not implemented. The technical realization belongs to [kernel.md](kernel.md); the seed-side consequences to [seed.md](seed.md).

## 1. Three physical roles, no mixing

- **The human** — the source. The idea, the thinking, the goal come from them. They speak only to agent zero.
- **Agent zero** — **translator co-orchestrator** (specified, not implemented). It translates in both directions — human intent → system heading, system state → human language — and makes governance possible without governing on its own initiative. It reads the raw frontier journal, the projections (custody, authority) and the world, and can question the nodes; each question is recorded in its own local log (a cold-start artifact, never a frontier fact — the frontier records HTTP exchanges only). It reads raw facts, never metrics: the sensors remain the human's instrument, otherwise they would leak into its heading drafts. It is never the only window: the human keeps direct access to the same raw projections (the cockpit), and agent zero's reports are verifiable against the raw evidence ("explain this spike" — audit by an agent independent of the population being audited).
- **The first node** (and all those after it) — standard nodes of the recursive graph, receiving the pinned heading exactly like any future node. Agent zero exists precisely so that the first node is not special.

**`speak`** (specified, not implemented): the human channel belongs to agent zero alone; no other node has a direct human channel. Between nodes there is no transport at all: a node is heard by **writing in the world**, which the kernel commits at the end of its turn with the node's uid as author, and which wakes every node that did not author it. Everything a node writes toward its parent is an observable, diffable commit — escalations, reports and "I can no longer see the heading" (instincts I4/I5) are free data points of the experiment.

## 2. The direction object — a double artifact

Constraint Pinning protects *literal* constraints: compaction erodes them, and pinning restores compliance (Governance Decay, arXiv:2606.22528 — a single compaction step raises the pooled violation rate from 0% to ~30%; pinning restores 0% at <0.5% context overhead; the paper's own honest-failure case: an operator-impersonation rescind breaks naive pinning, 0%→17%, hardened 10%). A *rich and implicit* direction is not pinnable as is. Hence two linked forms, versioned together:

- **The heading** — a few verbatim lines plus the cycle's value proxy ("how we will know this works"). Pinned outside compaction, re-injected at every turn, injected by the kernel into every child node's context. The proxy is **visible to the agents**: it is their work target — hiding it would divert them. The Goodhart risk is accepted: the measurement remains invisible, and the proxy↔intention gap is read by the human.
- **The letter** — the rich text of the negotiation (the why, the intentions, the context). Versioned with the heading, stored in the world, readable on demand by any node via its shell; never injected systematically (cost, cache, dilution).

Authority rule: **the current version is authoritative — not memory, not the last message.**

## 3. The crystallization

- The conversation is **free and pure**: no probe, no measurement, no hidden protocol.
- **Initiative**: both sides can open a revision — the human whenever they want, agent zero via a chat message (no dedicated format; the proposal is an observable event like any other).
- **Drafting**: agent zero drafts the version proposals (heading + proxy + letter); its reformulation reveals what it has understood of the heading.
- **Activation**: a version becomes active only upon **explicit ratification by the human** — the effective single-writer on the direction artifact: unintegrated writes carry conflicting implicit decisions (Cognition, "Don't Build Multi-Agents"). Ratification is the constitutive act of the object, not a barrier.
- The **ratification event** is dated and immutable, and its home is the world (a local-log-only home would place the ground truth off the observation surface). It is the ground truth of the whole metrology: post-heading relaxation time, drift vs adaptation, event studies — each heading change is a timestamped ITS intervention.
- **Cadence**: free, with a recorded recommendation — rare headings, intervening only when viability demands it. Headings too close together make relaxation unmeasurable: detection bounds on short time series are severe (Boettiger & Hastings 2012, J. R. Soc. Interface).

## 4. The channel (specified, not implemented)

Continuous and asynchronous: the human's messages enter the world as commits authored by the human, and agent zero wakes on that change like on any other — no channel priority, no forced interruption. Agent zero can initiate: propose a revision, relay a signal coming from the nodes, ask for clarification. The chat and the trajectory are two projections of the same surfaces (frontier journal + world history); the per-node local logs are cold-start artifacts no observer reads.

## 5. Non-goals

No measurement of sycophancy at first; no gates or approvals in the chat; no imposed cadence or revision heartbeat; no direct human ↔ working-node channel.

## 6. Consequences for the bootstrap ([seed.md](seed.md))

`speak` = agent zero alone; the seed prompt names "the person talking to you" as agent zero, not the human; the provisional v0 direction and its pinning stay as specified, and the first negotiation that retires v0 takes place between the human and agent zero.
