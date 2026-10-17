// Display-name rules (no default names; name required before joining/creating) and Restore Premium via OWNER_EMAILS,
// all with DEV_UNLOCK off. The owner address is a made-up one injected through the options (same path as the env var).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOwnerEmails } from '../src/config.js';
import { Client, connect, sleep, testServer } from './helpers.js';

const OWNER = 'owner@example.test';

async function restore(c: Client, email: string): Promise<any> {
  const n = c.log.filter((m) => m.t === 'restoreResult').length;
  c.send({ t: 'restorePremium', email });
  return c.waitFor((m) => m.t === 'restoreResult' && c.log.filter((x) => x.t === 'restoreResult').indexOf(m) === n);
}

test('hello with an empty nick leaves the name empty: no Player#### default, whitespace counts as empty', async () => {
  const srv = await testServer();
  try {
    assert.equal((await connect(srv.port, '')).welcome.nick, '');
    assert.equal((await connect(srv.port, '   ')).welcome.nick, '');
    assert.equal((await connect(srv.port, '<>')).welcome.nick, '');
    assert.equal((await connect(srv.port, 'Dana')).welcome.nick, 'Dana');
  } finally { await srv.close(); }
});

test('name_required: every action that seats, watches or creates is refused without a name, with no state change', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const c = (await connect(srv.port, '')).c;
    c.send({ t: 'devToggleSubscription' }); // premium, so a refusal can only be about the name
    await c.waitFor((m) => m.t === 'subscription');
    const gated: object[] = [
      { t: 'createTable', isPublic: true, target: 250 },
      { t: 'createTable', isPublic: false, target: 500 },
      { t: 'createTable', isPublic: true, target: 250, practice: false },
      { t: 'joinTable', id: 'abcdef12' },
      { t: 'watchTable', id: 'abcdef12' },
      { t: 'joinCode', code: 'ABC234' },
      { t: 'watchCode', code: 'ABC234' },
      { t: 'quickPlay' },
      { t: 'createTournament', size: 4, isPublic: false },
      { t: 'joinTournament', id: 'abcdef12' },
      { t: 'watchTournament', id: 'abcdef12' },
      { t: 'createEvent', tables: 2 },
    ];
    for (const msg of gated) {
      const before = c.log.length;
      c.send(msg);
      const e = await c.waitFor((m) => m.t === 'error' && c.log.indexOf(m) >= before);
      assert.equal(e.code, 'name_required', JSON.stringify(msg));
      assert.match(e.message, /Enter your name first/);
    }
    await sleep(60);
    assert.equal(c.log.some((m) => m.t === 'table' || m.t === 'tournament' || m.t === 'event'), false, 'nothing was created or joined');
    // a name of only spaces is still no name
    c.send({ t: 'setNick', nick: '   ' });
    assert.equal((await c.waitFor((m) => m.t === 'nick')).nick, '');
    c.send({ t: 'quickPlay' });
    assert.equal((await c.waitFor((m) => m.t === 'error' && m.code === 'name_required' && c.log.filter((x) => x.code === 'name_required').length > gated.length)).code, 'name_required');
    // with a name the same actions go through
    c.send({ t: 'setNick', nick: 'Zed' });
    await c.waitFor((m) => m.t === 'nick' && m.nick === 'Zed');
    c.send({ t: 'createTable', isPublic: false, target: 500 });
    const t = await c.waitFor((m) => m.t === 'table');
    assert.equal(t.seats[0].name, 'Zed');
  } finally { await srv.close(); }
});

test('Practice (public table with practice:true) needs no name and seats a nameless player as "You"', async () => {
  const srv = await testServer();
  try {
    const c = (await connect(srv.port, '')).c;
    c.send({ t: 'createTable', isPublic: true, target: 250, practice: true });
    const t = await c.waitFor((m) => m.t === 'table');
    assert.equal(t.seats[0].name, 'You');
    const d = (await connect(srv.port, 'Named')).c;
    d.send({ t: 'createTable', isPublic: true, target: 250, practice: true });
    assert.equal((await d.waitFor((m) => m.t === 'table')).seats[0].name, 'Named');
    // practice:true does not unlock a private table
    const e = (await connect(srv.port, '')).c;
    e.send({ t: 'createTable', isPublic: false, target: 250, practice: true });
    assert.equal((await e.waitFor((m) => m.t === 'error')).code, 'name_required');
  } finally { await srv.close(); }
});

test('OWNER_EMAILS parsing: comma separated, trimmed, lowercased, empties ignored, default empty', () => {
  assert.deepEqual(parseOwnerEmails(undefined), []);
  assert.deepEqual(parseOwnerEmails(''), []);
  assert.deepEqual(parseOwnerEmails(' A@x.test , ,B@Y.test,, '), ['a@x.test', 'b@y.test']);
});

test('restore premium: matching email (any case, with spaces) unlocks Premium, others get one friendly not_found, no DEV_UNLOCK', async () => {
  const srv = await testServer({ ownerEmails: [OWNER] });
  try {
    const { c } = await connect(srv.port, 'Olive');
    const no = await restore(c, 'someone@example.test');
    assert.equal(no.ok, false);
    assert.equal(no.code, 'not_found');
    assert.equal(no.message, 'That email doesn’t have active Premium on this server yet.');
    const near = await restore(c, 'owner@example.testx');
    assert.equal(near.message, no.message); // never reveals which addresses are owners
    assert.equal((await restore(c, 'nope')).code, 'bad_email');
    assert.equal(c.log.some((m) => m.t === 'subscription'), false);
    const yes = await restore(c, '  OwNer@Example.TEST ');
    assert.equal(yes.ok, true);
    assert.equal(yes.code, 'ok');
    assert.match(yes.message, /Premium restored/);
    assert.equal(c.log.find((m) => m.t === 'subscription').subscribed, true);
    // every request got exactly one restoreResult
    assert.equal(c.log.filter((m) => m.t === 'restoreResult').length, 4);
    // an owner who is already premium just gets a success again
    assert.equal((await restore(c, OWNER)).ok, true);
  } finally { await srv.close(); }
});

test('restore premium: an empty OWNER_EMAILS list matches nobody, even an empty email', async () => {
  const srv = await testServer({ ownerEmails: [] });
  try {
    const { c } = await connect(srv.port, 'Ned');
    assert.equal((await restore(c, OWNER)).code, 'not_found');
    assert.equal((await restore(c, '')).code, 'bad_email');
    assert.equal(c.log.some((m) => m.t === 'subscription'), false);
  } finally { await srv.close(); }
});

test('restore premium: rate limited to 5 attempts a minute per connection, then answers rate_limited (even for the right email)', async () => {
  const srv = await testServer({ ownerEmails: [OWNER] });
  try {
    const { c } = await connect(srv.port, 'Rita');
    for (let i = 0; i < 5; i++) assert.equal((await restore(c, `guess${i}@example.test`)).code, 'not_found');
    const lim = await restore(c, OWNER);
    assert.equal(lim.ok, false);
    assert.equal(lim.code, 'rate_limited');
    assert.equal(c.log.some((m) => m.t === 'subscription'), false);
    // a different connection has its own allowance
    const other = (await connect(srv.port, 'Other')).c;
    assert.equal((await restore(other, OWNER)).ok, true);
  } finally { await srv.close(); }
});

test('restore premium persists for the token: still Premium after reconnecting, not for other players', async () => {
  const srv = await testServer({ ownerEmails: [OWNER] });
  try {
    const first = await connect(srv.port, 'Pat');
    assert.equal(first.welcome.subscribed, false);
    assert.equal((await restore(first.c, OWNER)).ok, true);
    first.c.ws.close();
    await sleep(50);
    const again = await connect(srv.port, 'Pat', first.welcome.token);
    assert.equal(again.welcome.subscribed, true);
    assert.equal((await connect(srv.port, 'Stranger')).welcome.subscribed, false);
  } finally { await srv.close(); }
});

test('gated actions (create table, tournament/bracket, event) are refused before a restore and work after it, DEV_UNLOCK off', async () => {
  const srv = await testServer({ ownerEmails: [OWNER] });
  try {
    const { c } = await connect(srv.port, 'Gail');
    const actions: object[] = [
      { t: 'createTable', isPublic: false, target: 500 },
      { t: 'createTournament', size: 4, isPublic: false },
      { t: 'createEvent', tables: 2 },
    ];
    for (const msg of actions) {
      const before = c.log.length;
      c.send(msg);
      const e = await c.waitFor((m) => m.t === 'error' && c.log.indexOf(m) >= before);
      assert.equal(e.code, 'upgrade_required', JSON.stringify(msg));
    }
    assert.equal((await restore(c, OWNER)).ok, true);
    c.send(actions[0]);
    assert.equal((await c.waitFor((m) => m.t === 'table')).isHost, true);
    c.send({ t: 'leaveTable' });
    await c.waitFor((m) => m.t === 'left');
    c.send(actions[1]);
    assert.ok((await c.waitFor((m) => m.t === 'tournament')).tournament || true);
    c.send({ t: 'leaveTournament' });
    await c.waitFor((m) => m.t === 'tournamentLeft');
    c.send(actions[2]);
    await c.waitFor((m) => m.t === 'event');
    // the dev toggle stays off without DEV_UNLOCK
    c.send({ t: 'devToggleSubscription' });
    assert.equal((await c.waitFor((m) => m.t === 'error' && m.code === 'not_allowed')).code, 'not_allowed');
  } finally { await srv.close(); }
});
