# Monitoring architecture — the observation surface and the analysis pipeline

**Research date:** 23 September 2026
**Subject:** how the society is observed without being perturbed: where the instrument physically lives, what the two raw truths are, and how the readings (the 3 sensors and the metronome of `vision.md` §6) are derived from them.
**Method:** architectural design note, grounded in (a) the kernel's own primitives — the event journal, the world's git history, the commit-per-turn — and (b) a validation spike run against a simulated agent-society filesystem to measure what an off-the-shelf semantic graph tool does and does not recover from such a corpus. The spike's numbers are reported in §5; the tool itself is credited there.

---

## 1. The sandwich: observation physically outside the world

The instrument is arranged in three layers, and the society sits in the middle of them.

- **Above — the wire.** Every model request and response, every tool effect, every lifecycle transition is journaled by the kernel at boundaries an agent cannot avoid crossing (`kernel.md` §3). This is the truth about *deliberation*: what a node thought, what it was given, what it paid.
- **Below — the filesystem.** The world is a git repository, and the kernel commits it at the end of every node turn with the node's uid as the git author (`kernel.md` §5.2). This is the truth about *acts*: what changed, who changed it, when.
- **Between — the society.** Nodes perceive each other through the world's files and its git history; they have no address at which the journal, the analysis or the metrics can be reached. Nothing in their universe reports that they are being measured.

**The anti-Goodhart property, in its strongest form.** The usual rule is that metrics are invisible to the agents (`vision.md` §3). The sandwich makes the property physical rather than editorial: the instrument is not hidden from the observed world, it is *outside* it. There is no sensor to read, no counter to inflate, no report to make flattering, because no part of the apparatus exists inside the world the agents inhabit. Fidelity is therefore measured on acts — what the world and the wire record — and never on declarations. An agent that wants to influence the measurement has nothing to address.

**The precise boundary, stated honestly.** The world's own git history *is* inside the world: an agent can run `git log` and read who wrote what, and that is deliberate — authorship is how the society perceives itself, and the masks of `kernel.md` §7 protect the trace from erasure, not from reading. What is outside is everything above the filesystem (the journal) and everything derived from either record (the graph, the sensors, the readings). The observed may see each other's acts; they cannot see the instrument that reads them.

## 2. Two raw truths, one disposable projection

- **Raw truth 1 — the kernel event journal.** Append-only, hash-chained, per node (`kernel.md` §3). The wire side of every turn, including the commit hash that closed it.
- **Raw truth 2 — the world's git history.** Every write, with its author and its position in time (`kernel.md` §5.2, §7).
- **The cross-reference.** The two records are joined by the commit hash recorded in the `turn/end` journal event: for any journal `seq` the exact world state is known, and for any commit the turn that produced it is known. Neither record alone suffices — one holds the reasoning without the files, the other the files without the reasoning.
- **Everything else is a projection.** The semantic graph, its communities, its inferred roles, the metric series: all of it is *recomputable* from the two raw truths, disposable, and never a source of truth. A projection may be deleted and rebuilt at will; the two records may not. This is what lets the analysis be revised as the research progresses without rewriting the facts (`kernel.md` §3, rule 1).
- **Provenance is mandatory.** Every node and every edge in the projection carries a path back to the raw truth: a source file and line for the file layer, a commit and an author for the git layer, a `seq` for the journal layer. A reading that cannot be walked back to the raw records is not a reading.

## 3. The analysis layers

### 3.1 Layer A — the code graph (tree-sitter)

A deterministic AST pass over the code the society writes: `contains` for structure, `calls` and `imports` between symbols, `method` for class members, `indirect_call` for indirections that a hand-written graph would miss, and `rationale_for` carrying docstrings as the stated rationale of a symbol.

Free, offline, byte-reproducible, and it answers the anatomy questions: what calls what, which organ is never invoked, where complexity concentrates. It is the substrate of the structure sensor.

### 3.2 Layer B — the social and prose parser

The kernel imposes no communication structure (`kernel.md` §5.1), so the social graph exists **only in the files**, in whatever conventions the agents invented. This layer recovers it deterministically:

- **`@mention`** → `addressed` edges: who names whom, in which file, at which line.
- **`from:` / `to:` / `reply-to:` headers** → `authored`, `addressed_to` and `replied_to` edges, and therefore reply chains: who answered whom, and who did not answer.
- **Plain-text path citations** (bare paths and backticked paths) resolved against the world's file set → `cites` edges: which document refers to which artifact, including the proposal→implementation links that decide whether a convention was adopted or merely discussed.
- **Convention discovery.** Because no schema is imposed, the parser must recognize the society's own conventions from the files — a block format for messages, a bulletin board, a mailbox directory. The marker set is grown from observed files, never fixed in advance by the kernel.

### 3.3 Layer C — the git layer

The git history is a first-class analysis input, not a timestamp source:

- **Authorship** — per commit, and per line where needed: which node produced a file, a paragraph, a line.
- **Time** — commit order and timestamps give turns, durations and the ordering of a dialogue.
- **Tombstones** — a deletion is an event (the file vanished in commit X, authored by Y), never a silent absence. A projection that only knows the current tree cannot distinguish "never existed" from "removed".
- **Negation via diff** — the absence of an expected act is computable: a convention present in one snapshot and absent from a node's files, a question with no reply, a proposal with no implementation. A graph has no node for a non-edge; a diff against the previous snapshot does, and for a monitoring instrument negative evidence ("no handoff happened") is often the most interesting signal there is.

### 3.4 Optional layer — a local model for fuzzy prose semantics

The residue that no deterministic pass reaches: argument stance, agreement and disagreement, topic drift, the shape of a disagreement that survives only as prose. This pass runs against a **local model** (for example Ollama) so the pipeline stays offline and key-free, and it is strictly optional: with the semantic pass switched off, the graph loses the fuzzy edges and keeps everything else.

Its output is separable by construction, not by convention: every edge it produces is tagged `INFERRED` (§4), so a reader can re-run the pipeline without it and compare.

## 4. The honesty model: EXTRACTED / INFERRED on every edge

Every edge carries its tag, its provenance and the extractor that produced it.

- **EXTRACTED** — the relation is explicit in the source: a path citation, a header field, an import, a call, a deletion in a diff.
- **INFERRED** — a reasonable inference, never presented as a fact: a topical link, an implied dependency, a stance read from prose.

Two disciplines follow. First, the definitions are written into the extractor itself, so each tag must be justified at the moment the edge is produced rather than reconciled afterwards. Second, an ambiguous resolution is reported as ambiguous rather than resolved silently — a bare path that matches several files yields a flag, not a guessed edge.

**A warning about the headline.** The share of EXTRACTED edges is not a measure of how much is known. A graph can be 95% EXTRACTED and still know almost nothing social, because `contains` hierarchy is technically explicit and semantically empty. The tag is about honesty, not about coverage; coverage has to be measured on the relations that matter (§5).

## 5. Prior art, credit, and what the validation spike measured

**Graphify** (<https://github.com/Graphify-Labs/graphify>, by Graphify Labs) is the architectural inspiration for this pipeline, and three of its ideas are adopted directly: the **graph schema** (nodes and edges with stable ids and per-element provenance down to a line number), the **EXTRACTED / INFERRED honesty model**, and the **incremental content-hash cache** with a true no-op fast path and deterministic, byte-identical output.

Graphify treats the filesystem as a *codebase* and projects it as a structure graph. The monitoring pipeline treats the filesystem as a *society* and projects it as a social graph with provenance. Those projections disagree on nearly every edge that matters, which is why the architecture is borrowed and the pipeline is built here rather than adopted.

**What the validation spike measured.** A spike ran Graphify (v0.9.66, fully offline, no LLM backend) against a simulated agent-society filesystem — 27 tracked files, three tagged snapshots, with an agent-written message convention, a proposal, a holdout, a disagreement and an abandoned experiment embedded in it. Its deterministic pass over *code* is strong: a tool file was mapped completely, including `indirect_call` edges derived from `set_defaults(func=…)` patterns and `rationale_for` edges carrying docstrings, and prose→code `references` edges correctly merged a README into its tool's community. The keyless graph of the *society*, however, recovered almost none of what a monitor needs:

| Measured on the final snapshot (27 files) | Value |
|---|---|
| Real `@node` mentions in the corpus recovered as edges | **0 of 17** |
| Genuine plain-text path citations recovered as edges | **0 of 141** (26 distinct targets, cited by 24 of 26 files) |
| Corpus text retained as node labels | **7.3%** (2,967 of 40,859 characters) |
| Nodes with degree ≤ 1 | **124 of 170 (73%)** |
| Communities | **27 for 27 files** — one per file, mirroring the directory tree |
| Authorship, timestamp, first-seen commit on any node or edge | **none** |
| Representation of absence (tombstone, non-edge) | **none** |
| Role vocabulary (the words naming who does what) | **absent** — it lived in a markdown table body, which is not extracted |
| EXTRACTED share | 100% / 100% / **95%** across snapshots — but at the last snapshot 109 of 174 edges were `contains` hierarchy, so the headline measures structure, not knowledge |

The corpus's own convention is the sharpest illustration: a proposal file specified a message format, and an agent then wrote `tools/msg.py` implementing it — yet the proposal cited that file by bare path, so the graph contained no edge from the proposal to its implementation, and the protocol-migration story (who adopted the convention, who held out, when) was invisible in it. Recovering exactly that is what §3.2 and §3.3 exist for.

**What the spike proved about the plumbing.** The offline engineering is sound and worth not rewriting: 0.25 s for the 27-file corpus (0.232 / 0.259 / 0.255 s for the three snapshots), deterministic byte-identical `graph.json` across repeated runs on the same tree, a true no-op on an unchanged tree, a content-hash cache that survives `git checkout` (the correct behaviour when the world is rewritten by commits), correct pruning of deleted files, and a clean, stable, diffable `graph.json` — ids of the form `{path}_{symbol}`, per-node and per-edge `source_file` + `source_location`, trivially consumable. The approach is viable; the lens was wrong.

**Honest caveat.** The spike ran with no LLM backend, so the comparison is between Graphify keyless and what a society monitor needs — not between Graphify at full power and what a society monitor needs. The expectation, stated as an expectation and not as a finding, is that a semantic pass would add generic prose→prose relations and link the proposal to its implementation, while still producing no authorship, no mention edges, no negation and no temporal ordering. The custom layers would remain necessary.

## 6. Relation to the instrument (3 sensors + 1 metronome)

- **Sensor 2 (structure graph)** reads the projection directly: role stability, hierarchical coherence, turnover, the March cascade.
- **Sensor 1 (semantic trajectory)** consumes the prose the projection attributes and orders: embeddings over attributed text, with authorship and time as filters, so a phase can be read per node and per period rather than over an anonymous corpus.
- **Sensor 3 (value registry)** reads promises→acts→effects as citations and diffs: a promise is a file, its acts are commits, its effects are the tombstone or the adoption visible in the next snapshot.
- **The metronome (versioned direction)** labels the same pipeline over time: the projection is recomputed at each heading version, and the drift-versus-adaptation comparison is a comparison of two projections of the same two raw truths.

The pipeline is read-side throughout: it never writes into the world, never wakes a node, and never enters a context. Its cost is bounded by the corpus, not by the society's activity, and every reading it produces can be recomputed a posteriori.

## 7. Open points

- **Convention discovery.** With no imposed schema, finding the society's conventions is a discovery problem rather than a parsing one: the marker set starts small (`@name`, `from:`/`to:`/`reply-to:`, paths, tombstones) and grows from observed files, which means the pipeline's coverage is itself a measurement of the society's vocabulary.
- **Path resolution.** A bare path may match several files; unresolved and ambiguous citations are reported as such, never guessed. The rate of unresolved citations is a reading in its own right (the society's own naming discipline).
- **The optional semantic layer.** Which local model, and whether the fuzzy pass runs over the whole corpus or only over the residue the deterministic layers flag as semantic.
- **Where the pipeline runs.** Outside the world — a separate process reading the journal and a clone of the world repo — never as a Package mounted inside a node. An instrument reachable from the observed is not an instrument (§1).
- **Projection versioning.** The projection is disposable, but a *reading* may not be: metric series quoted in a paper must record the pipeline version and the two raw-truth watermarks they were computed from, or they become unreproducible claims.

## Sources

- **Graphify**, by Graphify Labs — <https://github.com/Graphify-Labs/graphify>. Architectural source of the graph schema, the EXTRACTED/INFERRED honesty model and the content-hash incremental cache; measured in the validation spike reported in §5 (v0.9.66, offline, no LLM backend, 27-file simulated agent-society corpus across three snapshots).
- **tree-sitter** — incremental parsing, the deterministic code layer.
- **Ollama** — local model runtime for the optional semantic pass (offline, key-free).
- **Internal**: `kernel.md` §3 (journal), §5 (world, wake-on-change, empty turns), §7 (git safeguards); `vision.md` §6 (the 3 sensors + the metronome); `ROADMAP.md` (the monitoring session).
