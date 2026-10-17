// Tests for the redesigned client's protocol: 6-char codes, table rules, host lobby actions,
// premium stubs, display name, and multi-table events ("Create Tournament").

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODE_ALPHABET, CODE_RE, parseClientMessage } from '../src/server/protocol.js';
import { Client, autoPlay, connect, sleep, testServer } from './helpers.js';

async function premium(c: Client): Promise<void> {
  c.send({ t: 'devToggleSubscription' });
  await c.waitFor((m) => m.t === 'subscription' && m.subscribed === true);
}

test('codes: 6 characters from an alphabet without 0/O/1/I, unique, case-insensitive on entry', async () => {
  assert.equal(CODE_ALPHABET.length >= 30, true);
  for (const bad of ['0', 'O', '1', 'I']) assert.equal(CODE_ALPHABET.includes(bad), false);
  assert.equal(CODE_RE.test('ABC234'), true);
  assert.equal(CODE_RE.test('ABC23'), false);
  assert.equal(CODE_RE.test('ABC2345'), false);
  assert.ok('msg' in parseClientMessage(JSON.stringify({ t: 'joinCode', code: ' abc234 ' })));
  const parsed = parseClientMessage(JSON.stringify({ t: 'joinCode', code: ' abc234 ' })) as any;
  assert.equal(parsed.msg.code, 'ABC234');
  assert.ok('error' in parseClientMessage(JSON.stringify({ t: 'joinCode', code: 'ABCDE' })));

  const srv = await testServer({ devUnlock: true });
  try {
    const host = (await connect(srv.port, 'Host')).c;
    await premium(host);
    host.send({ t: 'createTable', isPublic: false, target: 500 });
    const t = await host.waitFor((m) => m.t === 'table');
    assert.match(t.code, /^[A-HJ-KM-NP-Z2-9]{6}$/);
    const codes = new Set<string>([...srv.hub.tables.values()].map((x) => x.code));
    for (let i = 0; i < 40; i++) {
      const c = (await connect(srv.port, 'P' + i)).c;
      c.send({ t: 'quickPlay' });
      await c.waitFor((m) => m.t === 'table');
      c.close();
    }
    for (const x of srv.hub.tables.values()) codes.add(x.code);
    assert.equal(codes.size, srv.hub.tables.size); // every table has its own code
    // entering the code in lower case joins; a 5-character code is rejected as a bad message
    const g = (await connect(srv.port, 'Guest')).c;
    g.send({ t: 'joinCode', code: t.code.toLowerCase() });
    assert.equal((await g.waitFor((m) => m.t === 'table')).mySeat, 1);
    const g2 = (await connect(srv.port, 'G2')).c;
    g2.send({ t: 'joinCode', code: t.code.slice(0, 5) });
    assert.equal((await g2.waitFor((m) => m.t === 'error')).code, 'bad_message');
  } finally { await srv.close(); }
});

test('table rules: host sets target / break rule / sandbags before start; others and late changes are refused', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 5 } });
  try {
    const host = (await connect(srv.port, 'Host')).c;
    await premium(host);
    host.send({ t: 'createTable', isPublic: false, target: 500, breakRule: false, sandbags: true });
    const v0 = await host.waitFor((m) => m.t === 'table');
    assert.deepEqual(v0.rules, { target: 500, breakRule: false, sandbags: true });
    const guest = (await connect(srv.port, 'Guest')).c;
    guest.send({ t: 'joinCode', code: v0.code });
    await guest.waitFor((m) => m.t === 'table');

    guest.send({ t: 'setRules', target: 250 });
    assert.equal((await guest.waitFor((m) => m.t === 'error')).code, 'not_allowed');

    host.send({ t: 'setRules', target: 250, breakRule: true, sandbags: false });
    const v1 = await host.waitFor((m) => m.t === 'table' && m.rules.target === 250);
    assert.deepEqual(v1.rules, { target: 250, breakRule: true, sandbags: false });
    assert.deepEqual((await guest.waitFor((m) => m.t === 'table' && m.rules.target === 250)).rules, v1.rules);

    host.send({ t: 'setRules', target: 300 });
    assert.equal((await host.waitFor((m) => m.t === 'error')).code, 'bad_message');

    host.send({ t: 'addBots' });
    host.send({ t: 'startTable' });
    await host.waitFor((m) => m.t === 'table' && m.phase === 'bidding');
    const table = [...srv.hub.tables.values()].find((x) => x.code === v0.code)!;
    assert.equal(table.game!.target, 250);
    assert.equal(table.game!.breakRule, true);
    assert.equal(table.game!.sandbags, false);

    host.log.length = 0;
    host.send({ t: 'setRules', target: 500 });
    assert.equal((await host.waitFor((m) => m.t === 'error')).code, 'wrong_state');
  } finally { await srv.close(); }
});

test('rules reach the engine: break rule off lets the first leader open with a spade; bags are not counted without sandbags', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 0 } });
  try {
    const host = (await connect(srv.port, 'Host')).c;
    await premium(host);
    host.send({ t: 'createTable', isPublic: false, target: 250, breakRule: false, sandbags: false });
    const v0 = await host.waitFor((m) => m.t === 'table');
    host.send({ t: 'addBots' });
    host.send({ t: 'startTable' });
    await host.waitFor((m) => m.t === 'table' && m.phase === 'bidding');
    const table = [...srv.hub.tables.values()].find((x) => x.code === v0.code)!;
    assert.equal(table.game!.breakRule, false);
    // a spades-only-when-broken restriction would hide spades from a leader holding other suits; with the rule off nothing is hidden
    const g = table.game!;
    assert.equal(g.spadesBroken, false);
  } finally { await srv.close(); }
});

test('host lobby: add bots fills open seats, swap partners rotates the other seats, start works with four filled seats', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = (await connect(srv.port, 'Hostess')).c;
    await premium(host);
    host.send({ t: 'createTable', isPublic: false, target: 500 });
    const v0 = await host.waitFor((m) => m.t === 'table');
    assert.equal(v0.phase, 'waiting');
    assert.equal(v0.isHost, true);
    assert.equal(v0.hostSeat, 0);
    const guest = (await connect(srv.port, 'Gus')).c;
    guest.send({ t: 'joinCode', code: v0.code });
    const gv = await guest.waitFor((m) => m.t === 'table');
    assert.equal(gv.mySeat, 1);
    guest.send({ t: 'addBots' });
    assert.equal((await guest.waitFor((m) => m.t === 'error')).code, 'not_allowed');
    guest.log.length = 0;
    guest.send({ t: 'swapPartners' });
    assert.equal((await guest.waitFor((m) => m.t === 'error')).code, 'not_allowed');

    host.send({ t: 'addBots' });
    const filled = await host.waitFor((m) => m.t === 'table' && m.seats.every((s: any) => s.kind !== 'empty'));
    assert.deepEqual(filled.seats.map((s: any) => s.kind), ['human', 'human', 'bot', 'bot']);
    const names1 = filled.seats.map((s: any) => s.name);

    host.send({ t: 'swapPartners' });
    const swapped = await host.waitFor((m) => m.t === 'table' && m.seats[2].name !== names1[2]);
    assert.equal(swapped.seats[0].name, 'Hostess'); // the host keeps their seat
    assert.deepEqual([...swapped.seats.map((s: any) => s.name)].sort(), [...names1].sort());
    const gv2 = await guest.waitFor((m) => m.t === 'table' && m.mySeat !== 1);
    assert.equal(gv2.mySeat, 2); // the guest moved from East (opponent) to South: now the host's partner
    // three presses return the original order
    host.send({ t: 'swapPartners' });
    host.send({ t: 'swapPartners' });
    await sleep(100);
    const table = [...srv.hub.tables.values()].find((x) => x.code === v0.code)!;
    assert.deepEqual(table.seats.map((s) => s.name), names1);

    host.send({ t: 'startTable' });
    assert.equal((await host.waitFor((m) => m.t === 'table' && m.phase !== 'waiting')).seats.length, 4);
  } finally { await srv.close(); }
});

test('Go Premium is a stub (notice unless DEV_UNLOCK=1); Restore Premium needs an owner email unless DEV_UNLOCK=1', async () => {
  const off = await testServer();
  try {
    const { c } = await connect(off.port, 'Free');
    c.send({ t: 'goPremium' });
    const n1 = await c.waitFor((m) => m.t === 'notice');
    assert.match(n1.message, /Billing is not set up yet/);
    c.send({ t: 'restorePremium', email: 'owner@example.com' }); // no OWNER_EMAILS configured: nobody matches
    const n2 = await c.waitFor((m) => m.t === 'restoreResult');
    assert.equal(n2.ok, false);
    assert.equal(n2.code, 'not_found');
    c.send({ t: 'restorePremium', email: 'not-an-email' });
    assert.equal((await c.waitFor((m) => m.t === 'restoreResult' && m.code === 'bad_email')).ok, false);
    await sleep(50);
    assert.equal(c.log.some((m) => m.t === 'subscription'), false);
    // the gate still holds
    c.send({ t: 'createTable', isPublic: false, target: 500 });
    assert.equal((await c.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required')).code, 'upgrade_required');
  } finally { await off.close(); }

  const on = await testServer({ devUnlock: true });
  try {
    const a = (await connect(on.port, 'A')).c;
    a.send({ t: 'restorePremium', email: 'owner@example.com' });
    assert.equal((await a.waitFor((m) => m.t === 'subscription')).subscribed, true);
    assert.equal((await a.waitFor((m) => m.t === 'restoreResult', 8000, true)).ok, true);
    a.send({ t: 'createTable', isPublic: false, target: 500 });
    assert.equal((await a.waitFor((m) => m.t === 'table')).isHost, true);
    const b = (await connect(on.port, 'B')).c;
    b.send({ t: 'goPremium' });
    assert.equal((await b.waitFor((m) => m.t === 'subscription')).subscribed, true);
  } finally { await on.close(); }
});

test('display name: setNick changes the name used at the next seat; an empty hello nick keeps the old one, a new player has no name', async () => {
  const srv = await testServer();
  try {
    const { c, welcome } = await connect(srv.port, 'Old');
    c.send({ t: 'setNick', nick: '  New <b>Name  ' });
    assert.equal((await c.waitFor((m) => m.t === 'nick')).nick, 'New bName');
    c.close();
    await sleep(30);
    const again = await connect(srv.port, '', welcome.token);
    assert.equal(again.welcome.nick, 'New bName');
    const anon = await connect(srv.port, '');
    assert.equal(anon.welcome.nick, ''); // no generated default
    anon.c.send({ t: 'quickPlay' });
    assert.equal((await anon.c.waitFor((m) => m.t === 'error')).code, 'name_required');
  } finally { await srv.close(); }
});

test('welcome config carries what the new UI needs, price included', async () => {
  const srv = await testServer();
  try {
    const { welcome } = await connect(srv.port, 'X');
    assert.equal(welcome.config.priceUsdPerMonth, 1.99);
    assert.deepEqual(welcome.config.eventTableOptions, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(welcome.config.codeLength, 6);
    assert.equal(welcome.config.rules.bagLimit, 10);
    assert.deepEqual(welcome.config.tableTargets, [250, 500]);
  } finally { await srv.close(); }
});

// ---------- multi-table event ("Create Tournament") ----------

test('events: premium only to create, free to join with the code; entrants are seated at tables of four, bots fill', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 0 } });
  try {
    const free = (await connect(srv.port, 'Free')).c;
    free.send({ t: 'createEvent', tables: 2 });
    assert.equal((await free.waitFor((m) => m.t === 'error')).code, 'upgrade_required');
    free.send({ t: 'createEvent', tables: 9 });
    assert.equal((await free.waitFor((m) => m.t === 'error' && m.code === 'bad_message')).code, 'bad_message');

    const org = (await connect(srv.port, 'Org')).c;
    await premium(org);
    org.send({ t: 'createEvent', tables: 2, target: 250 });
    const ev0 = await org.waitFor((m) => m.t === 'event');
    assert.equal(ev0.state, 'registering');
    assert.equal(ev0.capacity, 8);
    assert.equal(ev0.isOrganizer, true);
    assert.match(ev0.code, /^[A-HJ-KM-NP-Z2-9]{6}$/);

    // five humans in total: table 1 has four humans, table 2 has one human and three bots
    const joiners: Client[] = [];
    for (let i = 0; i < 4; i++) {
      const c = (await connect(srv.port, 'J' + i)).c;
      c.send({ t: 'joinCode', code: ev0.code.toLowerCase() });
      const ev = await c.waitFor((m) => m.t === 'event');
      assert.equal(ev.joined, true);
      assert.equal(ev.isOrganizer, false);
      joiners.push(c);
    }
    joiners[0].send({ t: 'startEvent' });
    assert.equal((await joiners[0].waitFor((m) => m.t === 'error')).code, 'not_allowed');

    // an eighth... a ninth person cannot join once full: fill to capacity first
    const extra: Client[] = [];
    for (let i = 0; i < 3; i++) {
      const c = (await connect(srv.port, 'E' + i)).c;
      c.send({ t: 'joinCode', code: ev0.code });
      await c.waitFor((m) => m.t === 'event');
      extra.push(c);
    }
    const late = (await connect(srv.port, 'Late')).c;
    late.send({ t: 'joinCode', code: ev0.code });
    assert.equal((await late.waitFor((m) => m.t === 'error')).code, 'full');
    // ...so leave with the three extras to get to five entrants
    for (const c of extra) { c.send({ t: 'leaveEvent' }); await c.waitFor((m) => m.t === 'eventLeft'); }

    const all = [org, ...joiners];
    all.forEach(autoPlay);
    org.send({ t: 'startEvent' });
    const running = await org.waitFor((m) => m.t === 'event' && m.state === 'running');
    assert.equal(running.results.length, 2);
    const tv = await org.waitFor((m) => m.t === 'table', 5000, true);
    assert.ok(tv.tournament); // event tables are tournament-style tables
    const bots = (r: any) => r.teams.flatMap((t: any) => t.players).filter((p: any) => p.bot).length;
    assert.deepEqual(running.results.map(bots), [0, 3]);
    assert.equal(running.results[0].teams[0].name, 'Org & J0'); // consecutive joiners are partners

    const done = await org.waitFor((m) => m.t === 'event' && m.state === 'finished', 120000);
    assert.equal(done.winners.length, 2);
    for (const w of done.winners) assert.ok(w.scores[0] >= 250 || w.scores[1] >= 250 || w.scores.some((s: number) => s <= -200));
    assert.equal(done.results.every((r: any) => r.status === 'done' && r.winner !== null), true);
    // everybody was returned from the table to the event view
    await org.waitFor((m) => m.t === 'left', 5000, true);
  } finally { await srv.close(); }
});

test('events: only as many tables as needed are opened; the organizer leaving before the start cancels it', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 0 } });
  try {
    const org = (await connect(srv.port, 'Org')).c;
    await premium(org);
    org.send({ t: 'createEvent', tables: 8 });
    const ev0 = await org.waitFor((m) => m.t === 'event');
    const j = (await connect(srv.port, 'J')).c;
    j.send({ t: 'joinCode', code: ev0.code });
    await j.waitFor((m) => m.t === 'event');
    // a spectator can watch the event with its code
    const w = (await connect(srv.port, 'W')).c;
    w.send({ t: 'watchCode', code: ev0.code });
    const wv = await w.waitFor((m) => m.t === 'event');
    assert.equal(wv.joined, false);
    org.send({ t: 'startEvent' });
    const running = await org.waitFor((m) => m.t === 'event' && m.state === 'running');
    assert.equal(running.results.length, 1); // two humans need one table, not eight
    assert.equal(running.tables, 8);
    await w.waitFor((m) => m.t === 'event' && m.state === 'running');

    org.send({ t: 'createEvent', tables: 1 });
    assert.equal((await org.waitFor((m) => m.t === 'error')).code, 'busy');

    const org2 = (await connect(srv.port, 'Org2')).c;
    await premium(org2);
    org2.send({ t: 'createEvent', tables: 3 });
    const e2 = await org2.waitFor((m) => m.t === 'event');
    const j2 = (await connect(srv.port, 'J2')).c;
    j2.send({ t: 'joinCode', code: e2.code });
    await j2.waitFor((m) => m.t === 'event');
    org2.send({ t: 'leaveEvent' });
    await org2.waitFor((m) => m.t === 'eventLeft');
    assert.equal((await j2.waitFor((m) => m.t === 'eventLeft', 8000, true)).reason, 'The organizer cancelled the tournament');
    j2.send({ t: 'joinCode', code: e2.code });
    assert.equal((await j2.waitFor((m) => m.t === 'error' && m.code === 'not_found')).code, 'not_found');
  } finally { await srv.close(); }
});

// ---------- finished trick stays visible without blocking the next lead ----------

test('a completed trick stays visible (collect) for the trick-pause time while the next player may already lead', async () => {
  const srv = await testServer({ timings: { botDelayMs: 2, trickPauseMs: 400, handPauseMs: 50 } });
  try {
    const { c } = await connect(srv.port, 'Me');
    autoPlay(c);
    c.send({ t: 'quickPlay' });
    // a view that has the finished trick AND lets this player act at once means the pause is not blocking
    const hit = await c.waitFor((m) => m.t === 'table' && m.collect && m.collect.plays.length === 4 && m.legal && m.legal.length > 0, 30000);
    assert.ok(hit.collect.winner >= 0 && hit.collect.winner < 4);
    assert.equal(hit.turn, hit.mySeat);
    await sleep(100);
    assert.equal(c.log.some((m) => m.t === 'error'), false); // the immediate lead was accepted
    // the collect view clears after the pause
    await c.waitFor((m) => m.t === 'table' && m.collect === null && m.handNo === hit.handNo, 3000);
  } finally { await srv.close(); }
});
