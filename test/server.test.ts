// Server tests over real WebSockets: smoke game, validation, free-vs-paid gating, spectators.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { CONFIG } from '../src/config.js';
import { sanitizeNick } from '../src/server/protocol.js';
import { hostNotPremiumMessage, inviteMessage } from '../src/server/hub.js';
import { Client, autoPlay, connect, connectPremium, sleep, testServer } from './helpers.js';

test('smoke: connect, create table, start with bots, play a hand to the end, close', async () => {
  const srv = await testServer();
  try {
    const { c, welcome } = await connect(srv.port, 'Smoke');
    assert.match(welcome.token, /^[a-f0-9]{32}$/);
    c.send({ t: 'createTable', isPublic: true, target: 250, practice: true }); // free users play bots only
    const t0 = await c.waitFor((m) => m.t === 'table');
    assert.equal(t0.phase, 'waiting');
    assert.equal(t0.mySeat, 0);
    assert.equal(t0.code.length, 6);
    c.send({ t: 'startTable' });
    autoPlay(c);
    const done = await c.waitFor((m) => m.t === 'table' && m.lastHand !== null);
    assert.equal(done.lastHand.tricks.reduce((a: number, b: number) => a + b, 0), 13);
    // clients only ever received their own hand: 13 cards or fewer, never other seats' cards
    const views = c.log.filter((m) => m.t === 'table' && m.hand);
    assert.ok(views.every((v) => v.hand.length <= 13));
    assert.ok(views.every((v) => v.seats.every((s: any) => !('hand' in s))));
    c.close();
    await sleep(30);
  } finally { await srv.close(); }
});

test('validation: bad JSON, unknown type, oversize message, nickname sanitizing', async () => {
  const srv = await testServer();
  try {
    const c = new Client(srv.port);
    await c.open();
    c.ws.send('not json');
    assert.equal((await c.waitFor((m) => m.t === 'error')).code, 'bad_message');
    c.send({ t: 'createTable', isPublic: true, target: 250 });
    assert.equal((await c.waitFor((m) => m.t === 'error' && m.code === 'not_hello')).code, 'not_hello');
    const w = await c.hello('<img src=x onerror=alert(1)>  Bob\u0000');
    assert.ok(!/[<>]/.test(w.nick), w.nick);
    assert.ok(w.nick.length <= CONFIG.limits.maxNickLength);
    c.send({ t: 'nope' });
    assert.equal((await c.waitFor((m) => m.t === 'error' && m.message === 'Unknown message type')).code, 'bad_message');
    c.send({ t: 'play', card: 'ZZ' });
    await c.waitFor((m) => m.t === 'error' && m.message === 'Bad card');
    const closed = new Promise<number>((r) => c.ws.once('close', (code) => r(code)));
    c.ws.send(JSON.stringify({ t: 'ping', pad: 'x'.repeat(5000) }));
    assert.equal(await closed, 1009); // ws closes with "message too big"
  } finally { await srv.close(); }
});

test('sanitizeNick: trims, caps length, removes markup characters, may be empty (there is no default name)', () => {
  assert.equal(sanitizeNick('  A   B  '), 'A B');
  assert.equal(sanitizeNick('x'.repeat(100)).length, CONFIG.limits.maxNickLength);
  assert.equal(sanitizeNick('<b>hi</b>'), 'bhi/b');
  assert.equal(sanitizeNick('   '), '');
  assert.equal(sanitizeNick(42), '');
});

test('rate limiting: a flood of messages gets rate_limited errors', async () => {
  const srv = await testServer({ rateLimit: { burst: 10, perSecond: 1 } });
  try {
    const { c } = await connect(srv.port, 'Flood');
    for (let i = 0; i < 40; i++) c.send({ t: 'ping' });
    const e = await c.waitFor((m) => m.t === 'error' && m.code === 'rate_limited', 3000);
    assert.equal(e.code, 'rate_limited');
  } finally { await srv.close(); }
});

test('free tier: private tables and hosting tournaments need the host subscription', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { c } = await connect(srv.port, 'Free');
    // Free users can practice against bots, but cannot create a table for others
    c.send({ t: 'createTable', isPublic: true, target: 250, practice: true });
    await c.waitFor((m) => m.t === 'table');
    c.send({ t: 'leaveTable' });
    await c.waitFor((m) => m.t === 'left');
    c.send({ t: 'createTable', isPublic: true, target: 250 });
    const e0 = await c.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required');
    assert.equal(e0.message, inviteMessage());

    c.send({ t: 'createTable', isPublic: false, target: 250 });
    const e1 = await c.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required');
    assert.equal(e1.message, `Upgrade to host — $${CONFIG.subscriptionPriceUsdPerMonth.toFixed(2)}/month`);
    c.send({ t: 'createTournament', size: 4, isPublic: true });
    await c.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required' && m !== e1 && m !== e0);

    // dev toggle on -> allowed
    c.send({ t: 'devToggleSubscription' });
    assert.equal((await c.waitFor((m) => m.t === 'subscription')).subscribed, true);
    c.send({ t: 'createTable', isPublic: false, target: 250 });
    const t = await c.waitFor((m) => m.t === 'table' && m.id);
    assert.equal(t.isPublic, false);
    c.send({ t: 'leaveTable' });
    await c.waitFor((m) => m.t === 'left');
    c.send({ t: 'createTournament', size: 4, isPublic: true });
    const tour = await c.waitFor((m) => m.t === 'tournament');
    assert.equal(tour.isOrganizer, true);
    // Subscription is keyed by the stable id: a reconnect with the token keeps it
    const { welcome } = await connect(srv.port, 'Free', c.last.welcome.token);
    assert.equal(welcome.subscribed, true);
    assert.equal(welcome.config.priceUsdPerMonth, CONFIG.subscriptionPriceUsdPerMonth);
  } finally { await srv.close(); }
});

test('dev toggle and endpoint are disabled unless DEV_UNLOCK is set; there are no /billing HTTP routes (no webhook)', async () => {
  const srv = await testServer({ devUnlock: false });
  try {
    const { c, welcome } = await connect(srv.port, 'Nope');
    assert.equal(welcome.config.devUnlock, false);
    c.send({ t: 'devToggleSubscription' });
    assert.equal((await c.waitFor((m) => m.t === 'error')).code, 'not_allowed');
    const r = await fetch(`http://127.0.0.1:${srv.port}/dev/subscription`, { method: 'POST', body: JSON.stringify({ token: welcome.token }) });
    assert.equal(r.status, 404);
    const b = await fetch(`http://127.0.0.1:${srv.port}/billing/checkout`, { method: 'POST' });
    assert.ok(b.status === 404 || b.status === 405, String(b.status));
    const h = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(await h.text(), 'ok');
    const trav = await fetch(`http://127.0.0.1:${srv.port}/..%2f..%2fpackage.json`);
    assert.ok(trav.status === 404 || trav.status === 403 || trav.status === 400);
  } finally { await srv.close(); }

  const on = await testServer({ devUnlock: true });
  try {
    const { c, welcome } = await connect(on.port, 'Yes');
    const r = await fetch(`http://127.0.0.1:${on.port}/dev/subscription`, { method: 'POST', body: JSON.stringify({ token: welcome.token, active: true }) });
    assert.deepEqual(await r.json(), { subscribed: true });
    assert.equal((await c.waitFor((m) => m.t === 'subscription', 2000, true)).subscribed, true);
  } finally { await on.close(); }
});

test('public tables are listed; private ones are not; join by code works for both', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = (await connect(srv.port, 'Host')).c;
    host.send({ t: 'devToggleSubscription' });
    await host.waitFor((m) => m.t === 'subscription');
    host.send({ t: 'createTable', isPublic: false, target: 500 });
    const priv = await host.waitFor((m) => m.t === 'table');
    const guest = (await connect(srv.port, 'Guest')).c;
    const lobby = await guest.waitFor((m) => m.t === 'lobby', 3000, true);
    assert.equal(lobby.tables.length, 0);
    guest.send({ t: 'joinCode', code: priv.code.toLowerCase() });
    const v = await guest.waitFor((m) => m.t === 'table');
    assert.equal(v.mySeat, 1);
    assert.equal(v.seats[1].name, 'Guest');
    // wrong code
    const g2 = (await connect(srv.port, 'G2')).c;
    g2.send({ t: 'joinCode', code: 'ZZZZZZ' });
    assert.equal((await g2.waitFor((m) => m.t === 'error')).code, 'not_found');
  } finally { await srv.close(); }
});

// ---------- spectators ----------

const CARD_RE = /^[2-9TJQKA][SHDC]$/;
/** Collect every card-looking string in a message, ignoring the public "trick"/"lastTrick" fields. */
function privateCards(m: any): string[] {
  const out: string[] = [];
  const walk = (v: any, key: string) => {
    if (key === 'trick' || key === 'lastTrick') return;
    if (typeof v === 'string' && CARD_RE.test(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(m, '');
  return out;
}

test('spectators: watch by code (private table), never receive hands, cannot act, are counted', async () => {
  const srv = await testServer({ devUnlock: true, timings: { handPauseMs: 40, botDelayMs: 3 } });
  try {
    const host = (await connect(srv.port, 'Host')).c;
    host.send({ t: 'devToggleSubscription' });
    await host.waitFor((m) => m.t === 'subscription');
    host.send({ t: 'createTable', isPublic: false, target: 250 });
    const t0 = await host.waitFor((m) => m.t === 'table');
    host.send({ t: 'startTable' });
    autoPlay(host);

    const spec = (await connect(srv.port, 'Watcher')).c;
    spec.send({ t: 'watchCode', code: t0.code });
    const first = await spec.waitFor((m) => m.t === 'table');
    assert.equal(first.spectator, true);
    assert.equal(first.mySeat, -1);
    assert.equal('hand' in first, false);
    assert.equal('legal' in first, false);

    // spectator count shown to the table
    const counted = await host.waitFor((m) => m.t === 'table' && m.spectators === 1);
    assert.equal(counted.spectators, 1);

    // every action from a spectator is rejected
    for (const msg of [{ t: 'bid', bid: 3 }, { t: 'play', card: 'AS' }, { t: 'ready' }, { t: 'startTable' }, { t: 'rematch' }]) {
      spec.send(msg);
      const e = await spec.waitFor((m) => m.t === 'error', 2000);
      assert.equal(e.code, 'not_seated', JSON.stringify(msg));
      spec.log.length = spec.log.length; // keep log
    }

    // play through at least one full hand while watching
    await spec.waitFor((m) => m.t === 'table' && m.lastHand !== null, 15000);
    const tables = spec.log.filter((m) => m.t === 'table');
    assert.ok(tables.length > 20);
    for (const m of tables) {
      assert.equal(m.spectator, true);
      assert.equal('hand' in m, false);
      assert.equal('legal' in m, false);
      assert.deepEqual(privateCards(m), [], 'spectator message leaked a card outside the public trick');
    }
    // The raw frames also contain no "hand" key at all
    assert.ok(!JSON.stringify(spec.log).includes('"hand"'));

    // stopping the watch updates the count
    spec.send({ t: 'leaveTable' });
    await host.waitFor((m) => m.t === 'table' && m.spectators === 0);
  } finally { await srv.close(); }
});

test('spectating a table by id works only for public tables; private needs the code', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = (await connect(srv.port, 'Host')).c;
    host.send({ t: 'devToggleSubscription' });
    await host.waitFor((m) => m.t === 'subscription');
    host.send({ t: 'createTable', isPublic: false, target: 250 });
    const priv = await host.waitFor((m) => m.t === 'table');
    const s = (await connect(srv.port, 'S')).c;
    s.send({ t: 'watchTable', id: priv.id });
    assert.equal((await s.waitFor((m) => m.t === 'error')).code, 'not_found');
    s.send({ t: 'watchCode', code: priv.code });
    assert.equal((await s.waitFor((m) => m.t === 'table')).spectator, true);
  } finally { await srv.close(); }
});

test('a seated player is not a spectator and a spectator can later take a seat', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = (await connectPremium(srv.port, 'Host')).c;
    host.send({ t: 'createTable', isPublic: true, target: 250 });
    const t = await host.waitFor((m) => m.t === 'table');
    const s = (await connect(srv.port, 'Sit')).c;
    s.send({ t: 'watchCode', code: t.code });
    assert.equal((await s.waitFor((m) => m.t === 'table')).spectator, true);
    s.send({ t: 'joinCode', code: t.code }); // ask for a seat while watching
    const seated = await s.waitFor((m) => m.t === 'table' && m.spectator === false);
    assert.equal(seated.mySeat, 1);
  } finally { await srv.close(); }
});

test('reconnect with the token keeps the seat after a refresh', async () => {
  const srv = await testServer({ timings: { botDelayMs: 20, handPauseMs: 50 } });
  try {
    const { c, welcome } = await connect(srv.port, 'Ref');
    c.send({ t: 'quickPlay' });
    const before = await c.waitFor((m) => m.t === 'table');
    c.ws.terminate();
    await sleep(60);
    const again = await connect(srv.port, 'Ref', welcome.token);
    assert.equal(again.welcome.resumed, true);
    const v = await again.c.waitFor((m) => m.t === 'table', 8000, true);
    assert.equal(v.id, before.id);
    assert.equal(v.mySeat, before.mySeat);
    assert.ok(Array.isArray(v.hand));
  } finally { await srv.close(); }
});

test('a player joining mid-hand is queued without any hand data, then seated at the next hand', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 2, handPauseMs: 30 } });
  try {
    const host = (await connectPremium(srv.port, 'Host')).c;
    host.send({ t: 'quickPlay' }); // Premium: a public table, started with bots
    const t = await host.waitFor((m) => m.t === 'table');
    autoPlay(host);
    const g = (await connect(srv.port, 'Late')).c;
    g.send({ t: 'joinCode', code: t.code });
    const queued = await g.waitFor((m) => m.t === 'table');
    assert.equal(queued.queued, true);
    assert.equal(queued.spectator, true);
    assert.equal('hand' in queued, false);
    const seated = await g.waitFor((m) => m.t === 'table' && m.spectator === false, 15000);
    assert.equal(seated.queued, false);
    assert.ok(Array.isArray(seated.hand));
    for (const m of g.log.filter((x) => x.t === 'table' && x.spectator)) assert.equal('hand' in m, false);
  } finally { await srv.close(); }
});
