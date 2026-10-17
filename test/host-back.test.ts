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
