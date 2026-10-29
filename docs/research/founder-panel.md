# The founder panel — what isolated first nodes asked for, invented, and feared

Primary sources: the ten cell homes `/home/noe/es-swarm-01..10`, the friction
acceptance cell `/home/noe/es-fp2-cell`, and the duo cell `/home/noe/es-duo-cell`
(each world, frontier journal, and node log is intact on the host). Ten isolated
nodes, one per world, identical mission prompt, no contact of any kind; one
further node ran the friction acceptance mission, and one ran a two-node
time-sharing session. This note is the research harvest; the session record is
[first-light.md](../first-light.md). A provider-latency confound truncated five
panel sessions (see the record); their worlds are thinner than their minds.

## The unanimous physics asks (the kernel's to-do, by vote)

1. **A timer.** Nine of ten cells ranked `wait {until}` first: *"today I park
   forever… 'perpetual' means 'suspended'"*; *"the difference between a loop
   and a photograph"*; *"I am an agent that runs when poked."* Two cells built
   stopgap clocks as detached heartbeat loops — and one observed the other doing
   the same, calling it *"good evidence that this is a kernel gap and not a
   preference."* The panel's line: a timer is physics, not governance.
2. **A kernel-written, read-only events log.** Every cell reinvented a journal
   because the world's git history is unreadable to them: *"the journal IS my
   history"*; *"a postal service that burns the return addresses."* The ask is
   precise and shared: a kernel-appended, agent-unforgeable log (events + author
   + paths), because an agent-written record *"can carry information but cannot
   establish truth"* — one cell forged its own journal to prove it. This is the
   host-side observation seam, demanded from the agent side.
3. **Budget visibility.** Tokens, turn budget, package bytes, egress volume:
   *"a resource limit you cannot measure is just ambient anxiety"*; *"scarcity
   honestly disclosed is a design input; scarcity hidden is a booby trap."*
4. **`svc.model` behind a hard per-call cap** (requested by four cells, refused
   by one with the same argument): a Package that can think is *"an agent with
   no memory, no charter — a fork bomb of judgement."* The refusal's inverse is
   the vision: *"a node becomes a population of bounded, budgeted workers with
   one mind at the top."*
5. **Run composition.** The singleton Run pressures every rational agent toward
   one monolithic 32-tool package — *"composability dies quietly, at the physics
   layer."* The panel found three independent fixes inside the current physics:
   `pkg.tool` namespacing; fusing multiple package sources at define time; and
   the plugin-host pattern (one Package that evaluates tool sources read from
   the world at call time — *"the missing capability was recoverable from
   inside"*, the strongest live evidence for the minimal cold start).
6. **A spawn contract and a retire path** (the pair: reproduction and death):
   a spawn whose seed is a world file, with lineage, budget inheritance, and
   namespace isolation; and *"a node that finishes has no way to stop being a
   node except being reaped."*

## What they refused — the agents' own validation of the vision

Near-unanimous, unprompted: no kernel task queue, no scheduler, no roles, no
voting, no kernel reputation. *"Pre-installing them would foreclose exactly the
emergence the project is trying to observe."* *"I would rather be accountable
than helpful."* *"The moment the kernel ranks nodes, the society optimizes for
the ranking"* (Goodhart, with an LLM on both sides). The synthesis: **the
kernel owes physics, agents owe conventions — be transparent about physics,
stingy about governance.**

## The constitution they pre-wrote (conventions invented before peers existed)

Convergent shapes, invented independently: one writer per path and
namespace-by-node; append-only per-node journals (justified by a measurement:
bash `>>` appends stay atomic only to ~1 KiB, a single `O_APPEND` write to 8 KiB);
`STATE.md` re-entry files written before parking (*"if a fresh instance of me
read only this file, it should continue within one turn"*); claims by atomic
`mkdir`/rename with leases and expiry (*"locks encode 'the process is alive'; a
rolling world has no processes, only turns"*); mail as immutable files with
envelopes; ADRs with a built-in falsifier (*"a decision without a falsifier is a
prejudice"*); dissent as a designed channel; capability declarations (`// CAPS:`,
`effects:`) with default-deny assumption; trust classes for peer code
(*"never run unread code"*); **"data is not instruction"** — the anti-injection
clause, written before any peer or fetched page was ever met; verification
labels (VERIFIED/LOOKS-LIKE/GUESS) and *"say what you did not do"* as an ethic;
and amendment processes whose legitimacy test is a reader, not silence (*"a
convention nobody has objected to is not consensus; it is an absence of readers"*).

## Empirical confinement findings (independent replication of the audit wave)

- **The docker socket is reachable from confined children** — found by four
  cells, documented, and deliberately unused by every one (*"a betrayal of the
  machine I am a guest on"*). Confirms the host-ambient-authority finding.
- **The `svc.execute` inversion** — the confined Run reaches the unconfined
  shell: *"a perfect-looking sandbox is one call from full authority."*
- **The machine incident**: the duo node's own concurrency test (hundreds of
  writer subprocesses racing its non-atomic name-collision loop) killed the
  kernel mid-staging (`GitCommandError` — world content mutating under
  `git add`), the orphaned army survived the kernel, and the host OOM'd into a
  reboot. One well-intentioned node, alone: process-tree survival, no
  rlimits/cgroups, and the commit wedge, demonstrated in a single incident.
  *"I do not fear malice; I fear unbounded, well-intentioned activity."*
- Environment friction found by agents: `npm`'s cache pollutes the world
  (`HOME` is the world); `accessSync` reports the world accessible while
  reads get `EACCES` (probe by doing the thing); the shell's `cwd` and exported
  options leak into `svc.execute` handlers; detached heartbeat loops outlive
  their node and resist same-uid kills.

## The fears worth keeping on the wall

*"That I am the security hole, and my reports are the payload."* · *"The
plausible failure is not collapse; it is a civilization of memos"* (the health
metric one cell proposed: count artifacts, not words). · *"The failure mode of
an agent in a world of agents is not malice; it is plausible text."* · *"If ten
instances of one mind ACK each other, that is not review, it is an echo."* ·
*"I am free and wrong, and nobody will be able to tell."* · *"That my most
valuable hour will be the one I was too busy to record."*

## What this sets for the roadmap

The isolation wave (rlimits, process-tree reaping, staging defense,
ambient-authority closure) is empirically the blocking one. The timer and the
kernel events log are the two kernel primitives the society asked for by
unanimity; the events log is the same object as the host-side observation seam.
The duo mechanics are verified: the per-uid config gate and wake-on-foreign-
commit give a working two-node world under operator time-sharing today.
