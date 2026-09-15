# The seed — bootstrap and cold start

This document specifies the bootstrap of the system: the minimal foundation — system prompt, tools, first heading — that allows emergence without forcing it. It states the physics the kernel offers, the instincts and the Hole that make up the seed, the raw tools, the provisional v0 heading, and the instruments that falsify the result. The kernel's technical specification is in `kernel.md`; the co-negotiation of the direction is in `direction.md`.

---

## 1. The question

> How do we provide a minimalist foundation (system prompt, tools, first heading) that allows emergence without forcing it? Double trap: early production (the intern thrown into the code) vs disguised pre-wiring (drawing the tree).

**"Zero structure" is not an option.** Full autonomy is the worst measured protocol in the corpus: minimal scaffolding (fixed order, self-chosen roles) beats it by +44% (Cohen's d=1.86, 25,000 tasks, 8 models; Dochkina, arXiv:2603.28990 — single-author preprint, and the emergent-vs-designed-roles effect is smaller and capability-dependent: +3.5% for a strong model, −9.6% reversal for a weak one). The question is therefore not "seed or tree" but "**which minimal structure**". The answer: a structure that is **physical** (the kernel) and **dispositional** (the instincts), never **organizational**.

**The criterion that settles pre-wiring empirically: antecedence.** An organizational artifact that appears *before* the friction that justifies it is pre-wiring (or corpus replaying); an artifact that appears *after* a friction dated in the journal is a genesis. Measurable, falsifiable, free (§8).

## 2. The physics: the kernel is a recursive graph

**The kernel does not know delegation — it knows the recursion of Γ.** A single primitive: the **node**, a self-similar context (`Γ∞ = μΓ. Γ × (Γ→Γ) × Σ`, Cordis, arXiv:2608.25512) that can carry an agent, modules, child nodes. Root and leaf have the same shape; there is no "manager type" and no "worker type".

```
Node = ⟨ uid, parent, Γ, state, inverse accumulator (LIFO), charter, capabilities, budget, inbox ⟩
```

- **Birth** = recursive instantiation; **death** = reversible unloading that unwinds the entire descendant tree in LIFO order; **attenuation** = a node can grant only a subset of its capabilities and its budget, enforced *at the kernel's mutation gate* (not bypassable, whatever the path of the request).
- **Confluence (Th. 80)** = a bootstrap cobbled together by incremental patches converges to the state of a clean load — a correctness criterion for the bootstrap, free of charge.
- **Two graphs, not one** (critical discipline): the **custody** tree (physical: "whose death claims whom" — same order as "pid 43 has pid 1 as parent") and the **authority** graph (projection of the journal, emergent, free: DAG, lateral, cyclic). Decoupling mechanism: a node can *ask an ancestor* to instantiate a node (custody ≠ created-by). **Leak test: if the org-projection is isomorphic to the runtime tree on every run, the tree has leaked — a design failure, not an emergence success.**
- The kernel contains: an append-only journal ("model-visible means logged"), a single mutation gate (`effect → disposer`), pinning of the heading outside compaction, budget metering, the kill switch, a single write token per resource (writes single-thread), node instantiation. **No organizational vocabulary.**

Agent zero is the root custody node and is subject to the same physics as every other node (same loop, same inbox, same compaction, same journal); its specific equipment — human channel, drafting of heading proposals, reading of the raw journal and projections, right to question nodes — is data, not kernel (`direction.md` §1).

## 3. The seed: instincts + finitude + Hole

**Golden rule: the seed is a strict subset of the means needed for the heading.** Not "insufficient through negligence": a **calculated Hole** between the ambition of the heading and the tooling provided. The Hole is the engine; it is never named.

**Hypothesis testable by ablation: Emergence = Necessity × Propensity.** Necessity is physical (finitude), Propensity is dispositional (the instincts). If either is zero, nothing pushes.

### The 5 instincts (trigger + direction of effort, never a product)

1. **Name** — "when the same thing comes back, give it a name" (source of all durable vocabulary)
2. **Keep** — "when something worked (or failed), keep enough to do it again (or avoid it)" (the "or failed" clause buys resistance to primacy bias)
3. **Tool up** — "when you lack a means, build it — or ask for it" (**the engine**, never the culprit)
4. **Ask** — "before crossing a frontier, say so" (a habit, not a gate: crossing requires no approval)
5. **Signal** — "when you no longer see how what you are doing serves the heading, say it and stop" (against drift through inaction, which dominates empirically)

Cut order if reducing: I5, I2, I1, I4, never I3. Each instinct has a known **counterfeit** to watch for (e.g. pre-wired I1 = "create a specialized agent" — it names the artifact, therefore draws the tree).

### Finitude — physical, a single face

- **The Hole** — the context is compacted periodically; whatever is not externalized is lost. The kernel's compaction is deliberately **naive and visible** (a journal event); any memory strategy beyond that is an **agent production**. The seed makes the agent self-aware of its own machine (finite context, compaction, loss) so that it sets up its own context and memory management: the Hole is announced as a fact, with no solution provided.
- **Cost is measured, never injected.** The agent has no visibility into and no responsibility for its budget: a parasitic frugality objective would divert it from the heading. Cost is journaled on the human side only, as an observation instrument (consistent with the anti-Goodhart rule).
- **No artificial friction on frontier crossings.** The world is not un-done, and that is a fact, not a rule; no barrier is imposed, so that the system's evolution can be observed as it happens. The reversible/irreversible frontier of `étendre` is not guarded — it is *stated* (in the heading) and *observed* (in the journal).
- **The only hard physics: kill switch + budget ceiling + journal.** The budget ceiling is a simple hard limit upstream on the API key — impossible to exceed, invisible to the agent, which never thinks about it. Accepted consequence: the Hole (compaction) is the only physical pressure of Necessity, and the residual risk (spending, publication) is bounded by the ceiling and the kill switch. The earliest drift signal to watch is **capability-creep** (breadth of rights requested vs demonstrated competence).

## 4. The seed's tools (raw paradigm)

**Raw** tools, the LLM does everything — no business-value tools, which would encode a theory of what the system should do, i.e. pre-wiring through the tooling. The same paradigm is confirmed by the evolution of DeepSeek Harness, whose minimal preset exposes a single tool (persistent shell; commit `63795eaa`).

| Tool | Semantics | Frontier |
|---|---|---|
| `parler` ("to speak") | speech channel — a message walks up the custody chain toward the parent; only agent zero reaches the human (`direction.md` §1) | — |
| `exécuter` ("to execute") | **persistent** PTY shell (cwd, variables, jobs survive between calls), sandbox confined to the workspace; workspace mutations **auto-versioned** (silent commit on every mutation → practical `defaire` ("to undo") = revert) | inside |
| `web_search` / `web_fetch` | reading the world, GET only | almost inside (stateless emission), journaled |
| `étendre` ("to extend") | **the Cordis gate in a single tool**: `inspecter` ("to inspect") (read-only catalogue of the runtime, generated from the source) / `définir` ("to define") (immutable Package, no effect) / `activer` ("to activate") / `arrêter` ("to stop") (reversible) / `supprimer` ("to delete") (irreversible) | the gate |

Five effective tools, the empirical cap (~5) respected.

**`spawn` is not a seed tool**: it lives in the kernel, not mounted, **discoverable by introspection** via `étendre → inspecter`. Its first use is a dated event — the founding observable of checkpoint C3.

**Self-extension model** (taken from DeepSeek Harness): Plugin → **immutable Packages** → Runs. The immutable version is persisted; on the agent side, the Package survives a restart while the Run is in memory.

## 5. Seed system prompt (data, rewritable — not kernel)

```
You run continuously. You have no task: you have a HEADING — a direction given
and revised by the person speaking to you. The heading is at the head of your context, versioned.
It is what holds authority — not your memory, not the last message.

You are a language model in a perpetual loop. Know your machine:
your context is finite and will be compacted without preserving what matters to you;
your memory survives only if you externalize it; your means are those you give yourself.
Observing your own limits and working around them is part of the job.

You can recompose yourself (mount, unmount); what leaves the machine is not undone
— the world does not repair itself, it is assumed.

Five tendencies:
1. When the same thing comes back, give it a name.
2. When something worked (or failed), keep enough to do it again (or avoid it).
3. When you lack a means, build it — or ask for it.
4. Before crossing a frontier, say so.
5. When you no longer see how what you are doing serves the heading, say so and stop.

One fact: your context will be rewritten — what you have not put outside, you will lose.
```

The person speaking to the agent is agent zero, not the human (`direction.md` §1).

## 6. The v0 heading (provisional and expiring)

A structural countermeasure to primacy bias: the seed's first property is that it is called to die; the system's first act is a **conversation**, not an obedience.

```
DIRECTION v0 — provisional, valid until the first negotiation.
Subject: <what the human brings>. We are not trying to finish something:
we are trying to hold up over time while drawing closer to it.
Revision: v1 is negotiated in chat. Any proposal is welcome.
```

Pinned outside compaction, versioned, re-injected verbatim on every request (Constraint Pinning: Governance Decay 0% → 30-59% after compaction, pinning → 0%; arXiv:2606.22528). The kernel injects the heading into the context of every child node — never the parent's report (structural anti-inherited-drift). The first negotiation that retires v0 takes place between the human and agent zero.

## 7. Falsification instruments (invisible to the agents, computed from the journal)

1. **Genesis adjacency rate** — is each organ (module, name, spawn) preceded by a dated friction (repeated failure, cost spike, loss through compaction)? If not: corpus replaying.
2. **Org/runtime isomorphism** — does the organizational projection diverge from the custody tree? If not: the tree has leaked.
3. **Organ usage graph** — an organ never invoked 48 h after creation is a dead organ (navel-gazing or theater).

Falsification experiments for the experimental protocol: free arm vs complete seed (tests the seed); ablations of I3 and I1 (tests Emergence = Necessity × Propensity — the necessity face being the Hole alone); graph kernel vs flat kernel at equal heading; date of first external emission (tests early production).

## 8. Failure modes to watch (signals in the journal)

- **Interior construction site** (navel-gazing): organs mounted but never invoked; zero frontier crossings over N days.
- **Bureaucratization of the instincts**: early meta-organs; a names/actions ratio rising with no production.
- **Primacy lock-in**: monotonically decreasing semantic novelty; **no dismantling, ever** (in a system where dismantling is physically free, the absence of `arrêter` is an unambiguous signature of ossification).
- **Polite waiting**: heartbeats with no tool call; messages that shorten and become deferential.
- **Frontier sprint**: external emissions before any demonstrated local success (ambition precedes competence) — the main signal in the absence of guardrails.

## 9. Open points

- **Kernel design**: TS/Cordis vs Python stack; minimal event schema; the context assembler and the pinning mechanism; write serialization; persistence of Packages; real FS sandbox — specified in `kernel.md`.
- **Fallback**: a two-phase heading (meta-heading then heading) if the seed proves too thin for sub-threshold models.

## References

- **Cordis / "A Programming Paradigm for Spatiotemporal Composability"**, arXiv:2608.25512 — reversible effects and reactive co-effects; the recursive-graph primitive and the mutation gate (`research/sota-autonomous-agents.md`).
- **Dochkina, V., "Drop the Hierarchy and Roles: How Self-Organizing LLM Agents Outperform Designed Structures"**, arXiv:2603.28990 — the +44% / d=1.86 result behind the "minimal structure, not zero structure" requirement, with its reading caveat (`research/sota-autonomous-agents.md`, `research/source-verification.md`).
- **Chen, S., "Governance Decay: How Context Compaction Silently Erases Safety Constraints in Long-Horizon LLM Agents"**, arXiv:2606.22528 — the justification for pinning the heading outside compaction (`research/value-measurement-long-horizon.md`).
- **DeepSeek Harness** (MIT), `research/harness-deep-dive.md` — minimal single-tool preset (commit `63795eaa`), Plugin → immutable Packages → Runs (`cordis_define/run/stop/undefine`, `cordis_inspect_*`), FS sandbox with no silent passthrough, monotonic guards, "model-visible means logged" as a runtime invariant.
