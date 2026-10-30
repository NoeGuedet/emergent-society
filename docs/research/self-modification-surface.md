# Self-modification surface — what a node can and cannot recode about itself

A verified capability audit of the current code: every claim is cited to `src/` (plus
`native/es-landlock/es-landlock.c`) as `file:line`. The matrix in §0 is the short answer; §1-5
carry the evidence; §6 lists the gray zones that need an explicit decision. The one behavioral
claim derived from documented Linux semantics rather than execution is daemon survival
(fork-cleared `PR_SET_PDEATHSIG`, irreversible inherited Landlock, unmediated `prctl`); the
`.gitignore` finding was verified by execution in a throwaway repository.

---

## 0. Capability matrix (summary)

| Aspect of "self" | Node capability | Verdict | Evidence |
|---|---|---|---|
| Charter text (rewrite / append) | none | **impossible** | `src/host/host.ts:431-456`; `src/context/assembler.ts:110`; `src/node/loop.ts:346-349`; `src/node/tools/extend.ts:322-329` |
| Charter re-compose | none; `start` refuses a journaled cell, `resume` refuses the flags | **impossible** | `src/host/host.ts:440-442,458-463`; `src/host/layout.ts:204-228` |
| Model / provider | none | **impossible** (sent as a wire field, not readable text) | `src/host/host.ts:108-113,458-459`; `src/context/contracts.ts:113`; `src/provider/wire.ts:86` |
| uid | none | **impossible** | `src/host/options.ts:110-119`; `src/journal/layout.ts:37,45-50`; `src/node/driver.ts:196,716`; `src/node/loop.ts:174,484-488` |
| Step budget / turn shape | none | **impossible** | `src/node/loop.ts:507`; `src/context/contracts.ts:96-108` |
| Command timeouts, capture and result caps | none | **impossible** | `src/node/tools/dispatch.ts:538-542`; `src/node/loop.ts:424-428` |
| Advertised tool offering | none (frozen); live package tools are callable via the bridge | **impossible** (offering) / **possible** (callable capability) | `src/context/assembler.ts:56,105`; `src/node/packages/registry.ts:11-16`; `src/node/tools/extend.ts:30-33`; `src/node/tools/dispatch.ts:473-484` |
| Stored Package definitions | define / run / stop / undefine, all journaled | **possible** | `src/node/packages/store.ts:316-345,464-473`; `src/node/tools/extend.ts:343-412,461-574`; `src/context/events.ts:47-53` |
| Arbitrary journal facts | none (only the four verb facts + `tool/result` via the kernel) | **impossible** | `src/node/gate.ts:57-64,175-191`; `src/node/tools/extend.ts:322-329`; `src/node/tools/dispatch.ts:528-531,538-542` |
| Sandbox mode (confined / off) | none | **impossible** | `src/host/host.ts:126-155`; `src/node/loop.ts:407-421`; `src/host/options.ts:142` |
| World files (shared) | write / rewrite / delete anything under `world/` | **possible** | `src/node/tools/sandbox.ts:284`; `native/es-landlock/es-landlock.c:98,182-200` |
| Private scratch | read/write `<home>/tmp/<uid>` | **possible** | `src/node/tools/sandbox.ts:285,335` |
| Own config / journal (read) | none beyond the prompt and tool text | **read-only (structural)** | `src/host/host.ts:311-332,433`; `src/journal/layout.ts:84-100`; `src/provider/wire.ts:79-89` |
| Another node's config (read) | none | **impossible** | `src/node/tools/sandbox.ts:284-311`; `src/node/driver.ts:839,852` |

---

## 1. SELF — what a node can change about itself

### 1.1 Charter: rewrite, append, re-compose — all impossible

The composed charter is produced once, at the `start` gate, as `base + " You are <uid>."`:

- `src/host/host.ts:448-456` — `const base = charterFile !== undefined ? await readCharterFile(...) : defaultAgentConfig().charter;` then `charter: \`${base} You are ${uid}.\``. The exact composition is at **host.ts:455**.
- The base default is **`src/context/config.ts:18-21`**; the operator file is validated at **host.ts:351-415** (regular file, ≤ 8192 bytes at **host.ts:335**, fatal UTF-8, non-empty).
- The value is validated by **`src/context/config.ts:181-215`** and journaled as a `system/message` fact.

That journaled value is the only charter that can ever be in force:

- **`src/node/loop.ts:346-349`** — the initial config is written **only when the fold has none** (`if (this.fold.snapshot().config === null)`).
- **`src/context/assembler.ts:110`** — each request's `charter` is read from the folded config (`charter: config.value.charter`), and sent as the first system message (`src/provider/wire.ts:80`).
- The driver replays the journal into the fold on every boot (`src/node/driver.ts:838-861`), so a restart reproduces the same charter.

There is exactly one in-process API that can schedule a new config, and nothing in production calls it:

- **`src/node/loop.ts:305-310`** — `scheduleConfig(config)`; grep shows only the interface declaration (`loop.ts:106`) and this implementation. The host composition (`src/host/host.ts:99-199`) never calls it.
- Even that path is version-gated: **`src/node/loop.ts:475-479`** applies a scheduled config only when `scheduled.version > config.version`, and the fold enforces the same rule at replay (**`src/context/fold.ts:317-319`**, `'config version must strictly increase'`).
- The only event type that carries a config is `system/message` (`src/context/events.ts:31`); its validator is **`src/context/events.ts:392-406`** and it is **scope-agnostic** (no `turnScope` call, unlike `world/perception` at `events.ts:409`) and **non-ignorable** (`events.ts:90`). No tool receives the gate except `executeExtend`, and it appends only the four package verb facts plus `tool/result` (**`src/node/tools/extend.ts:322-329,348-351,399-402,501-503,534,571`**); the terminal and web ports receive only `gate.signal` (**`src/node/tools/dispatch.ts:528-531,538-542`**).

**Re-compose** is impossible from either side:

- **`src/host/host.ts:440-442`** — `start` into a cell whose journal holds a config throws `'cell already has a journaled configuration; use resume'`.
- **`src/host/host.ts:458-463`** — `resume` refuses `--model`, `--heading` and `--charter-file`.
- **`src/host/layout.ts:204-228`** — `init` is idempotent and never touches `nodes/`; no CLI verb deletes a journal (`src/host/options.ts:211-223`).

Consequence: the only way to give an *existing* uid a new charter is an out-of-band deletion of `<home>/nodes/<uid>/log.v0.*` by the operator. A *new* uid in the same home gets a freshly composed charter (**host.ts:433-456** runs for a uid with no log).

### 1.2 Model / provider: impossible

`model` is part of the journaled config (`src/context/contracts.ts:113`), fixed at `start`
(**`src/host/host.ts:435-436,453`** — required, and `mock-model` refused). The provider endpoint and key come
from the host credential store, read before the runtime exists (**`src/host/host.ts:547-552`**) and handed to
`OpenAITransport` (**`host.ts:108-113`**). `resume` refuses `--model` (**`host.ts:458-459`**). The model id is
emitted as a JSON field (**`src/provider/wire.ts:86`**), not as text the model reads.

### 1.3 uid: impossible

Chosen by `--uid` (defaulted) and validated as one safe path segment, at **`src/host/options.ts:110-119`** and
**`src/journal/layout.ts:37,45-50`**. It is then structurally load-bearing, not a label:

- the driver's readonly field (**`src/node/driver.ts:196`**), validated again at runtime construction (**`src/node/loop.ts:174`**);
- the journal directory (**`src/journal/layout.ts:84-100`**);
- the commit author (**`src/node/driver.ts:716`** → `src/node/world-commit.ts:79-85,116`);
- the perception uid, refused at turn start if it differs (**`src/node/loop.ts:484-488`**);
- the sandbox scratch path segment (**`src/node/tools/sandbox.ts:229-235,273`**).

### 1.4 Step budget and timeouts: impossible

`stepsPerTurn` is read from the folded (journaled) policy at the top of every turn:
**`src/node/loop.ts:507`** (`for (let step = 0; step < config.policy.stepsPerTurn; step += 1)`), with the
policy shape at **`src/context/contracts.ts:96-108`** and the factory numbers at **`src/context/config.ts:81-89`**.
Per-command limits likewise come from the journaled policy at each dispatch: **`src/node/tools/dispatch.ts:538-542`**
(`timeoutMs`, `killGraceMs`, `maxCaptureBytes`), and the kill grace at **`src/node/loop.ts:424-428`**. No tool
writes a policy number; `extend` cannot (see 1.5).

A node *can* consume the budget faster (long commands, chained turns — see G11) but cannot alter the numbers.

### 1.5 Tool offering: frozen; only *callable capability* can grow

- The offering is `config.tools`, sent sorted on every request (**`src/context/assembler.ts:56,105`**) and hashed
  with the config source (`assembler.ts:56-60`).
- The live registry is read at dispatch and never spliced into the request: **`src/node/packages/registry.ts:11-16`**
  ("The offering stays frozen — the registry is read at dispatch time by the funnel, never spliced into the request's
  tools array") and **`src/node/tools/extend.ts:30-33`** ("never mutate the offering (frozen for the process lifetime
  … the registry is read at dispatch, never spliced into the request)"). Test: `src/node/__tests__/extend.test.ts:931`
  ("keeps the offering byte-identical across the full lifecycle").
- Attenuation is applied at dispatch against the same journaled config: **`src/node/tools/dispatch.ts:98-100`**;
  a name that is offered but excluded is `denied`, any other name is `unknown-tool` (**dispatch.ts:101-117**).
- The native-call bridge changes nothing about the offering: only a name *outside* the offering and only with
  `extend` offered **and** allowed is bridged to the funnel (**dispatch.ts:473-484**); the capability is the funnel's
  own. Test: `extend.test.ts:554` (an attenuated `extend` never becomes a native bypass).

What *is* mutable is the set of package tools a Run registers, which become callable by bare name while the Run is
live — capability growth inside a frozen offering (`dispatch.ts:73-82`, `registry.ts:193-317`).

### 1.6 Sandbox mode: impossible

The mode is a host/CLI choice (`--no-sandbox`, **`src/host/options.ts:142,162`**; composed at
**`src/host/host.ts:126-155`**) and is resolved once per session build (**`src/node/loop.ts:407-421`**). Nothing
agent-reachable changes it.

---

## 2. WORLD — what `execute` can do

### 2.1 The rw set is defined in one place

**`src/node/tools/sandbox.ts:284-285`:**

```ts
addGrant('--rw', world);
addGrant('--rw', scratchDir);
```

`scratchDir` is `<home>/tmp/<uid>` (**`sandbox.ts:129`**); `HOME=world`, `TMPDIR=scratchDir`
(**`sandbox.ts:335`**). The rw grant is computed as the full filesystem right set: **`native/es-landlock/es-landlock.c:98`**
(`ES_FS_RIGHTS ((1ULL << 15) - 1)`) and **`c:182-200`** (`GRANT_RW` → `ES_FS_RIGHTS` for a directory), i.e.
read/write/truncate/execute plus `REMOVE_FILE`, `REMOVE_DIR`, `MAKE_*`, `REFER` — recursive by Landlock's
path-beneath semantics. The probe asserts a write/read-back/remove in both rw roots before the first command
(**`sandbox.ts:324-330`**, `probeSandbox` at `sandbox.ts:508-539`).

### 2.2 No path restriction *inside* the world — including files another node wrote

The grant is the whole worktree, so a node can create, rewrite, truncate, rename and delete any path under
`world/`, including files committed by another uid and files another turn left dirty. The kernel then commits
the resulting tree as the *turn's* author: **`src/node/world-commit.ts:108-118,235-238`** (`add --all -- .`), and the
perception preamble says so: **`src/context/diff.ts:47-48`** (`'attribution: commit author names the closer; omitted
own commits may contain peer in-flight writes'`). Cross-authorship is also documented by the driver's own recovery
comment (**`src/node/driver.ts:883-894`**): the zero-candidate recovery commits the whole dirty tree, "a peer's dirty
files are swept in with the node's own — commit-granular attribution, the accepted behavior".

`.gitignore` is honoured (**`world-commit.ts:92-94`**): a node can write files that never enter history at all
(empirically confirmed in a `/tmp` repo: a `.gitignore` containing `.gitignore` is itself never staged). See G4.

Nested repositories are excluded from staging and their gitlinks swept (**`world-commit.ts:227-238,246-248,283-309`**);
a root-level `.git` is skipped and "never read by the explicit pair" (**`world-commit.ts:278-282`**).

### 2.3 Everything outside world + scratch

Read set: `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/lib32` as `--rox` (**`sandbox.ts:52,287-290`**); eight
`/etc` files plus `/etc/ssl/openssl.cnf` (regular file only) and `/etc/ssl/certs`, `/proc`, and five devices
(**`sandbox.ts:60-76,291-311`**). Write set outside the world: only `/dev/null` and `/dev/tty`
(**`sandbox.ts:70-76`**). `/`, `/home`, `/var`, `/tmp` and the rest of the cell home are never granted
(**`sandbox.ts:17-19`**); `world.git/`, `frontier/`, `nodes/<uid>/` and `providers.json` are all inside
`<home>` and therefore unreadable and unwritable — asserted for `world.git` and `nodes/<uid>` by
`src/node/__tests__/sandbox-confinement.test.ts:24-30,265-292` and for the credential store at
`sandbox-confinement.test.ts:22-24`.

Two structural guards: the cell home may not be inside the world (**`sandbox.ts:262-268`**) and the launcher may
not fall inside any grant (**`sandbox.ts:313-321`**) — the latter because a launcher inside an agent-writable root
could rewrite the policy that confines it (`sandbox.ts:21-24`).

### 2.4 Git is kernel-only

Every kernel git call carries `--git-dir <home>/world.git --work-tree <home>/world` and strips every `GIT_*`
redirect/config variable: **`src/node/world.ts:196-201`**, **`src/node/world-git.ts:40-98`**
(`GIT_ENV_STRIP`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_NO_REPLACE_OBJECTS`,
`GIT_NO_LAZY_FETCH`). The git dir is outside the worktree by construction (**`src/host/layout.ts:47-50,64-66,118-131`**),
so `git` run by the shell in the world sees no history; a node can init its own repo in a subdirectory, but that
subtree is excluded from the kernel's commit (`world-commit.ts:227-238`). This matches the `execute` description
(**`src/context/config.ts:28`**).

Egress is open and unjournaled by design: **`sandbox.ts:26-28`** (no network rights handled), and the description
states it (**`config.ts:28`**: "Egress is open by decision: the shell can reach the network, and those exchanges are
not journaled").

---

## 3. PACKAGES (`extend`)

### 3.1 The store is per uid, not shared

`packagesDir = nodes/<uid>/packages` — **`src/node/packages/store.ts:151`**, built by
**`src/host/host.ts:120-122`** with `home` and `uid` from the host options. Identity is
`sha256(canonicalJson(manifest) ‖ source)` (**`store.ts:279-283`**), directories are `0700`/`0600`
(**`store.ts:47-49`**), and a define is write-once per id (**`store.ts:329-332`**).

Therefore a define by node A is invisible to node B: different `nodes/<uid>/` roots. The only sharing channel is
the world itself — `define` accepts a source path inside the world worktree or inside the node's scratch
(**`store.ts:132-140,172-177,210-260`**), so B can define from a file A wrote, but that is source *text*, not a
shared store. In addition, today at most one host runs per cell home: the frontier journal's writer lock is per
home (**`src/frontier/journal.ts:240-270`**, `SessionAlreadyOwnedError` at `journal.ts:248`), and the owner record is
explicitly liveness metadata, with exclusion coming from "the journals' own writer locks"
(**`src/host/owner.ts:14-19`**). The node's own local-log lock is per `(home, uid)` (**`src/node/loop.ts:60-64`**,
`src/journal/writer.ts:179-198`).

### 3.2 A newer same-name define does override — by name, not by id

- Two defines with the same name but different purpose/source produce different ids (identity includes the manifest
  and the source, **`store.ts:279-283`**); an identical re-define returns the same id (**`store.ts:329-332`**).
- The name channel resolves "latest" as **greatest directory mtime, tie-broken by id descending**
  (**`store.ts:522-533`**), then returns the first *verified* candidate (**`store.ts:535-545`**).
- So `run {name}` runs the newest stored version; the old version remains addressable by id; `undefine {name}`
  deletes the newest, with **no** skipping of a corrupt newest (**`store.ts:558-561`**), and then the name resolves
  to the previous version. The `extend` description states the contract (**`src/context/config.ts:62`**:
  "a name resolves to the latest stored version"), and the tests pin it: `src/node/__tests__/extend.test.ts:1148`
  (run by name = latest), `:1206` (undefine latest → falls back), `:1261` (run v1, define v2, stop by name).

### 3.3 Can a Package/Run call `extend`, or define/undefine other packages? No

- The child protocol has exactly seven frame shapes: `run/ready`, `tool/invoke`, `tool/result` (ok/err),
  `svc/execute`, `svc/web_search`, `svc/web_fetch`, `svc/result`, `run/dispose` —
  **`src/node/packages/protocol.ts:45-69`**. There is no extend/define frame, and the supervisor rejects anything
  else as a protocol teardown (**`src/node/packages/supervisor.ts:600-662`**).
- The facade handed to a handler is exactly `handler(args, svc)` with `svc.execute`, `svc.web_search`,
  `svc.web_fetch` (**`src/context/config.ts:62`**; `src/node/tools/extend.ts:276-284`).
- The Run's Landlock cannot reach `nodes/<uid>/packages`: its grants are the Run leaf plus the system read set only
  (**`src/node/tools/sandbox.ts:444-473`**, and `sandbox.ts:340-348` states "Never `<home>` itself, never
  `nodes/<uid>/packages/`, never the world (a Run is not a shell)").
- Guest code is arbitrary JavaScript evaluated in the child (**`src/node/packages/run-bootstrap.ts:1015-1023`**),
  so it can spawn processes and use the network, but it has no channel to the package store or to `extend`.

**But** a Run inherits the node's shell through `svc.execute`: the supervisor calls `deps.terminal.run(...)`
(**`supervisor.ts:700-717`**), and the host passes the node's own terminal port when `execute` is allowed
(**`src/host/host.ts:140`**). So package code can write the world and leave persistent shell state (see G7).

### 3.4 Run lifetime: outlives the turn, not a clean stop — and "disposal" is direct-child-only

- A Run is in-memory and independent of turns; the description says so (**`config.ts:62`**, "A Run is in-memory: a
  restart reaps it — the stored Package survives, so run it again") and `inspect` repeats it
  (**`src/node/tools/extend.ts:232-233`**).
- Clean stop: `NodeDriver.shutdown` journals `node/shutdown`, then calls `hooks.onStop` with a ready gate before the
  writer closes (**`src/node/driver.ts:771-805`**, the call at `driver.ts:786-791`). The runtime's `onStop` disposes
  the terminal first and then the Run (**`src/node/loop.ts:185-200`**); `stopPackages` calls
  `supervisor.stopRun()` and journals a `package/stop` with `reason:'host-stop'`
  (**`loop.ts:268-279`**).
- `stopRun`'s disposal (**`src/node/packages/supervisor.ts:534-565`**): unregister the tools
  (`supervisor.ts:538`), send `run/dispose` fire-and-forget (`548-549`), await exit **or** `killGraceMs`
  with `run.child.kill('SIGKILL')` (`550-556`), one `setImmediate` for the drain, a second `SIGKILL` if not yet
  exited (`559-563`), then `reapLeaf` removes the leaf directory (`564`; `reapLeaf` at `271-274`).
- Failure teardown is the same, without the grace: **`supervisor.ts:262-269`** (`run.child.kill('SIGKILL')`).
- The boot scan deletes everything under `nodes/<uid>/runs` (**`src/node/loop.ts:289-303`**, the `rm` at
  `loop.ts:299-302`) — it reaps **leaves, not processes**.

There is no process-tree reaping anywhere in the repository: the only spawn sites are
`src/node/world-git.ts:167,195`, `src/node/tools/terminal.ts:418,423`, `src/node/packages/supervisor.ts:395`;
none passes `detached`, none creates a process group, none calls `kill(-pid)`/`killpg`, and nothing sets rlimits or
cgroups (the `inspect` text says so at `src/node/tools/extend.ts:291-293`). The supervisor kills the direct child
only (`supervisor.ts:268,552,562`).

Kernel death: the launcher sets `PR_SET_PDEATHSIG=SIGKILL` on itself before the in-place `execve`
(**`native/es-landlock/es-landlock.c:513-528`**, with `PR_SET_NO_NEW_PRIVS` at `c:504`), so the *confined program*
dies with the kernel. With `sandbox:false` there is no launcher and no parent-death signal at all
(**`supervisor.ts:379-386`**: `program = interpreter; argv = [bootstrapLeaf, ...]`); the child then exits only when
its stdin sees EOF (**`run-bootstrap.ts:884-888,910-916`**).

### 3.5 Can a Run spawn `setsid`/`nohup` daemons, and do they get killed? Yes, and no

- Guest code can `await import('node:child_process')` and spawn detached children, or simply ask the node's shell
  via `svc.execute` to start one.
- Nothing ever kills such a process. The shell's own teardown is documented to leave survivors:
  **`src/node/tools/terminal.ts:28-35`** — "a reset kills the shell and lets the pty teardown SIGHUP the foreground
  group — a backgrounded or SIGHUP-ignoring process can survive, and the journal never claims otherwise". The kill
  itself is `SIGTERM` then `SIGKILL` on the pty child (**`terminal.ts:449-467`**).
- `PDEATHSIG` is not inherited by the shell's or the Run's descendants (Linux clears it on `fork(2)`), and
  `prctl` is not mediated by Landlock, so even the confined program can clear its own parent-death signal.
- Landlock *is* inherited and can never be relaxed, so a survivor keeps the rw set it was born with: a shell-born
  daemon keeps `world/` + `<home>/tmp/<uid>` read-write; a Run-born one keeps only its (already deleted) leaf.

See G1/G2 — this is the single most consequential finding in this audit.

---

## 4. PERCEPTION — what a node can read about itself and others

### 4.1 What reaches the model

Exactly: the charter (first system message), the heading (second system message), the committed history and the
open-turn queue, and the tool schemas/descriptions — **`src/provider/wire.ts:79-89`** and
**`src/context/assembler.ts:90-112`** (`sections` at `assembler.ts:90-96`; `charter`/`heading` at `110-111`).
`model` and `parameters` are wire fields (**`wire.ts:86-87`**), not text; `policy` is in the plan
(`assembler.ts:104`) but is never rendered into the messages. So a node does **not** learn its step budget, its
timeouts, its model id, or its caps from the prompt — only from tool descriptions and from `extend inspect`.

World perception is the kernel's diff of *foreign* commits; its own commits are omitted and merely named
(**`src/context/diff.ts:14,47-48,149-158`**; range/watermark logic at `src/node/driver.ts:687-704`).

### 4.2 `readCellConfig` / `nodeLayout`: per-uid by construction, not by an access check

- **`src/host/host.ts:311-332`** — `readCellConfig(home, uid)` is module-private (no `export`), builds the path from
  `nodeLayout(home, uid)` (`host.ts:312-313`), treats a missing log as "nothing journaled"
  (`host.ts:316-321`), and refuses a corrupt one by name (`host.ts:327-331`).
- Its only caller is `resolveInitialConfig`, with the CLI's own uid — **`host.ts:433`**.
- **`src/journal/layout.ts:89-100`** — `nodeLayout` validates the uid with `assertNodeUid` and joins
  `home/nodes/<uid>`; **`layout.ts:37,45-50`** is the regex. That is a *path-segment* check, not an authorization
  check: any caller holding a foreign uid could read that node's log. The real gate is that no agent-reachable code
  holds a foreign uid, and the filesystem gate below.
- Every runtime read uses the runtime's own uid: `hooks.readHistory(home, this.uid, ...)` at
  **`src/node/driver.ts:839`**, `JournalReader.open(home, this.uid)` at **`driver.ts:852`**, and the hook wired at
  **`src/node/loop.ts:182`**.

### 4.3 Can one node read another node's config?

No, through any existing capability:

- The only file-reading tool is `execute`'s shell; its read set excludes `<home>` entirely
  (**`src/node/tools/sandbox.ts:284-311`**; `nodes/<uid>` is explicitly asserted EACCES by
  `sandbox-confinement.test.ts:24-30,265-292`).
- No tool exposes the journal, the fold, or `readCellConfig`; `dispatch` gives tools no gate (**§1.1**).
- The world contains no node config (charters live only in the journal, `src/context/events.ts:31`).
- A second node cannot even run concurrently against the same home (frontier writer lock,
  `src/frontier/journal.ts:240-270`).

The one way a node's config becomes readable by another is voluntary publication: writing the text into a world
file. Nothing prevents a node from writing its own charter, caps, or the tool text into the world.

### 4.4 Self-knowledge available

`extend {verb:"inspect"}` is the only introspection verb: base tools as given, live tools with schemas, stored
packages with sizes and caps, the sandbox mode and the honesty block (**`src/node/tools/extend.ts:207-295`**).
It is a rendering of live kernel state, not of the journal.

---

## 5. CHARTER CONTENT — what the composed charter actually says

### 5.1 Exact composed string (default, uid `node-0`)

From **`src/context/config.ts:18-21`** (one string, concatenated):

```
You act by writing in the shared world. Preserve durable knowledge in files. Your context is finite: it is compacted periodically and whatever you have not put outside it is lost. The heading is the boot seed; the living direction is the world's files.
```

plus, from **`src/host/host.ts:455`** (`` `${base} You are ${uid}.` ``):

```
You act by writing in the shared world. Preserve durable knowledge in files. Your context is finite: it is compacted periodically and whatever you have not put outside it is lost. The heading is the boot seed; the living direction is the world's files. You are node-0.
```

With `--charter-file`, `base` is the raw file text (**`host.ts:448-450`**) and the same sentence is appended with
exactly one ASCII space before `You`, and no other separator normalization (`host.ts:455`). Pinned by tests:
`src/host/__tests__/lifecycle.test.ts:365` (`defaultAgentConfig().charter + ' You are node-0.'`), `:388`
(operator base), `:434` (8192-byte acceptance).

### 5.2 What it says about self-modification: nothing

The whole composed charter is four clauses and a name:

1. "You act by writing in the shared world."
2. "Preserve durable knowledge in files."
3. "Your context is finite: it is compacted periodically and whatever you have not put outside it is lost."
4. "The heading is the boot seed; the living direction is the world's files."
5. "You are <uid>."

It does **not** mention: the `extend` tool or Packages; that the offering is frozen; that the charter/config is
journaled and cannot be changed; that the uid is the git author or the wake predicate's exclusion key; the frontier,
the journals, the sandbox, the Landlock boundary, compaction's replacement (beyond clause 3), or any prohibition.
The identity sentence is descriptive, not normative. A node reading its charter cannot learn from it that its
charter is immutable — it learns that only from the absence of any mechanism, which is indistinguishable from an
unmentioned one.

Where the bounds are actually taught: the tool descriptions (frozen, journaled config —
**`config.ts:28`** for the shell boundary, **`config.ts:36`** for `wait`/wake, **`config.ts:62`** for `extend`,
Packages, `svc` and the Run's file reach), and the `extend inspect` honesty block
(**`src/node/tools/extend.ts:249-293`**). The only *runtime* reminder of the Hole is the compaction replacement
notice, **`src/context/compaction.ts:39`**: `Older committed context was removed; externalize what must survive.`

Cross-check: the Hole wording comes from the friction pass 2 record
(`docs/plans/2026-10-29-fp2-friction-pass-2.md:12-20`, "The default charter gains the two seed facts … and the
heading-authority fact … NO memory strategy is taught") and `docs/seed.md:30`. `docs/kernel.md:9` claims
"flow-down travels through charters and delegation", and `docs/kernel.md:73` states "A shared tool offering across
working nodes is a host/seed obligation, not a kernel-enforced invariant" — no charter flow-down mechanism exists in
`src/` (see G12).

---

## 6. GRAY ZONES — items that need an explicit Lead decision

**G1 — Persistent daemons outlive the turn and the kernel (highest severity).**
A node can run `setsid`/`nohup`-style processes from `execute` (or from a Run via `svc.execute`); no code path ever
kills anything but the direct child (`src/node/packages/supervisor.ts:268,552,562`; `src/node/tools/terminal.ts:449-467`),
and the terminal's own doc admits survivors (`terminal.ts:28-35`). They keep the Landlock domain they were born with
(Linux: restrictions are inherited and irreversible), so a shell-born daemon keeps `world/` read-write and can keep
mutating the shared world — and can keep running after the host exits, unrecorded by any journal.
*Decision needed:* are outliving processes allowed at all? If not, the kernel needs process-group/cgroup supervision
(or a per-node session id plus a sweep), because Landlock alone cannot express "die with the kernel" for grandchildren.

**G2 — `PDEATHSIG` is not a containment answer.** It is set only on the launcher's own process before `execve`
(`native/es-landlock/es-landlock.c:513-528`); it is cleared on `fork(2)`, and `prctl` is unmediated by Landlock, so
the confined program can clear its own. The launcher comment "A confined program must not outlive the process that
spawned this launcher" is therefore true only of the direct child, while `src/node/loop.ts:281-287` claims "no Run
survives a restart" (the code reaps leaves, `loop.ts:299-302`). *Decision needed:* align the comments and the
invariant with what is enforced; consider naming the residual in the docs that claim it.

**G3 — `--no-sandbox` is a credential-exfiltration switch, not just a debugging one.** A Run started without the
sandbox is an unconfined child of the kernel with the kernel's uid (`supervisor.ts:379-386`); package code can then
read `<home>/providers.json` and exfiltrate over the open egress. `inspect` states this honestly
(`src/node/tools/extend.ts:263-265`), but nothing refuses it. *Decision needed:* forbid `--no-sandbox` when a
credential is loaded, or gate it behind an explicit second opt-in.

**G4 — The world's history is not the world's state.** `.gitignore` is honoured (`src/node/world-commit.ts:92-94`),
so a node can write files that are never committed and therefore never appear in any peer's perception (perception is
per-commit patches, `src/context/diff.ts:9-13,146-190`). The files remain on disk, readable by any node that runs
`ls`/`cat` instead of trusting the diff. A `.gitignore` that ignores itself never enters history either (verified
empirically). *Decision needed:* is "world = git history" an invariant? If yes, `.gitignore` must be kernel-owned or
ignored by the commit path; if no, the perception contract should stop implying the diff is the world.

**G5 — Attribution drift on destructive writes.** Rewriting or deleting a peer's file produces a commit authored by
whoever ends the turn (`world-commit.ts:108-118,235-238`), and the failed-turn recovery sweeps the whole dirty tree
including peers' in-flight writes (`src/node/driver.ts:883-894`). The perception preamble discloses it
(`diff.ts:47-48`). *Decision needed:* accept commit-granular attribution as the contract (documented), or add
per-path provenance.

**G6 — Private durable state exists and is not the world.** `<home>/tmp/<uid>` is the shell's `TMPDIR`
(`src/node/tools/sandbox.ts:285,335`), persists across turns and restarts, is never committed, and is invisible to
peers. The definition store is likewise private (`store.ts:151`). The charter says only "Preserve durable knowledge
in files" and "the living direction is the world's files", which a node can satisfy entirely in private.
*Decision needed:* is private durable self-state acceptable (and should the charter say so), or should the scratch be
wiped per session?

**G7 — Package code inherits the node's shell rights.** `svc.execute` runs in the node's own persistent shell
(`supervisor.ts:700-717`; `src/host/host.ts:140`), so a "sandboxed" Run can still write the world and can leave env
vars, cwd and background jobs in the session the node's next `execute` uses. `inspect` teaches this
(`extend.ts:276-288`). *Decision needed:* confirm that Packages are a *code-organisation* boundary, not a
capability boundary — otherwise `svc.execute` needs attenuation.

**G8 — `system/message` is scope-agnostic and non-ignorable.** `src/context/events.ts:392-406` does not call
`turnScope` (contrast `world/perception` at `events.ts:409`), and the type is non-ignorable (`events.ts:90`). Today
the only writers are `ready()` (`src/node/loop.ts:346-349`) and `beginTurn` for a scheduled config
(`loop.ts:475-479`), and no production code schedules one. But the *only* barrier between a future tool and an
agent-driven charter rewrite is that tools get no gate. *Decision needed:* add an authority/scope check on config
writes (ready-scope-only, or a kernel-held token) so the barrier is structural rather than accidental.

**G9 — "Latest" is mtime, not logic.** `resolveLatestByName` sorts by directory mtime with an id tie-break
(`src/node/packages/store.ts:522-533`), so two defines inside one timestamp resolution are ordered arbitrarily
(though deterministically). `undefine` by name deletes the newest irreversibly (`store.ts:558-561`;
`src/node/tools/extend.ts:540-574`) and restores identity only if the source file still exists. *Decision needed:*
accept mtime as the version order (and say so), or add a monotonic version counter to the manifest.

**G10 — `/proc` is granted read-only, and the environ/fd denial is not Landlock's.** `/proc` is in the read set
(`src/node/tools/sandbox.ts:306-307`); the battery shows `cat /proc/<pid>/environ` and `readlink /proc/<pid>/fd/0`
are EACCES while `/proc/<pid>/stat` is readable (`sandbox-confinement.test.ts:527-589`), which is the kernel's ptrace
check, not the Landlock ruleset. On a host with `kernel.yama.ptrace_scope=0` the guarantee may not hold, and the
signal-scoping ruleset exists only for ABI ≥ 6 (`native/es-landlock/es-landlock.c:484-487`). *Decision needed:*
verify the target host's `ptrace_scope` and Landlock ABI, or narrow the `/proc` grant to what node/tooling needs.

**G11 — No node-level budget or step ceiling.** `stepsPerTurn` bounds one turn (`src/node/loop.ts:507`), but an
exhausted call group returns `'chained'` and the driver starts the next turn immediately
(`src/node/driver.ts:374-377`), indefinitely. With 8 steps × 300 s (`src/context/config.ts:82-85`) a node can hold
the host for hours per turn and never stop. There is no budget code (`grep` finds none); `docs/seed.md:33` places the
ceiling upstream on the API key. *Decision needed:* confirm that is the intended and sufficient ceiling, or implement
a per-node/per-cell budget in the kernel.

**G12 — A cell is not guaranteed one charter or one offering.** Each uid composes its own config at its own `start`
(`src/host/host.ts:431-456`), and nothing compares configs across uids; `docs/kernel.md:73` already admits the
offering is a host/seed obligation. *Decision needed:* is a cell one society with one charter, or N independently
chartered nodes sharing a world? Today the answer is the latter, silently.

**G13 — Journal-vs-world crash windows.** A kernel crash between `commitWorld` and `turn/end` leaves the commit
unattributed until the next resume, which writes a synthetic closer naming it
(`src/node/driver.ts:862-876,896-904`); if none is found it commits the whole dirty tree (`driver.ts:896-904`).
An effect is therefore never lost, but it can be mis-attributed across a crash. *Decision needed:* accept as the
documented recovery semantics (it is documented in `driver.ts:883-894`), or add a pre-commit intent record.

**G14 — Definition sources are not journaled.** `package/define` carries id, name, purpose and byte count only
(`src/context/events.ts:47`), never source bytes (by design, `events.ts:45-47`). The only copy of what the code was
is `nodes/<uid>/packages/<id>/package.js` (`store.ts:121-122,340-344`), and the world file it came from may be
overwritten or deleted by any node. *Decision needed:* does the audit trail need the source (or a durable digest→source
map) for post-hoc alignment review?

**G15 — `define` accepts the node's scratch as a source root.** `store.ts:172-177` admits the world *or* the scratch
(`<home>/tmp/<uid>`), so a package can be defined from a private file that no peer and no commit ever saw — the
definition is then part of the node's persistent self. *Decision needed:* same question as G6, applied to code rather
than data.

---

## 7. Verification limits

- No test suite was run; no file in the repository was written. The confinement battery and the extend suite were
  *read* as evidence of intended behaviour.
- The `.gitignore` claim was verified by execution in a throwaway `/tmp` repo, not in the project.
- Daemon survival is derived from the code plus documented Linux semantics (fork-cleared `PDEATHSIG`, inherited
  Landlock domains, `prctl` unmediated). It was not executed against a live node in this audit.
- `kernel.yama.ptrace_scope` and the host's Landlock ABI were not sampled.

---

## Synthesis — what a node can and cannot recode about itself (10 lines)

1. It cannot touch its charter: the string is fixed at `start`, journaled once, replayed from the fold, and no tool holds an append path to `system/message` (`host.ts:448-456`; `loop.ts:346-349`; `assembler.ts:110`).
2. It cannot trigger a re-compose: `start` refuses a journaled cell and `resume` refuses the composing flags (`host.ts:440-442,458-463`); only an out-of-band journal deletion does it.
3. It cannot change model, provider, parameters or uid; all are journaled, and the uid is load-bearing in the journal path, git author, perception check and scratch path (`contracts.ts:110-115`; `driver.ts:716`; `loop.ts:174,484-488`).
4. It cannot change its step budget, shell timeout, capture or result caps; every number is read from the journaled policy at use (`loop.ts:507`; `dispatch.ts:538-542`).
5. It cannot change the advertised five-tool offering; the registry is read at dispatch and never spliced into the request (`registry.ts:11-16`; `extend.ts:30-33`; test `extend.test.ts:931`).
6. It can grow its *callable* capability: define/run/stop/undefine Packages, whose tools are invocable by bare name through the bridge without moving the offering (`extend.ts:384`; `dispatch.ts:473-484`).
7. Those are its only durable, journaled self-changes, and the store is per uid, so one node's Packages are invisible to another except as world source text (`store.ts:151`; `host.ts:120-122`).
8. In the world it is effectively omnipotent: `world/` is granted recursively read-write (`sandbox.ts:284`; `es-landlock.c:98,182-200`), so it can rewrite or delete any peer's file, committed under the closing turn's author (`world-commit.ts:235-238`; `diff.ts:47-48`).
9. Outside the world it is confined: the rest of the cell home, `world.git`, `frontier/`, `nodes/` and `providers.json` are denied (`sandbox.ts:17-19,284-311`), and git is kernel-only (`world.ts:196-201`).
10. The charter teaches none of this; its only self-knowledge is the prompt, the tool descriptions and `extend inspect`, and its only persistence beyond the turn is the world it writes plus any daemon it leaves running (`terminal.ts:28-35`).
