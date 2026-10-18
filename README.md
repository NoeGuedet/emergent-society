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

- **The journal is the only truth.** Every mediated action of every node is an event in an append-only, hash-chained log — the boundary fact (the top-level tool invocation and its result, the model response, the observed world diff), not an exhaustive trace: the shell's syscalls inside a turn are not individually logged. Everything else — dashboards, metrics, agent memory — is a disposable projection.
- **Metrics are invisible to the agents.** Instrumentation lives outside the graph (anti-Goodhart). Fidelity is measured on acts, never on self-reports.
- **The world is the filesystem.** The kernel imposes no message transport: nodes communicate by writing files, the kernel commits the world at the end of every turn with the node's uid as git author, and a node is woken by the changes it did not author.
- **Minimal raw tools.** Nodes get a handful of raw capabilities (shell, speech, web, self-extension) instead of business-shaped tools; the LLM does everything else.
- **Replay is not re-execution.** The full state of the society is reconstructible from the durable records — the hash-chained journal, the canonical claim-check blobs it references (the original payloads, not a disposable index), and the world's Git history — with no model or tool call replayed.

## Status

Implementation phase, no product yet: the design is settled and the kernel is being implemented checkpoint by checkpoint, in the order given in [`docs/kernel.md`](docs/kernel.md) §10. Three checkpoints (C1.1–C1.3) plus all three C1.4 lots (C1.4a web tools, C1.4b persistent terminal, C1.4c Landlock confinement) are implemented and tested under a strict typecheck. **C1.1 — the journal** (`src/journal/`): hash-chained append-only event log, framed zstd persistence, claim-check blobs, write-behind with an explicit flush barrier, verifying reader and torn-tail repair, and a stable flock-guarded single-writer ownership. **C1.2 — the node driver** (`src/node/`): the turn ritual, the commit-per-turn on the shared world repo with the node's uid as git author, wake-on-change over the world's HEAD, the free loop with explicit wait, the journaled turn and shutdown vocabulary — with no message transport, since the world is the filesystem and nodes communicate by writing files ([`docs/kernel.md`](docs/kernel.md) §5). **C1.3 — the durable context and provider boundary** (`src/context/`, `src/provider/`, and the runtime in `src/node/loop.ts`): an incremental journal fold, a provenance-bearing committed surface with a pinned heading and transactional compaction, a bounded pinned world perception rendered from Git output, one canonical non-streaming wire, the raw provider response journaled before projection, bounded retries, and disposable projection snapshots. **C1.4a — the kernel-mediated web tools** (`src/node/tools/web.ts`, `src/node/tools/providers.ts`): `web_search`/`web_fetch` over a kernel-side credential store (`<home>/providers.json`, outside the world when the host follows the documented layout), dispatched through the same gate as the shell. The kernel takes the key from the store only to place it in the `Authorization` header; it never interpolates the stored key into an event, artifact, world write or model request. The store is plaintext at rest — since C1.4c its content is unreadable and unwritable from the confined shell, the protection being the kernel's filesystem policy, not encryption — and provider response bodies are captured verbatim (bounded by `maxResponseBytes`, with incompleteness recorded), so a hostile provider can reflect the key in its response body: that body is journaled, folded into the tool result and committed surface, and can be projected into a later model request through `wire.ts` — accepted for the experiment phase. **C1.4b — the persistent terminal `execute`** (`src/node/tools/terminal.ts`, with `proc.ts` and `sanitize.ts`): one PTY session per node with typed statuses, one active write, a bounded per-command capture and reset-on-timeout. **C1.4c — Landlock confinement of `execute`** (`native/es-landlock/`, `src/node/tools/sandbox.ts`, `terminal.ts`, `loop.ts`): the shell runs by default through the vendored C11 launcher, which self-restricts with Landlock and `execve`s bash in place (pid, session and controlling tty preserved), behind a strict allowlist — the world and a per-node scratch leaf writable, merged-usr dirs read+execute, a narrow `/etc` file list and `/proc` read, five device files individually — with a functional probe at first execute and exit-125-plus-`es-landlock:` failures classified `spawn-failed`. The guarantee is scoped to filesystem content: the content of `providers.json`, of the journal and of host files outside the explicit system read set is unreadable and unwritable from the shell; the residuals (pathname UNIX sockets, metadata mutations, `/proc` stat surfaces, resource exhaustion, open egress) are listed in [`docs/kernel.md`](docs/kernel.md) §7. So the kernel-mediated web tools and their kernel-side credential store are implemented (C1.4a), and so are the persistent terminal (C1.4b) and its confinement (**C1.4c**); the full broker's placeholder↔endpoint substitution remains a documented target with no checkpoint assigned. **C1 as a whole is not reached**: agent zero and the human chat, the `extend` Package layer, the SQLite index and the invariant backstop are not implemented, so there is no CLI, main process, cockpit or running product yet — what exists is the library source plus the runtime a future host would drive, not a launchable kernel. Nothing here has run autonomously against a live model; the confined shell has so far run only under the test suite, and no safety claim is made for an autonomous run.

**Composition (library only).** There is no host executable yet. A host wires the mediated web tools in by loading the kernel-side credential store and spreading the optional `webTools` property — it is optional, so under `exactOptionalPropertyTypes` it is spread conditionally and never assigned `undefined`:

```ts
import { createAgentRuntime } from './src/node/loop.js';
import { loadProviders } from './src/node/tools/providers.js';
import { webToolsFromProviders } from './src/node/tools/web.js';

const webTools = webToolsFromProviders(await loadProviders(home));
const runtime = createAgentRuntime({
  ...options,
  ...(webTools !== undefined ? { webTools } : {}),
});
```

`RuntimeOptions.terminal` is a required option: the host supplies the environment allowlist as `terminal.env` (never `process.env`); `DEFAULT_TERMINAL_ENV`, exported by `src/node/tools/terminal.ts`, is the safe default. The shell is **confined by default** (C1.4c) through the vendored Landlock launcher, and the sandbox then owns three environment entries after the allowlist: `HOME=<world>`, `TMPDIR=<home>/tmp/<uid>` (mode `0700`, kernel-created) and `HISTFILE=/dev/null`. `terminal.sandbox: false` is the explicit, loud opt-out — it hands the shell back its ambient authority — and the kernel process itself stays outside the sandbox either way. A sandbox that cannot be built or probed fails every `execute` closed as `spawn-failed` with the launcher's diagnostic, never a silent unconfined shell.

**`<home>/providers.json` schema.** The file is one JSON object; the only recognized provider is `tavily`:

```json
{ "tavily": { "key": "...", "baseUrl": "https://api.tavily.com", "timeoutMs": 20000, "maxResults": 8, "maxResponseBytes": 1048576 } }
```

- `key` — required, nonempty string; it is sent only in the `Authorization` header.
- `baseUrl` — optional, default `https://api.tavily.com`. Must be `https:` unless the host is loopback (`http:` is accepted only for `localhost`, `::1`, `[::1]`, or `127.0.0.0/8`); it may not embed credentials or carry a query/fragment, and trailing slashes are stripped.
- `timeoutMs` — optional, default 20000, range 1–120000.
- `maxResults` — optional, default 8, range 1–20.
- `maxResponseBytes` — optional, default 1048576 (1 MiB), range 1024–8388608 (8 MiB); the response body is captured only up to this cap.

Unknown providers and unknown fields are refused, and the file itself is capped at 1 MiB. A missing file is an empty registry, so the offered web calls resolve as `denied`; a malformed file is a loud refusal that never quotes a value (validation errors name positions). The defaults and ceilings live in `src/node/tools/providers.ts`.

Placing `<home>` outside the world and outside the project checkout is a host responsibility. One case is enforced: with confinement on and at the first `execute`, a `<home>` inside the world fails closed (`spawn-failed`), because the shell would otherwise be granted the home itself; placing the project checkout outside the world remains a host duty.

**Migrating a legacy world (C1.4c).** A legacy world is refused at open because it has no verifiable external git dir at all — the refusal signal is the failed pair/trust check, not the presence of an in-world `.git`. There is no auto-migration; the documented migration (also quoted by the refusal) is:

1. Stop the host.
2. Record the pre-migration head: `git --git-dir=world/.git rev-parse HEAD`.
3. `mv world/.git world.git`.
4. **Sanitize the moved git dir:** `rm -f world.git/config.worktree world.git/info/grafts world.git/shallow world.git/objects/info/alternates world.git/commondir`; `rm -rf world.git/hooks` (a bare re-init leaves a planted non-sample hook in place).
5. **Materialize** every symlink under `world.git`: replace each link with a `cp -a` of its target after inspection, repeating until `find world.git -type l` is empty (or use `cp -aL`) — a linked directory's target may itself contain links, and deleting a symlinked `refs/heads` would silently lose the branch tip. Replace every multi-linked file with a fresh copy (`find world.git -type f -links +1`): a hardlinked `HEAD`/`refs/heads/main` stays agent-writable through its world alias and survives a plain `mv`.
6. Rewrite `world.git/config` to exactly the allowlisted keys: `repositoryformatversion` (keep `1` for a sha-256 repo), `filemode`, `bare=false`, `logallrefupdates`, `untrackedCache`, and `extensions.objectFormat` when sha-256.
7. Re-seed the hooks: `git --git-dir=world.git --work-tree=<absolute world path> init` (keeps `bare=false`, re-creates the 14 `.sample` files).
8. Record the pairing: `git --git-dir=world.git config core.worktree <absolute world path>`.
9. **Postcondition:** `git --git-dir=world.git rev-parse HEAD` must equal the pre-migration HEAD.

A bare `mv` is rejected because it would carry a poisoned config, hooks, symlink or hardlink layout from before C1.4c into the kernel's trust zone. After migration, an agent-created `<world>/.git` is ignored at open and never staged; refusing it would hand the shell a permanent boot-denial via `mkdir .git`.

## Development

Node 24 is required (`nvm use`, per [.nvmrc](.nvmrc)). The journal's single-writer ownership is a Linux/local-filesystem mechanism: it needs util-linux `/usr/bin/flock` and `/proc` (for pid start times), so it is not supported on NFS or shared multi-host storage, and the on-disk ownership protocol is only guaranteed within one version — upgrading across the old and new lock protocols is a cold upgrade, taken while no node is writing. A Git at or above **2.42** is required (verified on 2.43.0): the perception pins attributes to the `to` tree with `GIT_ATTR_SOURCE`, which earlier Git ignores and silently reads from the working tree. This floor is documented, not enforced with a version guard. Independently, replay binds the world's Git history to the exact `git --version` recorded in each perception, so a host with a *different* Git version fails replay explicitly rather than promising byte equality. Install reproducibly with `npm ci` (the existing dependencies are few and pinned) and build the vendored Landlock launcher with `npm run build:native`, which needs a host C compiler (`cc`); the vitest global setup builds it once when it is absent or older than its source or the build script, and aborts the suite with a clear message only when a build is needed and `cc` is missing. Run the tests with `npm test` and the strict typecheck with `npm run typecheck`. This launcher is the only build step; the binary is git-ignored, never committed.

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
