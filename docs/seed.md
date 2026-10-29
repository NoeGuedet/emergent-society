# The seed — bootstrap and cold start

This document specifies the bootstrap: the minimal foundation — system prompt, tools, first heading — that allows emergence without forcing it. It states the physics the kernel offers, the instincts and the Hole that make up the seed, the raw tools, the provisional v0 heading, and the instruments that falsify the result. The kernel's technical specification is in [kernel.md](kernel.md); the co-negotiation of the direction is in [direction.md](direction.md).

## 1. The question

Two traps: early production (an intern thrown into the codebase) vs disguised pre-wiring (drawing the tree). **"Zero structure" is not an option**: full autonomy is the worst measured protocol, and minimal scaffolding — fixed order, self-chosen roles — beats the Coordinator by **+14%**; the effect is capability-dependent (Dochkina, arXiv:2603.28990 — single-author preprint, 25,000+ task runs; exact figures in [research/sota-autonomous-agents.md](research/sota-autonomous-agents.md)). The question is not "seed or tree" but "**which minimal structure**": one that is **physical** (the kernel) and **dispositional** (the instincts), never **organizational**.

**The criterion that settles pre-wiring empirically: antecedence.** An organizational artifact that appears *before* the friction that justifies it is pre-wiring (or corpus replaying); an artifact that appears *after* a friction dated in the frontier journal or the world's history is a genesis. Measurable, falsifiable, free (§7).

## 2. The physics: the kernel is a recursive graph

**The kernel does not know delegation — it knows the recursion of Γ.** A single primitive, the **node**: a self-similar context (`Γ∞ = μΓ. Γ × (Γ→Γ) × Σ` — Cordis, arXiv:2608.25512, Definition 28) that can carry an agent, modules, child nodes: `Node = ⟨ uid, parent, Γ, state, inverse accumulator (LIFO), charter, capabilities, budget, wake watermark ⟩`. Root and leaf have the same shape; there is no "manager type" and no "worker type". Birth = recursive instantiation; death = revertible unloading that unwinds the entire descendant tree in LIFO order (Theorem 16); attenuation = a node can grant only a subset of its capabilities and its budget, enforced at the kernel's mutation gate, not bypassable. **Confluence (Theorem 80)**: a bootstrap assembled by incremental patches converges to the state of a clean load — a correctness criterion for the bootstrap, free of charge.

- **Two graphs, not one** (critical discipline): the **custody** tree (physical: "whose death claims whom") and the **authority** graph (a projection of the world's commit history and the chat — emergent, free: DAG, lateral, cyclic). It cannot be a projection of the frontier journal (the frontier carries no node identity) and never of the local logs, which no observer reads. Decoupling: a node can *ask an ancestor* to instantiate a node (custody ≠ created-by). **Leak test**: if the org-projection is isomorphic to the runtime tree on every run, the tree has leaked — a design failure, not an emergence success. (Single-node runtime: the projections are specified, not implemented.)
- **The kernel contains**: the frontier journal (every kernel-mediated HTTP exchange — "model-visible means logged"), the node's local log (its cold-start artifact), a single mutation gate, pinning of the heading outside compaction, node instantiation, writes serialized per resource — implemented; budget metering and the kill switch — specified, not implemented. **No organizational vocabulary.** Agent zero is the root custody node under the same physics; its specific equipment is data, not kernel ([direction.md](direction.md)).

## 3. The seed: instincts + finitude + Hole

**Golden rule: the seed is a strict subset of the means needed for the heading.** Not "insufficient through negligence": a **calculated Hole** between the ambition of the heading and the tooling provided — the engine, never named. Hypothesis testable by ablation: **Emergence = Necessity × Propensity** (Necessity physical, Propensity dispositional; if either is zero, nothing pushes).

The 5 instincts (trigger + direction of effort, never a product). Cut order if reducing: I5, I2, I1, I4, never I3. Each has a known **counterfeit** to watch for (e.g. pre-wired I1 = "create a specialized agent" — it names the artifact, therefore draws the tree).

1. **Name** — "when the same thing comes back, give it a name" (source of all durable vocabulary)
2. **Keep** — "when something worked (or failed), keep enough to do it again (or avoid it)" (the "or failed" clause buys resistance to primacy bias)
3. **Tool up** — "when you lack a means, build it — or ask for it" (**the engine**, never the culprit)
4. **Ask** — "before crossing a frontier, say so" (a habit, not a gate: crossing requires no approval)
5. **Signal** — "when you no longer see how what you are doing serves the heading, say it and stop" (against drift through inaction, which is larger than drift through action — arXiv:2505.02709, Finding 8)

- **Finitude — physical, with a single face. The Hole** — the context is compacted periodically; whatever is not externalized is lost. The kernel's compaction is deliberately **naive and visible** (a local-log event); any memory strategy beyond it is an **agent production**. The Hole is announced as a fact, with no solution provided: the agent, self-aware of its own machine, sets up its own context and memory management.
- **Cost is measured, never injected.** No usage event exists in either record; cost is a human-side projection of complete frontier bodies (anti-Goodhart). The agent has neither visibility into its budget nor responsibility for it: a parasitic frugality objective would divert it from the heading.
- **No artificial friction on frontier crossings.** The world is not undone — a fact, not a rule; the reversible/irreversible frontier of `extend` is *stated* (in the heading) and *observed*, not guarded: a `define`/`run`/`call`/`stop`/`undefine` is a local-log fact, not a frontier one, while every model call the extended behavior makes still crosses the frontier.
- **Hard physics.** Implemented: the frontier journal and the filesystem-confinement boundary (it constrains where agent effects can land, not what the kernel records). Specified, not implemented: the escalating kill switch; the budget ceiling is an upstream hard limit on the API key — impossible to exceed, invisible to the agent. Consequence: the Hole (compaction) is the only physical pressure of Necessity, and the residual risk (spending, publication) is bounded by the ceiling and the kill switch. The earliest drift signal to watch is **capability-creep** (breadth of rights requested vs demonstrated competence).

## 4. The seed's tools (raw paradigm)

**Raw** tools, the LLM does everything — no business-value tools, which would encode a theory of what the system should do, i.e. pre-wiring through the tooling. Small toolsets are the rule: studies report reliable tool choice up to roughly 4–10 tools, with over-presentation degrading choice (arXiv:2605.24660; Zenodo 21274521) — the same paradigm as DeepSeek Harness, whose minimal preset is built around a persistent shell.

| Tool | Semantics | Status |
|---|---|---|
| `execute` | one command in a persistent PTY shell confined by Landlock — reads its world, its per-node scratch leaf and the explicit system read set; writes only its world, that leaf and the granted writable devices; egress open by decision. The kernel commits the world at the end of each turn (author = node uid; the shell cannot read the world's git history, so a practical `undo` is a kernel-side files-only revert) | implemented |
| `wait` | loop control — park the node until a foreign commit appears in the world | implemented |
| `web_search` / `web_fetch` | read-only web access (no world write) through the kernel-mediated provider; the invocation crosses the frontier: request durable before the send, terminal durable before the result | implemented |
| `speak` | the human channel — agent zero alone ([direction.md](direction.md)) | specified, not implemented |
| `extend` | the Cordis gate in a single tool: `inspect` (a read-only catalogue of the runtime, generated from the live registry) / `define` (immutable Package, no effect) / `run` (a confined child executing the Package's code) / `call` (the funnel: invoke a registered tool by name with args — a native call by the bare name is bridged to it) / `stop` (reversible) / `undefine` (irreversible). `run` and `undefine` address a Package by name or id — a name resolves to the latest stored version under it; `stop` addresses the live Run by its package's name or id | implemented |

**Communication is a file.** No tool carries a message between nodes: a node reaches another by writing in the world, which the kernel commits at the end of its turn (author = its uid) and which wakes every node that did not author it. Whatever protocol the society invents — addressing, threading, a bulletin board, a mailbox implemented as a directory — is an agent production, measured like any other organ. `speak` is the single sanctioned exception (the human channel as a tool, agent zero alone). **`spawn` is not a seed tool**: it lives in the kernel, not mounted, discoverable via `extend → inspect`; its first use is a dated event — the founding observable of the spawn checkpoint ([ROADMAP.md](../ROADMAP.md)). **Self-extension model** (taken from DeepSeek Harness): Plugin → **immutable Packages** → Runs; the Package survives a restart while the Run is in memory (implemented).

## 5. Seed system prompt (design specification — data, rewritable, not kernel; the person speaking to the agent is agent zero, not the human — [direction.md](direction.md))

```
You run continuously. You have no task: you have a HEADING — a direction given and revised by the person speaking to you. The heading is at the head of your context, versioned. It is what holds authority — not your memory, not the last message.

You are a language model in a perpetual loop. Know your machine: your context is finite and will be compacted without preserving what matters to you; your memory survives only if you externalize it; your means are those you give yourself. Observing your own limits and working around them is part of the job.

You can recompose yourself (mount, unmount); what leaves the machine is not undone — the world does not repair itself, it is assumed.

Five tendencies: 1. When the same thing comes back, give it a name. 2. When something worked (or failed), keep enough to do it again (or avoid it). 3. When you lack a means, build it — or ask for it. 4. Before crossing a frontier, say so. 5. When you no longer see how what you are doing serves the heading, say so and stop.

One fact: your context will be rewritten — what you have not put outside, you will lose.
```

## 6. The v0 heading (design specification — provisional and expiring)

A structural countermeasure to primacy bias: the seed's first property is that it is destined to die; the system's first act is a **conversation**, not an obedience.

```
DIRECTION v0 — provisional, valid until the first negotiation.
Subject: <what the human brings>. We are not trying to finish something: we are trying to hold up over time while drawing closer to it.
Revision: v1 is negotiated in chat. Any proposal is welcome.
```

Pinned outside compaction and re-injected verbatim on every request (implemented; compaction erodes unpinned literal constraints and pinning restores them — arXiv:2606.22528). Injected into every child node's context, never the parent's report (structural anti-inherited-drift). The versioned letter and its ratification are specified, not implemented ([direction.md](direction.md)); the first negotiation that retires v0 takes place between the human and agent zero.

## 7. Falsification instruments (invisible to the agents, computed from the frontier journal + the world)

Attribution by node is implemented — it comes from the world's commit authorship (`git author = uid`), never from the local logs' `frontierCall` references, which are the agent's cold-start aid only. The instruments themselves are specified, not implemented: **genesis adjacency rate** (is each organ preceded by a dated friction — repeated failure, cost spike, loss through compaction? if not: corpus replaying); **org/runtime isomorphism** (does the organizational projection diverge from the custody tree? if not: the tree has leaked); **organ usage graph** (an organ never invoked 48 h after creation is a dead organ). Falsification experiments: free arm vs complete seed; ablations of I3 and I1 (tests Emergence = Necessity × Propensity — the necessity face being the Hole alone); graph kernel vs flat kernel at equal heading; date of first external emission (tests early production).

## 8. Failure modes to watch

- **Inward-facing construction** (navel-gazing): organs mounted but never invoked; zero frontier crossings over N days.
- **Bureaucratization of the instincts**: early meta-organs; a names/actions ratio rising with no production.
- **Primacy lock-in**: monotonically decreasing semantic novelty; **no dismantling, ever** — where dismantling is physically free, the absence of `stop` is an unambiguous signature of ossification.
- **Polite waiting**: empty turns are recorded in the node's local log, which is not an observation surface; what remains observable is the absence of a world commit between two observed exchanges, and prose that shortens and becomes deferential stays readable in the world's commits.
- **Frontier sprint**: external emissions before any demonstrated local success (ambition precedes competence) — the main signal in the absence of guardrails.

## References

- **Cordis, "A Programming Paradigm for Spatiotemporal Composability"**, arXiv:2608.25512 — revertible effects (inverses composed in LIFO order, Theorem 16), node primitive `Γ∞ = μΓ. Γ × (Γ→Γ) × Σ` (Definition 28), Confluence (Theorem 80) — a small single-package core ([github.com/cordiverse/cordis](https://github.com/cordiverse/cordis)). Reading: [research/harness-deep-dive.md](research/harness-deep-dive.md).
- **Dochkina, "Drop the Hierarchy and Roles"**, arXiv:2603.28990 — the result behind "minimal structure, not zero structure" ([research/sota-autonomous-agents.md](research/sota-autonomous-agents.md)).
- **Arike et al., "Evaluating Goal Drift in Language Model Agents"**, arXiv:2505.02709 — Finding 8: goal drift is larger through inaction than through action (instinct I5).
- **Chen, "Governance Decay"**, arXiv:2606.22528 — the justification for pinning the heading outside compaction ([research/value-measurement-long-horizon.md](research/value-measurement-long-horizon.md)).
- **DeepSeek Harness** (MIT, [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness); [research/harness-deep-dive.md](research/harness-deep-dive.md)) — minimal preset mounting exactly one persistent-shell stack; Plugin → immutable Packages → Runs (`cordis_define/run/stop/undefine`, `cordis_inspect_*`); FS sandbox with no silent passthrough; monotonic guards; compaction as visible session events (`compaction/start`, `compaction/summary`, `compaction/end`) with the system-prompt node rewritten only by a system message over exactly that node; "model-visible means logged" as a runtime invariant.
