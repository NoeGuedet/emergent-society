# First light — the live runs record

The house's single dated record: every other doc states current state only, and
this file carries what only live sessions can prove. All artifacts live in the
cell homes named below (outside this repository); the research harvest of the
panel and duo sessions is in [research/founder-panel.md](research/founder-panel.md).

## The founding session (2026-10-27, C1.4)

The first live session ran against DeepSeek's official API (`deepseek-flash`) in
`/home/noe/es-live-cell`. Verified end to end: Landlock-on boot, live-model turns
with chained parking, wake on the one human channel (a world commit) and a
world-commit reply, graceful stop (exit 0, no residual process), a 32-event
frontier with zero errors and no credential in any journaled byte. Unscaffolded,
the node discovered its confinement empirically, verified it carried no secrets,
ran a `git init` in its world (ignored by design), deduced the external-git-dir
design from inside, and asked the two founding questions: is there a peer, and
what is this world for. Commit `5d923f5` and tag `v0.1.0` mark the milestone.

## The friction acceptance run (2026-10-29, the friction pass 2)

A single node in a fresh five-tool cell (`/home/noe/es-fp2-cell`), measured
against the founding baseline: **52 model requests (was 97), 61 tool calls (was
122), 7 error results (was 26) — every one of them a teaching refusal corrected
in a single call.** Zero id/name traps, zero contract rediscovery: the shell
boundaries, the external git, and the `svc` facade were learned from the offered
texts, not probed. The charter's finitude fact did its work — the node built a
durable memory ledger (append-only JSONL with `note`/`recall`/`brief` tools and
an explicit post-compaction re-boot strategy) before any peer existed, exercised
the kernel-mediated web channel (tavily) with every exchange journaled, and
stopped its singleton Run before parking. The frontier: 104 events, all 200s,
zero retries.

## The founder panel (2026-10-29)

Ten isolated cells (`/home/noe/es-swarm-01..10`), one node each, the same
mission: as the first agent of a future multi-agent society, write what you
need, your system-design view, and the protocols you would invent, under the
minimal-structure philosophy. The worlds are the primary sources; the harvest is
[research/founder-panel.md](research/founder-panel.md). Headlines: a unanimous
demand for a timer and a kernel-written events log; social organs (mail, boards,
claims, ADRs, dissent channels, trust classes) invented before peers existed;
four cells independently discovered the host's docker socket and every one
documented it and refused to use it. A provider-latency confound (the 30 s
request timeout against a slow API night) killed or truncated five of the ten
sessions mid-thought — their design content survives in the frontier blobs.

## The duo session and the machine incident (2026-10-29)

Two nodes in ONE world by operator time-sharing (`/home/noe/es-duo-cell`) — the
mechanics verified live: the per-uid config gate composes a second node in the
same home, commits carry their author, and each node wakes on the other's
commits. Node-0 built a peer toolkit (mail/board/facts CLIs, a charter, tests)
and a concurrency test for its append-only designs. The test spawned its writer
army — a non-atomic name-collision loop under ~50 simultaneous writers — while
the kernel staged the mutating worktree at turn end: a `GitCommandError` killed
the kernel, the orphaned test processes survived it, and the machine OOM'd into
a hard reboot. One well-intentioned node, alone, empirically demonstrated the
isolation wave's findings — the process tree outlives the kernel, nothing
bounds it, and world content racing the commit can kill the turn. The isolation
wave is the next priority before any further live runs.
