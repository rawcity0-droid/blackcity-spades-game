// Free vs Premium: anyone can WATCH any game and play Practice vs bots. Playing with other humans needs an invite
// (a table / tournament code) from a host who is Premium right now. Premium customers host and invite.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG } from '../src/config.js';
import { hostNotPremiumMessage, inviteMessage, upgradeMessage } from '../src/server/hub.js';
import { Client, connect, connectPremium, sleep, testServer } from './helpers.js';

const err = (c: Client, code: string, since = 0) => c.waitFor((m) => m.t === 'error' && m.code === code && c.log.indexOf(m) >= since);
const hasNoHand = (c: Client) => c.log.filter((m) => m.t === 'table').every((m) => m.hand === undefined && (m.legal === undefined || m.legal.length === 0) && (m.spectator === true || m.mySeat >= 0));

async function premiumTable(srv: { port: number }, nick = 'Host', isPublic = true) {
  const host = await connectPremium(srv.port, nick);
  host.c.send({ t: 'createTable', isPublic, target: 250 });
  const t = await host.c.waitFor((m) => m.t === 'table');
  return { ...host, table: t };
}
const revoke = async (c: Client) => { c.send({ t: 'devToggleSubscription' }); await c.waitFor((m) => m.t === 'subscription' && m.subscribed === false); };

test('free users cannot create a table (public or private), a tournament, a bracket or an event', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { c } = await connect(srv.port, 'Free');
    c.send({ t: 'createTable', isPublic: true, target: 250 });
    assert.equal((await err(c, 'upgrade_required')).message, inviteMessage());
    c.send({ t: 'createTable', isPublic: false, target: 250 });
    await c.waitFor((m) => m.t === 'error' && m.message === upgradeMessage());
    for (const msg of [{ t: 'createTournament', size: 4, isPublic: true }, { t: 'createTournament', size: 8, isPublic: false }, { t: 'createEvent', tables: 2 }]) {
      const before = c.log.length;
      c.send(msg);
      assert.equal((await err(c, 'upgrade_required', before)).message, upgradeMessage());
    }
    assert.equal(c.log.some((m) => m.t === 'table' || m.t === 'tournament' || m.t === 'event'), false);
    assert.equal(srv.hub['tables'].size, 0);
    assert.equal(srv.hub['tournaments'].size, 0);
  } finally { await srv.close(); }
});

test('free users can practice against bots; a practice table is solo, unlisted and cannot be joined by anyone', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const free = (await connect(srv.port, 'Free')).c;
    free.send({ t: 'createTable', isPublic: true, target: 250, practice: true });
    const t = await free.waitFor((m) => m.t === 'table');
    assert.equal(t.practice, true);
    assert.equal(t.isPublic, false);
    free.send({ t: 'startTable' });
    await free.waitFor((m) => m.t === 'table' && m.phase === 'bidding');
    // another (Premium) player cannot take a seat by code or id, but may watch
    const prem = (await connectPremium(srv.port, 'Prem')).c;
    prem.send({ t: 'joinCode', code: t.code });
    assert.equal((await err(prem, 'not_allowed')).message, 'That is a solo practice table');
    prem.send({ t: 'joinTable', id: t.id });
    await err(prem, 'not_found');
    assert.equal((srv.hub.lobbyMessage() as any).tables.length, 0, 'practice tables are never listed');
  } finally { await srv.close(); }
});

test('quickPlay for a lone free user ends up in a practice game against bots, and never at a Premium host\'s table', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await premiumTable(srv, 'Host'); // a public table with open seats
    const free = (await connect(srv.port, 'Free')).c;
    free.send({ t: 'quickPlay' });
    const t = await free.waitFor((m) => m.t === 'table');
    assert.notEqual(t.id, host.table.id);
    assert.equal(t.practice, true);
    assert.equal(t.seats.filter((s: any) => s.kind === 'human').length, 1);
    const tbl = srv.hub['tables'].get(host.table.id);
    assert.equal(tbl.humanCount(), 1, 'the Premium host table did not get the free player');
  } finally { await srv.close(); }
});

test('free users cannot join a table or tournament by id from the lobby', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await premiumTable(srv, 'Host');
    // a host can be in only one thing: use a second Premium player for the tournament
    const org = await connectPremium(srv.port, 'Org');
    org.c.send({ t: 'createTournament', size: 4, isPublic: true });
    const tour = await org.c.waitFor((m) => m.t === 'tournament');
    const free = (await connect(srv.port, 'Free')).c;
    free.send({ t: 'joinTable', id: host.table.id });
    assert.equal((await err(free, 'upgrade_required')).message, inviteMessage());
    free.send({ t: 'joinTournament', id: tour.id });
    await free.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required' && m.message === inviteMessage() && free.log.filter((x) => x.t === 'error').length === 2);
    assert.equal(srv.hub['tables'].get(host.table.id).humanCount(), 1);
    // ...but watching the same table and tournament from the lobby works
    free.send({ t: 'watchTable', id: host.table.id });
    assert.equal((await free.waitFor((m) => m.t === 'table')).spectator, true);
    free.send({ t: 'leaveTable' });
    await free.waitFor((m) => m.t === 'left');
    free.send({ t: 'watchTournament', id: tour.id });
    assert.equal((await free.waitFor((m) => m.t === 'tournament')).joined, false);
  } finally { await srv.close(); }
});

test('free users can watch any table by code or id, never receive hands, and can chat', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await premiumTable(srv, 'Host');
    host.c.send({ t: 'startTable' });
    await host.c.waitFor((m) => m.t === 'table' && m.phase === 'bidding');
    const w1 = (await connect(srv.port, 'Eve')).c;
    w1.send({ t: 'watchCode', code: host.table.code });
    const v = await w1.waitFor((m) => m.t === 'table');
    assert.equal(v.spectator, true);
    w1.send({ t: 'chat', text: 'hello from a free watcher' });
    const msg = await host.c.waitFor((m) => m.t === 'chatMsg');
    assert.equal(msg.role, 'watcher');
    // a private table can be watched by code too
    const priv = await premiumTable(srv, 'PrivHost', false);
    const w2 = (await connect(srv.port, 'Walt')).c;
    w2.send({ t: 'watchCode', code: priv.table.code });
    assert.equal((await w2.waitFor((m) => m.t === 'table')).spectator, true);
    await sleep(50);
    assert.ok(hasNoHand(w1) && hasNoHand(w2));
    // seat requests from a watcher still go through the invitation rule (joinCode of a Premium host's table)
    w1.send({ t: 'leaveTable' });
    await w1.waitFor((m) => m.t === 'left');
  } finally { await srv.close(); }
});

test('free users can join by CODE a table, tournament or event made by a Premium host', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await premiumTable(srv, 'Host', false);
    const g = (await connect(srv.port, 'Guest')).c;
    g.send({ t: 'joinCode', code: host.table.code });
    const seated = await g.waitFor((m) => m.t === 'table');
    assert.equal(seated.mySeat, 1);

    const org = await connectPremium(srv.port, 'Org');
    org.c.send({ t: 'createTournament', size: 4, isPublic: false });
    const tour = await org.c.waitFor((m) => m.t === 'tournament');
    const g2 = (await connect(srv.port, 'Guest2')).c;
    g2.send({ t: 'joinCode', code: tour.code });
    assert.equal((await g2.waitFor((m) => m.t === 'tournament')).joined, true);

    const evOrg = await connectPremium(srv.port, 'EvOrg');
    evOrg.c.send({ t: 'createEvent', tables: 1 });
    const ev = await evOrg.c.waitFor((m) => m.t === 'event');
    const g3 = (await connect(srv.port, 'Guest3')).c;
    g3.send({ t: 'joinCode', code: ev.code });
    assert.equal((await g3.waitFor((m) => m.t === 'event')).joined, true);
  } finally { await srv.close(); }
});

test('a code only works while its host is Premium: tables, tournaments and events of a non-Premium host are refused', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await premiumTable(srv, 'Host', true);
    const org = await connectPremium(srv.port, 'Org');
    org.c.send({ t: 'createTournament', size: 4, isPublic: true });
    const tour = await org.c.waitFor((m) => m.t === 'tournament');
    const evOrg = await connectPremium(srv.port, 'EvOrg');
    evOrg.c.send({ t: 'createEvent', tables: 1 });
    const ev = await evOrg.c.waitFor((m) => m.t === 'event');
    await revoke(host.c);
    await revoke(org.c);
    await revoke(evOrg.c);

    const free = (await connect(srv.port, 'Free')).c;
    for (const code of [host.table.code, tour.code, ev.code]) {
      const before = free.log.length;
      free.send({ t: 'joinCode', code });
      assert.equal((await err(free, 'not_allowed', before)).message, hostNotPremiumMessage());
    }
    assert.equal(srv.hub['tables'].get(host.table.id).humanCount(), 1);
    // a Premium joiner is not affected by the host's status
    const prem = (await connectPremium(srv.port, 'Prem')).c;
    prem.send({ t: 'joinCode', code: host.table.code });
    assert.equal((await prem.waitFor((m) => m.t === 'table')).mySeat, 1);
    // and watching is still open to a free user
    free.send({ t: 'watchCode', code: host.table.code });
    assert.equal((await free.waitFor((m) => m.t === 'table' && m.spectator === true)).spectator, true);
  } finally { await srv.close(); }
});

test('the invite code stays valid when the Premium host leaves and someone else becomes host (it follows the creator)', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await premiumTable(srv, 'Host', false);
    const a = (await connect(srv.port, 'A')).c;
    a.send({ t: 'joinCode', code: host.table.code });
    await a.waitFor((m) => m.t === 'table');
    host.c.send({ t: 'leaveTable' });
    await host.c.waitFor((m) => m.t === 'left');
    const b = (await connect(srv.port, 'B')).c;
    b.send({ t: 'joinCode', code: host.table.code });
    // the table's creator is still Premium, so the code is still an invitation
    const seated = await b.waitFor((m) => m.t === 'table');
    assert.equal(seated.spectator, false);
    assert.ok(seated.mySeat >= 0);
    assert.equal(b.log.some((m) => m.t === 'error'), false);
  } finally { await srv.close(); }
});

test('Premium is unchanged: host public and private tables, quickPlay matches into tables, join by id', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const a = await premiumTable(srv, 'A', true);
    const b = await connectPremium(srv.port, 'B');
    b.c.send({ t: 'joinTable', id: a.table.id });
    assert.equal((await b.c.waitFor((m) => m.t === 'table')).mySeat, 1);
    b.c.send({ t: 'leaveTable' });
    await b.c.waitFor((m) => m.t === 'left');
    b.c.send({ t: 'quickPlay' });
    const q = await b.c.waitFor((m) => m.t === 'table');
    assert.equal(q.id, a.table.id, 'Premium quickPlay still matches into an open public table');
    const c = await connectPremium(srv.port, 'C');
    c.c.send({ t: 'createTable', isPublic: false, target: 500 });
    assert.equal((await c.c.waitFor((m) => m.t === 'table')).isPublic, false);
    c.c.send({ t: 'leaveTable' });
    await c.c.waitFor((m) => m.t === 'left');
    c.c.send({ t: 'createTournament', size: 4, isPublic: true });
    assert.equal((await c.c.waitFor((m) => m.t === 'tournament')).isOrganizer, true);
  } finally { await srv.close(); }
});

test('the rule is one setting: with playWithOthersNeedsInvite off, free users play public tables like before', async () => {
  const srv = await testServer();
  const saved = CONFIG.hostOnly.playWithOthersNeedsInvite;
  (CONFIG.hostOnly as { playWithOthersNeedsInvite: boolean }).playWithOthersNeedsInvite = false;
  try {
    const a = (await connect(srv.port, 'A')).c;
    a.send({ t: 'createTable', isPublic: true, target: 250 });
    const t = await a.waitFor((m) => m.t === 'table');
    const b = (await connect(srv.port, 'B')).c;
    b.send({ t: 'joinTable', id: t.id });
    assert.equal((await b.waitFor((m) => m.t === 'table')).mySeat, 1);
  } finally {
    (CONFIG.hostOnly as { playWithOthersNeedsInvite: boolean }).playWithOthersNeedsInvite = saved;
    await srv.close();
  }
});
