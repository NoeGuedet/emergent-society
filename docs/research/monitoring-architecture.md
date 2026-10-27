# Monitoring architecture — the observation surface and the analysis pipeline

**Subject.** How the society is observed without being perturbed: where the instrument physically lives, what the two raw truths are, and how the readings (the three sensors and the metronome of `../vision.md`) are derived from them.
**Status.** The kernel facts below are implemented (see `../kernel.md`). The pipeline — layers, honesty model, sensors — is **specified, not implemented**: no monitoring code exists and no metric has been computed from the frontier journal or the world.

## 1. The sandwich: observation physically outside the world

The instrument is arranged in three layers, and the society sits in the middle.

- **Above — the wire.** The **frontier journal** (`<home>/frontier/journal.v0.jsonl.zstd`; append-only, hash-chained, one chain per cell home) records every kernel-mediated HTTP exchange — model requests and responses, and the mediated web-tool calls — at the HTTP boundary an agent cannot avoid crossing. The request is durable before the send; the terminal record is durable before the caller proceeds; an open call gets an `http/incomplete` marker at boot. Lifecycle turns (`turn/start`, `turn/end`) live in the node's local log (`log.v0.*`), a cold-start artifact no observer reads — the instrument does not take its timeline from them.
- **Below — the filesystem.** The world is a git repository whose git dir lives outside the worktree (`<home>/world.git`, kernel-owned; the shell has no path to the world's history). The kernel commits the world at the end of every node turn with the node's uid as the git author. This is the truth about *acts* at **commit granularity**: the author names the node whose turn closed the commit, not every file inside it — one shared working tree means a turn-end commit can carry a peer's in-flight writes. It says who moved the world when, not who wrote each line.
- **Between — the society.** Nodes perceive each other through the world's files; perception is served kernel-side. Nothing in their universe reports that they are being measured.

**Confinement is implemented.** The persistent `execute` shell is filesystem-confined by default (Landlock, through a vendored launcher, fail-closed): the frontier journal, the node's local log, the credential store and host files outside the explicit system read set are unreadable from the shell. The boundary is scoped to filesystem content — egress remains open by explicit decision, and pathname UNIX sockets, metadata mutations and `/proc` stat surfaces remain unmediated. The anti-Goodhart property is therefore physical with respect to filesystem content: there is no sensor to read, no counter to inflate, no report to make flattering, because no part of the apparatus is reachable inside the world the agents inhabit. Fidelity is measured on acts — what the world and the wire record — never on declarations.

## 2. Two raw truths, one disposable projection

- **Raw truth 1 — the frontier journal.** Every kernel-mediated HTTP exchange, durable before the effect, in one total order per cell home.
- **Raw truth 2 — the world's git history.** One commit per closed turn, with the git author naming the node whose turn closed it (commit-granular, not per-file).
- **The cross-reference, both halves.** Every frontier `http/request` carries `world_head` — the world HEAD the kernel observed when it journaled the request, kernel-stamped and best-effort (`null` when unreadable) — joining a call to the world's timeline, never to a node. `turn/end` in the node's local log records the commit hash its turn produced: a cold-start fact, invisible to observers. An arbitrary local-log `seq` is **not** an exact world snapshot — a shell write mid-turn, or a commit made outside any turn, has no per-`seq` mapping. Neither surface alone suffices: one holds the exchanges without the files, the other the files without the exchanges.
- **Everything else is a projection.** The semantic graph, its communities, its inferred roles, the metric series: recomputable from the two raw truths, disposable, never a source of truth. A projection may be deleted and rebuilt at will; the two records may not.
- **Provenance is mandatory.** Every node and edge in the projection carries a path back to the raw truth: a source file and line for the file layer, a commit and author for the git layer, a frontier `seq` or call id for the wire layer. A reading that cannot be walked back to the raw records is not a reading.

## 3. The analysis layers (design)

**Layer A — the code graph.** A deterministic AST pass over the code the society writes, built on [tree-sitter](https://github.com/tree-sitter/tree-sitter) (an incremental parser generator and parsing library): `contains` for structure, `calls` and `imports` between symbols, `method` for class members, `indirect_call` for indirections a hand-written graph would miss, `rationale_for` carrying docstrings as the stated rationale of a symbol. Free, offline, byte-reproducible; it answers the anatomy questions — what calls what, which organ is never invoked, where complexity concentrates. It is the substrate of the structure sensor.

**Layer B — the social and prose parser.** The kernel imposes no communication structure, so the social graph exists only in the files, in whatever conventions the agents invented. The parser recovers it deterministically: `@mention` → `addressed` edges; `from:` / `to:` / `reply-to:` headers → `authored`, `addressed_to` and `replied_to` edges, and therefore reply chains; plain-text path citations resolved against the world's file set → `cites` edges, including the proposal→implementation links that decide whether a convention was adopted or merely discussed. The marker set is grown from observed files, never fixed in advance — convention discovery is a discovery problem, not a parsing one.

**Layer C — the git layer.** Authorship is per commit only: per-file and per-line attribution is not recoverable from either record (one shared tree, commit-granular author; no syscall-level trace in the frontier). Commit order and timestamps order acts within the world repo. **Tombstones**: a deletion is an event — the file vanished in commit X, closed by its turn's author — never a silent absence; a projection that only knows the current tree cannot distinguish "never existed" from "removed". **Negation via diff**: the absence of an expected act is computable — a question with no reply, a proposal with no implementation; a graph has no node for a non-edge, and for a monitoring instrument negative evidence is often the most interesting signal there is. Per-file truth (per-node worktrees, merge conflicts as an observable social phenomenon) is a research direction, not a capability.

**Optional layer — a local model for fuzzy prose semantics.** The residue no deterministic pass reaches — argument stance, agreement and disagreement, topic drift — runs against a local model runtime such as [Ollama](https://ollama.com/) (download, run and manage LLMs locally), so the pipeline stays offline and key-free. Its output is separable by construction: every edge it produces is tagged `INFERRED`.

## 4. The honesty model: EXTRACTED / INFERRED on every edge

Every edge carries its tag, its provenance and the extractor that produced it. **EXTRACTED** — the relation is explicit in the source: a path citation, a header field, an import, a call, a deletion in a diff. **INFERRED** — a reasonable inference, never presented as a fact: a topical link, an implied dependency, a stance read from prose. Two disciplines follow: the definitions are written into the extractor itself, so each tag is justified at the moment the edge is produced; and an ambiguous resolution is reported as ambiguous rather than silently resolved — a bare path that matches several files yields a flag, not a guessed edge. The share of EXTRACTED edges is not a measure of how much is known: `contains` hierarchy is explicit and semantically empty. The tag is about honesty, not coverage; coverage is measured on the relations that matter.

## 5. Prior art

[Graphify](https://github.com/Graphify-Labs/graphify) (Graphify Labs) is the architectural inspiration for this pipeline. Three of its ideas are adopted directly: the **graph schema** (nodes and edges with stable ids and per-element provenance down to a line number), the **EXTRACTED/INFERRED honesty model**, and the **incremental content-hash cache** (a true no-op fast path on an unchanged tree, deterministic, byte-identical output). Graphify treats the filesystem as a *codebase* and projects it as a structure graph; this pipeline treats the filesystem as a *society* and projects it as a social graph with provenance. The projections disagree on nearly every edge that matters, which is why the architecture is borrowed and the pipeline is built here rather than adopted.

## 6. Relation to the instrument (3 sensors + 1 metronome)

- **Sensor 2 (structure graph)** reads the projection directly: role stability, hierarchical coherence, turnover, the March cascade.
- **Sensor 1 (semantic trajectory)** consumes the prose the projection attributes and orders: embeddings over attributed text, with authorship and time as filters, so a phase is read per node and per period rather than over an anonymous corpus.
- **Sensor 3 (value registry)** reads promises→acts→effects as citations and diffs: a promise is a file, its acts are commits, its effects are the tombstone or the adoption visible in the next snapshot.
- **The metronome (versioned direction)** labels the same pipeline over time: the projection is recomputed at each heading version, and drift-versus-adaptation is a comparison of two projections of the same two raw truths.

The pipeline is read-side throughout: it never writes into the world, never wakes a node, never enters a context. It runs outside the world — a separate process reading the frontier journal and a clone of the world repo — never as a Package mounted inside a node; an instrument reachable from the observed is not an instrument. A reading quoted in a paper must record the pipeline version and the two raw-truth watermarks it was computed from, or it becomes an unreproducible claim.

## 7. Open points

- **Convention discovery.** With no imposed schema, the marker set starts small (`@name`, headers, paths, tombstones) and grows from observed files, so the pipeline's coverage is itself a measurement of the society's vocabulary.
- **Path resolution.** A bare path may match several files; unresolved and ambiguous citations are reported as such, never guessed — the unresolved rate is a reading in its own right (the society's naming discipline).
- **The optional semantic layer.** Which local model, and whether the fuzzy pass runs over the whole corpus or only over the residue the deterministic layers flag as semantic.

## Sources

- [Graphify](https://github.com/Graphify-Labs/graphify) — architectural inspiration (graph schema, honesty model, incremental cache).
- [tree-sitter](https://github.com/tree-sitter/tree-sitter) — the deterministic code layer.
- [Ollama](https://ollama.com/) — local model runtime for the optional semantic pass.
- `../kernel.md` — the two records (frontier journal, local log), the world and wake-on-change, sandbox.
- `../vision.md` — the three sensors and the metronome.
