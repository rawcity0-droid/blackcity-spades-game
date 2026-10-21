// Tournament teams before the start: the organizer's team codes (one per team, 2 people per code),
// solo joins filling open teams, organizer swap / make partners / split, leaving before the start,
// and the bracket / event tables honoring the teams.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/engine/cards.js';
import { Tournament, TournamentHost } from '../src/server/tournament.js';
import { TableEvent } from '../src/server/event.js';
import { connect, connectPremium, testServer } from './helpers.js';

const host = (): TournamentHost => ({ createMatchTable: () => ({ id: 'tbl', code: 'CODE1' }), changed() {} });
function tour(size = 4) {
  const t = new Tournament({ id: 'a', code: 'ABCDE', size, organizerId: 'org', isPublic: false, host: host(), rng: mulberry32(1) });
  t.pairing.setCodes(Array.from({ length: size }, (_, i) => `TM${i + 1}`));
  t.join('org', 'Org', 'TM1');
  return t;
}
const names = (t: Tournament | TableEvent) => t.pairing.teams().map((x) => x.join('+'));
const key = (t: Tournament | TableEvent, pid: string) => t.entrants.find((e) => e.playerId === pid)!.key;

test('team codes: two people per code are partners, a 3rd is turned away; the organizer is in Team 1', () => {
  const t = tour();
  assert.equal(t.join('a', 'Ann', 'TM2').ok, true);
  assert.equal(t.join('b', 'Ben', 'TM2').ok, true);
  const r = t.join('c', 'Cal', 'TM2');
  assert.equal(r.ok, false); assert.equal(!r.ok && r.code, 'full');
  assert.equal(t.join('c', 'Cal', 'TM1').ok, true);
  assert.deepEqual(names(t), ['org+c', 'a+b']);
});

test('solo joins fill open teams from the end, two solos together; organizer sees every code, players none', () => {
  const t = tour();
  t.join('s1', 'Sam'); t.join('s2', 'Sue'); t.join('s3', 'Sky');
  assert.deepEqual(names(t), ['org', 's3', 's1+s2']);
  const vo = t.view('org') as any;
  assert.deepEqual(vo.teams.map((x: any) => x.code), ['TM1', 'TM2', 'TM3', 'TM4']);
  assert.deepEqual(vo.teams.map((x: any) => x.fill), ['1 of 2', 'empty', '1 of 2', 'full']);
  const vp = t.view('s1') as any;
  assert.ok(vp.teams.every((x: any) => x.code === null));
  assert.equal(vp.teams.length, 3); // empty teams are hidden from players
});

test('organizer swap, make partners and split; others cannot edit; locked after start', () => {
  const t = tour();
  t.join('a', 'Ann', 'TM2'); t.join('b', 'Ben', 'TM2'); t.join('c', 'Cal', 'TM1');
  assert.equal(t.arrange('a', 'swap', key(t, 'b'), key(t, 'c')).ok, false);
  assert.equal(t.arrange('org', 'swap', key(t, 'b'), key(t, 'c')).ok, true);
  assert.deepEqual(names(t), ['org+b', 'a+c']);
  assert.equal(t.arrange('org', 'pair', key(t, 'org'), key(t, 'a')).ok, true);
  assert.deepEqual(names(t), ['org+a', 'c+b']);
  assert.equal(t.arrange('org', 'unpair', key(t, 'c')).ok, true);
  assert.deepEqual(names(t), ['org+a', 'c', 'b']);
  t.start('org');
  assert.equal(t.arrange('org', 'unpair', key(t, 'org')).ok, false);
});

test('leaving before the start leaves the partner alone in the team; the spot opens for the code again', () => {
  const t = tour();
  t.join('a', 'Ann', 'TM2'); t.join('b', 'Ben', 'TM2');
  t.leave('a');
  assert.deepEqual(names(t), ['org', 'b']);
  assert.equal(t.join('d', 'Dee', 'TM2').ok, true);
  assert.equal(t.pairing.partnerOf('b'), 'd');
});

test('build() makes the bracket from the teams; a lone player gets a named computer partner', () => {
  const t = tour(4);
  t.join('a', 'Ann', 'TM2'); t.join('c', 'Cal', 'TM2'); t.join('d', 'Dee', 'TM1'); t.join('b', 'Ben', 'TM3');
  assert.equal(t.start('org').ok, true);
  const teams = t.rounds[0].flatMap((m) => m.teams).map((x) => x!.slots.map((s) => s.playerId ?? 'cpu').join('+'));
  assert.ok(teams.includes('org+d')); assert.ok(teams.includes('a+c')); assert.ok(teams.includes('b+cpu'));
  const lone = t.rounds[0].flatMap((m) => m.teams).find((x) => x!.slots[0].playerId === 'b')!;
  assert.ok(lone.slots[1].name.length > 0 && !/bot/i.test(lone.slots[1].name));
});

test('multi-table event: tables x 2 team codes; teams sit as partners (seats 0&2, 1&3)', () => {
  const seated: any[] = [];
  const ev = new TableEvent({ id: 'e', code: 'EVENT', tables: 2, target: 250, organizerId: 'org',
    host: { createEventTable: (_e, entry) => { seated.push(entry); return { id: 't' + seated.length, code: 'C' + seated.length }; }, changed() {} } });
  ev.pairing.setCodes(['E1', 'E2', 'E3', 'E4']);
  ev.join('org', 'Org', 'E1'); ev.join('a', 'Ann', 'E3'); ev.join('b', 'Ben', 'E3'); ev.join('c', 'Cal', 'E1');
  assert.equal((ev.view('org') as any).teams.length, 4);
  assert.equal(ev.start('org').ok, true);
  assert.equal(seated.length, 1); // two teams fit one table
  const s = seated[0].seats.map((x: any) => x.playerId);
  assert.deepEqual([s[0], s[2]], ['org', 'c']); assert.deepEqual([s[1], s[3]], ['a', 'b']);
});

test('through the server: organizer gets one code per team, partners join by code, everyone sees teams live', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { c: org } = await connectPremium(srv.port, 'Org');
    org.send({ t: 'createTournament', size: 4, isPublic: false });
    const v0 = await org.waitFor((m) => m.t === 'tournament');
    assert.equal(v0.teams.length, 4);
    assert.deepEqual(v0.teams[0].members.map((m: any) => m.name), ['Org']);
    const code2 = v0.teams[1].code;
    const { c: ann } = await connect(srv.port, 'Ann');
    const { c: cal } = await connect(srv.port, 'Cal');
    const { c: dee } = await connect(srv.port, 'Dee');
    ann.send({ t: 'joinCode', code: code2 });
    await ann.waitFor((m) => m.t === 'tournament');
    cal.send({ t: 'joinCode', code: code2 });
    const vc = await cal.waitFor((m) => m.t === 'tournament' && m.teams.some((x: any) => x.fill === 'full'));
    assert.deepEqual(vc.teams.find((x: any) => x.fill === 'full').members.map((m: any) => m.name), ['Ann', 'Cal']);
    assert.ok(vc.teams.every((x: any) => x.code === null));
    dee.send({ t: 'joinCode', code: code2 });
    assert.equal((await dee.waitFor((m) => m.t === 'error')).code, 'full');
    dee.send({ t: 'joinCode', code: v0.code }); // the plain code still works: solo
    const vo = await org.waitFor((m) => m.t === 'tournament' && m.teams.some((x: any) => x.members.some((y: any) => y.name === 'Dee')));
    assert.equal(vo.teams[3].members[0].name, 'Dee');
    org.close(); ann.close(); cal.close(); dee.close();
  } finally { await srv.close(); }
});
