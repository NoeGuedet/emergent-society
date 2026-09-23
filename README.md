# emergent-society

**A research harness for observing the emergence of multi-agent LLM societies — and for measuring whether a human can steer them without breaking what makes them emergent.**

This is a research project, not a product. The goal is to run long-lived, self-organizing societies of LLM agents, watch what emerges, and publish the findings. Everything is designed so that emergence can actually happen: no guardrails, no pre-built memory, no hidden scaffolding, and everything is recorded so that emergence can be studied.

## The thesis

Most multi-agent frameworks hard-code the organization (roles, workflows, budgets). We take the opposite bet: give agents a minimal physics, a seed of instincts, and raw tools — then let the organization emerge. The human is not an operator but a **co-orchestrator**: they negotiate the society's direction with a dedicated node (agent zero), and the realignment propagates through the graph while the system keeps running.

Three properties we refuse to compromise on:

1. **Perpetual**: the society runs continuously, asynchronously, without a blocking "waiting for human" state. Questions and answers are events, never `await`s.
2. **Emergent**: memory, roles, tools and organization are built by the agents themselves, from a seed that deliberately includes a **Hole**: a naive, visible, incomplete starting point they must outgrow.
3. **Directed**: the human's intent enters as a verbatim pinned *heading* (an event in the journal, ratified by the human), and its propagation is measured, not assumed.

## Design principles

- **The journal is the only truth.** Every action of every node is an event in an append-only, hash-chained log. Everything else — dashboards, metrics, agent memory — is a disposable projection.
- **Metrics are invisible to the agents.** Instrumentation lives outside the graph (anti-Goodhart). Fidelity is measured on acts, never on self-reports.
- **The world is the filesystem.** The kernel imposes no message transport: nodes communicate by writing files, the kernel commits the world at the end of every turn with the node's uid as git author, and a node is woken by the changes it did not author.
- **Minimal raw tools.** Nodes get a handful of raw capabilities (shell, speech, web, self-extension) instead of business-shaped tools; the LLM does everything else.
- **Replay is not re-execution.** The full state of the society can be reconstructed from the journal alone.

## Status

Implementation phase, no product yet: the design is settled and the kernel is being implemented checkpoint by checkpoint, in the order given in [`docs/kernel.md`](docs/kernel.md) §10. The C1.1 journal — hash-chained append-only event log, framed zstd persistence, claim-check blobs, write-behind with an explicit flush barrier, verifying reader and torn-tail repair — exists in `src/journal/`. The C1.2 node driver — the turn ritual, the free loop with explicit wait, the journaled turn and shutdown vocabulary — exists in `src/node/`; the message transport it still carries (a single `send` primitive, one `deliver` entry point, mail claimed into a durable projection, an in-memory wake latch) is retired and pending removal: the world is the filesystem, and nodes communicate by writing files ([`docs/kernel.md`](docs/kernel.md) §5). Both are covered by a passing test suite under a strict typecheck.

## Documents

| Document | Content |
|---|---|
| [Vision](docs/vision.md) | The living document: what the project is, the three invariants, the two memories |
| [Seed](docs/seed.md) | How to avoid a cold start that kills emergence: the 5 instincts, the Hole, raw tools |
| [Direction](docs/direction.md) | Human ↔ agent zero ↔ nodes: co-negotiated direction, pinned heading, versioned letter |
| [Kernel](docs/kernel.md) | The full technical spec: event-native async runtime, journal format, sandboxing, driver |
| [Research corpus](docs/research/) | State of the art, metrics, devil's advocate, harness internals deep-dive, monitoring architecture |
| [Roadmap](ROADMAP.md) | Where we stand and what's next |

## License

MIT — see [LICENSE](LICENSE).
