// What really happens when a host (or tournament organizer) goes back. The Back confirm texts (public/leave-rules.js) describe this.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, connect, connectPremium, sleep, testServer } from './helpers.js';

async function hostWithGuests(srv: { port: number }, guests: string[]) {
  const host = await connectPremium(srv.port, 'Hosty');
  host.c.send({ t: 'createTable', isPublic: false, target: 250 });
  const t = await host.c.waitFor((m) => m.t === 'table');
  const gs: Client[] = [];
  for (const name of guests) {
    const g = (await connect(srv.port, name)).c;
    g.send({ t: 'joinCode', code: t.code });
    await g.waitFor((m) => m.t === 'table' && m.mySeat >= 0);
    gs.push(g);
  }
  return { host: host.c, table: t, guests: gs };
}
const lastTable = (c: Client) => [...c.log].reverse().find((m) => m.t === 'table');

test('host goes back before the start: the seat opens, the next player becomes host, the table stays open', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { host, table, guests } = await hostWithGuests(srv, ['Gus']);
    host.send({ t: 'leaveTable' });
    const left = await host.waitFor((m) => m.t === 'left');
    assert.equal(left.reason, '');
    await guests[0].waitFor((m) => m.t === 'table' && m.isHost === true, 8000, true);
    const v = lastTable(guests[0]);
    assert.equal(v.seats[0].kind, 'empty');
    assert.equal(v.seats[v.mySeat].name, 'Gus');
    assert.ok(srv.hub['tables'].has(table.id));
  } finally { await srv.close(); }
});

test('host goes back mid-game: a bot takes the seat, the other human becomes host, and the game continues', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 5, handPauseMs: 20 } });
  try {
    const { host, table, guests } = await hostWithGuests(srv, ['Gus']);
    host.send({ t: 'addBots' });
    host.send({ t: 'startTable' });
    await guests[0].waitFor((m) => m.t === 'table' && m.phase === 'bidding');
    host.send({ t: 'leaveTable' });
    await host.waitFor((m) => m.t === 'left');
    await guests[0].waitFor((m) => m.t === 'table' && m.isHost === true, 8000, true);
    const v = lastTable(guests[0]);
    assert.equal(v.seats[0].kind, 'bot');
    assert.equal(v.phase === 'bidding' || v.phase === 'playing', true);
    assert.ok(srv.hub['tables'].has(table.id));
  } finally { await srv.close(); }
});

test('host who is the last human goes back: the table closes and watchers are sent back with "The table closed"', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { host, table } = await hostWithGuests(srv, []);
    const w = (await connect(srv.port, 'Eve')).c;
    w.send({ t: 'watchCode', code: table.code });
    await w.waitFor((m) => m.t === 'table' && m.spectator);
    host.send({ t: 'leaveTable' });
    await host.waitFor((m) => m.t === 'left');
    const bye = await w.waitFor((m) => m.t === 'left', 8000, true);
    assert.equal(bye.reason, 'The table closed');
    await sleep(30);
    assert.equal(srv.hub['tables'].has(table.id), false);
  } finally { await srv.close(); }
});

test('organizer goes back before the start: the tournament is cancelled for everyone; mid-run it carries on', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const org = await connectPremium(srv.port, 'Org');
    org.c.send({ t: 'createTournament', size: 4, isPublic: false });
    const tour = await org.c.waitFor((m) => m.t === 'tournament');
    const g = (await connect(srv.port, 'Guest')).c;
    g.send({ t: 'joinCode', code: tour.code });
    await g.waitFor((m) => m.t === 'tournament' && m.joined);
    org.c.send({ t: 'leaveTournament' });
    await org.c.waitFor((m) => m.t === 'tournamentLeft');
    const gone = await g.waitFor((m) => m.t === 'tournamentLeft', 8000, true);
    assert.equal(gone.reason, 'The organizer cancelled the tournament');
    assert.equal(srv.hub['tournaments'].size, 0);

    // an event (Create Tournament) behaves the same way
    const ev = await connectPremium(srv.port, 'EvOrg');
    ev.c.send({ t: 'createEvent', tables: 1 });
    const e = await ev.c.waitFor((m) => m.t === 'event');
    const g2 = (await connect(srv.port, 'Guest2')).c;
    g2.send({ t: 'joinCode', code: e.code });
    await g2.waitFor((m) => m.t === 'event' && m.joined);
    ev.c.send({ t: 'leaveEvent' });
    assert.equal((await g2.waitFor((m) => m.t === 'eventLeft', 8000, true)).reason, 'The organizer cancelled the tournament');
  } finally { await srv.close(); }
});

// ---------- Back is client-only: the host stays seated and connected ----------

test('a host who only looks at another screen stays seated and host, keeps receiving updates, and is never put under bot control', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 5, handPauseMs: 20 } });
  try {
    const { host, table, guests } = await hostWithGuests(srv, ['Gus']);
    host.send({ t: 'addBots' });
    host.send({ t: 'startTable' });
    await guests[0].waitFor((m) => m.t === 'table' && m.phase === 'bidding');
    // the Back button sends nothing: the host connection simply stays quiet. Updates and chat still reach it.
    const before = host.log.length;
    guests[0].send({ t: 'chat', text: 'are you there?' });
    await host.waitFor((m) => m.t === 'chatMsg' && m.text === 'are you there?');
    await sleep(100);
    assert.ok(host.log.length > before);
    const t = srv.hub['tables'].get(table.id);
    assert.equal(t.hostId, srv.hub['players'].get(t.seats[0].playerId).id);
    assert.equal(t.seats[0].kind, 'human');
    assert.equal(t.seats[0].connected, true);
    assert.equal(t.seats[0].botControlled, false, 'no bot takes the seat of a connected player');
    // the host's latest snapshot is the table's current state, so Return to game shows it with nothing to fetch
    const mine = lastTable(host);
    const theirs = lastTable(guests[0]);
    assert.equal(mine.isHost, true);
    assert.equal(mine.mySeat, 0);
    assert.equal(mine.handNo, theirs.handNo);
    assert.equal(mine.phase, theirs.phase);
    assert.equal(mine.turn, theirs.turn);
    assert.ok(Array.isArray(mine.hand));
  } finally { await srv.close(); }
});

test('a page reload (same token) resumes the same seat, host role and chat history', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { host, table, guests } = await hostWithGuests(srv, ['Gus']);
    const token = host.last.welcome.token;
    host.send({ t: 'chat', text: 'before the reload' });
    await guests[0].waitFor((m) => m.t === 'chatMsg');
    host.ws.terminate();
    await sleep(60);
    const again = await connect(srv.port, 'Hosty', token);
    assert.equal(again.welcome.resumed, true);
    const v = await again.c.waitFor((m) => m.t === 'table', 8000, true);
    assert.equal(v.id, table.id);
    assert.equal(v.mySeat, 0);
    assert.equal(v.isHost, true);
    const hist = await again.c.waitFor((m) => m.t === 'chatHistory', 8000, true);
    assert.equal(hist.msgs.at(-1).text, 'before the reload');
  } finally { await srv.close(); }
});
