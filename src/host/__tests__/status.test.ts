import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readStatus, formatStatus } from '../status.js';
import { acquireOwner } from '../owner.js';
import { HostConfigError } from '../errors.js';
import { JournalReader, frontierLayout } from '../../journal/index.js';
import { encodeBatch, scanBatches } from '../../journal/framing.js';
import {
  FRONTIER_EVENT_TYPES, openFrontierJournal as openWriter, type FrontierJournal,
} from '../../frontier/index.js';
import { TEST_STORAGE } from '../../frontier/__tests__/helpers.js';
import { WorldRepo } from '../../node/world.js';
import { clearWorldState, markWorldDegraded } from '../../node/world-state.js';
import { commitAs } from '../../node/__tests__/helpers.js';

/**
 * The read-only `status` report, observed over a real cell home.
 *
 * The fixture is a real `mkdtemp` home with a real `WorldRepo.init` world
 * pair — not the node suites' `useWorld`, which makes the home and the world
 * siblings, so `readStatus(home)` would report `world: absent` for a home
 * that owns one. Every test that needs a frontier opens the real writer
 * itself; the local `openFrontierJournal` wrapper remembers each handle so
 * `afterEach` can close what even a failing test leaves open, then the home
 * is removed.
 *
 * The nine cases are the first-light Task 8 spec verbatim: reading a
 * lock-holding writer without a lock and without reconciling; the
 * `http/incomplete` marker appearing only after a real frontier open; the
 * snake_case payloads projected without any blob resolution (the body and
 * header sentinels stay in the blobs); a hostile local log and a `chmod 000`
 * on `nodes/` changing no report byte and the source staying clean of the
 * banned identifiers; the exact human lines with null last records omitted;
 * world HEAD, an absent world, a non-repo git dir and all four owner states
 * mapped exactly; a missing and a non-directory home refused with
 * `HostConfigError`; and the two damage shapes folding into `frontier.error`
 * with the counts their generator position implies.
 */

const journals: FrontierJournal[] = [];
let home = '';
let world: WorldRepo;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'es-status-'));
  world = await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
});

afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

/**
 * The fixture's writer opener: the frontier barrel's opener plus one side
 * effect — the handle is remembered, so `afterEach` closes a journal even
 * when a test fails before its own `close()`. The cases below call this local
 * name, which keeps their bodies verbatim.
 */
function openFrontierJournal(
  home: string,
  opts: {
    readonly worldHead: () => Promise<string | null>;
    readonly now: () => number;
  },
): Promise<FrontierJournal> {
  // The real storage seam: a status fixture's home is fine, so no refusal.
  return openWriter(home, { ...opts, storage: TEST_STORAGE }).then((journal: FrontierJournal) => {
    journals.push(journal);
    return journal;
  });
}

/** Every frontier event's type, in order, through the journal's own reader. */
async function readFrontierTypes(home: string): Promise<string[]> {
  const reader = await JournalReader.openIn(frontierLayout(home), {
    knownTypes: FRONTIER_EVENT_TYPES,
  });
  const types: string[] = [];
  for await (const event of reader.events()) types.push(event.type);
  return types;
}

/** A pid that belonged to a child this helper fully reaped: dead, not a zombie. */
async function reapedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawn failed');
  await once(child, 'exit');
  return pid;
}

it('reads a frontier while its writer holds the lock and appends nothing', async () => {
  const journal = await openFrontierJournal(home, { worldHead: async () => null, now: Date.now });
  await journal.gate.begin({ method:'POST', url:'https://h/v1/x', headers:{}, body: Buffer.from('{}'), encoding:'utf8' });
  const before = await readFrontierTypes(home);
  const report = await readStatus(home);
  expect(report.frontier.present).toBe(true);
  expect(report.frontier.count).toBe(1);
  expect(report.frontier.counts['http/request']).toBe(1);
  expect(report.frontier.openCalls).toBe(1);
  expect(report.frontier.lastHash).toMatch(/^[0-9a-f]{64}$/);
  expect(await readFrontierTypes(home)).toEqual(before); // no reconcile
  await journal.close();
});
it('reports http/incomplete only after a real frontier open', async () => {
  const journal = await openFrontierJournal(home, { worldHead: async () => null, now: Date.now });
  await journal.gate.begin({ method:'POST', url:'https://h/v1/x', headers:{}, body: Buffer.from('{}'), encoding:'utf8' });
  await journal.close();
  expect((await readFrontierTypes(home)).filter((t) => t === 'http/incomplete')).toHaveLength(0);
  const reopened = await openFrontierJournal(home, { worldHead: async () => null, now: Date.now });
  await reopened.close();
  expect((await readFrontierTypes(home)).filter((t) => t === 'http/incomplete')).toHaveLength(1);
  expect((await readStatus(home)).frontier.openCalls).toBe(0);
});
it('projects the snake_case payload and never resolves bodies', async () => {
  const head = await commitAs(world,'human',{'a.txt':'a'},'seed');
  const journal = await openFrontierJournal(home, { worldHead: async () => head, now: Date.now });
  const call = await journal.gate.begin({ method:'POST', url:'https://h/v1/x',
    headers:{ accept:'x-HEADER-SENTINEL' }, body: Buffer.from('BODY-SENTINEL'), encoding:'utf8' });
  await journal.gate.complete(call, { status: 200, headers:{}, body: Buffer.from('RESP-SENTINEL'),
    encoding:'utf8', complete: true });
  const r = await readStatus(home);
  expect(r.frontier.lastRequest).toEqual({ call: call.call, url:'https://h/v1/x', worldHead: head, attempt: 0 });
  expect(r.frontier.lastResponse!.status).toBe(200);
  expect(r.frontier.lastResponse!.error).toBeNull();
  expect(Number.isFinite(r.frontier.lastResponse!.durationMs)).toBe(true);
  const text = formatStatus(r) + JSON.stringify(r);
  for (const s of ['BODY-SENTINEL','RESP-SENTINEL','x-HEADER-SENTINEL','authorization']) expect(text).not.toContain(s);
  await journal.close();
});
it('does not read the local log: hostile log and byte-identical reports', async () => {
  await mkdir(join(home,'nodes','node-0'), { recursive: true });
  await writeFile(join(home,'nodes','node-0','log.v0.jsonl.zstd'), 'LOCAL-SENTINEL', { mode: 0o600 });
  const beforeJson = JSON.stringify(await readStatus(home));
  const beforeText = formatStatus(await readStatus(home));
  const mode = (await stat(join(home,'nodes'))).mode & 0o777;
  try {
    await chmod(join(home,'nodes'), 0o000);
    expect(JSON.stringify(await readStatus(home))).toBe(beforeJson);
    expect(formatStatus(await readStatus(home))).toBe(beforeText);
  } finally { await chmod(join(home,'nodes'), mode); }
  const source = await readFile(fileURLToPath(new URL('../status.ts', import.meta.url)), 'utf8');
  expect(source).not.toMatch(/\bnodeLayout\b|C13_EVENT_TYPES|loadVerifiedEvents/);
  expect(source).not.toMatch(/openFrontierJournal|OpenAITransport|webToolsFromProviders/);
});
it('formats the exact lines and omits null last records', () => {
  const base = { home: '/h', host: { state: 'idle' as const },
    frontier: { present: false, count: 0, lastHash: null, counts: {}, openCalls: 0,
      lastRequest: null, lastResponse: null, error: null },
    world: { present: true, head: null, error: null, state: 'healthy' as const } };
  expect(formatStatus(base).split('\n')).toEqual([
    'home: /h', 'host: idle',
    'frontier: 0 events last=null http/request=0 http/response=0 http/incomplete=0 open=0',
    'world: head=null',
  ]);
  const full = { ...base, host: { state: 'running' as const, pid: 7, uid: 'node-0', command: 'start' as const },
    frontier: { ...base.frontier, present: true, count: 1, lastHash: 'a'.repeat(64),
      counts: { 'http/request': 1, 'http/response': 1 }, openCalls: 0,
      lastRequest: { call: 'c', url: 'https://h/v1/x', worldHead: null, attempt: 0 },
      lastResponse: { call: 'c', status: 200, error: null, durationMs: 3 } } };
  expect(formatStatus(full).split('\n')).toEqual([
    'home: /h', 'host: running pid=7 uid=node-0 command=start',
    `frontier: 1 events last=${'a'.repeat(64)} http/request=1 http/response=1 http/incomplete=0 open=0`,
    'last-request: call=c url=https://h/v1/x world_head=null attempt=0',
    'last-response: call=c status=200 error=null duration_ms=3',
    'world: head=null',
  ]);
  expect(formatStatus({ ...base, host: { state: 'stale' as const } })).not.toContain('pid=');
  // The storage fact survives a stale record (the host is gone, the fact is not).
  expect(formatStatus({ ...base, host: { state: 'stale' as const, storage: 'unquoted' } }))
    .toContain('host: stale storage=unquoted');
  expect(formatStatus({ ...base, host: { state: 'unverified' as const, pid: 9 } })).toContain('unverified pid=9');
  // The normal production storage=unquoted fact (not a degradation: no quota
  // is ever detected) is printed on every host line that carries it; a quoted
  // fact changes no byte.
  expect(formatStatus({ ...base, host: { state: 'unverified' as const, pid: 9, storage: 'unquoted' } }))
    .toContain('unverified pid=9 storage=unquoted');
  expect(formatStatus({ ...base, host: { state: 'unverified' as const, pid: 9, storage: 'quoted' } }))
    .not.toContain('storage=');
  expect(formatStatus({ ...base, host: { state: 'unverified' as const, pid: 9, sandbox: 'off' } })).toContain('unverified pid=9 sandbox=off');
  expect(formatStatus({ ...full, host: { ...full.host, sandbox: 'landlock' } })).toContain('host: running pid=7 uid=node-0 command=start sandbox=landlock');
  // The fence field is printed only when unavailable: an available (or absent)
  // fence changes no byte of a healthy line.
  expect(formatStatus({ ...full, host: { ...full.host, fence: 'available' as const } }))
    .toBe(formatStatus(full));
  expect(formatStatus({ ...full, host: { ...full.host, fence: 'unavailable' as const } }))
    .toBe(formatStatus(full).replace(
      'host: running pid=7 uid=node-0 command=start',
      'host: running pid=7 uid=node-0 command=start fence=unavailable',
    ));
  expect(formatStatus({
    ...base, host: { state: 'unverified' as const, pid: 9, fence: 'unavailable' as const },
  })).toContain('unverified pid=9 fence=unavailable');
  expect(formatStatus({ ...base, world: { present: false, head: null, error: null, state: 'healthy' as const } })).toContain('world: absent');
});
it('reports the durable degraded world sidecar, and only a successful commit clears it', async () => {
  await markWorldDegraded(home, 'git-exit', 1);
  const degraded = await readStatus(home);
  expect(degraded.world).toEqual({
    present: true, head: null, error: null, state: 'degraded', reason: 'git-exit',
  });
  expect(formatStatus(degraded).split('\n')).toEqual([
    'home: ' + home, 'host: idle',
    'frontier: 0 events last=null http/request=0 http/response=0 http/incomplete=0 open=0',
    'world: head=null',
    'world-state: degraded reason=git-exit',
  ]);
  // The report never opens the node log: a planted local-log sentinel and a
  // fenced `nodes/` directory change no byte of the degraded report either.
  await mkdir(join(home,'nodes'), { recursive: true });
  await writeFile(join(home,'nodes','node-0.log'), 'LOCAL-SENTINEL', { mode: 0o600 });
  expect(JSON.stringify(await readStatus(home))).not.toContain('LOCAL-SENTINEL');
  await clearWorldState(home);
  expect((await readStatus(home)).world).toEqual({
    present: true, head: null, error: null, state: 'healthy',
  });
  expect(formatStatus(await readStatus(home))).not.toContain('world-state:');
});
it('reports world HEAD, world absent and host owner states', async () => {
  const head = await commitAs(world,'human',{'a.txt':'a'},'seed');
  const r = await readStatus(home);
  expect(r.world).toEqual({ present: true, head, error: null, state: 'healthy' });
  await rm(join(home,'world.git'), { recursive: true, force: true });
  expect((await readStatus(home)).world).toEqual({
    present: false, head: null, error: null, state: 'healthy',
  });
  await mkdir(join(home,'world.git'));
  expect((await readStatus(home)).world).toMatchObject({ present: true, head: null,
    error: expect.stringMatching(/WorldNotARepo|NotARepo/) });
  await rm(join(home,'world.git'), { recursive: true, force: true });
  await rm(join(home,'world'), { recursive: true, force: true });
  const owner = await acquireOwner(home, { uid:'node-0', command:'start' });
  expect((await readStatus(home)).host).toEqual({ state:'running', pid: owner.record.pid, uid:'node-0', command:'start' });
  await owner.release();
  expect((await readStatus(home)).host).toEqual({ state:'idle' });
  const offOwner = await acquireOwner(home, { uid:'node-0', command:'start', sandbox:'off' });
  expect((await readStatus(home)).host).toEqual({ state:'running', pid: offOwner.record.pid, uid:'node-0', command:'start', sandbox:'off' });
  await offOwner.release();
  await writeFile(join(home,'host.json'), JSON.stringify({ ...owner.record, token:'a'.repeat(32), startTime:null }), { mode:0o600 });
  await chmod(join(home,'host.json'), 0o600);
  expect((await readStatus(home)).host).toEqual({ state:'unverified', pid: process.pid });
  const dead = await reapedPid();
  await writeFile(join(home,'host.json'), JSON.stringify({ ...owner.record, pid: dead, token:'a'.repeat(32), startTime:1 }), { mode:0o600 });
  await chmod(join(home,'host.json'), 0o600);
  expect((await readStatus(home)).host).toEqual({ state:'stale' });
  await writeFile(join(home,'host.json'), JSON.stringify({ ...owner.record, pid: dead, token:'a'.repeat(32), startTime:1, storage:'unquoted' }), { mode:0o600 });
  await chmod(join(home,'host.json'), 0o600);
  expect((await readStatus(home)).host).toEqual({ state:'stale', storage:'unquoted' });
});
it('surfaces the owner record\'s fence fact while a host holds it', async () => {
  const fenced = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  await fenced.annotate({ fence: 'available' });
  expect((await readStatus(home)).host).toEqual({
    state: 'running', pid: fenced.record.pid, uid: 'node-0', command: 'start',
    fence: 'available',
  });
  // The available fact adds no human field; `--json` carries it.
  expect(formatStatus(await readStatus(home)))
    .not.toContain('fence=');
  await fenced.release();
  // A record with no fence key (every pre-fence record) is reported exactly as
  // before — no fabricated field.
  const unfenced = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  expect((await readStatus(home)).host).toEqual({
    state: 'running', pid: unfenced.record.pid, uid: 'node-0', command: 'start',
  });
  await unfenced.annotate({ fence: 'unavailable', fenceReason: 'no-cell-cgroup' });
  const degraded = await readStatus(home);
  expect(degraded.host).toEqual({
    state: 'running', pid: unfenced.record.pid, uid: 'node-0', command: 'start',
    fence: 'unavailable', fenceReason: 'no-cell-cgroup',
  });
  expect(formatStatus(degraded).split('\n')[1])
    .toBe(`host: running pid=${unfenced.record.pid} uid=node-0 command=start fence=unavailable`);
  await unfenced.release();
  expect((await readStatus(home)).host).toEqual({ state: 'idle' });
});
it('throws HostConfigError for a missing home and for a non-directory home', async () => {
  await expect(readStatus(join(home,'nope'))).rejects.toBeInstanceOf(HostConfigError);
  const file = join(home,'file'); await writeFile(file,'');
  await expect(readStatus(file)).rejects.toBeInstanceOf(HostConfigError);
});
it('resolves with CorruptFrameError and loses prior counts on an undecodable frame', async () => {
  const journal = await openFrontierJournal(home, { worldHead: async () => null, now: Date.now });
  await journal.gate.begin({ method:'POST', url:'https://h/v1/x', headers:{}, body: Buffer.from('{}'), encoding:'utf8' });
  await journal.close();
  const logPath = join(frontierLayout(home).dir, frontierLayout(home).logFile);
  const len = Buffer.alloc(4); len.writeUInt32LE(3, 0);
  await appendFile(logPath, Buffer.concat([len, Buffer.from('xxx')]));
  const r = await readStatus(home);
  expect(r.frontier.error).toBe('CorruptFrameError');
  expect(r.frontier.count).toBe(0);
  expect(r.frontier.counts).toEqual({});
  expect(r.frontier.openCalls).toBe(0);
});
it('resolves with ChainBreakError and keeps the verified prefix counts', async () => {
  const journal = await openFrontierJournal(home, { worldHead: async () => null, now: Date.now });
  for (let i = 0; i < 3; i += 1) {
    await journal.gate.begin({ method:'POST', url:`https://h/v1/${i}`, headers:{},
      body: Buffer.from('{}'), encoding:'utf8' });
  }
  await journal.close();
  const logPath = join(frontierLayout(home).dir, frontierLayout(home).logFile);
  const raw = await readFile(logPath);
  const { batches } = scanBatches(raw);
  const first = encodeBatch(batches[0]!.lines);
  const second = encodeBatch(batches[1]!.lines);
  const broken = encodeBatch([batches[2]!.lines[0]!.replace(/"hash":"[0-9a-f]+"/, `"hash":"${'0'.repeat(64)}"`)]);
  await writeFile(logPath, Buffer.concat([first, second, broken]));
  const r = await readStatus(home);
  expect(r.frontier.error).toBe('ChainBreakError');
  expect(r.frontier.count).toBe(2);
  expect(r.frontier.counts['http/request']).toBe(2);
});
it('surfaces the storage fact in JSON, and in the human line only when unquoted', async () => {
  const owner = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  await owner.annotate({ fence: 'available', storage: 'quoted' });
  expect((await readStatus(home)).host).toEqual({
    state: 'running', pid: owner.record.pid, uid: 'node-0', command: 'start',
    fence: 'available', storage: 'quoted',
  });
  // A quoted host is not a degradation: the human line stays byte-identical.
  expect(formatStatus(await readStatus(home))).not.toContain('storage=');
  await owner.annotate({ fence: 'available', storage: 'unquoted' });
  expect((await readStatus(home)).host).toMatchObject({ storage: 'unquoted' });
  expect(formatStatus(await readStatus(home))).toContain('storage=unquoted');
  await owner.release();
  // A record without the optional fact (every pre-storage record) reports
  // exactly what it did before: no fabricated field, no changed byte.
  const legacy = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  expect((await readStatus(home)).host).toEqual({
    state: 'running', pid: legacy.record.pid, uid: 'node-0', command: 'start',
  });
  expect(formatStatus(await readStatus(home))).not.toContain('storage=');
  await legacy.release();
});
