// Tournament teams before the start: player-made team codes, organizer swap / pair / unpair,
// leaving before the start, and the bracket / event tables honoring the teams.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/engine/cards.js';
import { Tournament, TournamentHost } from '../src/server/tournament.js';
import { TableEvent } from '../src/server/event.js';
import { connect, connectPremium, testServer } from './helpers.js';

const host = (): TournamentHost => ({ createMatchTable: () => ({ id: 'tbl', code: 'CODE1' }), changed() {} });
const tour = (size = 4) => new Tournament({ id: 'a', code: 'ABCDE', size, organizerId: 'org', isPublic: false, host: host(), rng: mulberry32(1) });
const names = (t: Tournament | TableEvent) => t.pairing.teams(t.entrants).map((x) => x.join('+'));
const key = (t: Tournament | TableEvent, pid: string) => t.entrants.find((e) => e.playerId === pid)!.key;

test('team code: the partner is locked in, solos pair in join order, a full team turns away a 3rd', () => {
  const t = tour();
  t.join('org', 'Org'); t.join('a', 'Ann');
  assert.equal(t.makeTeam('a', 'TEAM1').ok, true);
  t.join('b', 'Ben');
  assert.deepEqual(names(t), ['org+b', 'a']); // Ann waits for her partner; solos pair up
  assert.equal(t.join('c', 'Cal', 'TEAM1').ok, true);
  assert.deepEqual(names(t), ['org+b', 'a+c']);
  const r = t.join('d', 'Dee', 'TEAM1');
  assert.equal(r.ok, false); assert.equal(!r.ok && r.code, 'full');
  assert.equal(t.join('d', 'Dee', 'NOPE1').ok, false);
});

test('team codes hold a spot toward max entrants', () => {
  const t = tour(2); // 2 teams = 4 people
  t.join('org', 'Org'); t.join('a', 'Ann'); t.makeTeam('a', 'TEAM1'); t.join('b', 'Ben');
  assert.equal(t.join('x', 'Xi').ok, false); // the last spot is Ann's partner's
  assert.equal(t.join('c', 'Cal', 'TEAM1').ok, true);
});

test('organizer swap and pair override a team code; others cannot edit; locked after start', () => {
  const t = tour();
  t.join('org', 'Org'); t.join('a', 'Ann'); t.makeTeam('a', 'TEAM1'); t.join('c', 'Cal', 'TEAM1'); t.join('b', 'Ben');
  assert.deepEqual(names(t), ['org+b', 'a+c']);
  assert.equal(t.arrange('a', 'swap', key(t, 'b'), key(t, 'c')).ok, false);
  assert.equal(t.arrange('org', 'swap', key(t, 'b'), key(t, 'c')).ok, true);
  assert.deepEqual(names(t), ['org+c', 'a+b']);
  assert.equal(t.arrange('org', 'pair', key(t, 'org'), key(t, 'a')).ok, true);
  assert.deepEqual(names(t).sort(), ['c+b', 'org+a'].sort());
  t.start('org');
  assert.equal(t.arrange('org', 'unpair', key(t, 'org')).ok, false);
});

test('unpair splits a team; leaving before the start makes the partner solo', () => {
  const t = tour(8);
  t.join('org', 'Org'); t.join('a', 'Ann'); t.join('b', 'Ben'); t.join('c', 'Cal');
  t.arrange('org', 'pair', key(t, 'a'), key(t, 'b'));
  assert.deepEqual(names(t), ['org+c', 'a+b']);
  t.arrange('org', 'unpair', key(t, 'a'));
  assert.deepEqual(names(t), ['org+a', 'c+b']); // Ben moved to the end of the join order
  t.makeTeam('c', 'TEAM2'); t.join('d', 'Dee', 'TEAM2');
  t.leave('c');
  assert.equal(t.pairing.partnerOf('d'), undefined);
  assert.equal(t.join('e', 'Eve', 'TEAM2').ok, false); // the code stopped working
});

test('build() makes the bracket from the teams shown; a lone player gets a named computer partner', () => {
  const t = tour(4);
  t.join('org', 'Org'); t.join('a', 'Ann'); t.join('b', 'Ben'); t.join('c', 'Cal'); t.join('d', 'Dee');
  t.arrange('org', 'pair', key(t, 'org'), key(t, 'd'));
  t.arrange('org', 'pair', key(t, 'a'), key(t, 'c'));
  assert.equal(t.start('org').ok, true);
  const teams = t.rounds[0].flatMap((m) => m.teams).map((x) => x!.slots.map((s) => s.playerId ?? 'cpu').join('+'));
  assert.ok(teams.includes('org+d')); assert.ok(teams.includes('a+c')); assert.ok(teams.includes('b+cpu'));
  const lone = t.rounds[0].flatMap((m) => m.teams).find((x) => x!.slots[0].playerId === 'b')!;
  assert.ok(lone.slots[1].name.length > 0 && !/bot/i.test(lone.slots[1].name));
});

test('multi-table event seats the teams as partners (seats 0&2, 1&3)', () => {
  const seated: any[] = [];
  const ev = new TableEvent({ id: 'e', code: 'EVENT', tables: 2, target: 250, organizerId: 'org',
    host: { createEventTable: (_e, entry) => { seated.push(entry); return { id: 't' + seated.length, code: 'C' + seated.length }; }, changed() {} } });
  ev.join('org', 'Org'); ev.join('a', 'Ann'); ev.makeTeam('a', 'TEAM3'); ev.join('b', 'Ben'); ev.join('c', 'Cal', 'TEAM3');
  ev.arrange('org', 'swap', key(ev, 'b'), key(ev, 'c'));
  assert.equal(ev.start('org').ok, true);
  const s = seated[0].seats.map((x: any) => x.playerId);
  assert.deepEqual([s[0], s[2]], ['org', 'c']); assert.deepEqual([s[1], s[3]], ['a', 'b']);
});

test('through the server: Make a team, partner joins with the team code, organizer sees teams live and can swap', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { c: org } = await connectPremium(srv.port, 'Org');
    org.send({ t: 'createTournament', size: 4, isPublic: false });
    const v0 = await org.waitFor((m) => m.t === 'tournament');
    const { c: ann } = await connect(srv.port, 'Ann');
    ann.send({ t: 'joinCode', code: v0.code });
    await ann.waitFor((m) => m.t === 'tournament');
    ann.send({ t: 'makeTeam' });
    const va = await ann.waitFor((m) => m.t === 'tournament' && m.teams.some((x: any) => x.waitingCode));
    const code = va.teams.find((x: any) => x.waitingCode).waitingCode;
    const { c: cal } = await connect(srv.port, 'Cal');
    cal.send({ t: 'joinCode', code });
    const vo = await org.waitFor((m) => m.t === 'tournament' && m.teams.some((x: any) => x.members.length === 2 && x.locked));
    const team = vo.teams.find((x: any) => x.locked).members.map((m: any) => m.name);
    assert.deepEqual(team, ['Ann', 'Cal']);
    assert.ok(vo.teams.every((x: any) => x.waitingCode === null || x.waitingCode === '')); // codes are private
    const k = (n: string) => vo.teams.flatMap((x: any) => x.members).find((m: any) => m.name === n).key;
    org.send({ t: 'arrangeTeams', action: 'swap', a: k('Org'), b: k('Cal') });
    const vc = await cal.waitFor((m) => m.t === 'tournament' && m.teams.some((x: any) => x.members.some((y: any) => y.name === 'Org') && x.members.length === 2));
    assert.deepEqual(vc.teams.find((x: any) => x.members.some((y: any) => y.name === 'Org')).members.map((m: any) => m.name), ['Org', 'Ann']);
    const { c: dee } = await connect(srv.port, 'Dee');
    dee.send({ t: 'joinCode', code });
    assert.equal((await dee.waitFor((m) => m.t === 'error')).code, 'not_found'); // the organizer's edit ended the code
    org.close(); ann.close(); cal.close(); dee.close();
  } finally { await srv.close(); }
});
