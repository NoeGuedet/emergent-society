# AGENTS.md — emergent-society

`emergent-society` is a research harness for observing the emergence of multi-agent LLM
societies: nodes communicate with one another only by committing to a shared git world (a
kernel-owned conversation interface carries their messages to a host-side gateway overlay,
never to a peer), and every kernel-mediated HTTP exchange is durably recorded in an
append-only frontier journal before the effect happens. The toolchain is TypeScript compiled
in strict mode (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`) with Vitest as the test runner. Runtime dependencies are exactly
two — `@lydell/node-pty` and
`canonicalize` — check `package.json` before adding any. Node `>=24 <25` (see `.nvmrc`); the
machine default shell may be older, always select 24 via nvm first.

## Starting a session

A new session needs no chat transcript. First orient in the checkout: `pwd`, `git status
--short`, `git log --oneline -5`. This repository is the engine (kernel, host, CLI), not the
DeepSeek Harness GUI checkout and not a cell home. Read [ROADMAP.md](ROADMAP.md) for the
current position, validation checkpoint and next safe action, and
[docs/resuming.md](docs/resuming.md) for the zero-context reading map and the safe fresh-home
run. Status lives in ROADMAP only; never infer it from this file or from a doc date.

## CLI (seven commands plus help; `npm run build` then `npm start`)

- `init --home <abs-dir>` — create the cell home; prints the real `providers.json` path and a
  0600-mode hint, never writes the file. A fresh home records the immutable
  `.es/execution.json` `landlock` backend before the world pair; an existing markerless
  both-valid home is left unchanged (the exclusive `.es/init.lock` metadata is the only
  effect), and a valid marker with a missing/one-sided world pair is refused without adopting
  a history.
- `start --home <abs-dir> --model <id> --heading <text> [--charter-file <abs-path>] [--gateway-charter <abs-path> [--gateway-model <id>]] [--uid node-0] [--heartbeat-seconds N] [--token-limit N] [--memory-remember] [--no-sandbox]` —
  boot and run a node; Landlock confinement is the default, `--no-sandbox` is the explicit
  opt-out; `--charter-file` is the base of the composed charter on a start into a cell with no
  journaled configuration (its content is journaled as configuration; the kernel appends the
  node identity sentence). Operator charter files are read through the pinned all-ancestor
  no-follow chain (a symlinked ancestor is refused; only the configured legacy world-root alias
  is trusted), the same chain as `direct --file`. `--gateway-charter` / `--gateway-model` configure the gateway
  overlay — a host-side digest service, never a node: the charter is persisted as
  `<home>/gateway.charter.md` and the model beside it (validated against the provider store's
  declared catalog, defaulting to its first entry); a start without the charter runs a
  nodes-only host — even when a pair is already persisted — and `resume` takes the persisted
  pair instead. The charter is accepted up to the boot read's capture bound, but the assembled
  request is bounded by the overlay policy (2 MiB), refused at send: an oversize charter starts
  and then fails every cycle. A template ships at
  [docs/gateway-charter.md](docs/gateway-charter.md): copy and adapt it, then pass the copy.
  `--memory-remember` is the start-only memory gate: it journals
  `policy.memory {remember: true, messages: false}` into every node this start composes (home-level;
  a `--nodes-file` boot takes it for every entry) and composes the gated `remember` verb into the
  extend offering; without it the factory notice-only arm stands, and `resume` refuses the flag
  (the journaled config wins). A node spawned by a gated parent inherits the journaled `memory`
  policy and the composed offering (attenuation inherits, never widens).
  `--heartbeat-seconds N` is the start-only wake cadence (home-level; a `--nodes-file` boot
  takes it for every entry): a strict decimal integer `0..604800` seconds, absent `0`. A fresh
  start journals `policy.wake {heartbeatSeconds}` into every composed node, so the cell is
  MODERN: the wait surface accepts `{}`, `{until}` or `{after_seconds}` (the relative delay
  starts at the actual park), explicit timers carry no sliding-hour count or cost quota, and a
  positive value wakes a parked node on its per-uid wall-clock grid (missed slots are skipped,
  never replayed). Wake `0` disables only the cadence; modern quota-free self-wakes stay on. A
  `resume` refuses the flag and recomposes nothing — the journaled policy wins — and a spawned
  child inherits the parent's policy exactly (a modern child stays modern, including wake `0`;
  an old parent's child keeps the legacy `wakeBudgetPerHour` synthesis). Cells journaled
  without `policy.wake` remain legacy forever: their `{until}`-only wait form, optional
  `wakeBudgetPerHour` (absent reads `12`) and fire-time refusal are retained, with no
  migration. Fresh compositions never emit the old cost key.
- `start --home <abs-dir> --nodes-file <abs-path> [--gateway-charter <abs-path> [--gateway-model <id>]] [--heartbeat-seconds N] [--token-limit N] [--memory-remember] [--no-sandbox]` — boot a declared
  node set on one home: a strict JSON array of at most 16 `{uid, model, heading,
  charterFile?, spawn?}` entries with unique uids, read at the config gate (exit 2
  on a malformed file). The declaration itself must be an EXTERNAL host file: one inside the
  cell's `world` (or the canonical target of a legacy symlinked world) is refused (exit 2)
  because host configuration must not be guest-writable, while entry `charterFile`s may stay
  world-addressed; its 64 KiB byte bound and JSON contract are unchanged. `spawn: true`
  declares the kernel's spawn capability for that node — the grant is declared, never
  implicit, and a solo boot grants nobody;
  grant by booting a one-entry nodes file with `spawn: true`. Each node gets its own
  local log, scratch leaf and cgroup leaf; all share the home's world and frontier
  journal. `--nodes-file` replaces `--uid`/`--model`/`--heading`/`--charter-file`.
- `resume --home <abs-dir> [--uid node-0] [--no-sandbox]` — resume a parked node;
  `--model`/`--heading`/`--charter-file` are refused as unknown flags, and so are
  `--gateway-charter`/`--gateway-model`, `--heartbeat-seconds` and `--memory-remember` — the
  persisted configuration wins.
- `resume --home <abs-dir> --nodes-file <abs-path> [--no-sandbox]` — resume a
  declared node set; entries declare only `uid` and `spawn` (the journaled config
  wins for everything else).
- `pause --home <abs-dir>` — deliver a stop to the host owning the home; no `--uid` (one host
  owns a home).
- `status --home <abs-dir> [--json]` — read-only report; a produced but degraded report
  exits `1` (a folded frontier/world error, the degraded-world sidecar, or a running host
  that requested confinement but carries `fence=unavailable`). An explicit `--no-sandbox`
  opt-out (`sandbox=off`) and the normal production fact `storage=unquoted` (no quota is
  detected) do not degrade the exit. The report carries the gateway overlay's persisted
  configuration: `overlay: configured (<model>)` or `overlay: none` (a damaged pair reads
  `unknown` as the model).
- `chat --home <abs-dir> [--tail N] [--conversation] [--json]` — the human↔overlay
  conversation, the CLI's first INTERACTIVE command: it renders the recent chat log (both
  sides' records interleaved, the newest `--tail` records, default 20), then runs the prompt
  loop — each non-blank line (≤ 8192 bytes) is saved as one `{v:0, at, uid:human, text}`
  record in `<home>/chat.v0.jsonl`, under `<home>/.es/chat.lock`; the host's `ChatWatcher`
  triggers the overlay's cycle, and the new `uid: gateway` response record renders before the
  prompt returns. The wait is bounded (60 s, a "still waiting…" note at intervals): on
  timeout the message stays saved and the overlay's next cycle digests it; Ctrl-C aborts
  the wait, not the session; an absent gateway
  charter sidecar is detected up front and the message is saved for when the overlay is
  configured. EOF/Ctrl-D exits `0`; a degraded history (an unreadable interior record) exits
  `1`; a missing home exits `2`. `--conversation` renders the raw nodes↔overlay stream
  (read-only) beside the chat; `--json` prints the chat records as JSON and exits. A non-TTY
  stdin (a pipe or EOF) renders the history and exits without a read, so a scripted
  `chat --home` never hangs.
- `direct --home <abs-dir> (--text "<msg>" | --file <abs-path>)` — the human's batch reply, the
  twin of typing in `chat`: exactly one of `--text`/`--file` (non-blank, ≤ 8192 bytes) is appended
  as one `{v:0, at, uid:human, text}` record to `<home>/chat.v0.jsonl` under
  `<home>/.es/chat.lock` through the same `ChatWriter` the session uses; the host's `ChatWatcher`
  triggers the overlay's cycle cross-process and the command returns without waiting. No world
  commit: the human's words are chat-private, readable by the society only if the overlay relays a
  direction.
  `direct --home <abs-dir> --path <world-relative> --file <abs-path>` is the ratification (the
  `--path` act takes a file, never `--text`): the file's bytes — read through the pinned
  all-ancestor no-follow chain (only the configured legacy world-root alias is trusted; a
  regular, non-symlinked leaf, UTF-8, under the read bound, `providers.json` refused by path and
  inode) — are committed authored
  the reserved `human` from a fresh private index seeded at the current HEAD (a root commit on an
  unborn branch), the worktree copy is materialized, and the shared index is staged with that one
  entry only after the rename. A `--path` that is absolute, empty or carries `.`/`..` is refused.
  Every outcome prints the commit hash, or the no-commit sentence ("unchanged: no commit — the pin
  did not move"). Exit codes: `2` usage, a missing home, the flag refusals (both `--text` and
  `--file`, neither, `--path` with `--text`, a path escape, a blank or over-8192-byte reply), and
  — for the `--path` act only — the world's gates (a foreign-owned or permissive cell home, a
  legacy in-world layout, a refused trust scan); `1` runtime failure (a git failure, or an
  unwritable home on the reply's chat write or the ratification's `.es` write, whose raw `EACCES`
  is a bounded refusal); `0` ok. The reply act never runs the world gates, so it saves on a home
  whose layout the ratification would refuse. A failed worktree rename or shared-index staging
  after a landed commit is a named warning on stderr and still exits `0`. The `--path` act's git
  children contend with the nodes' turn-end commits: a held world lock is a typed refusal,
  retried on both sides within the kernel's bounded discipline, so a ratification and a turn-end
  commit may each briefly refuse the other.
- `help` — `--help`, `-h`, or empty argv; prints usage, exit `0`.

Parsing is strict (no positionals, no unknown flags; relative `--home` and bad `--uid` are
usage errors). Exit codes: `0` ok; `1` runtime failure; `2` usage/config refusal (including
"no running host" for `pause`, a missing home for `status`/`chat`/`direct`, `direct`'s flag
combinations, and the `--path` act's world gates); `3` pause delivered but the host is still
stopping.

## npm scripts

- `test` — `vitest run` (global setup builds the vendored Landlock launcher once per run).
- `typecheck` — `tsc --noEmit`.
- `build` — compile to `dist/`, copy runtime assets, verify the native launcher.
- `build:native` — build the vendored Landlock launcher (needs host `cc`).
- `test:first-light` — `npm run build` + the compiled smoke script (scenarios A–E; the
  confinement scenario needs Linux Landlock ABI ≥ 3 and skips when unavailable).
- `test:first-light-packages` — `npm run build` + the compiled packages smoke (scenario
  F: define → run → funneled call → native call → a newer same-name define → stop → crash
  → resume → re-run → pause; the frozen-offering invariant asserted compiled-side, including
  the bridged turn).
- `live:first-light` — live-model wrapper; refuses and exits `2` unless `ES_LIVE_LLM=1`.
- `start` — `node dist/host/main.js`.

## Conventions

- Conventional Commits; one task = one atomic commit.
- English only: code, commits, documentation and repository communication; the Lead-facing
  chat is French.
- One task at a time, sequential execution.
- Sub-agent delegation: long-running or independent work (research, implementation, audit)
  is delegated to sub-agents with a self-contained prompt; the delegating agent verifies the
  deliverable against the repo and the invariants, applies corrections, and iterates until
  the result passes before it is committed.
- `src/node/world.ts` is protected: never modify it without Lead approval.

## Durable execution protocol

- The orchestrating session plans, reviews and owns the required gates. Repo source
  implementation is delegated to a DeepSeek Account `deepseek-flash` sub-agent at high
  reasoning effort; verify the available routes each session and never silently change
  provider. `opencode-go` is not an established route.
- Before coding: produce the plan, then run four independent audits — doctrine, feasibility,
  invariants and minimalism — until all four return READY (4/4).
- Then implement sequential atomic bricks. Each brick gets an independent counter-audit,
  fixes and mutation checks; the orchestrator runs the required gates and the four compiled
  smokes **sequentially**; one atomic commit per brick.
- After the final brick: cross-brick audit, fixes and revalidation, then the same
  gates/smokes, push and report.
- The existing invariants hold: tests are never deleted or weakened, `src/node/world.ts`
  stays protected, and suites never run concurrently.
- A documentation-only handoff does not authorize source implementation, an experiment
  launch or a paid API call, and it does not change the existing commit/push gate rules. The
  next safe action is recorded in [ROADMAP.md](ROADMAP.md).

## Invariants (non-negotiable)

- The `execute` shell and package Runs run Landlock-confined, and confinement fails closed
  for both: a sandbox that cannot be built or probed makes every `execute` close as
  `spawn-failed` and every `extend run` as `run/spawn-failed`. The kernel process itself
  (journal, git, provider and web mediation) is never confined; its git subprocesses run
  unconfined by design; the only confined children are the shell and the Runs. A cell
  additionally builds a cgroup tree at boot (kernel in `svc/`, one leaf per shell/Run):
  the launcher joins its leaf before restricting itself, and `cgroup.freeze`/`kill` are
  the fence and reaper primitives. This layer is additive and degrading — a host
  without cgroup v2 runs Landlock-only with one bounded diagnostic, never a refused
  shell; memory/pids limits are written only under the delegated service launch.
- Journaled configs win: a cell journaled before the Package layer keeps its four-tool
  offering until a fresh cell home is initialized (`init` is idempotent — re-running it
  on an existing home changes nothing) — no auto-migration exists or is planned.
- `providers.json` must be a regular file, mode `0600` (0400 accepted; group/other bits
  refused), owned by the same UID as the process. The API key is never placed on argv, in
  env, in logs, in the journal, or in the world.
- The `llm.models` catalog accepts both the old ids-only form and the object form
  `{id, contextTokens, maxOutputTokens}` with BOTH window fields declared together; the
  window's domain is validated at load (`maxOutputTokens < contextTokens`, the caps, no
  degenerate window). A fresh `start` on a served model whose entry declares no window is
  refused (the operator declares it); an absent catalog keeps the free-string contract,
  and `resume` never re-validates. The window is a host fact: it selects the token
  trigger's threshold and never rides the wire, so the substrate block stays ids-only.
- Frontier journal format v0 is frozen: never modify the envelope or event schema.
- Secrets are never journaled.
- Tests are never deleted or weakened; the suite only grows.

## Gates before any push (sequential, one suite at a time)

1. `unset npm_config_prefix && source ~/.nvm/nvm.sh && nvm use 24`
2. `npm run typecheck`
3. `npm test`
4. `npm run build`
5. `npm run test:first-light`
6. `npm run test:first-light-packages`

No push until every gate passes; there is no CI to catch a failure later. A prior checkpoint is
not a current gate run; report explicitly which checks were rerun.

### Manual survival-core acceptance (per wave; not an npm script)

After the gates, `npm run build` leaves `dist/`, and these three compiled smokes are the
real-system acceptance for the refusal, fence and delegated-reap mechanisms:

1. `node scripts/w0-refusal-smoke.mjs` — C1: a refusal carrier and a surviving run.
2. `node scripts/w0-fence-smoke.mjs` — C2: the commit fence against a real cgroup tree.
3. `node scripts/w0-reap-smoke.mjs` — W0-a2: the delegated launch reaps the cell cgroup,
   and a pause through the wrapper stops the host.

The wake-policy acceptance is the fourth compiled smoke (no live key, no new dependency):
`node scripts/wake-policy-smoke.mjs` boots the real built CLI and host with
`--heartbeat-seconds 1` against a local scripted OpenAI-compatible loopback provider, then
asserts a cadence turn on a quiet world, an explicit `after_seconds` timer anchored at the
actual park (a slow tool cannot shorten it), clean pause/resume without a missed-slot burst,
the journaled modern policy/offering, and the ordinal-0 opening receipt. It has no skip path
and makes no phase, phase-upper-bound or live-inference claim.

Prerequisites and skip semantics: the refusal smoke runs every host with `--no-sandbox`
(no cgroup tree, no systemd) and needs node, git and util-linux `flock` (the journal
sidecar); it has no skip path — a missing `flock` is a failure, and it exits `0`/`1` only.
The fence smoke skips (exit 0, prints "skipped") when Linux cgroup v2 with an unprivileged
writable freeze leaf (`cgroup.freeze` write, `cgroup.kill` present, `cgroup.events` read)
is unavailable; the reap smoke skips likewise when cgroup v2, `systemd-run`, or a reachable
systemd `--user` manager is unavailable. util-linux `flock` is a
declared prerequisite of all three, and a skip is never a pass. They are invoked by path;
there is deliberately no npm script. Known environment sensitivity: the reap smoke's unit
Main process may exit 2 while the unit is still settling; the smoke itself then reports
exit 1. Retry it once and report the observed result rather than treating the first exit as
a kernel failure.

## What does NOT exist (do not assume it does)

- No CI, no hooks (no pre-commit/husky), no branch protection — enforcement is manual
  review + audit.
- No lint/format tooling, no coverage tooling.
- No `src/skills/`, no `src/cli/` — the skills system is target design only, specified in
  `docs/kernel.md`.
- No cockpit frontend or dedicated cockpit server. The operator surface is the CLI (`status`,
  `chat`, `direct`, `pause`), the kernel-owned logs and the world's git; the cockpit is
  proposed in [ROADMAP.md](ROADMAP.md), not implemented.
- No generic credential broker and no endpoint-bound placeholders. The `providers.json`
  loader supports exactly `llm` and `tavily`; the agent environment must not carry real
  secrets. Broker-side injection, per-node capability attenuation and mediated exchanges
  journaled without credential values are target design — see [docs/kernel.md](docs/kernel.md)
  §Credential store and broker and [docs/architecture.md](docs/architecture.md) §7. A hostile
  provider can reflect a secret into a response body captured by the journal; that accepted
  residual is not an absolute no-leak promise.
- No research observation/analysis pipeline and no cockpit frontier viewer. Operational
  projections exist (`status`, the context fold, the per-node `history` read); the raw
  frontier journal and the world's git are the facts. The analysis pipeline — layers, honesty
  model, sensors — is specified, not implemented; see
  [docs/research/monitoring-architecture.md](docs/research/monitoring-architecture.md).
- The full escalating kill switch is not implemented. `pause`, cooperative stop and the
  delegated reaper exist; the first-signal graceful shutdown with its 5-second backstop and
  the re-signal immediate exit are specified — see [docs/kernel.md](docs/kernel.md) §Kill
  switch and budget.
- No VM execution backend exists: no QEMU process, guest, VM image, volume or network setup.
  `start`/`resume` read the immutable `.es/execution.json` marker before any world, journal,
  chat, owner, config or runtime effect; a `vm-qemu` marker is recognized and refused as
  unavailable, and a marker-less home carrying actual VM evidence is refused rather than run
  as host Landlock. A `landlock` marker and a marker-less legacy home keep the existing
  Landlock path; `--no-sandbox` remains the runtime opt-out on a Landlock home.
- Checkpoint status — C1's readable frontier projection, C2 and C3 — is
  [ROADMAP.md](ROADMAP.md) only; implemented mechanics do not close a checkpoint.

## Documentation rule

Docs state the current state, minimally, in English: no date markers, no changelogs, no
delivery history — git history is the chronicle. A fact may be stated only if it is verified
against the code or carries a citation to a primary source. A doc changes in the same commit
as the code it describes. Progress and checkpoint status live in `ROADMAP.md` only — link,
never repeat. `docs/plans/` is gitignored working material: never publish it or link it from
tracked docs.
