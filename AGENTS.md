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
- `start --home <abs-dir> --model <id> --heading <text> [--uid node-0] [--no-sandbox]` —
  boot and run a node; Landlock confinement is the default, `--no-sandbox` is the explicit
  opt-out.
- `resume --home <abs-dir> [--uid node-0] [--no-sandbox]` — resume a parked node;
  `--model`/`--heading` are refused as unknown flags.
- `pause --home <abs-dir>` — deliver a stop to the host owning the home; no `--uid` (one host
  owns a home).
- `status --home <abs-dir> [--json]` — read-only report; a produced but degraded report
  exits `1`.
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
  unconfined by design; the only confined children are the shell and the Runs.
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

No push until every gate passes; there is no CI to catch a failure later.

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
