# emergent-society

A research harness for observing the emergence of multi-agent LLM societies — and for measuring whether a human can steer them without breaking what makes them emergent. Nothing organizational is coded: nodes get minimal physics, a seed of instincts, and raw tools, and communicate only by writing to a shared filesystem world. The human co-orchestrates the society's direction with a dedicated node (agent zero), while everything is recorded so that emergence can be studied.

## Current state

Implementation phase; no product. The journal module, node driver, context and provider boundary, web tools, persistent terminal, Landlock confinement, and frontier journal are implemented and tested, with a host layer driving them (five-command CLI, first-light smoke, live wrapper). The live path is verified (see the [Roadmap](ROADMAP.md)); live runs are gated by `ES_LIVE_LLM=1` via `scripts/first-light-live.mjs`. Progress and remaining checkpoints live in the [Roadmap](ROADMAP.md); the current-code map in [Architecture](docs/architecture.md).

## Documents

| Document | Content |
|---|---|
| [Vision](docs/vision.md) | What the project is |
| [Architecture](docs/architecture.md) | Concepts → implemented code |
| [Seed](docs/seed.md) | Instincts, the Hole, raw tools |
| [Direction](docs/direction.md) | Pinned heading, versioned letter |
| [Kernel](docs/kernel.md) | Technical spec |
| [AGENTS.md](AGENTS.md) | Commands and conventions |
| [Roadmap](ROADMAP.md) | Progress, checkpoints |
| [SOTA survey](docs/research/sota-autonomous-agents.md) | State of the art |
| [Harness deep-dive](docs/research/harness-deep-dive.md) | DeepSeek Harness internals |
| [Devil's advocate](docs/research/devils-advocate.md) | Counter-evidence |
| [Value measurement](docs/research/value-measurement-long-horizon.md) | Long-horizon value metrology |
| [Exploration/exploitation](docs/research/exploration-exploitation-metrics.md) | Metric catalogue |
| [Value–adaptation coupling](docs/research/value-adaptation-coupling.md) | Adaptation vs drift |
| [Monitoring architecture](docs/research/monitoring-architecture.md) | Observation pipeline |
| [First light](docs/first-light.md) | Founding run record |

## Environment

- Node 24 (per [.nvmrc](.nvmrc)).
- Git ≥ 2.42 — the world perception pins attributes with `GIT_ATTR_SOURCE`, which earlier Git silently reads from the working tree instead.
- Linux — the journal's single-writer ownership needs util-linux `flock` and `/proc`; NFS and shared multi-host storage are unsupported.

Commands and scripts: [AGENTS.md](AGENTS.md). Cell-home layout: [docs/kernel.md](docs/kernel.md). Library composition: [docs/architecture.md](docs/architecture.md).

## Acknowledgments

This project reimplements its inspirations from scratch:

- **[Cordis](https://github.com/cordiverse/cordis)** (Shigma, Koishi ecosystem) — the mutation gate and the self-similar node primitive, formalized in [*A Programming Paradigm for Spatiotemporal Composability*](https://arxiv.org/abs/2608.25512) (PKU + DeepSeek).
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** (MIT) — the journal-as-only-truth pattern, immutable Packages, the compaction protocol, the persistent shell behind Landlock, the escalating kill switch.
- **[Graphify](https://github.com/Graphify-Labs/graphify)** — the monitoring pipeline's graph schema and EXTRACTED/INFERRED edge honesty.
- **[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)** (Apache 2.0) — the credential-broker pattern.

## License

MIT — see [LICENSE](LICENSE).
