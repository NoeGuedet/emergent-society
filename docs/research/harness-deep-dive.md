# Deep dive: DeepSeek Harness, Cordis, and the paper "Spatiotemporal Composability"

**Research date:** 11 September 2026
**Context:** research for the `cell` project — a minimal event-driven/async kernel, an append-only event log, modules that can be loaded/unloaded hot and reversibly, and an emergent organization of LLM agents.
**Method:** the official GitHub repository read directly (README + docs sources via the GitHub API), arXiv paper 2608.25512 read locally (92-page PDF, sections 1, 3, 4.1, 5, 6), technical press and blogs cross-checked.

Every claim carries its source. Legend: **[V]** fact verified against a primary source (repository, paper) · **[I]** inference · **[?]** not found / not verifiable · **[S]** secondary source (press/blog, variable reliability).

---

## 1. Executive summary

1. **DeepSeek Harness (`dsh`)** is an open-source (MIT) agentic harness published by DeepSeek on 13 August 2026 in *developer preview*, built on the plugin meta-framework **Cordis** (vendored in the repository). Everything in it is a plugin: model adapter, tool registry, session log, and **the agent loop itself**. [V]
2. The **append-only session log** is the single source of truth: the LLM history is *derived* from the log, never stored separately; resume, fork, replay and the Trajectory view all share the same stream of typed events (`SessionEventMap`). Key invariant: **"model-visible means logged"** — anything that reaches a model request must be reconstructible from the log. [V]
3. **Cordis** (from the Koishi ecosystem, author Shigma, ~2000 lines of TypeScript at its core) provides: Context (a service container), `inject` (declarative dependencies with waiting), Fiber (a lifecycle state machine), `ctx.effect` (reversible effects with a disposer), typed events with 5 dispatch modes, isolation via realms. [V]
4. The paper **arXiv:2608.25512** (PKU + DeepSeek, August 2026) formalizes the whole thing: *reversible effects* (every transformation of the context carries an inverse held by the runtime, twisted composition → LIFO unloading), *reactive co-effects* (declared dependencies, every change classified activating/deactivating/neutral), unified in the *context paradigm*. A **dynamic composition calculus** proves that the local guarantees scale up to the whole system (termination, confluence, preservation). [V]
5. For a minimal kernel, the central lesson: **a single mutation gate** (`ctx.effect`), **per-state inverses** returned at the point of application, **one LIFO accumulator per component**, **dependencies identified by provider (uid) and not by value**, and **an append-only log from which every derived state is a projection**. [V]

---

## 2. TASK 1 — DeepSeek Harness (`dsh`)

### 2.1 Identity, status, installation

- Repository: `github.com/deepseek-ai/deepseek-harness`, MIT license, published on 13 August 2026, *developer preview* with an explicit warning: "THERE WILL BE COMPATIBILITY-BREAKING CHANGES". [V] https://github.com/deepseek-ai/deepseek-harness
- Docs: https://deepseek-harness.github.io/deepseek-harness/ [V]
- Launch: `npx @deepseek-ai/dsh web` → Web UI on `http://127.0.0.1:3080`; from source: `pnpm install && pnpm run build && pnpm dsh web`. Node `^22.19.0 || >=24.0.0` required. [V] (README; Node version confirmed by https://atomicbot.ai/blog/what-is-deepseek-harness [S])
- Popularity: >200k GitHub stars as of 11 Sept. 2026 (the repository's live counter: 220k stars, 26k forks); ~155k stars in 5 days; ~7000 repositories with the `dsh-plugin` topic. [V/S]
- Official formula: "Agent = Model + Harness". [S] https://vgtimes.com/tech-and-hardware/164409-deepseek-launches-harness-an-open-source-ai-agent-environment.html
- Published session formats: the release record indicates `latestReleasedVersion: 3`, proof tag `dsh-v0.1.5-alpha.1` — so the preview has already published 3 versions of the log format. [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/session-format-status.md

### 2.2 Exact architecture: Cordis, profiles, bundles, presets

Three distinct layers of composition (not to be confused):

1. **Profile** (runtime): a named composition stored in the Harness home; list of stacked bundles + out-of-tree plugins + user `cordis.patch.yml`. Shipped profiles: `web`, `headless`, `sdk`, `sdk-minimal`, `acp`. [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
2. **Bundle**: a distribution format for lines of Cordis config plus the code they mount. `dsh-base` is the first layer of the web/headless/sdk/acp profiles (model adapters, tools, persistence, sandbox, approval, settings, credentials, telemetry); `dsh-web-app`, `dsh-headless`, `dsh-sdk-app`, `dsh-acp-app` each add their own surface. Order of application: bundles in profile order → profile patch → home patch → `--patch` overlays. A patch targets a line by `id` and replaces its whole config, or inserts new lines. [V] (same source)
3. **Agent preset** (per session): per-session `agent.cordis.yml` composition — tools, prompt sections, skills. Mounted once per process under a "standing scope"; agents join it by scope-key parentage. Generations keyed on the file stamp (mtime+size): a session already joined keeps its generation even if the file changes. [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-presets/README.md

Architecture points verified in `docs/architecture.md`:

- **"There is no privileged core to patch"**: dsh is extended by mounting a plugin alongside the others; every registration is an effect that unwinds on unload. [V]
- Core packages and their ctx keys: `core/session` → `ctx.sessions` (append-only log); `core/system-prompt` → `ctx.systemPrompt`; `core/tools` → `ctx.tools`; `core/agent` → `ctx.agents`; `core/agent-loop` → `ctx.agentLoop`; `llm/llm` → `ctx.llm`. [V]
- **Three event domains**: *session events* (durable facts, log + broadcast via `session/event`), *agent events* (`agent/*`: inbox, step, status, request, validation, continuation — live), *capability events* (`fs/*`, `tools/*`, `telemetry/*` — policy/adapters). [V]
- **Turn flow**: a *step* = one model request plus the tools it calls; a *turn* = zero or more steps. Pipeline: `turn/start` → claim inbox → assembly → `agent/pre-step` (waterfall, may rewrite/reject) → `step/start` → `agent/request` → append `user/message` + `request/header` → freeze history → stream (`agent/assistant-stream` live chunks) → `assistant/message` → `tool/call` → `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tool/result` → `step/end` → … → `turn/end`. [V]
- **Capability seams**: a swappable capability = three roles (Service Definition / Service Provider / Consumer). E.g. filesystem+subprocess share an "execution world": pointing the providers at a remote sandbox moves Bash, PTY and LSP without forking the providers. [V]
- `dsh --profile web --dump-config` displays the full tree; each line is replaceable by patch. [V]

### 2.3 How the agent writes and mounts its own plugins on the fly

**Extensions** subsystem (`packages/extensions`), verified against the group README and the generated docs:

- The agent can **inspect and modify the live runtime without editing the repository files or the configuration**: define, run, update, stop, remove *dynamic Cordis packages*, from model tools or a browser panel. [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/extensions/README.md
- Four packages: `tool-cordis` (seven model tools: inspect the runtime, define/run/stop/remove dynamic packages, registered on `ctx.tools`), `cordis-host-runner` (definition registry + sandboxed lifecycle on the host side, provides `ctx.dynamicCordisRunner` and `ctx.cordisInspect`), `cordis-client-runner` (evaluates half-browser code as a live plugin), `ui-cordis` (panel, lifecycle cards, `@pluginId` input source). [V] (same source)
- Versioning model: a *Plugin* has **immutable** *Packages* (versions); `define()` creates the first Package or adds one; `run()` activates an exact version (run-current or switch mode). Activation on the host side is **sandboxed** and an unauthorized activation **waits for an approval**; a plugin-wide authorization covers future versions. [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/extensions.md
- Dual-half: a package may have a host half (Node) and/or a client half (browser); a client package requires a browser page to activate (event `cordis/request-run`). [V] (same source)
- **Major limitation: "Definitions exist only in process memory and disappear when DSH restarts."** — dynamic plugins are in memory only. [V] (packages/extensions/README.md)
- The inspector: `ctx.cordisInspect` lets the model **query approved runtime metadata before writing code** (host + client registry, read-only JSON queries). [V] (subsystems/extensions.md)
- The **Creator** preset (see 2.6) adds runtime inspection, in-memory plugin experimentation and preset authoring guidance. [S/V — corroborated by the `cordis-plugin-development` and `editing-cordis-compositions` skills shipped in `presets/cordis/`]

### 2.4 The chat interface (human ↔ agent)

- **The Web UI is itself a Cordis application on the browser side** (same pattern as the Koishi console): plugins loaded independently, lazy module graph, vendored Cordis Loader mounted at boot, `ctx.remote.<namespace>` for typed Host calls, Cordis events forwarded selectively. [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md
- Strictly layered architecture: Host (authoritative state) → Remote transport → Client models (without React) → UI adapters → Conversation/Slots → React. Data direction: `Host state → Remote → Client model → UI adapter → Conversation → Slots → React`. [V] (same source)
- **Two views over the same log**: `ui-chat` (conversation) and `ui-trajectory` (run inspection) are two *targets* of the Conversation subsystem; each has its own Definitions and snapshots, and they can interpret the same family of events without sharing their display model. Live chunks arrive as client-only transient events `assistant/live-chunk`; the durable events `assistant/message`/`assistant/attempt` embed the complete compact streams for history replay. [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/conversation.md
- Human input: the Web UI requires selecting a workspace before enabling typing; messages are queued and *claimed* by the driver through a **single inbox**; `agent.inject()` injects context that lands in the next admitted request (it is also the channel for cron notifications, file changes, etc.). [V] (architecture.md, getting-started guide)
- **Approvals**: if the permission policy requires it, the Web UI asks before an operation; there is a dedicated `user-questions` subsystem for the agent's questions to the human. [V] (docs/subsystems/user-questions.md exists; getting-started guide)
- Chat is not the only interface: one-shot headless CLI, TypeScript SDK (JSON-RPC server), Python SDK (launches `dsh --profile sdk`), ACP server (automation-only), Electron desktop app (no web server and no loopback port, RPC over versioned pipes). [V] (architecture.md)

### 2.5 The append-only event log: schema, vocabulary, replay

Primary source: `docs/subsystems/session.md` (package `core/session`, `ctx.sessions`). [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md

**Principles:**
- A `Session` = **append-only log of typed events**; the LLM message history is *derived* from the log (`deriveMessages()`), never stored separately; **replay = re-derivation from the same events**. Seeding a `Session` with an existing log = replay/fork/resume.
- Runtime invariant: **"Model-visible means logged"** — anything that reaches a model request must be reconstructible from the log; adding a model-visible input = extending `SessionEventMap` and rendering it from the log.
- **Merge-extensible**: a plugin adds its event types by TypeScript declaration merging (e.g. `compaction/start|summary|end`, `hook/invoked|result`). Switches on `SessionEvent` must not use `assertNever`.

**Event vocabulary (`SessionEventMap`), verified:**
- `turn/start`, `turn/end` (with `TurnEndReason`), `step/start`, `step/end` — structural boundaries.
- `user/message` — human prompt, injected synthetic context (`agent.inject()`: file-change notices, AGENTS.md, skills, cron notifications), or goal continuation; `source` distinguishes them.
- `system/message` — the **rendered** system prompt, as a surface node (node 0 + later in-history nodes); an empty prompt clears all active nodes.
- `assistant/message` — assembled message of a step + **the exact compacted stream** (`AssistantStreamRecord[]`, without joining delta boundaries) + optional `usage` + `interrupted?: true`.
- `assistant/attempt` — attempt settled without a surface message (failure, retry, cancel, stream error), embedded stream, does not enter the model history.
- `tool/call` (name + **raw unparsed** JSON `arguments` + `callId`), `tool/result` (message + `error?: {name, code}` + `meta?: JsonValue`).
- `request/header` — the complete request envelope (call config, adapter defaults, assembled tool schemas); log-only; the last snapshot reconstructs the header (`foldRequestHeader`); reasons: `initial|resume|change|series`. **Every request is a pure function of the log.**
- `request/context` — route metadata (provider, model, contextWindow, systemPromptUpdate), logged only on change.
- `session/end-seed` — end-of-seed marker (replay/fork/resume); `{inherited: true}` for the fork cut.

**Structure of an event (`SessionEvent<T>`):** discriminated union on `type`; contiguous monotone `seq` (`seq = log.length`), `time` epoch ms, typed `data`, `ignorable?: true` (a reader that encounters an unknown type **without** this marker MUST refuse to reconstruct the session rather than silently dropping it). Branded types: `SessionSeq`, `SessionLogOffset`, etc.

**Surface** (projection of visible messages): the 4 message-producing types (`system/message`, `user/message`, `assistant/message`, `tool/result`) carry a mandatory `SurfaceOp`: `'append'` or `{op:'replace', startSeq, endSeq}` (used by compaction: replaces an interval of nodes, `sourceEventSeqs` cites the masked nodes). `Session.surface` exposes `nodes` + `replaceGeneration`; `foldSurface(events)` replays the complete surface. A human transcript reads the original append events, not the surface.

**Persistence:** JSONL; v0 = `session.jsonl[.zstd]`, v1+ = `session.vN.jsonl[.zstd]`; **the paths of committed generations are never renamed, replaced or deleted**; adjacent migrations `vN → vN+1` (one package per step); writing = encode + verify + exclusive publication of the successor next to the unchanged source. [V] (architecture.md §Session log)

**Projections:** mandatory seam `dsh-session-projection` (`ctx.sessionProjections`): registered units fold committed events incrementally, consumers read a typed state via `stateOf()`. [V] (architecture.md)

### 2.6 The 4 run modes (= agent presets)

Beware of the vocabulary: the August press talks about "Standard, Code, Minimal, Creator"; **in the current repository these are agent presets** and "Code mode" was renamed **PTC** (decision note `2026-08-25-rename-code-mode-to-ptc`). Presets shipped in `packages/preset/agent-presets/presets/`: `standard`, `ptc`, `minimal`, `cordis`. [V — repository tree]

| Mode | Repository preset | Contents | Source |
|---|---|---|---|
| **Standard** | `standard` | Full coding agent: file editing, shell, file/web search, skills, planning, goals, subagents, workflows | [V] preset dir + [S] MarkTechPost https://www.marktechpost.com/2026/08/17/deepseek-ai-releases-deepseek-harness-in-developer-preview/ |
| **Code / PTC** | `ptc` | Exposes the tools through a "Code Mode" SDK: the model combines multi-step operations into **a single TypeScript program** | [V] preset dir + rename note + [S] DataCamp https://www.datacamp.com/blog/what-is-deepseek-harness |
| **Minimal** | `minimal` | **A single fixed tool: a persistent `bash` (PTY)** — `str_replace_editor` was removed by commit `63795eaa` (03/09/2026, "remove str_replace_editor from minimal profiles"), to benchmark models in a bare environment (RL training config) | [V] preset dir + agent-presets README + commit `63795eaa` |
| **Creator** | `cordis` | Runtime inspection, experimentation with in-memory Cordis plugins, preset authoring (skills `cordis-plugin-development`, `editing-cordis-compositions`) | [V] preset dir + [S] AgentHome https://agenthome.info/en/tools/deepseek-harness/ |

Rules verified on the presets: a session can change preset only **as long as it has not produced anything** (otherwise the composition is frozen for life, because swapping the tools would leave logged tool calls that the new composition cannot perform); the switch is recorded in the log (`agent-preset/selected`); authoring is **copy-only** (creating a preset = copying an existing directory into the user root, never a composition text supplied by a caller). [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-presets/README.md

### 2.7 Known limitations

**Verified (primary sources):**
1. **Developer preview, breaking changes announced**; **no security audit** ("must not be treated as secure or production-ready"); sandbox/approvals reduce risk without guaranteeing isolation. [V] SAFETY.md + README
2. **Dynamic plugins in memory only**: "Definitions exist only in process memory and disappear when DSH restarts." [V] packages/extensions/README.md
3. Presets: a session cannot change preset after having produced anything; a superseded generation is never reclaimed (watchers leak until the end of the process); the generation is keyed on the composition file alone (an edit to an adjacent skill/asset is not detected); a preset copy is never mounted for validation; the health check does not prove importability. [V] agent-presets README §Known Limitations
4. Public postmortems (4): `acp-default-export-drops-inject`, `js-expression-disabled-filesystem-tools`, `web-agent-gui-feedback-loop`, `landlock-partial-notice-misclassified-child-failures`. [V] docs/postmortem/
5. Live patch reload: only the `web` profile (and custom profiles by default) reloads hot; `headless`, `sdk`, `sdk-minimal`, `acp` apply all layers once at startup. [V] architecture.md
6. A hard process loss before settlement leaves no durable attempt stream. [V] architecture.md
7. **[Added 14/09] Fiber unloading is parallel between sibling effects**: LIFO is guaranteed only *inside* a `ctx.effect`; between sibling effects of the same fiber, async disposers run in parallel (issue cordiverse/cordis#26, PR #144 open as of 14/09/2026). [V] fiber.ts `_unload` + upstream issue
8. **[Added 14/09] The mutation gate is not watertight from the inside**: arbitrary Cordis code can call `ctx.effect`/`ctx.provide` directly and bypass any attenuation facade (paper §6.3: sandboxing untrusted code requires an *external* sandbox) — hence dsh's `node:vm` + whitelisted facade for dynamic Packages. [V]
9. **[Added 14/09] No proper upstream documentation for Cordis v4**: the README points to dsh's cordis-primer; a support risk worth noting. [V]

**Secondary sources (to be taken with caution):**
- SitePoint mentions a `HarnessPlugin` subclass, `agent.run()`, a `harness` CLI — **inconsistent with the repository** (CLI = `dsh`, plugins = Cordis functions/objects); consider these details **invented**. [?] https://www.sitepoint.com/deepseek-harness-developer-preview/
- SitePoint: "circular plugin dependencies and multi-agent context sharing remain undocumented" — plausible but not re-verified in the repository. [?]
- Cordis gotchas (Starlog): stateful services (connection pools) break the hot-reload promise (the manual `accept` API is needed); communication between sibling contexts is awkward (emit on the common parent). [S] https://starlog.is/articles/developer-tools/cordiverse-cordis
- HN/dev debate: some criticize the paper as "metatheory cosplay", others defend the framework's real engineering value. [S] https://findharness.com/blog/cordis-framework-explained

---

## 3. TASK 2 — Cordis, the meta-framework

### 3.1 Origin and ecosystem

- Cordis began as the plugin foundation of **Koishi** (a chatbot framework for QQ/Discord/Telegram), npm package `cordis` published as early as **2022** by **Shigma**, organization **Cordiverse**. It is not a DeepSeek creation: DeepSeek adopted it, vendored it (`vendor/cordis`, version 4.0.0-rc.7), rescoped it as `@deepseek-ai/cordis`, and patched it (18 local modifications: lifecycle hardening, transactional config loading, JSDoc). [V/S] https://redreamality.com/blog/cordis-spatiotemporal-composability-deepseek-harness/ , https://juejin.cn/post/7673436957741236239
- Core ≈ **2000 lines of TypeScript**: Service (named ctx keys), Fiber (state machine), Effect (registration = disposer), `inject` (declarative waiting on dependencies), typed Events. [S — corroborated by the paper §5] https://juejin.cn/post/7673436957741236239
- **Koishi validates the model in production**: >4000 community plugins in 4 years, with a real dependency topology (IM adapters, DB drivers, functional plugins written by independent authors who coordinate only through the co-effect that connects them). [V — paper §5.3]
- **The Koishi web console is a second, independent Cordis application** above the same kernel: its plugins compose browser and UI primitives instead of server ones. Proof of generality: the model fixes *how* effects and co-effects compose, not their meaning. [V — paper §5.3]
- **Important versioning**: Koishi uses **Cordis v3**; the paper presents **Cordis v4** (refined effect/co-effect semantics, rewritten loader). The compositional model is shared, but "v3 in production" is not a complete validation of v4. [V — paper §5.3 note 4]

### 3.2 The technical model

Primary sources: paper §5 (core library), `docs/cordis-primer.md`, `docs/cordis-tutorial/02-lifecycle-and-effects.md` of the Harness repository.

**Context.** The `ctx` is the single entity through which every interaction passes: a service container (named keys `ctx.tools`, `ctx.llm`…), carrier of effects and co-effects, structured as a **tree** (each plugin receives a child context derived from the parent). [V — paper §3.3.1, Def. 28]

**Plugin.** Three equivalent forms: function (`export function apply(ctx)` + optional `name`/`inject`), object (`{ name, inject, apply }`), or a class `extends Service` (to provide a service consumable by others). `ctx.plugin(fn)` mounts a plugin **from code** — the same operation the YAML loader applies to each config entry — and returns a **fiber**. [V] https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md , https://findharness.com/blog/cordis-framework-explained

**Services and `inject`.** A plugin declares `inject: ['tools']`: Cordis **waits** for the required services to exist before activating the plugin; the load order is deduced from the needs, not orchestrated by hand. A service is available only as long as its provider fiber is ACTIVE. [V — paper §5.1.2-5.1.3, primer]

**Reversible effects (`ctx.effect`).** Any resource not natively managed by Cordis (timer, connection, watcher) is wrapped in `ctx.effect(() => { /* install */ return () => { /* dispose */ } })`: the body runs at load, the returned disposer runs at unload, **never called manually** for a resource whose lifetime is the plugin's. Every context-mediated mutation reduces to `ctx.effect`: registrations, mounts of child plugins, service provisions. Disposers run in **reverse registration order (LIFO)** at teardown. [V — paper §5.1.1, tutorial 02, primer]

**Fiber.** The runtime handle of a loaded plugin instance: `uid` (unique, the root = 0), `ctx`, validated `config`, `state`, `store` (snapshot of the service implementations at load time). Methods: `dispose()` (unloads and waits for all cleanup, including async, and recursively unloads the children), `restart()`, `update(config)` (validates then restarts), `await()`. State machine: `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`, with a `FAILED` branch; `PENDING` = declared but a required service is missing (the number-one cause of "why does my plugin show nothing"). [V — tutorial 02 + https://agentatlas.org/blog/cordis-explained-how-deepseek-harness-plugin-framework-works/]

**Typed events — 5 dispatch modes** (the mode is part of the event's public contract, tagged `@mode` in the Harness docs):

| Mode | Awaited? | Order | Return value? |
|---|---|---|---|
| `emit` | No | registration order | No |
| `waterfall` | No | registration order | Yes (via `next()`) |
| `parallel` | Yes | all in parallel | No |
| `serial` | Yes | sequential, can short-circuit | Yes |
| `bail` | No | until the first bail | Yes |

`waterfall` = *around* middleware: the listener receives `(...args, next)`, calls `next()` to delegate, returns without `next()` to short-circuit; cooperative listeners mutate a shared object then delegate; `prepend: true` to run before the ordinary registrations. [V — cordis-primer.md §Dispatch Modes]

**Isolation (realms) and interception.** `ctx.isolate(key, realm)` derives a child context where the key resolves to an independent **realm**: two contexts assigning different realms to the same key get independent bindings (multi-tenancy, tests, sandboxing, per-session presets in Harness). `ctx.intercept(key, metadata)` merges metadata consulted at access time (fine-grained policy: e.g. restricting the paths of an fs) — modifiable hot **without triggering a reload**. Both derive a child context; retrieval is implicit (discarding the child is enough). [V — paper §3.2.3, §5.1.2, §6.3]

**Proxy access.** `ctx[key]` goes through a Proxy that walks up the fiber chain: the first fiber whose *committed* view binds the key → authorized; a fiber that declares the key without having committed it → `INACTIVE_ACCESS`; root reached without declaration → `UNDECLARED_ACCESS`. **Capability-based access control**: a component can only access the dependencies declared in `inject` — reviewable at load time. [V — paper §5.1.4, §6.3]

### 3.3 Hot load/unload: guarantees and non-guarantees

**Declarative loader** (`cordis.yml`): each entry = one fiber (stable id, module url, isolate, intercept, config, disabled). Reconciliation is incremental and chooses the least disruptive operation per changed field: `id`/`url` → rebuild; `isolate` → realm reassignment (delimiter-based algorithm, without reloading the provider if possible); `intercept` → updated in place; `config` → handed back to the component which diffs and reloads only on a material change; `disabled` → unload/reload. `@cordisjs/group` loads a list of children (keyed diff by id), `@cordisjs/include` grafts an external config file. [V — paper §5.2.1]

**Proven guarantees** (the paper's metatheory, §4.3):
- **Quiescence/termination**: the system reaches a stable state after any series of changes (Th. 73).
- **Confluence**: the quiescent state is a function of the final configuration alone, not of the order of the steps (Th. 80) → the loader can reconcile in any order.
- **No load order to arrange**: a fiber whose keys are not yet provided waits; modules load **concurrently**.
- **Dependency-ordered unloading**: a provider goes UNLOADING *before* its inverses run; its dependents recompute an unsatisfied view and start their own teardown while its bindings are still in place; the provider waits for each notified dependent to reach INACTIVE before reclaiming its effects.
- **Transactional HMR** (`@cordisjs/hmr`, 3 phases: accepted/declined classification of modules, detection of stale entries, transactional reload with cache backup and full rollback if an import fails); **no need for `accept` annotations à la Webpack/Vite** because the fiber already bounds all the component's effects. [V — paper §5.2.2]

**Non-guarantees / author obligations** (explicit in the paper):
- The runtime **does not check** that the supplied inverse actually reverts the effect (the "witness" is an author obligation, §5.1.1), nor that the operations of a key commute (§3.4.2).
- **System boundary** (§6.1): only the locations the system modifies *exclusively* and can restore are reversible. An emission to the outside (network write, process fork…) crosses the boundary; recovery then requires *withholding* (delaying the emission) or application-level *compensation* (e.g. deleting the created file, refunding) — outside the theorems.
- A cross-process request via a service broker must be designed **asynchronous** (latency, mid-flight failure). [V — §6.2]
- Ecosystem: hot-reloading **stateful** services (pools, caches) remains a hard point in practice (manual `accept` API); communication between sibling contexts only via the common parent. [S] https://starlog.is/articles/developer-tools/cordiverse-cordis

---

## 4. TASK 3 — The paper arXiv:2608.25512 (reading of the local PDF)

*A Programming Paradigm for Spatiotemporal Composability* — Yifan Shi¹², Wei Zhang¹, Tianyi Cui² (¹Peking University, ²DeepSeek-AI), 92 pages. Read: abstract, §1 (intro), §2 (preliminaries), §3 (complete concrete model), §4.1 (components/fibers), §5 (Cordis + Koishi implementation), §6.1-6.3 (discussion). File: `/Users/noe/projects/cell/paper.pdf`. [V — direct reading]

### 4.1 The two dimensions (§1)

- **Temporal composability**: when a component is removed, its modifications to the shared environment must be **completely and safely undone** — tracking of every allocation, registration, mutation, and ordered reclamation.
- **Spatial composability**: components must **declare, discover and resolve** their mutual dependencies in a structured way, with lifecycle coordination when the dependencies change.
- Statically, these two dimensions reduce to lexical scoping (RAII) and import resolution. Dynamically (plugins, **self-evolving agentic harnesses** — explicit motivation §1.2.2: continuous modifications, without human supervision, a restart per modification is untenable and a faulty modification can disable even the process needed for recovery), runtime mechanisms are required.
- VSCode analysis: 87/100 top extensions contain executable code and require an extension host restart to be removed; the `deactivate` hook separates the creation of the effect from its disposal (a violation of the *locality of concern*); only 7/100 declare `extensionDependencies` and the inter-extension API is untyped. [V]

### 4.2 Reversible effects (§3.1) — the mechanical core

- An effect is modeled as a **function Γ → Γ×(Γ→Γ)**: applied to the context, it returns the modified context **plus an explicit inverse** chosen *for the state where the effect was applied* (Def. 8, 𝔈*Γ). This is the key point vs. a uniform inverse fixed in advance: **the inverse is returned at the point of application**.
- **Twisted composition** (Def. 1): inverses accumulate in opposite order — `(f₁,g₁)∘(f₂,g₂) = (f₁∘f₂, g₂∘g₁)`. The twisted monoid 𝔗Γ automatically yields **LIFO unloading**.
- **Effect context** `∂Γ = Γ × (Γ→Γ)` (Def. 2): the state + the **accumulator** φ (composite of the inverses). `track` (Def. 3) is a monoid homomorphism (Th. 5); `recover(γ,φ) = (φ(γ), id)` (Def. 6); **soundness invariant** φ(γ) = γ₀ preserved by every tracked effect whose inverse reverts it (Th. 7).
- **Effect iterators** (Def. 17): a component loads a *sequence* of effects, reified as an iterator — each iteration yields (context, inverse, Maybe continuation). This is a **reified delimited continuation**, which maps directly onto the **generators** (`yield`) of mainstream languages. Loading = running an iterator while accumulating the inverses; unloading = applying the accumulator (Th. 16: reversing in inverse order restores to each inverse the state its own application produced).
- **Cordis realization (§5.1.1, Algo. 1)**: `ctx.effect(callback)` drives the callback like a generator, folding each yielded inverse into a composite (prepend → LIFO), with (a) **auto-disposal** (flag `armed`: halts the in-flight iteration + recovery at most once) and (b) **parental composition** (the child's disposer is prepended into the parent context's accumulator — the recursive structure ∂²Γ).
- **The runtime does not check the witness**: that the inverse reverts is an author obligation (§5.1.1).

### 4.3 Reactive co-effects (§3.2) — living dependencies

- Co-effect context: `Σ = (k:K) ⇀ 𝒱_k`, a dependently typed partial table (Def. 19). `get` requires presence, `set` requires absence — **no double provision**.
- **`set(k,v)` is a reversible effect (type 𝔈*Σ)**: provision and removal inherit automatic tracking. *This is the central synergy: co-effect operations are effects, and effects are reversible.* (§3.2.1)
- **Specification** `d ⊆ K` (Def. 21) + **classification of every transition**: `notify_d(σ,σ')` = activating / deactivating / neutral (Def. 22). Reactivity has an algebraic basis: since every mutation goes through effect functions, every change of satisfaction is detectable at each effect boundary.
- **Isolation (realms)**: `Σiso = (K⇀R) × ((r:R)⇀𝒱_r)` — two-layer resolution `k → ρ(k) → σ(ρ(k))` (Def. 24-25). Runtime ad-hoc polymorphism, dynamically adjustable. **Interception**: monoid metadata per key, right-biased merge (the enclosing context takes precedence over the component's declaration) — lets an orchestrator constrain the use of a dependency without modifying the component (Def. 26-27).
- **Realization (§5.1.2, Algos. 2-3)**: three symbol-keyed slots per context (`@@store`, `@@isolate`, `@@intercept`); `ctx.set` = a `ctx.effect` that writes the store and calls `notify`; `notify` tests for each living fiber whether a changed key ∈ `fiber.inject` **and resolves to the same realm**, then `refresh`. **Identity by provider, not by value**: a fiber's target = the tuple of the uids of the provider fibers; a uid is never reused, so a replaced provider cannot be confused with its replacement even at equal values; a provider that rewrites its own binding in place is **not** observed (to propagate, remove then reinstall). [V — §5.1.3]

### 4.4 The context paradigm and independence (§3.3-3.4)

- **Unified context** `Γ∞ = μΓ. Γ × (Γ→Γ) × Σ` (Def. 28): recursive state + accumulator + co-effects. Every component↔environment interaction passes through this single entity. Σ subsumes *all* shared mutable state, not only dependencies.
- **Mediation discipline** (Def. 30): context-mediated iterators have only two kinds of steps — an operation on a read key, or the provision of an own key. Anything that reads something else (a key without a step, a location that no key binds) falls outside the paradigm.
- **Observational equivalence** (§3.3.2): two states are equivalent if no sequence of operations distinguishes them (≃). This is what makes recovery *attainable* (a heap after free is not bit-for-bit equal, but indistinguishable). The granularity of ≃ is an **interface design choice**: publishing fewer outcomes = fewer tests = a coarser relation.
- **Independence** (Def. 42): two iterators are independent if every transformation of one commutes with every transformation of the other (forwards *and* inverses) and disturbs neither inverse nor continuation. Th. 43: under pairwise independence, **the inverses can be applied in any order** and still reach γ₀. Th. 45: operations on distinct keys are independent by default. A key's commutativity is a **constituent of the co-effect** (Def. 46), proved by the provider. Examples: a registration table with unique identifiers commutes (routes, listeners); an **ordered middleware chain does not commute**; an allocator whose handles are not observed commutes (POSIX: `open` returning the lowest free descriptor does NOT commute).
- Design consequence (end of §3.4): the commuting part is carried by the effects (free order); the order-sensitive part is carried by the co-effects (order imposed by LIFO intra-component and by dependency inter-component).

### 4.5 Fibers and inertial lifecycle (§4.1, §5.1.3)

- **Component** = triple `(d, p, e)`: dependency specification, declared provision, witnessed effect function (Def. 48). **Fiber** = instantiation: `⟨d,p,e,π,σ,τ,θ⟩` with parent π, own table σ, retirement flag τ, state θ ∈ {Inactive, Reloading, Active, Unloading} (Def. 49).
- **Committed view** ω: for each declared key, the name of the fiber that provided it at commit time. A fiber **reads the same bindings for as long as it is loaded, including during its own teardown** — this is what allows a component to unload cleanly while the dependency that triggered the teardown is itself on its way out (Th. 70, Algo. 6).
- **Inertia** (§4.4, Algo. 5): reload and unload are *inertial* — a transition once started runs to completion before responding to a new target change, with chaining: at the end of a reload, if the target changed → unload; at the end of an unload, if the target has become satisfied again → reload. At the iteration level, the guard tests the target **at each iteration boundary** → partial rollback *intra*-transition.
- **Unload scheduling**: `refresh` marks UNLOADING *before* creating the task (the fiber stops providing) → dependents recompute and go into teardown while the bindings are still there; `unload` **waits** for each notified dependent to reach INACTIVE before running its inverses. Termination comes from the fact that a fiber only waits on dependents that are already unsatisfiable (Th. 73) — the provider graph is traversed on demand, never analyzed globally.
- Re-enabling: a reactivated entry instantiates a **fresh fiber** — the entry is the identity that survives revisions, the fiber the identity of one activation (§5 intro).

### 4.6 System boundary (§6.1) — what is NOT reversible

- A location is **inside** if the system modifies it exclusively and can restore the previous state; **outside** otherwise (operation = idΓ, untracked, non-reversible).
- A **co-effect moves the boundary** by reifying an external location (all operations pass through the interface it provides, each with an inverse).
- **Acquisition vs emission**: open/malloc/fork install a record inside (reversible); write/send emit outside (irreversible). Recovery of an emission = *withholding* (the output commit problem) or application-level **compensation** (deleting the created file, refunding the payment) — composes in LIFO like the inverses, but the commutation theorems do not transfer to it as-is.
- **Service broker** (§6.2): for a multiplicity of providers, prefer a central broker (load balancing, rolling updates, cross-process RPC) over exclusive binding, which disturbs all consumers on every switchover.
- **Security** (§6.3): proxy access + `inject` declarations = capability-based access control (reviewable at load time); interception adds fine-grained policy hot. Sandboxing untrusted code requires an **external** sandbox.

---

## 5. Synthesis: what a minimal event-driven/async kernel + append-only log should retain

Recommendations directly actionable for the `cell` kernel, sorted by importance. Each point indicates where it comes from.

### 5.1 The kernel

1. **A single mutation gate.** Every modification of the shared environment goes through a single primitive of type `effect(install) -> disposer`. If an effect does not go through it, it is outside the guarantee — and that must be known (explicit boundary, paper §6.1). The kernel can be tiny *because* everything else is a plugin: Cordis fits in ~2000 lines. [V]
2. **Per-state inverses, returned at the point of application** (not a global `deactivate` fixed in advance). The accumulator composes in LIFO by construction (twisted composition). This eliminates VSCode's class of "incomplete cleanup" bugs and preserves the *locality of concern*: creation and destruction in the same place. [V — §3.1]
3. **Iterator/generator as the loading model**: a module's `apply` is a generator that yields disposers; the engine can thus interrupt at each iteration boundary (guard) and do a partial intra-transition rollback. Async-first: the paper explicitly notes the difference between eager (TS promises) and lazy (Python coroutines, Rust futures) — a Python port must spawn the tasks explicitly. [V — §3.1.3, §5.1.3 note 2]
4. **Declarative dependencies + reactive waiting, no boot order.** `inject` + activating/deactivating/neutral classification at each change. Identify a dependency by **the provider's identity (fresh uid, never reused)**, never by its value. [V — §3.2, §5.1.3]
5. **Inertial 5-state lifecycle + committed view.** PENDING/LOADING/ACTIVE/UNLOADING/DISPOSED (+FAILED); a transition runs to completion; at unload, mark out-of-service *before* scheduling the inverses and **wait for the dependents**; a module reads the same bindings throughout its teardown. [V — §4.4, §5.1.3]
6. **Typed events with a contractual dispatch mode.** At minimum: `emit` (observation), `serial`/`waterfall` (interception with `next()`), `parallel`. The mode is part of the event's public contract — this is what makes the extension points stable while everything else is replaceable. [V — primer]
7. **Context tree + isolation realms** for agent multi-tenancy (each agent/session = child context; per-key isolation for the presets; interception for hot policy without reload). [V — §3.2.3, §5.2.1]
8. **Declarative config reconciled** (entries id/url/config/disabled + group/include) rather than an imperative boot: confluence (Th. 80) guarantees that the final state depends only on the final config — a crucial property for a system that *modifies itself*. Transactional HMR with rollback on import failure. [V — §5.2]

### 5.2 The append-only log (modeled on dsh-session)

9. **The log is the only source of truth; everything else is a projection.** Conversational history, UI, replay, fork, resume, metrics: all derive from the same stream. Invariant: *"model-visible means logged"* — any input that reaches the model must be reconstructible from the log. [V — session.md]
10. **Minimal event schema**: `{type, seq (contiguous, monotone), time, data}`, discriminated union on `type`, JSON-lossless payloads validated at append, `ignorable` marker for extensibility (a reader refuses an unknown required type instead of dropping it). Base vocabulary: boundaries `turn/start|end`, `step/start|end`, messages `user|system|assistant`, `tool/call|result`, snapshots `request/header`, `end-seed` marker to distinguish inherited history from living history. [V — session.md]
11. **Extensibility by merging, not by editing**: plugins add their event types; consumers switch with fall-through (never `assertNever`). [V]
12. **Derived surface with append/replace operations** (for compaction: replacing an interval of nodes while citing the sources) and **replacement generation** to distinguish growth from rewriting. [V]
13. **Immutable generational persistence**: files `session.vN.jsonl[.zstd]`, never renamed nor overwritten; adjacent migrations one-step-at-a-time; exclusive publication of the successor. [V — architecture.md]
14. **Incremental projections as a mandatory seam**: each state consumer folds the committed events; no ad-hoc state cache diverging from the log. [V]

### 5.3 For agent emergence (the "everything mounts itself")

15. The path proven by dsh: the agent writes a plugin → **immutable version** (Package) → sandboxed activation **under approval** → in-memory run with read-only inspectors to reason before writing. Accepted limitation: volatile definitions (memory only). For `cell`, persisting self-written plugins is a **gap to fill** (dsh does not do it yet). [V — extensions]
16. The human↔agent interface as **one view among others over the log** (Chat and Trajectory are two projections of the same stream); human input enters through the same inbox as the context injections; questions/approvals are waterfall events scoped to the session. [V — web-client, conversation, architecture]

---

## 6. Appendix: inventory and reliability of the sources

### Primary (consulted directly)
- Repository: https://github.com/deepseek-ai/deepseek-harness (README, SAFETY.md, docs/architecture.md, docs/cordis-primer.md, docs/cordis-tutorial/02-lifecycle-and-effects.md, docs/subsystems/{session,extensions,web-client,conversation,web}.md, docs/session-format-status.md, docs/postmortem/, packages/extensions/README.md, packages/preset/agent-presets/README.md, full tree via the Git API)
- Paper: arXiv:2608.25512, local PDF `/Users/noe/projects/cell/paper.pdf` (92 pp., sections 1-6 read by targeted excerpts)
- Official site: https://deepseek-harness.github.io/deepseek-harness/

### Secondary (blogs/press — used for context, corroboration, limitations)
- Pandaily (launch, Composio benchmark of 8 harnesses): https://pandaily.com/deepseek-harness-developer-preview-everything-is-a-plugin-black-whale-aug2026
- MarkTechPost (4 modes, Cordis kernel, positioning): https://www.marktechpost.com/2026/08/17/deepseek-ai-releases-deepseek-harness-in-developer-preview/
- DataCamp (profiles vs presets, PTC, limits): https://www.datacamp.com/blog/what-is-deepseek-harness
- vgtimes: https://vgtimes.com/tech-and-hardware/164409-deepseek-launches-harness-an-open-source-ai-agent-environment.html
- atomicbot (figures, Node version): https://atomicbot.ai/blog/what-is-deepseek-harness
- everydev (feature list): https://www.everydev.ai/tools/deepseek-harness
- AgentHome (detailed modes): https://agenthome.info/en/tools/deepseek-harness/
- Juejin/CSDN (why Cordis vs InversifyJS/DI, vendor details): https://juejin.cn/post/7673436957741236239 , https://agent.csdn.net/6a82749a662f9a54cb9da8e7.html
- Starlog (stateful services gotchas, sibling contexts): https://starlog.is/articles/developer-tools/cordiverse-cordis
- FindHarness (3 plugin forms, HMR via fiber, paper debate): https://findharness.com/blog/cordis-framework-explained
- AgentAtlas (fiber fields, 5 dispatch modes): https://agentatlas.org/blog/cordis-explained-how-deepseek-harness-plugin-framework-works/
- Redreamality (v3 vs v4, cordis vs @deepseek-ai/cordis): https://redreamality.com/blog/cordis-spatiotemporal-composability-deepseek-harness/
- Floatboat (ctx.effect, lifecycle events): https://floatboat.ai/blog/cordis-plugin-framework
- Mishig/HF (undo & depend explainer): https://mishig-undo-and-depend.hf.space/
- CrackingWalnuts (adapter lifecycle): https://crackingwalnuts.com/post/deepseek-harness-cordis-spatiotemporal-composability
- dshub1024 (seams table, plugin path): https://www.dshub1024.com/en/blog/cordis-in-deepseek-harness
- pyshine (design decisions): https://pyshine.com/deepseek-harness-everything-is-a-plugin-agent-harness-cordis/

### Not found / not verified
- [?] Official upstream Cordis documentation (cordiverse) consulted directly — not fetched; the Cordis facts above are sourced from the paper and the vendored dsh docs (considered primary).
- [?] SitePoint details (`HarnessPlugin`, `agent.run()`, `harness` CLI) — inconsistent with the repository, judged invented.
- [?] Direct HN/Reddit discussions — no primary HN thread fetched; the "metatheory cosplay" debate is reported by FindHarness [S].
- [?] Source code of the packages (`packages/core/session/src/*`) read directly — no; the quoted declarations come from docs that declare themselves generated from the source with CI verification (`verify-cordis-catalog`).
