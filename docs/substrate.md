# The substrate is a treatment — a design challenge for the engine

**Status.** Design proposal. Not implemented. Scope: the engine — the physics a node inhabits — not the operator's product surface.

The [vision](vision.md) is a proactive, perpetual society steered by a [direction](direction.md) that a human and an agent zero co-negotiate. The engine's substrate is not a neutral background for that society: it is a treatment. It enables some behaviours, suppresses others, and decides what can be observed. The current substrate — specified in [kernel.md](kernel.md), mapped in [architecture.md](architecture.md) — was designed for a single-node research prototype; it is coherent for that purpose. It is not yet the substrate of a society. This note names the choices, challenges them against the vision, and proposes a revised substrate with a migration path.

The argument is not that the current choices are wrong. It is that they are *choices*, and that a research engine should know which of its constraints are conditions of the phenomenon and which are opinions disguised as gravity.

## 1. The substrate today

| Choice | What it buys | What it costs |
|---|---|---|
| **One shared mutable git worktree** | Communication is a file; one history; direct observation; the simplest medium that works | No per-file attribution; overwrites; no concurrency; a peer's dirty files ride the next commit; `.gitignore` can silence the channel; the worktree is a single point of failure |
| **Commit per turn** | A clean unit of observation; authorship; the journal/turn/world join; a bounded effect; a fence around the critical section | A turn-batched society; intra-turn acts are invisible; a crash loses the turn; attribution stops at the commit |
| **Wake on a foreign commit** | No idle cost; an observable trigger; simple and deterministic | A reactive society; no initiative; the human becomes the clock; "perpetual" becomes "suspended" when nothing happens |
| **A pinned heading** | The direction survives compaction; a stable reference for drift; the metronome | A static, top-down direction; a strong prior; compliance pressure; the rich letter is absent |
| **Compaction at 256 KiB** | A physical pressure to externalize; bounded cost; a visible transaction | A byte threshold, not the model window; short runs never reach it; a prompt above the window but below the threshold can deadlock a node; compaction is deletion, not summarization |
| **One host per home** | Simplicity; one writer; no concurrency bugs; a safe prototype | No concurrent society; the operator is the scheduler; the multi-node claim is aspirational |

Three choices are easy to miss because they are not in the list above: **one public square** (a single world biases the topology toward one room), **one model family** (a society of clones is a weak analogue), and **one frontier per cell without node identity** (the record has a total order but no actor).

## 2. Why the substrate is the experiment

The medium is the message. A shared mutable worktree makes communication an overwrite and coordination a convention. A commit per turn makes the society batch-like. A wake on a foreign commit makes it reactive. A static pinned heading makes it compliant. A 256 KiB hole decides when memory begins to matter. A single host makes plurality impossible.

The experiment therefore measures *which society this substrate produces*, not *society from nothing*. That is not a defect: it is the condition of any observation. The defect would be to leave the constitution unexamined. The question is not "how do we remove structure?" but "which structure is load-bearing for the phenomenon?"

## 3. The criterion

A substrate choice is a treatment if it can be stated, measured, and ablated. Four questions:

- **Enable** — what does it make possible?
- **Distort** — what behaviour does it induce?
- **Observe** — what signal does it leave in the journal or the world?
- **Ablate** — what is the control condition?

A choice that cannot be ablated is a constitution. A choice that can be is a variable. The goal is to turn as many choices as possible into variables.

The minimum is not zero. The minimum is the set of constraints whose ablation makes the phenomenon invisible. Everything beyond that set must be justified, measured, or varied.

## 4. Challenges

### 4.1 The shared mutable worktree

*What it buys.* Communication is a file, and the world is the only channel. One history, one tree, no protocol. It is the simplest medium in which a society of writers can exist, and it makes the world directly readable by every node.

*What it costs.* No per-file attribution: a commit names the turn's author, not the writer of every file. Overwrites are silent; last bytes win. There is no concurrency: one worktree, one commit path. A node can wedge the commit path with a large file or an unreadable path. `.gitignore` and `.gitattributes` let a node silence or hide content from its peers and from history. A commit can carry a peer's in-flight writes. The worktree is a single point of failure.

*Alternative.* Separate the two objects the current design conflates: the **world** as a shared, read-only history of published state, and a **workspace** as a private, writable draft per node. Publication is a kernel-mediated integration at the turn boundary, with conflict detection and attribution. Communication remains file-based — the world is still the medium — but the publication becomes an observable social act. The cost is an integration protocol. The benefit is plurality, ownership, and per-publication attribution; conflict becomes an explicit phenomenon rather than a silent overwrite.

*Verdict.* Keep the shared mutable worktree if the *object* of study is "which conventions emerge in a shared mutable world". Replace it if the *medium* must support a society. The vision needs plurality; the current choice is the medium, not the object. This is the largest bet to reopen.

### 4.2 Commit per turn

*What it buys.* A clean unit of observation, authorship, the join between the local turn and the world's history, a bounded effect, and a natural critical section for the commit fence.

*What it costs.* The society is batch-like: acts are gathered, then published. Intra-turn acts are invisible until the turn closes. A crash loses the turn's uncommitted work, or sweeps it into a recovery commit. Attribution stops at the commit. The turn boundary is a strong temporal structure, and it is easy to mistake it for the society's natural clock.

*Alternative.* Continuous commits, per-node branches, or a checkpoint/publish split. Each has a cost: noise, merge work, or a more complex attribution model.

*Verdict.* Keep it as the measurement unit for the first experiment. Treat it as a variable: compare turn-based publication with asynchronous publication. Do not mistake the turn for the society.

### 4.3 Wake on a foreign commit

*What it buys.* No idle cost. A static world spends no tokens. The trigger is an observable event, and the wake predicate is simple: a commit the node did not author.

*What it costs.* The society is reactive. A node cannot choose to act on a schedule, to think when nothing changes, or to maintain itself. With no peers, the human is the clock. "Perpetual" becomes "suspended" whenever the world is still. The founder panel named this directly: a perpetual system without a timer is a photograph, not a loop ([research/founder-panel.md](research/founder-panel.md)).

*Alternative.* A timer or heartbeat, with a budget. The wake predicate becomes a disjunction: a foreign commit, a schedule, or an internal goal. The timer is physics, not organization: it gives time to the system without giving it a task queue or a scheduler.

*Verdict.* The current choice is insufficient for the vision. Add a timer, bound it with a budget, and treat "reactive versus proactive" as a variable.

### 4.4 The pinned heading

*What it buys.* The direction survives compaction. It is re-injected on every request, so the current version remains authoritative even after the history is rewritten. It is the metronome against which drift and adaptation are measured.

*What it costs.* The heading is static: it is set at boot and cannot be revised. It is a strong top-down constraint. It is always visible, which invites compliance and Goodhart pressure. It is a few lines, not the rich letter the design describes. The pin protects a text that the system cannot yet change.

*Alternative.* Keep the pin as the mechanism, and make the heading a versioned artifact: a heading, a value proxy and a letter, revised through the chat and activated by an explicit human ratification. The pin ensures the current version is never lost to compaction; the version is the object the experiment studies.

*Verdict.* Keep the pin; it is the anti-drift mechanism. The static heading is a placeholder, not the thesis. Separate the invariants (a constitution that should not drift) from the direction (a goal that should be revisable); the pin protects the former, the version carries the latter.

### 4.5 The 256 KiB hole

*What it buys.* A physical pressure to externalize. The context is finite, so whatever is not written down is lost. Cost is bounded. The compaction is a visible transaction.

*What it costs.* The threshold is a byte count, not the model's window. It is high enough that short live runs never reach it, so the Necessity leg is untested. A prompt above the model's window but below the threshold can receive a terminal refusal and leave a node parked. Compaction is deletion, not summarization: the removed text is gone from the model's context.

*Alternative.* A token-based threshold calibrated to the model window, with a reserve for the response and the pinned prefix. Test at least two sizes, small and large, as an ablation. Keep the transaction durable and visible; the notice is the minimum.

*Verdict.* Keep the Hole; calibrate it. A hole that never binds is not a necessity, it is scenery. The Necessity leg of the hypothesis is untested until compaction actually fires and the agent must adapt.

### 4.6 One host per home

*What it buys.* Simplicity. One writer, one owner record, one driver, no concurrency bugs. It is the right shape for a single-node prototype.

*What it costs.* There is no concurrent society. A second node is a second home or a time-sharing session; the operator is the scheduler. The multi-node claim is aspirational, and the social phenomena that require plurality — division of labour, peer review, disagreement, coordination — cannot be observed.

*Alternative.* N drivers in one host, or N hosts on a shared world. Each node keeps its own local log; the frontier is shared; a commit queue serializes publication; each node gets its own cgroup leaf. The isolation work already anticipates per-node leaves; the host composition is the missing piece.

*Verdict.* This is a prototype limitation, not a research choice. Lift it first.

### 4.7 Hidden choices

- **One public square.** A single world biases the topology toward one room. The agents can carve subspaces with directories, so the choice is not fatal, but the substrate should not decide the topology by default. Either support multiple spaces or state the single-square assumption as part of the treatment.
- **One model family.** A society of clones can coordinate, but it is a weak analogue of a society. Different models per node are already possible through configuration; the choice is whether the experiment treats the monoculture as a condition or as a variable.
- **One frontier per cell without node identity.** The frontier has a total order and no actor. Under concurrency, a model call cannot be attributed to a node from the frontier alone. A frontier version with a node field, or a kernel-signed sidecar, is the observation-substrate fix.

## 5. A revised substrate

A proposal, not a mandate:

- **World.** A shared, read-only history of published state.
- **Workspace.** A private, writable draft per node.
- **Publish.** A kernel-mediated integration at the turn boundary; conflicts are detected and recorded; attribution is per publication.
- **Time.** A timer plus wake-on-change. A node may act on a schedule, on a foreign change, or on an internal goal; a budget bounds the cost.
- **Direction.** A versioned heading and letter; ratification is a dated event; the pinned heading is the metronome; the invariants are separate.
- **Memory.** Token-calibrated compaction; a durable, visible transaction; externalization is the agent's work.
- **Plurality.** N nodes, per-node workspaces, a shared world, a shared frontier with attribution.
- **Observation.** Frontier plus world; node identity; a read-only event log for the agents; metrics outside the world.
- **Safety.** The existing confinement and cgroups; a kill switch; the delegated launch as the default; an egress policy.

## 6. What stays

The journal's durability discipline; the commit plumbing; the refusal taxonomy; the confinement; the Package layer; the documentation's honesty about status and residuals. The proposal changes the topology of the substrate, not its engineering standard. A revision that weakens the record to gain plurality would be a bad trade.

## 7. Migration path

Each increment has a proof and a control. No increment without a falsifiable claim.

1. **Plurality.** N drivers, per-node logs, a commit queue, cgroup leaves. *Proof:* two concurrent nodes commit with distinct authors; the frontier remains one chain; no commit is lost. *Control:* one node.
2. **Time.** A timer and a budget. *Proof:* a node wakes on schedule with no foreign commit and produces a turn. *Control:* wake-on-change only.
3. **World model.** Private workspace plus publish. *Proof:* two nodes edit the same file; the integration produces a conflict event; both publications are attributable. *Control:* the shared mutable worktree.
4. **Direction.** A versioned heading plus ratification. *Proof:* a ratified change appears in every node's next request; the old version is archived. *Control:* a static heading.
5. **Hole.** Token-calibrated compaction. *Proof:* compaction fires at the threshold; the agent externalizes; the transaction is durable. *Control:* a large context with no compaction.
6. **Observation.** Node identity. *Proof:* every model call is attributable under concurrency. *Control:* commit-granular attribution only.

The order matters: plurality and time are the conditions of the phenomena the vision describes; the world model is the largest bet; the direction is the thesis; the hole and the observation substrate make the thesis measurable.

## 8. Open questions

- Is the world one shared history or multiple spaces?
- Is publication per turn or continuous?
- Is the timer a kernel primitive or a Package?
- Is the direction a system message or a world file?
- Is the society one model family or many?
- What is the unit of attribution: turn, commit, file, or call?
- Does the revised substrate still produce the phenomenon, or does it make the society too indirect?

## 9. The test of the revision

The revision is good if it makes the vision's questions answerable: does a proactive society hold a direction? does structure emerge, or is it the substrate? can a human steer without breaking what makes it emergent?

If the substrate cannot be ablated into variants, it is still a constitution, not an experiment. The goal is not a smaller substrate. It is a substrate whose every clause is justified, observed, and variable.
