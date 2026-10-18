import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { inviteMessage } from '../src/server/hub.js';
import { Client, connect, connectPremium, sleep, testServer } from './helpers.js';

// Free players' Quick play: a shared random-match queue. Four queued players start together; after matchWaitMs bots fill the empty seats.
// Free players still cannot create tables / tournaments or join by id; joining with a Premium host's code and watching stay as before.

const humans = (t: any) => t.seats.filter((s: any) => s.kind === 'human').length;
const queued = (srv: any) => srv.hub['matchQueue'].length;
const err = (c: Client, code: string, past = false) => c.waitFor((m) => m.t === 'error' && m.code === code, 8000, past);

test('a lone free player sees Finding players, then bots fill the table after the wait', async () => {
  const srv = await testServer({ timings: { matchWaitMs: 300 } });
  try {
    const { c } = await connect(srv.port, 'Solo');
    c.send({ t: 'quickPlay' });
    const q = await c.waitFor((m) => m.t === 'matching' && m.active);
    assert.equal(q.waiting, 1);
    assert.equal(q.size, 4);
    assert.ok(q.remainingMs > 0 && q.remainingMs <= 300);
    assert.equal(queued(srv), 1);
    assert.equal(c.log.some((m) => m.t === 'table'), false, 'no table while waiting');
    const notice = await c.waitFor((m) => m.t === 'notice' && m.kind === 'match');
    assert.match(notice.message, /bots joined your table/);
    const t = await c.waitFor((m) => m.t === 'table' && m.phase !== undefined, 8000, true);
    assert.equal(humans(t), 1);
    assert.equal(t.seats.filter((s: any) => s.kind === 'bot').length, 3);
    assert.equal(c.last.matching.active, false);
    assert.equal(queued(srv), 0);
    assert.equal(srv.hub['matchTimer'], null);
  } finally { await srv.close(); }
});

test('two free players are matched together; bots take the other two seats', async () => {
  const srv = await testServer({ timings: { matchWaitMs: 300 } });
  try {
    const a = (await connect(srv.port, 'Ann')).c;
    const b = (await connect(srv.port, 'Ben')).c;
    a.send({ t: 'quickPlay' });
    await a.waitFor((m) => m.t === 'matching' && m.active);
    b.send({ t: 'quickPlay' });
    const upd = await a.waitFor((m) => m.t === 'matching' && m.active && m.waiting === 2);
    assert.equal(upd.waiting, 2, 'the first player sees the second arrive');
    const ta = await a.waitFor((m) => m.t === 'table', 8000);
    const tb = await b.waitFor((m) => m.t === 'table', 8000, true);
    assert.equal(ta.id, tb.id, 'same table');
    assert.equal(humans(ta), 2);
    assert.equal(ta.seats.filter((s: any) => s.kind === 'bot').length, 2);
    assert.equal(ta.practice, false);
    assert.equal(ta.isPublic, false, 'unlisted: nobody else can pick this table from the lobby');
    assert.match((await a.waitFor((m) => m.t === 'notice' && m.kind === 'match', 8000, true)).message, /2 players found/);
    assert.notEqual(ta.mySeat, tb.mySeat);
    assert.equal((srv.hub.lobbyMessage() as any).tables.length, 0);
  } finally { await srv.close(); }
});

test('four queued free players start at once with no bots, and the queue is empty', async () => {
  const srv = await testServer({ timings: { matchWaitMs: 60000 } }); // would wait a minute: the fourth player starts it
  try {
    const cs: Client[] = [];
    for (const n of ['P1', 'P2', 'P3', 'P4']) { cs.push((await connect(srv.port, n)).c); }
    for (const c of cs) { c.send({ t: 'quickPlay' }); await sleep(20); }
    const tables = await Promise.all(cs.map((c) => c.waitFor((m) => m.t === 'table', 5000, true)));
    assert.equal(new Set(tables.map((t) => t.id)).size, 1);
    assert.equal(humans(tables[0]), 4);
    assert.match((await cs[0].waitFor((m) => m.t === 'notice' && m.kind === 'match', 5000, true)).message, /Four players found/);
    assert.equal(queued(srv), 0);
    assert.equal(srv.hub['matchTimer'], null, 'the wait timer is cleared');
  } finally { await srv.close(); }
});

test('a fifth player starts a new queue; the first four are not disturbed', async () => {
  const srv = await testServer({ timings: { matchWaitMs: 60000 } });
  try {
    const cs: Client[] = [];
    for (const n of ['P1', 'P2', 'P3', 'P4', 'P5']) cs.push((await connect(srv.port, n)).c);
    for (const c of cs) { c.send({ t: 'quickPlay' }); await sleep(20); }
    await cs[3].waitFor((m) => m.t === 'table', 5000, true);
    assert.equal(queued(srv), 1);
    assert.equal(cs[4].log.some((m) => m.t === 'table'), false);
    assert.equal(cs[4].last.matching.waiting, 1);
  } finally { await srv.close(); }
});

test('cancel leaves the queue; a disconnect leaves it too; the wait timer stops when nobody is left', async () => {
  const srv = await testServer({ timings: { matchWaitMs: 700 } });
  try {
    const a = (await connect(srv.port, 'Ann')).c;
    const b = (await connect(srv.port, 'Ben')).c;
    a.send({ t: 'quickPlay' });
    b.send({ t: 'quickPlay' });
    await b.waitFor((m) => m.t === 'matching' && m.active && m.waiting === 2);
    a.send({ t: 'cancelMatch' });
    await a.waitFor((m) => m.t === 'matching' && m.active === false);
    assert.equal(queued(srv), 1);
    assert.equal((await b.waitFor((m) => m.t === 'matching' && m.active && m.waiting === 1, 8000, true)).waiting, 1, 'the one still waiting is told');
    // Ann can queue again later, and can do something else after cancelling (she is no longer busy)
    a.send({ t: 'createTable', isPublic: true, target: 250, practice: true });
    await a.waitFor((m) => m.t === 'table');
    a.send({ t: 'leaveTable' });
    await a.waitFor((m) => m.t === 'left');
    b.ws.terminate(); // disconnecting also leaves the queue
    await sleep(80);
    assert.equal(queued(srv), 0);
    assert.equal(srv.hub['matchTimer'], null);
    await sleep(800);
    assert.equal(srv.hub['tables'].size, 0, 'no table is created for someone who left');
    a.send({ t: 'cancelMatch' }); // cancelling when not queued is harmless
    await sleep(30);
  } finally { await srv.close(); }
});

test('while queued: no other table actions; pressing Quick play again just re-shows the wait', async () => {
  const srv = await testServer({ devUnlock: true, timings: { matchWaitMs: 60000 } });
  try {
    const host = await connectPremium(srv.port, 'Host');
    host.c.send({ t: 'createTable', isPublic: true, target: 250 });
    const ht = await host.c.waitFor((m) => m.t === 'table');
    const { c } = await connect(srv.port, 'Free');
    c.send({ t: 'quickPlay' });
    await c.waitFor((m) => m.t === 'matching' && m.active);
    const n = c.log.filter((m) => m.t === 'matching').length;
    c.send({ t: 'quickPlay' });
    await c.waitFor(() => c.log.filter((m) => m.t === 'matching').length > n);
    assert.equal(queued(srv), 1, 'not queued twice');
    c.send({ t: 'createTable', isPublic: true, target: 250, practice: true });
    assert.match((await err(c, 'busy')).message, /finding players/i);
    c.send({ t: 'watchTable', id: ht.id });
    await c.waitFor((m) => m.t === 'error' && m.code === 'busy' && c.log.filter((x) => x.t === 'error').length === 2);
    c.send({ t: 'cancelMatch' });
    c.send({ t: 'watchTable', id: ht.id });
    await c.waitFor((m) => m.t === 'table' && m.spectator === true);
  } finally { await srv.close(); }
});

test('free players still cannot create, host or pick a table; joining a Premium host\'s code and watching still work', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await connectPremium(srv.port, 'Host');
    host.c.send({ t: 'createTable', isPublic: false, target: 250 });
    const ht = await host.c.waitFor((m) => m.t === 'table');
    const { c } = await connect(srv.port, 'Free');
    c.send({ t: 'createTable', isPublic: true, target: 250 });
    assert.equal((await err(c, 'upgrade_required')).message, inviteMessage());
    c.send({ t: 'createTable', isPublic: false, target: 250 });
    await c.waitFor((m) => m.t === 'error' && c.log.filter((x) => x.t === 'error').length === 2);
    c.send({ t: 'createTournament', size: 4, isPublic: true });
    c.send({ t: 'createEvent', tables: 2 });
    c.send({ t: 'joinTable', id: ht.id });
    await c.waitFor((m) => m.t === 'error' && c.log.filter((x) => x.t === 'error').length === 5);
    assert.ok(c.log.filter((m) => m.t === 'error').every((m) => m.code === 'upgrade_required'));
    assert.equal(queued(srv), 0, 'none of that touches the queue');
    c.send({ t: 'joinCode', code: ht.code }); // an invite from a Premium host is still fine
    const joined = await c.waitFor((m) => m.t === 'table' && m.id === ht.id);
    assert.equal(joined.mySeat >= 0, true);
  } finally { await srv.close(); }
});

test('Premium quickPlay is unchanged: no queue, an open public table or a public table with bots at once', async () => {
  const srv = await testServer({ devUnlock: true, timings: { matchWaitMs: 60000 } });
  try {
    const p = await connectPremium(srv.port, 'Prem');
    p.c.send({ t: 'quickPlay' });
    const t = await p.c.waitFor((m) => m.t === 'table', 3000);
    assert.equal(t.isPublic, true);
    assert.equal(humans(t), 1);
    assert.equal(queued(srv), 0);
  } finally { await srv.close(); }
});

test('CONFIG.freeRandomMatch = false gives the old solo game against bots, with no waiting', async () => {
  const srv = await testServer({ timings: { matchWaitMs: 60000 } });
  const saved = CONFIG.freeRandomMatch;
  (CONFIG as any).freeRandomMatch = false;
  try {
    const { c } = await connect(srv.port, 'Solo');
    c.send({ t: 'quickPlay' });
    const t = await c.waitFor((m) => m.t === 'table', 3000);
    assert.equal(t.practice, true);
    assert.equal(queued(srv), 0);
  } finally { (CONFIG as any).freeRandomMatch = saved; await srv.close(); }
});
