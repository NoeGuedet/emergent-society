# AGENTS.md — emergent-society

`emergent-society` is a research harness for observing the emergence of multi-agent LLM
societies: nodes communicate only by committing to a shared git world, and every
kernel-mediated HTTP exchange is durably recorded in an append-only frontier journal before
the effect happens. The toolchain is TypeScript compiled in strict mode (plus
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) with Vitest
as the test runner. Runtime dependencies are exactly two — `@lydell/node-pty` and
`canonicalize` — check `package.json` before adding any. Node `>=24 <25` (see `.nvmrc`); the
machine default shell may be older, always select 24 via nvm first.

## CLI (five commands plus help; `npm run build` then `npm start`)

- `init --home <abs-dir>` — create the cell home; prints the real `providers.json` path and a
  0600-mode hint, never writes the file.
- `start --home <abs-dir> --model <id> --heading <text> [--charter-file <abs-path>] [--uid node-0] [--no-sandbox]` —
  boot and run a node; Landlock confinement is the default, `--no-sandbox` is the explicit
  opt-out; `--charter-file` is the base of the composed charter on a start into a cell with no
  journaled configuration (its content is journaled as configuration; the kernel appends the
  node identity sentence).
- `resume --home <abs-dir> [--uid node-0] [--no-sandbox]` — resume a parked node;
  `--model`/`--heading`/`--charter-file` are refused as unknown flags.
- `pause --home <abs-dir>` — deliver a stop to the host owning the home; no `--uid` (one host
  owns a home).
- `status --home <abs-dir> [--json]` — read-only report; a produced but degraded report
  exits `1` (a folded frontier/world error, the degraded-world sidecar, or a running host
  that requested confinement but carries `fence=unavailable`). An explicit `--no-sandbox`
  opt-out (`sandbox=off`) and the normal production fact `storage=unquoted` (no quota is
  detected) do not degrade the exit.
- `help` — `--help`, `-h`, or empty argv; prints usage, exit `0`.

Parsing is strict (no positionals, no unknown flags; relative `--home` and bad `--uid` are
usage errors). Exit codes: `0` ok; `1` runtime failure; `2` usage/config refusal (including
"no running host" for `pause`, missing home for `status`); `3` pause delivered but the host
is still stopping.

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
- English only: code, commits, documentation, communication.
- One task at a time, sequential execution.
- Sub-agent delegation: long-running or independent work (research, implementation, audit)
  is delegated to sub-agents with a self-contained prompt; the delegating agent verifies the
  deliverable against the repo and the invariants, applies corrections, and iterates until
  the result passes before it is committed.
- `src/node/world.ts` is protected: never modify it without Lead approval.

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

No push until every gate passes; there is no CI to catch a failure later.

### Manual survival-core acceptance (per wave; not an npm script)

After the gates, `npm run build` leaves `dist/`, and these three compiled smokes are the
real-system acceptance for the refusal, fence and delegated-reap mechanisms:

1. `node scripts/w0-refusal-smoke.mjs` — C1: a refusal carrier and a surviving run.
2. `node scripts/w0-fence-smoke.mjs` — C2: the commit fence against a real cgroup tree.
3. `node scripts/w0-reap-smoke.mjs` — W0-a2: the delegated launch reaps the cell cgroup,
   and a pause through the wrapper stops the host.

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

## Documentation rule

Docs state the current state, minimally, in English: no date markers, no changelogs, no
delivery history — git history is the chronicle. A fact may be stated only if it is verified
against the code or carries a citation to a primary source. A doc changes in the same commit
as the code it describes. Progress and checkpoint status live in `ROADMAP.md` only — link,
never repeat. `docs/plans/` is gitignored working material: never publish it or link it from
tracked docs.
