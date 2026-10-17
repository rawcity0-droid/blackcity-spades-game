// Stripe billing against a LOCAL MOCK only (test/mock-stripe.ts). The real Stripe API is never called and no real key is used.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG } from '../src/config.js';
import { Billing } from '../src/server/billing.js';
import { originOf } from '../src/server/server.js';
import { Client, connect, sleep, testServer } from './helpers.js';
import { MockStripe, PRICE, SECRET } from './mock-stripe.js';

const OWNER = 'owner@example.test';
const SESSION = 'cs_test_paidsession1234567890';

async function setup(opts: { ownerEmails?: string[]; timeoutMs?: number } = {}) {
  const mock = await new MockStripe().start();
  const billing = new Billing({ secretKey: SECRET, priceId: PRICE, apiBase: mock.url, timeoutMs: opts.timeoutMs ?? 2000 });
  const srv = await testServer({ billing, ownerEmails: opts.ownerEmails ?? [OWNER] });
  return { mock, srv, billing, close: async () => { await srv.close(); await mock.stop(); } };
}

const result = (c: Client, t: 'premiumResult' | 'restoreResult', since: number) => c.waitFor((m) => m.t === t && c.log.indexOf(m) >= since);
async function confirm(c: Client, sessionId: string): Promise<any> { const n = c.log.length; c.send({ t: 'confirmPremium', sessionId }); return result(c, 'premiumResult', n); }
async function restore(c: Client, email: string): Promise<any> { const n = c.log.length; c.send({ t: 'restorePremium', email }); return result(c, 'restoreResult', n); }
const subscribedMsgs = (c: Client) => c.log.filter((m) => m.t === 'subscription');

test('billing is disabled unless both STRIPE_SECRET_KEY and STRIPE_PRICE_ID are set; Go Premium then says not set up, no Stripe call', async () => {
  assert.equal(new Billing({}).enabled, false);
  assert.equal(new Billing({ secretKey: SECRET }).enabled, false);
  assert.equal(new Billing({ priceId: PRICE }).enabled, false);
  assert.equal(Billing.fromEnv({}).enabled, false);
  assert.equal(Billing.fromEnv({ STRIPE_SECRET_KEY: SECRET, STRIPE_PRICE_ID: PRICE }).enabled, true);
  const mock = await new MockStripe().start();
  const srv = await testServer({ billing: new Billing({ secretKey: SECRET, apiBase: mock.url }) }); // no price id
  try {
    const { c } = await connect(srv.port, 'Nia');
    c.send({ t: 'goPremium' });
    assert.match((await c.waitFor((m) => m.t === 'notice')).message, /Billing is not set up yet/);
    const r = await confirm(c, SESSION);
    assert.equal(r.code, 'billing_off');
    assert.equal(mock.requests.length, 0);
  } finally { await srv.close(); await mock.stop(); }
});

test('Go Premium creates a subscription Checkout Session with the documented fields and sends the URL', async () => {
  const { mock, srv, close } = await setup();
  try {
    const { c, welcome } = await connect(srv.port, 'Gus');
    c.send({ t: 'goPremium' });
    const co = await c.waitFor((m) => m.t === 'checkout');
    assert.match(co.url, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_created/);
    const [req] = mock.calls('/v1/checkout/sessions');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
    assert.match(String(req.headers['content-type']), /application\/x-www-form-urlencoded/);
    assert.equal(req.form.get('mode'), 'subscription');
    assert.equal(req.form.get('line_items[0][price]'), PRICE);
    assert.equal(req.form.get('line_items[0][quantity]'), '1');
    assert.equal(req.form.get('managed_payments[enabled]'), 'false');
    assert.equal(req.form.get('success_url'), `http://127.0.0.1:${srv.port}/?premium=success&session_id={CHECKOUT_SESSION_ID}`);
    assert.equal(req.form.get('cancel_url'), `http://127.0.0.1:${srv.port}/?premium=cancel`);
    assert.equal(req.form.get('client_reference_id'), welcome.id);
    assert.equal(req.form.get('metadata[host_id]'), welcome.id);
    assert.equal(req.form.get('metadata[app]'), 'blackcity-spades');
    assert.equal(req.form.get('client_reference_id') === welcome.token, false); // the secret token is never sent to Stripe
    // nothing was unlocked by merely starting checkout
    assert.equal(subscribedMsgs(c).length, 0);
    // an already-premium player is not sent to checkout again
    c.send({ t: 'devToggleSubscription' });
    srv.hub.store.setStripe(welcome.id, { email: 'a@b.test', customerId: 'cus_x', subscriptionId: 'sub_x' });
    c.send({ t: 'goPremium' });
    assert.match((await c.waitFor((m) => m.t === 'notice' && /already active/.test(m.message))).message, /already active/);
    assert.equal(mock.calls('/v1/checkout/sessions').length, 1);
  } finally { await close(); }
});

test('return URLs come from the request origin (x-forwarded-* behind a proxy), with a safe localhost fallback', () => {
  const req = (headers: Record<string, string>, port = 3000) => ({ headers, socket: { localPort: port } }) as any;
  assert.equal(originOf(req({ host: 'spades.example.test' })), 'http://spades.example.test');
  assert.equal(originOf(req({ host: 'internal:10000', 'x-forwarded-host': 'spades.example.test', 'x-forwarded-proto': 'https' })), 'https://spades.example.test');
  assert.equal(originOf(req({ host: 'evil.test/path?x' }, 4321)), 'http://localhost:4321');
  assert.equal(originOf(req({}, 4321)), 'http://localhost:4321');
  assert.equal(CONFIG.publicBaseUrl, ''); // PUBLIC_BASE_URL is unset in tests
});

test('return verification unlocks only for a paid, complete, subscription-mode, active session on the configured price', async () => {
  const { mock, srv, close } = await setup();
  try {
    mock.addCustomer('cus_1', 'buyer@example.test');
    mock.addSub('sub_ok', 'cus_1', 'active');
    mock.addSession({ id: SESSION, sub: 'sub_ok' });
    const bad: [string, any, string][] = [
      ['unpaid', { id: 'cs_test_unpaid12345678', sub: 'sub_ok', paymentStatus: 'unpaid' }, 'not_paid'],
      ['open', { id: 'cs_test_open123456789', sub: 'sub_ok', status: 'open' }, 'not_paid'],
      ['one-time mode', { id: 'cs_test_paymode12345678', sub: 'sub_ok', mode: 'payment' }, 'bad_session'],
      ['not made by this app', { id: 'cs_test_foreign1234567', sub: 'sub_ok', app: null }, 'bad_session'],
    ];
    for (const [, s] of bad) mock.addSession(s);
    mock.addSub('sub_wrong', 'cus_1', 'active', 'price_other');
    mock.addSession({ id: 'cs_test_wrongprice12345', sub: 'sub_wrong' });
    mock.addSub('sub_dead', 'cus_1', 'canceled');
    mock.addSession({ id: 'cs_test_inactive1234567', sub: 'sub_dead' });
    mock.addSub('sub_late', 'cus_1', 'past_due');
    mock.addSession({ id: 'cs_test_pastdue12345678', sub: 'sub_late' });
    const { c: c0 } = await connect(srv.port, 'Vera');
    for (const [name, s, code] of bad) assert.equal((await confirm(c0, s.id)).code, code, name);
    assert.equal((await confirm(c0, 'cs_test_wrongprice12345')).code, 'wrong_plan');
    assert.equal((await confirm(c0, 'cs_test_inactive1234567')).code, 'inactive');
    assert.equal((await confirm(c0, 'cs_test_pastdue12345678')).code, 'inactive');
    assert.equal((await confirm(c0, 'cs_test_doesnotexist12345')).code, 'bad_session'); // Stripe 404
    assert.equal((await confirm(c0, 'not a session id')).code, 'bad_session'); // never even sent to Stripe
    assert.equal((await confirm(c0, '')).code, 'bad_session');
    assert.equal(subscribedMsgs(c0).length, 0);
    // (a fresh connection: confirm attempts are limited to 10 a minute per connection)
    const c = (await connect(srv.port, 'Vera2')).c;
    // free player cannot create a private table yet
    c.send({ t: 'createTable', isPublic: false, target: 500 });
    assert.equal((await c.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required')).code, 'upgrade_required');
    const ok = await confirm(c, SESSION);
    assert.equal(ok.ok, true);
    assert.equal(ok.message, 'Premium is active.');
    assert.equal(subscribedMsgs(c)[0].subscribed, true);
    const call = mock.calls('/v1/checkout/sessions/' + SESSION).pop()!;
    assert.equal(call.query.get('expand[]'), 'subscription');
    assert.equal(call.headers.authorization, `Bearer ${SECRET}`);
    // gated actions work now (create table, bracket, event)
    c.send({ t: 'createTable', isPublic: false, target: 500 });
    assert.equal((await c.waitFor((m) => m.t === 'table')).isHost, true);
    c.send({ t: 'leaveTable' });
    await c.waitFor((m) => m.t === 'left');
    c.send({ t: 'createTournament', size: 4, isPublic: false });
    await c.waitFor((m) => m.t === 'tournament');
    c.send({ t: 'leaveTournament' });
    await c.waitFor((m) => m.t === 'tournamentLeft');
    c.send({ t: 'createEvent', tables: 2 });
    await c.waitFor((m) => m.t === 'event');
    // the buyer email and customer id are stored, and indexed by email
    assert.deepEqual(srv.hub.store.customersForEmail('BUYER@example.test'), ['cus_1']);
  } finally { await close(); }
});

test('verification is idempotent for the same host and a session cannot be replayed by another host', async () => {
  const { mock, srv, close } = await setup();
  try {
    mock.addSub('sub_ok', 'cus_1', 'active');
    mock.addSession({ id: SESSION, sub: 'sub_ok' });
    const a = await connect(srv.port, 'Ann');
    assert.equal((await confirm(a.c, SESSION)).ok, true);
    assert.equal((await confirm(a.c, SESSION)).ok, true); // same session id twice: harmless
    const b = await connect(srv.port, 'Bob');
    const r = await confirm(b.c, SESSION);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'claimed');
    assert.equal(subscribedMsgs(b.c).length, 0);
    // the bound host survives a reconnect with the same token; Bob is still free
    const a2 = await connect(srv.port, 'Ann', a.welcome.token);
    assert.equal(a2.welcome.subscribed, true);
    const b2 = await connect(srv.port, 'Bob', b.welcome.token);
    assert.equal(b2.welcome.subscribed, false);
    // Restore by email re-links the subscription to another device
    mock.addCustomer('cus_1', 'buyer@example.test');
    const re = await restore(b2.c, 'Buyer@Example.test');
    assert.equal(re.ok, true);
    assert.equal(subscribedMsgs(b2.c)[0].subscribed, true);
  } finally { await close(); }
});

test('restore by email: active subscription unlocks; cancelled, wrong price and unknown emails get the same friendly message', async () => {
  const { mock, srv, close } = await setup();
  try {
    mock.addCustomer('cus_a', 'active@example.test');
    mock.addSub('sub_a', 'cus_a', 'active');
    mock.addCustomer('cus_t', 'trial@example.test');
    mock.addSub('sub_t', 'cus_t', 'trialing');
    mock.addCustomer('cus_c', 'cancelled@example.test');
    mock.addSub('sub_c', 'cus_c', 'canceled');
    mock.addCustomer('cus_w', 'other@example.test');
    mock.addSub('sub_w', 'cus_w', 'active', 'price_other');
    mock.addCustomer('cus_m', 'Mixed.Case@Example.test'); // stored with capitals: only Search (case-insensitive) finds it
    mock.addSub('sub_m', 'cus_m', 'active');
    const { c } = await connect(srv.port, 'Rae');
    const msg = 'That email doesn’t have active Premium on this server yet.';
    for (const e of ['cancelled@example.test', 'other@example.test', 'nobody@example.test']) {
      const r = await restore(c, e);
      assert.equal(r.ok, false, e);
      assert.equal(r.code, 'not_found');
      assert.equal(r.message, msg);
    }
    assert.equal(subscribedMsgs(c).length, 0);
    const ok = await restore(c, ' Active@Example.TEST ');
    assert.equal(ok.ok, true);
    assert.equal(subscribedMsgs(c).length, 1);
    const d = await connect(srv.port, 'Dee');
    assert.equal((await restore(d.c, 'trial@example.test')).ok, true);
    const e2 = await connect(srv.port, 'Eli');
    assert.equal((await restore(e2.c, 'mixed.case@example.test')).ok, true);
    // owner emails still unlock without asking Stripe
    const before = mock.requests.length;
    const f = await connect(srv.port, 'Fay');
    assert.equal((await restore(f.c, OWNER)).ok, true);
    assert.equal(mock.requests.length, before);
  } finally { await close(); }
});

test('re-verification: a stale Stripe-backed Premium is re-checked at the next gated action and locked if cancelled', async () => {
  const { mock, srv, close } = await setup();
  try {
    const day = 24 * 3600 * 1000;
    mock.addSub('sub_live', 'cus_1', 'active');
    mock.addSub('sub_gone', 'cus_2', 'canceled');
    mock.addSub('sub_late', 'cus_3', 'past_due');
    const mk = async (nick: string, sub: string, ageMs: number) => {
      const r = await connect(srv.port, nick);
      srv.hub.store.setStripe(r.welcome.id, { email: nick + '@example.test', customerId: 'cus', subscriptionId: sub }, Date.now() - ageMs);
      return r;
    };
    // fresh: no Stripe call at all
    const fresh = await mk('Fresh', 'sub_gone', 1000);
    fresh.c.send({ t: 'createTable', isPublic: false, target: 500 });
    await fresh.c.waitFor((m) => m.t === 'table');
    assert.equal(mock.calls('/v1/subscriptions').length, 0);
    // stale + still active: allowed, and marked verified again
    const live = await mk('Live', 'sub_live', 2 * day);
    live.c.send({ t: 'createTable', isPublic: false, target: 500 });
    await live.c.waitFor((m) => m.t === 'table');
    assert.ok(Date.now() - srv.hub.store.get(live.welcome.id)!.verifiedAt! < 5000);
    assert.equal(mock.calls('/v1/subscriptions/sub_live').length, 1);
    // stale + cancelled: locked, refused
    for (const [nick, sub] of [['Gone', 'sub_gone'], ['Late', 'sub_late']]) {
      const gone = await mk(nick, sub, 2 * day);
      gone.c.send({ t: 'createEvent', tables: 2 });
      assert.equal((await gone.c.waitFor((m) => m.t === 'error')).code, 'upgrade_required');
      assert.equal(gone.c.log.find((m) => m.t === 'subscription')?.subscribed, false);
      assert.equal(srv.hub.store.isSubscribed(gone.welcome.id), false);
    }
    // owner unlocks never expire and never ask Stripe
    const own = await connect(srv.port, 'Own');
    await restore(own.c, OWNER);
    const n = mock.requests.length;
    own.c.send({ t: 'createTable', isPublic: false, target: 500 });
    await own.c.waitFor((m) => m.t === 'table');
    assert.equal(mock.requests.length, n);
    // reconnecting also re-checks a stale record
    const back = await mk('Back', 'sub_gone', 3 * day);
    back.c.close?.();
    const again = await connect(srv.port, 'Back', back.welcome.token);
    await again.c.waitFor((m) => m.t === 'subscription' && m.subscribed === false, 4000, true);
  } finally { await close(); }
});

test('Stripe unreachable: previous Premium is kept during the grace period, locked after it; nothing unlocks on errors', async () => {
  const { mock, srv, close } = await setup();
  try {
    const day = 24 * 3600 * 1000;
    mock.mode = 'error500';
    const mk = async (nick: string, ageMs: number) => {
      const r = await connect(srv.port, nick);
      srv.hub.store.setStripe(r.welcome.id, { email: 'a@b.test', customerId: 'cus', subscriptionId: 'sub_x' }, Date.now() - ageMs);
      return r;
    };
    const within = await mk('Within', 2 * day); // stale but inside recheck + grace
    within.c.send({ t: 'createTable', isPublic: false, target: 500 });
    await within.c.waitFor((m) => m.t === 'table');
    assert.equal(srv.hub.store.isSubscribed(within.welcome.id), true);
    const beyond = await mk('Beyond', 30 * day);
    beyond.c.send({ t: 'createTable', isPublic: false, target: 500 });
    assert.equal((await beyond.c.waitFor((m) => m.t === 'error')).code, 'upgrade_required');
    assert.equal(srv.hub.store.isSubscribed(beyond.welcome.id), false);
    // errors during confirm / restore / go premium: one failure reply each, nothing unlocked
    const { c } = await connect(srv.port, 'Err');
    assert.equal((await confirm(c, SESSION)).code, 'unreachable');
    assert.equal((await restore(c, 'x@example.test')).code, 'unreachable');
    c.send({ t: 'goPremium' });
    assert.match((await c.waitFor((m) => m.t === 'notice' && m.kind === 'error')).message, /Could not start checkout/);
    assert.equal(subscribedMsgs(c).length, 0);
  } finally { await close(); }
});

test('a Stripe request that hangs times out and the client still gets exactly one reply', async () => {
  const { mock, srv, close } = await setup({ timeoutMs: 250 });
  try {
    mock.mode = 'hang';
    const { c } = await connect(srv.port, 'Tim');
    const t0 = Date.now();
    assert.equal((await confirm(c, SESSION)).code, 'unreachable');
    assert.ok(Date.now() - t0 < 3000);
    assert.equal((await restore(c, 'x@example.test')).code, 'unreachable');
    await sleep(100);
    assert.equal(c.log.filter((m) => m.t === 'premiumResult').length, 1);
    assert.equal(c.log.filter((m) => m.t === 'restoreResult').length, 1);
  } finally { await close(); }
});

test('rate limits: confirm and restore attempts are limited per connection', async () => {
  const { mock, srv, close } = await setup();
  try {
    const { c } = await connect(srv.port, 'Lim');
    for (let i = 0; i < 10; i++) assert.equal((await confirm(c, 'cs_test_nothere' + String(i).padStart(10, '0'))).code, 'bad_session');
    assert.equal((await confirm(c, SESSION)).code, 'rate_limited');
    const { c: d } = await connect(srv.port, 'Lim2');
    for (let i = 0; i < 5; i++) assert.equal((await restore(d, `nobody${i}@example.test`)).code, 'not_found');
    assert.equal((await restore(d, 'nobody@example.test')).code, 'rate_limited');
    assert.ok(mock.requests.length > 0);
  } finally { await close(); }
});

test('the secret key never appears in logs or in anything sent to a client', async () => {
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  const { mock, srv, close } = await setup();
  try {
    mock.addSub('sub_ok', 'cus_1', 'active');
    mock.addSession({ id: SESSION, sub: 'sub_ok' });
    mock.addCustomer('cus_1', 'buyer@example.test');
    const { c } = await connect(srv.port, 'Sec');
    c.send({ t: 'goPremium' });
    await c.waitFor((m) => m.t === 'checkout');
    await confirm(c, SESSION);
    await restore(c, 'buyer@example.test');
    mock.mode = 'error500'; // the mock even echoes the key inside its error text
    await confirm(c, 'cs_test_second1234567890');
    await restore(c, 'zzz@example.test');
    c.send({ t: 'goPremium' }); // refused locally (already premium) or via error
    await sleep(100);
    const wire = JSON.stringify(c.log);
    assert.equal(wire.includes(SECRET), false);
    assert.equal(wire.includes('sk_test_'), false);
    assert.equal(/Bearer/i.test(wire), false);
    const text = logs.join('\n');
    assert.equal(text.includes(SECRET), false);
    assert.equal(/Bearer|Authorization|sk_test_/i.test(text), false);
    assert.ok(/\[billing\] .*HTTP 200/.test(text), 'status codes are logged'); // some logging does happen
  } finally { Object.assign(console, orig); await close(); }
});
