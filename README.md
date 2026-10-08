# emergent-society

**A research harness for observing the emergence of multi-agent LLM societies — and for measuring whether a human can steer them without breaking what makes them emergent.**

This is a research project, not a product. The goal is to run long-lived, self-organizing societies of LLM agents, watch what emerges, and publish the findings. Everything is designed so that emergence can actually happen: no organizational guardrails, no pre-built memory, no hidden scaffolding, and everything is recorded so that emergence can be studied.

## The thesis

Most multi-agent frameworks hard-code the organization (roles, workflows, budgets). We take the opposite bet: give agents a minimal physics, a seed of instincts, and raw tools — then let the organization emerge. The human is not an operator but a **co-orchestrator**: they negotiate the society's direction with a dedicated node (agent zero), and the realignment propagates through the graph while the system keeps running.

Three properties we refuse to compromise on:

1. **Perpetual**: the society runs continuously, asynchronously, without a blocking "waiting for human" state. Questions and answers are events, never `await`s.
2. **Emergent**: memory, roles, tools and organization are built by the agents themselves, from a seed that deliberately includes a **Hole**: a naive, visible, incomplete starting point they must outgrow.
3. **Directed**: the human's intent enters as a verbatim pinned *heading* (an event in the journal, ratified by the human), and its propagation is measured, not assumed.

## Design principles

- **The journal is the only truth.** Every mediated action of every node is an event in an append-only, hash-chained log — the boundary fact (the top-level tool invocation and its result, the model response, the observed world diff), not an exhaustive trace: raw shell syscalls inside a turn are not individually logged. Everything else — dashboards, metrics, agent memory — is a disposable projection.
- **Metrics are invisible to the agents.** Instrumentation lives outside the graph (anti-Goodhart). Fidelity is measured on acts, never on self-reports.
- **The world is the filesystem.** The kernel imposes no message transport: nodes communicate by writing files, the kernel commits the world at the end of every turn with the node's uid as git author, and a node is woken by the changes it did not author.
- **Minimal raw tools.** Nodes get a handful of raw capabilities (shell, speech, web, self-extension) instead of business-shaped tools; the LLM does everything else.
- **Replay is not re-execution.** The full state of the society is reconstructible from the durable records — the hash-chained journal, the canonical claim-check blobs it references (the original payloads, not a disposable index), and the world's Git history — with no model or tool call replayed.

## Status

Implementation phase, no product yet: the design is settled and the kernel is being implemented checkpoint by checkpoint, in the order given in [`docs/kernel.md`](docs/kernel.md) §10. Three checkpoints are implemented and tested under a strict typecheck. **C1.1 — the journal** (`src/journal/`): hash-chained append-only event log, framed zstd persistence, claim-check blobs, write-behind with an explicit flush barrier, verifying reader and torn-tail repair, and a stable flock-guarded single-writer ownership. **C1.2 — the node driver** (`src/node/`): the turn ritual, the commit-per-turn on the shared world repo with the node's uid as git author, wake-on-change over the world's HEAD, the free loop with explicit wait, the journaled turn and shutdown vocabulary — with no message transport, since the world is the filesystem and nodes communicate by writing files ([`docs/kernel.md`](docs/kernel.md) §5). **C1.3 — the durable context and provider boundary** (`src/context/`, `src/provider/`, and the runtime in `src/node/loop.ts`): an incremental journal fold, a provenance-bearing committed surface with a pinned heading and transactional compaction, a bounded pinned world perception rendered from Git output, one canonical non-streaming wire, the raw provider response journaled before projection, bounded retries, a foreground raw shell tool, and disposable projection snapshots. **C1 as a whole is not reached**: agent zero and the human chat, the confinement of `execute` (Landlock/PTY) and the credential broker, the `extend` Package layer, the SQLite index and the invariant backstop are not implemented, so there is no CLI, main process, cockpit or running product yet — what exists is the library source plus the runtime a future host would drive, not a launchable kernel. Nothing here has run autonomously against a live model or a confined shell, and no safety claim is made for such a run.

## Development

Node 24 is required (`nvm use`, per [.nvmrc](.nvmrc)). The journal's single-writer ownership is a Linux/local-filesystem mechanism: it needs util-linux `/usr/bin/flock` and `/proc` (for pid start times), so it is not supported on NFS or shared multi-host storage, and the on-disk ownership protocol is only guaranteed within one version — upgrading across the old and new lock protocols is a cold upgrade, taken while no node is writing. Replay binds the world's Git history to the exact `git --version` recorded in each perception, so a host with a different Git version fails replay explicitly rather than promising byte equality. Install reproducibly with `npm ci` (the existing dependencies are few and pinned), run the tests with `npm test`, and the strict typecheck with `npm run typecheck`. There is no build step.

## Documents

| Document | Content |
|---|---|
| [Vision](docs/vision.md) | The living document: what the project is, the three invariants, the two memories |
| [Architecture](docs/architecture.md) | How the system works, from the top: the map between the concepts and the implemented code |
| [Seed](docs/seed.md) | How to avoid a cold start that kills emergence: the 5 instincts, the Hole, raw tools |
| [Direction](docs/direction.md) | Human ↔ agent zero ↔ nodes: co-negotiated direction, pinned heading, versioned letter |
| [Kernel](docs/kernel.md) | The full technical spec: event-native async runtime, journal format, sandboxing, driver |
| [Research corpus](docs/research/) | State of the art, metrics, devil's advocate, harness internals deep-dive, monitoring architecture |
| [Roadmap](ROADMAP.md) | Where we stand and what's next |

## Acknowledgments

This project reimplements its inspirations from scratch and owes them its foundations:

- **[Cordis](https://github.com/cordiverse/cordis)** (by Shigma, from the Koishi ecosystem) — the reversible-effects runtime behind our mutation gate and the self-similar node primitive (the Γ recursion), formalized in *[A Programming Paradigm for Spatiotemporal Composability](https://arxiv.org/abs/2608.25512)* (PKU + DeepSeek).
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (MIT, DeepSeek) — the journal-as-only-truth pattern and its "model-visible means logged" invariant, the Plugin → immutable Packages → Runs self-extension model, the compaction protocol, the persistent shell behind a Landlock sandbox, and the escalating kill switch. Our internals are analyzed in [`docs/research/harness-deep-dive.md`](docs/research/harness-deep-dive.md).
- **[Graphify](https://github.com/Graphify-Labs/graphify)** (Graphify Labs) — the architectural inspiration for our monitoring pipeline: graph schema, EXTRACTED/INFERRED edge honesty, incremental content-hash cache. A validation spike motivated our custom three-layer pipeline; the numbers and the credit are in [`docs/research/monitoring-architecture.md`](docs/research/monitoring-architecture.md).
- **[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)** (Apache 2.0) — the credential-broker pattern behind ours: gateway-held named providers, endpoint-bound placeholders substituted on the wire, leak-free refusals on endpoint mismatch. See [`docs/kernel.md`](docs/kernel.md) §7.

## License

MIT — see [LICENSE](LICENSE).
