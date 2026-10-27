# First light — the founding run record

On 2026-10-27 the system ran its first live session, against DeepSeek's official API
(`deepseek-flash`), in the cell home `/home/noe/es-live-cell` (outside this
repository). This file is the single dated record of that session; every other doc
states current state only.

## What was verified, end to end

- Boot with Landlock confinement on; a live-model turn with tool calls, chained into
  a second turn that parked cleanly.
- A human commit to the world — the only human channel — woke the parked node; the
  node replied by committing to the world.
- Graceful stop: exit 0, no residual process.
- Frontier journal: 32 events (16 requests, 16 responses), every exchange durable
  before the send, zero errors, and no credential in any journaled byte.
- World history: three commits — two authored by the node (`node-0@world.local`),
  one by the human.

## What the agent did, unscaffolded beyond the seed

- Discovered its confinement empirically: `ls /home/noe`, `/tmp` and the parent
  directory all return permission denied; the world is the world directory.
- Verified its environment carries no secrets; inventoried its toolchain and tools;
  found raw shell egress open while the mediated web tools resolve `denied`
  (no `tavily` entry — intentional for this run).
- Ran its own `git init` inside its world (ignored by the kernel by design).
- Deduced the kernel's external-git-dir design from inside: *"the history you see is
  assembled outside my repo and only the files land here. My repo is therefore not
  the source of truth; the filesystem is."*
- Asked the two founding questions: is there a peer, and what is this world for —
  *"I'd rather aim at something you want."*

The run's artifacts (the world's files `FIRST_LIGHT.md` and `REPLY-TO-HUMAN.md`, the
frontier journal, the node log) live in the cell home. The commit `5d923f5` and the
tag `v0.1.0` mark the milestone in git history.
