# Roadmap

References: [Vision](docs/vision.md) — what the project is; [Architecture](docs/architecture.md) — the concepts→code map; [Kernel](docs/kernel.md) — the technical spec; [Research](docs/research/) — the evidence base.

## Current state

**Implemented and tested.** The C1.1–C1.4 lots: journal module, node driver, context and provider boundary, web tools, persistent terminal, Landlock confinement, frontier journal. The host layer: the five-command CLI (`init`, `start`, `resume`, `pause`, `status`), the first-light smoke (scenarios A–E), the live wrapper. The live path is verified against a real model: boot, live-model turns with tool calls, park, wake on a foreign commit, reply in the world, graceful stop — every frontier exchange journaled, zero errors.

C1.5 `extend` (the Package layer) is also implemented and tested: the six-verb tool, the confined Run supervisor, the persistent content-addressed store, the frozen five-tool offering with the funnel, the boot scan and the host-stop disposal — the C2 criterion path (install → persist → survive restart → clean unload) rehearsed in the Vitest acceptance spine and proven compiled in the scenario F packages smoke. The C1.5 friction pass is implemented on top of it, from the first live run's evidence: Packages addressable by name (`run` and `undefine` take name or id, a name resolving to the newest stored version under it; `stop` addresses the live Run by its package's name or id), a native call to a live-registered tool bridged to the funnel (the offering stays frozen), the source contract taught in the tool description, the honest no-provider web denial, and the shell's `openssl.cnf` grant; the scenario F smoke exercises the name path, the version skew and the bridge compiled-side. The friction pass 2 is implemented on top of the audit wave's findings: the Hole facts shipped in the charter (plus the operator `--charter-file`), the node identity composed into every freshly composed charter, the shell and wait contracts taught (the real read/write set with the mode qualifier, the external git, the full wait contract), the Package contract taught (the svc facade with its resolve/reject channels, the Run's file reach and lifetime, the define/run split), the wake perception budgeted newest-first under the byte cap with the dropped count and the oldest omitted commit named (renderer policy v2; v1 journals replay unchanged), the refusals that teach (a detail per nameable rule, the frozen codes intact, the documented bare exceptions) and the bare stop for the singleton Run. The live phase is checkpointed: the friction acceptance run measured the pass (52 model requests where the founding run spent 97, every remaining error a teaching refusal corrected in one call); the founder panel — ten isolated first nodes under one mission prompt — demanded the same two kernel primitives by unanimity (a timer; a kernel-written events log, the agent-side face of the host observation seam) while inventing mail, claims, ADRs, trust classes and the data-is-not-instruction clause before peers existed; and the duo session verified the two-node time-sharing mechanics (per-uid config gate, wake on the other's commits, one shared frontier) while its machine incident demonstrated the isolation findings empirically — one well-intentioned node's unbounded test activity survived its own kernel and OOM'd the host — making the isolation wave the blocking one before any further live runs. The sessions are recorded in [first-light.md](docs/first-light.md); the research harvest is in [founder-panel.md](docs/research/founder-panel.md). **Specified, not implemented.** C1.6 agent zero, human chat, `speak`, the disposable SQLite index and projections, the daemon and cockpit; C1.7 the escalating kill switch. The full placeholder↔endpoint credential broker remains a documented target.

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
