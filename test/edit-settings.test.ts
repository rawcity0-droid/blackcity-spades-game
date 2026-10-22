// Organizer "Edit settings" before the start: bracket size / tables, target, bidding rule, public / private;
// joined players are kept, team codes follow the team count, and nothing can change after the start.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/engine/cards.js';
import { Tournament } from '../src/server/tournament.js';
import { TableEvent } from '../src/server/event.js';
import { parseClientMessage } from '../src/server/protocol.js';
import { connect, connectPremium, testServer } from './helpers.js';

let n = 0;
const codes = (k: number) => Array.from({ length: k }, () => `NEW${++n}`);

function tour(size: number) {
  const t = new Tournament({ id: 'a', code: 'ABCDE', size, organizerId: 'org', isPublic: false, host: { createMatchTable: () => ({ id: 'x', code: 'X' }), changed() {} }, rng: mulberry32(2) });
  t.pairing.setCodes(Array.from({ length: size }, (_, i) => `TM${i + 1}`));
  t.join('org', 'Org', 'TM1');
  return t;
}

test('bracket: grow keeps codes and adds new ones; shrink moves people from removed teams; too many people is refused', () => {
  const t = tour(4);
  t.join('a', 'Ann', 'TM4'); t.join('b', 'Ben', 'TM4');
  const g = t.edit('org', { size: 8 }, codes);
  assert.equal(g.ok, true);
  assert.equal(t.size, 8);
  assert.deepEqual(t.pairing.codes().slice(0, 4), ['TM1', 'TM2', 'TM3', 'TM4']);
  assert.equal(t.pairing.codes().length, 8);
  t.join('c', 'Cal', t.pairing.codes()[7]);
  const s = t.edit('org', { size: 4 }, codes);
  assert.equal(s.ok, true);
  assert.equal(s.ok && s.removedCodes.length, 4); // reported back to the hub, which drops them
  assert.equal(t.pairing.codes().length, 4);
  assert.equal(t.entrants.length, 4);
  assert.deepEqual(t.pairing.teams().flat().sort(), ['a', 'b', 'c', 'org']); // nobody lost
  assert.equal(t.pairing.partnerOf('a'), 'b'); // a pair stays together
  for (const p of ['d', 'e', 'f', 'g']) t.join(p, p.toUpperCase());
  const big = tour(8);
  for (const p of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) big.join(p, p);
  const r = big.edit('org', { size: 4 }, codes);
  assert.equal(r.ok, false); assert.match(!r.ok ? r.message : '', /10 people have joined, but 4 teams fit only 8/);
  assert.equal(big.size, 8);
});

test('bracket: bidding rule and public / private change; only the organizer; locked after the start', () => {
  const t = tour(4);
  assert.equal(t.edit('x', { jokers: true }, codes).ok, false);
  assert.equal(t.edit('org', { jokers: true, isPublic: true }, codes).ok, true);
  assert.equal(t.jokers, true); assert.equal(t.teamMin4, true); assert.equal(t.isPublic, true);
  assert.equal(t.edit('org', { teamMin4: false, jokers: false }, codes).ok, true);
  assert.equal(t.teamMin4, false); assert.equal(t.jokers, false);
  assert.equal(t.edit('org', { size: 5 }, codes).ok, false);
  t.start('org');
  const r = t.edit('org', { teamMin4: true }, codes);
  assert.equal(r.ok, false); assert.match(!r.ok ? r.message : '', /can’t be changed after the start/);
});

test('event: tables and target change; team codes are tables x 2; refuses when people would not fit', () => {
  const ev = new TableEvent({ id: 'e', code: 'EVENT', tables: 2, target: 250, organizerId: 'org', host: { createEventTable: () => ({ id: 't', code: 'C' }), changed() {} } });
  ev.pairing.setCodes(['E1', 'E2', 'E3', 'E4']);
  ev.join('org', 'Org', 'E1');
  for (const p of ['a', 'b', 'c', 'd']) ev.join(p, p);
  const r = ev.edit('org', { tables: 1 }, codes);
  assert.equal(r.ok, false); assert.match(!r.ok ? r.message : '', /5 people have joined, but 1 table seats only 4/);
  assert.equal(ev.edit('org', { tables: 3, target: 500, jokers: true }, codes).ok, true);
  assert.equal(ev.tables, 3); assert.equal(ev.target, 500); assert.equal(ev.jokers, true);
  assert.equal(ev.pairing.codes().length, 6);
  assert.deepEqual(ev.pairing.codes().slice(0, 4), ['E1', 'E2', 'E3', 'E4']);
  assert.equal(ev.capacity, 12);
  assert.equal(ev.edit('org', { target: 333 }, codes).ok, false);
});

test('protocol: editTournament / editEvent / setRules isPublic are validated', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'editTournament', size: 8, jokers: true })), { msg: { t: 'editTournament', size: 8, isPublic: undefined, teamMin4: undefined, jokers: true, setsOut: undefined, bigBids: undefined } });
  assert.ok('error' in parseClientMessage(JSON.stringify({ t: 'editEvent', tables: 'two' })));
  assert.ok('error' in parseClientMessage(JSON.stringify({ t: 'editTournament', isPublic: 'yes' })));
  assert.equal((parseClientMessage(JSON.stringify({ t: 'setRules', isPublic: true })) as any).msg.isPublic, true);
});

test('through the server: edit settings re-sends the view with new team codes; Premium needed; mid-game rule change says so', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { c: org } = await connectPremium(srv.port, 'Org');
    org.send({ t: 'createTournament', size: 4, isPublic: false });
    const v0 = await org.waitFor((m) => m.t === 'tournament');
    org.send({ t: 'editTournament', size: 8, jokers: true });
    const v1 = await org.waitFor((m) => m.t === 'tournament' && m.size === 8);
    assert.equal(v1.teams.length, 8); assert.equal(v1.jokers, true);
    assert.deepEqual(v1.teams.slice(0, 4).map((x: any) => x.code), v0.teams.map((x: any) => x.code));
    const { c: ann } = await connect(srv.port, 'Ann');
    ann.send({ t: 'joinCode', code: v1.teams[7].code }); // a new code works
    await org.waitFor((m) => m.t === 'tournament' && m.teams[7].fill === '1 of 2');
    org.send({ t: 'editTournament', size: 4 });
    const v2 = await org.waitFor((m) => m.t === 'tournament' && m.size === 4);
    assert.ok(v2.teams.some((x: any) => x.members.some((y: any) => y.name === 'Ann')));
    const { c: bo } = await connect(srv.port, 'Bo');
    bo.send({ t: 'joinCode', code: v1.teams[7].code }); // the removed team's code is gone
    assert.equal((await bo.waitFor((m) => m.t === 'error')).code, 'not_found');
    ann.send({ t: 'editTournament', size: 8 });
    assert.equal((await ann.waitFor((m) => m.t === 'error')).code, 'not_allowed'); // only the (Premium) organizer

    const { c: h } = await connectPremium(srv.port, 'Host');
    h.send({ t: 'createTable', isPublic: false, target: 500, practice: true });
    await h.waitFor((m) => m.t === 'table');
    h.send({ t: 'startTable' });
    await h.waitFor((m) => m.t === 'table' && m.phase !== 'waiting');
    h.send({ t: 'setRules', target: 250 });
    const e = await h.waitFor((m) => m.t === 'error');
    assert.match(e.message, /can’t be changed during a game/);
    org.close(); ann.close(); bo.close(); h.close();
  } finally { await srv.close(); }
});
