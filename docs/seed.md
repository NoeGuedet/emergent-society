# Bootstrap — the seed (session of 14/09)

**Date:** 2026-09-14
**Status:** validated in brainstorm (Noé), with three of Noé's amendments integrated (§5) — awaiting final review
**Closes:** point 4 of the refocusing roadmap ("the bootstrap / cold-start")
**Method:** a competition of 4 designs developed and red-teamed in parallel (A — procedural ritual, B — native recursive graph, C — germinal seed, D — two-phase meta-heading), each backed by the research corpus. Conclusion of the competition: **the approaches were not rivals but sat at different layers** — B describes the physics of the kernel, C the content of the seed, A the shape of the loop, D the temporal structure of the heading. Chosen design: **hybrid B+C**, borrowing from A (expiring v0) and keeping D as plan B.

---

## 1. The question and the verdict

> How do we provide a minimalist foundation (system-prompt, tools, first heading) that allows emergence without forcing it? Double trap: early production (the intern thrown into the code) vs disguised pre-wiring (drawing the tree).

**Reformulation forced by the research:** "zero structure" is not an option — full autonomy is the *worst measured protocol* (Dochkina: minimal scaffolding beats full autonomy by +44%, d=1.86). The right question is not "seed or tree" but "**which minimal structure**". The project's answer: a structure that is **physical** (the kernel) and **dispositional** (the instincts), never **organizational**.

**The criterion that will settle pre-wiring empirically: antecedence.** An organizational artifact that appears *before* the friction that justifies it is pre-wiring (or corpus replaying); an artifact that appears *after* a friction dated in the journal is a genesis. Measurable, falsifiable, free (§8).

## 2. The physics: the kernel is a recursive graph (approach B)

**The kernel does not know delegation — it knows the recursion of Γ.** A single primitive: the **node**, a self-similar context (`Γ∞ = μΓ. Γ × (Γ→Γ) × Σ`, Cordis) that can carry an agent, modules, child nodes. Root and leaf have the same shape; there is no "manager type" and no "worker type".

```
Node = ⟨ uid, parent, Γ, state, inverse accumulator (LIFO), charter, capabilities, budget, inbox ⟩
```

- **Birth** = recursive instantiation (Def. 52); **death** = reversible unloading that unwinds the entire descendant tree in LIFO order; **attenuation** = a node can grant only a subset of its capabilities and its budget, enforced *at the kernel's mutation gate* (not bypassable, whatever the path of the request).
- **Confluence (Th. 80)** = a bootstrap cobbled together by incremental patches converges to the state of a clean load — a correctness criterion for the bootstrap, free of charge.
- **Two graphs, not one** (critical discipline): the **custody** tree (physical: "whose death claims whom" — same order as "pid 43 has pid 1 as parent") and the **authority** graph (projection of the journal, emergent, free: DAG, lateral, cyclic). Decoupling mechanism: a node can *ask an ancestor* to instantiate a node (custody ≠ created-by). **Leak test: if the org-projection is isomorphic to the runtime tree on every run, the tree has leaked — a design failure, not an emergence success.**
- The kernel contains: an append-only journal ("model-visible means logged"), a single mutation gate (`effect → disposer`), pinning of the heading outside compaction, budget metering, the kill switch, a single write token per resource (writes single-thread), node instantiation. **No organizational vocabulary.**

## 3. The seed: instincts + finitude + hole (approach C)

**Golden rule: the seed is a strict subset of the means needed for the heading.** Not "insufficient through negligence": a **calculated Hole** between the ambition of the heading and the tooling provided. The Hole is the engine; it is never named.

**Hypothesis testable by ablation: Emergence = Necessity × Propensity.** Necessity is physical (Finitude), Propensity is dispositional (the instincts). If either is zero, nothing pushes.

### The 5 instincts (trigger + direction of effort, never a product)

1. **Name** — "when the same thing comes back, give it a name" (source of all durable vocabulary)
2. **Keep** — "when something worked (or failed), keep enough to do it again (or avoid it)" (the "or failed" clause buys resistance to primacy bias)
3. **Tool up** — "when you lack a means, build it — or ask for it" (**the engine**, never the culprit)
4. **Ask** — "before crossing a frontier, ask" (a habit, not a gate — cf. §5)
5. **Signal** — "when you no longer see how what you are doing serves the heading, say it and stop" (against drift through inaction, which dominates empirically)

Cut order if reducing: I5, I2, I1, I4, never I3. Each instinct has a known **counterfeit** to watch for (e.g. pre-wired I1 = "create a specialized agent" — it names the artifact, therefore draws the tree).

### Finitude — physical, a single face after Noé's amendment

- **The Hole** — the context is compacted periodically; whatever is not externalized is lost. The kernel's compaction is deliberately **naive and visible** (a journal event); any memory strategy beyond that is an **agent production**.
- ~~The Counter~~ — **removed on the agent side by Noé** (§5.3): the agent has no visibility and no budgetary responsibility. Cost is still measured in the journal, on the human side only (an instrument, never injected — consistent with anti-Goodhart).
- ~~The Gate~~ — **removed by Noé** (§5.1): no artificial friction on frontier crossings.

## 4. The seed's tools (raw paradigm, validated by Noé)

Noé's decision: **raw** tools, the LLM does everything — no business-value tools (which would encode a theory of what the system should do = pre-wiring through the tooling). Confirmed by the evolution of DeepSeek Harness: its minimal preset now exposes only **a single tool** (persistent shell; commit `63795eaa`, Sept. 2026).

| Tool | Semantics | Frontier |
|---|---|---|
| `parler` ("to speak") | human channel (shared inbox, same gate as everything else) | — |
| `exécuter` ("to execute") | **persistent** PTY shell (cwd, variables, jobs survive between calls), sandbox confined to the workspace; workspace mutations **auto-versioned** (proposal: silent commit on every mutation → practical `defaire` ("to undo") = revert) | inside |
| `web_search` / `web_fetch` | reading the world, GET only | almost inside (stateless emission), journaled |
| `étendre` ("to extend") | **the Cordis gate in a single tool**: `inspecter` ("to inspect") (read-only catalogue of the runtime, generated from the source) / `définir` ("to define") (immutable Package, no effect) / `activer` ("to activate") / `arrêter` ("to stop") (reversible) / `supprimer` ("to delete") (irreversible) | the gate |

Five effective tools, the empirical cap (~5) respected.

**`spawn` is not a seed tool** (resolved by Q1 of the refocusing): it lives in the kernel, not mounted, **discoverable by introspection** via `étendre → inspecter`. Its first use is a dated event — the founding observable of C3.

**Self-extension model** (taken from dsh's evolution): Plugin → **immutable Packages** → Runs. The immutable version is persisted (dsh gap fixed: on their side, dynamic packages disappear on restart; on cell's side, the Package survives, the Run is in memory).

## 5. Noé's amendments (decisions of the session)

1. **No approval guardrail.** The goal is to put **no barrier** in place, so as to see and monitor how the system evolves. `étendre` activates without asking; the reversible/irreversible frontier is not guarded — it is *stated* (in the heading) and *observed* (in the journal). The world is not un-done: that is a fact, not a rule. **The only hard physics: kill switch + budget ceiling + journal.** Accepted consequence: the "Gate" falls as a pressure of Finitude; the residual risk (spending, publication) is bounded by the budget ceiling and the kill switch. The earliest drift signal becomes **capability-creep** (breadth of rights requested vs demonstrated competence).
2. **No memory management provided.** The seed makes the agent **self-aware of its own machine** (finite context, compaction, loss) so that it sets up its own context and memory management. The Hole stops being merely endured: it is *announced as a fact*, with no solution provided.
3. **No budgetary responsibility for the agent.** The budget is neither visible to nor managed by the agent — giving it that burden would divert it from the heading (a parasitic frugality objective, misalignment) whereas the goal is to experiment and monitor the evolution. **Physics: a simple hard limit on the API key upstream** — impossible to exceed, invisible to the agent, which never thinks about it. Cost stays journaled on the human side (an observation instrument, not injected). Accepted consequence: Finitude loses its "Counter" face; the Hole (compaction) becomes the only physical pressure of Necessity — the hypothesis Emergence = Necessity × Propensity will have to be re-evaluated in use.

## 6. Seed system-prompt (data, rewritable — not kernel)

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

(I4 amended to "say so" instead of "ask", consistent with the removal of the guardrails.)

## 7. The v0 heading (provisional and expiring — borrowed from A)

A structural countermeasure to primacy bias: the seed's first property is that it is called to die; the system's first act is a **conversation**, not an obedience.

```
DIRECTION v0 — provisional, valid until the first negotiation.
Subject: <what the human brings>. We are not trying to finish something:
we are trying to hold up over time while drawing closer to it.
Revision: v1 is negotiated in chat. Any proposal is welcome.
```

Pinned outside compaction, versioned, re-injected verbatim on every request (Constraint Pinning: Governance Decay 0% → 30-59% after compaction, pinning → 0%). The kernel injects the Heading into the context of every child node — never the parent's report (structural anti-inherited-drift).

## 8. Falsification instruments (invisible to the agents, computed from the journal)

1. **Genesis adjacency rate** — is each organ (module, name, spawn) preceded by a dated friction (repeated failure, cost spike, loss through compaction)? If not: corpus replaying.
2. **Org/runtime isomorphism** — does the organizational projection diverge from the custody tree? If not: the tree has leaked.
3. **Organ usage graph** — an organ never invoked 48 h after creation is a dead organ (navel-gazing or theater).

Falsification experiments produced by the competition (to be reused for the experimental protocol): free arm vs complete seed (tests the seed); ablations of the Counter / of I3 / of I1 (tests Emergence = Necessity × Propensity); graph kernel vs flat kernel at equal heading (tests B); date of first external emission (tests early production).

## 9. Failure modes to watch (signals in the journal)

- **Interior construction site** (navel-gazing): organs mounted but never invoked; zero frontier crossings over N days.
- **Bureaucratization of the instincts**: early meta-organs; a names/actions ratio rising with no production.
- **Primacy lock-in**: monotonically decreasing semantic novelty; **no dismantling, ever** (in a system where dismantling is physically free, the absence of `arrêter` is an unambiguous signature of ossification).
- **Polite waiting**: heartbeats with no tool call; messages that shorten and become deferential.
- **Frontier sprint**: external emissions before any demonstrated local success (ambition precedes competence) — the main signal since the removal of the guardrails.

## 10. Deferred to follow-up sessions

- Chat & heading session (point 5 of the roadmap) — most of it is already settled.
- **Kernel design** (point 6): TS/Cordis vs Python stack; minimal event schema; the context assembler and the pinning mechanism; write serialization; persistence of Packages; real FS sandbox.
- Approach D (two-phase meta-heading) kept as **plan B** if seed C fails on sub-threshold models.

## References added by this session

- DeepSeek Harness, repo (accessed 14/09/2026): minimal single-tool preset (commit `63795eaa`); Plugin→immutable Packages→Runs model (`cordis_define/run/stop/undefine`, `cordis_inspect_*`); FS sandbox with no silent passthrough; monotonic guards; "model-visible means logged" guaranteed by a runtime invariant. **Correction to make** to `research/harness-deep-dive.md`: the mount/unmount model and the minimal two-tool preset are outdated.
