# Prior art — DeepSeek Harness and Cordis

DeepSeek Harness (`dsh`, github.com/deepseek-ai/deepseek-harness, MIT) is the closest
shipped prior art to this project's kernel: an agent harness built on the Cordis plugin
runtime, on an "everything is a plugin" architecture, with an append-only session log as
its single source of truth. It is in developer preview with announced compatibility-
breaking changes. This file records the *patterns*; snapshot coordinates (dates, line
counts, file lists, commit hashes, star counts) are deliberately absent.

## Session log

- The append-only log is the single source of truth; the model-visible message history is
  derived from it, never stored separately. Invariant: model-visible means logged —
  anything that reaches a model request is reconstructible from the log.
- Event envelope `{type, seq, time, data, ignorable?}` with a contiguous monotone `seq`.
  A reader that meets an unknown event type without `ignorable` refuses to reconstruct
  the session rather than silently skipping it; `ignorable: true` is the per-event
  extensibility opt-out.
- Compaction is a logged protocol: `compaction/start | summary | end`. Message-producing
  events carry a `SurfaceOp` — `'append'` or `{op: 'replace', startSeq, endSeq}` — so a
  summary replaces a cited interval of the visible surface while the original events stay
  in the log. Node 0 (the system prompt) may be rewritten only by a `system/message` over
  exactly that node.
- Persistence: JSONL generations compressed as checksummed Zstandard frames; writes go
  through a bounded write-behind batching window; torn-tail repair happens at the reader —
  a torn final frame contributes only its complete records, and the resuming reader
  appends synthetic closers.

## Human-in-the-loop and process control

- `ask_user_question` blocks the turn waiting for the human's answer by default; a
  timeout is never approval.
- Process shutdown: graceful disposal backed by a 5-second timeout; a repeated signal
  escalates to a forced exit.
- `maxConsecutiveWakes` caps consecutive automatic wake-ups per owner — the prior art
  this repo's kernel explicitly rejects (kernel.md: "No wake budget … rejected:
  observation over prevention").

## Tools and sandboxing

- Persistent bash: the shell's cwd, exported variables, functions and background jobs
  persist across tool calls; each agent gets an isolated shell. The minimal profile mounts
  exactly one persistent-shell stack.
- Sandbox backends are functionally probed and fail closed; among them an
  npm-distributed landlock-run launcher.
- Filesystem sandboxing denies with a structured error naming the mode; unfenced full
  access is a loud opt-out, never a silent fallback.

## Agent-defined plugins

- The agent can define, run, stop and undefine dynamic Cordis packages at runtime
  (`cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine`) and query approved
  runtime metadata read-only (`cordis_inspect`).
- A definition renders immutable *Packages* (versions); `run()` activates an exact
  version; activation is sandboxed, and an unauthorized activation waits for approval.
- The dynamic-package guard façade exposes a whitelist of lifecycle-safe context verbs
  and declared services; framework internals are denied.
- Definitions are process-local: they disappear when dsh restarts. dsh does not persist
  self-written plugins — the gap this project's persistent-modules design fills.

## Cordis and the composability paper

- Cordis (github.com/cordiverse/cordis, author Shigma) is the plugin runtime abstracted
  from the Koishi chatbot framework; dsh adopted and vendored it.
- "A Programming Paradigm for Spatiotemporal Composability" (arXiv:2608.25512; Shi and
  Zhang, Peking University; Cui, DeepSeek-AI) formalizes it. The paper's term is
  *revertible* effects: every context transformation carries an inverse held by the
  runtime; twisted composition yields LIFO recovery; the unified context is
  Γ∞ = μΓ. Γ × (Γ→Γ) × Σ; and confluence — the quiescent state is a function of the final
  configuration alone — lets the loader reconcile in any order.
- Security boundary (§6.3): language-level access control cannot contain untrusted code;
  sandboxing "requires an external sandbox".
- The paper covers component composition. It does not address direction, organizational
  emergence, or measurement.

## Postmortems

dsh keeps written incident postmortems in the public repo (e.g. `0001`, an ACP default
export dropping `agent.inject()`); cite github.com/deepseek-ai/deepseek-harness. The
pattern — a harness that journals its own failure modes — is the point.

## Relation to this project (current state)

Everything above describes DeepSeek Harness's design, not this project's. This repo keeps
the storage pattern — framed, append-only journals under `src/journal/` — but locates
truth in a frontier journal at the kernel-mediated HTTP boundary; the per-node stream is
a cold-start artifact that observers never read. dsh's session-event vocabulary
(`assistant/attempt`, `request/header`, `request/context`)
is not part of this project's vocabulary.
