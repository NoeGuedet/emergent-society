# Roadmap

References: [Vision](docs/vision.md) — what the project is; [Architecture](docs/architecture.md) — the concepts→code map; [Kernel](docs/kernel.md) — the technical spec; [Research](docs/research/) — the evidence base.

## Current state

**Implemented and tested.** The C1.1–C1.4 lots: journal module, node driver, context and provider boundary, web tools, persistent terminal, Landlock confinement, frontier journal. The host layer: the five-command CLI (`init`, `start`, `resume`, `pause`, `status`), the first-light smoke (scenarios A–E), the live wrapper. The live path is verified against a real model: boot, live-model turns with tool calls, park, wake on a foreign commit, reply in the world, graceful stop — every frontier exchange journaled, zero errors.

**Implemented and tested.** C1.5 `extend` (the Package layer): the six-verb tool, the confined Run supervisor, the persistent content-addressed store, the frozen five-tool offering with the funnel, the boot scan and the host-stop disposal — the C2 criterion path (install → persist → survive restart → clean unload) rehearsed in the Vitest acceptance spine. **Specified, not implemented.** C1.6 agent zero, human chat, `speak`, the disposable SQLite index and projections, the daemon and cockpit; C1.7 the escalating kill switch. The full placeholder↔endpoint credential broker remains a documented target.

## Checkpoints

A checkpoint is reached when its criterion is demonstrated on a running system, not when its parts are coded.

- **C1 — minimal kernel + agent zero + chat + a readable projection of the frontier journal.** *Criterion: we can see everything the agent does, and we can talk to it.*
- **C2 — agent zero hot-extends the system on its own initiative.** *Criterion: reversibility demonstrated — clean unload.*
- **C3 — `spawn` + direction.** *Criterion: at comparable budget per unit of time, the organization maintains a coherent trajectory where a solo agent drifts or collapses.*

## Open decision

**Node 26 upgrade.** Node 24 is in its maintenance-LTS phase and the runtime floor is `>=24 <25`; decide when to move to Node 26.

## Framing rules

- No code before the design is validated.
- No organizational structure is coded; metrics are invisible to the agents; fidelity is measured on acts, never self-reports.
- The frontier journal is the only truth; replay is not re-execution.
- Hard physics: upstream budget ceiling, kill switch, the frontier journal and its gate, the mutation gate, the confinement boundary.
- Git history is the project's chronicle.
