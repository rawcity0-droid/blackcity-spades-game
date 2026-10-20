// Activity log lines (`[activity] {json}` on stdout) and best-of-3 / best-of-5 rounds for every bracket size.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG } from '../src/config.js';
import { mulberry32 } from '../src/engine/cards.js';
import { ACTIVITY_PREFIX, isTestNick } from '../src/server/activity.js';
import { Billing } from '../src/server/billing.js';
import { Tournament } from '../src/server/tournament.js';
import { autoPlay, connect, testServer } from './helpers.js';
import { MockStripe, PRICE, SECRET } from './mock-stripe.js';

/** Capture console.log while fn runs; returns the parsed activity events (and the raw lines). */
async function capture(fn: () => Promise<void>): Promise<{ evs: any[]; raw: string[] }> {
  const raw: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { const s = a.map(String).join(' '); if (s.startsWith(ACTIVITY_PREFIX + ' ')) raw.push(s); else orig(...a); };
  try { await fn(); } finally { console.log = orig; }
  return { raw, evs: raw.map((l) => JSON.parse(l.slice(ACTIVITY_PREFIX.length + 1))) };
}
const waitUntil = async (pred: () => boolean, ms = 30000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};

test('test nicknames: LiveCheck / HealthCheck / Health prefixes', () => {
  for (const n of ['LiveCheck', 'LiveCheck42', 'HealthCheck', 'Health-3', 'health']) assert.equal(isTestNick(n), true, n);
  for (const n of ['Raw', 'Vera', 'MyHealth', '', null]) assert.equal(isTestNick(n as any), false, String(n));
});

test('hello: one line per connection with resumed, no token or id; test flag for check nicknames', async () => {
  const srv = await testServer();
  let token = '';
  try {
    const { raw, evs } = await capture(async () => {
      const a = await connect(srv.port, 'Vera');
      token = a.welcome.token;
      a.c.close();
      await connect(srv.port, 'Vera', token);
      await connect(srv.port, 'LiveCheck7');
    });
    assert.deepEqual(evs.map((e) => [e.ev, e.resumed, e.test]), [['hello', false, undefined], ['hello', true, undefined], ['hello', false, true]]);
    for (const l of raw) { assert.ok(!l.includes(token)); assert.match(l, /^\[activity\] \{"ev":"hello","resumed":(true|false)(,"test":true)?,"at":"[^"]+"\}$/); }
  } finally { await srv.close(); }
});

test('Play now: game_start and game_end with kind, humans, bots, target, winner, scores, seconds', async () => {
  const srv = await testServer();
  try {
    const { evs } = await capture(async () => {
      const { c } = await connect(srv.port, 'HealthCheck');
      autoPlay(c);
      c.send({ t: 'quickPlay' });
      await waitUntil(() => !!(c.log.find((m) => m.t === 'table' && m.winner != null)));
    });
    const start = evs.find((e) => e.ev === 'game_start');
    const end = evs.find((e) => e.ev === 'game_end');
    assert.ok(start && end);
    assert.equal(start.kind, 'playnow');
    assert.equal(start.humans, 1);
    assert.equal(start.bots, 3);
    assert.equal(start.target, CONFIG.freeMatchTarget);
    assert.equal(start.test, true);
    assert.equal(end.tableId, start.tableId);
    assert.ok(end.winner === 0 || end.winner === 1);
    assert.equal(end.scores.length, 2);
    assert.equal(typeof end.seconds, 'number');
    assert.equal(end.forfeit, false);
  } finally { await srv.close(); }
});

test('tournament: tournament_start, game_start/end (kind tournament), series_end with round and score, tournament_end', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { evs, raw } = await capture(async () => {
      const org = (await connect(srv.port, 'Org')).c;
      org.send({ t: 'devToggleSubscription' });
      await org.waitFor((m) => m.t === 'subscription');
      org.send({ t: 'createTournament', size: 4, isPublic: true });
      await org.waitFor((m) => m.t === 'tournament');
      autoPlay(org);
      org.send({ t: 'startTournament' });
      await org.waitFor((m) => m.t === 'tournament' && m.state === 'finished', 60000);
    });
    const kinds = evs.map((e) => e.ev);
    assert.equal(kinds.filter((k) => k === 'tournament_start').length, 1);
    assert.equal(kinds.filter((k) => k === 'tournament_end').length, 1);
    const ts = evs.find((e) => e.ev === 'tournament_start');
    assert.deepEqual([ts.kind, ts.size, ts.rounds], ['tournament', 4, 2]);
    const games = evs.filter((e) => e.ev === 'game_start');
    assert.ok(games.length >= 2 && games.every((g) => g.kind === 'tournament' && g.humans === 1 && g.bots === 3));
    const series = evs.filter((e) => e.ev === 'series_end');
    assert.ok(series.length >= 1);
    for (const s of series) {
      assert.equal(s.bestOf, s.final ? 5 : 3);
      assert.equal(Math.max(...s.wins), s.final ? 3 : 2);
      assert.equal(s.round, s.final ? 2 : 1);
    }
    assert.ok(kinds.indexOf('tournament_end') > kinds.lastIndexOf('series_end'));
    for (const l of raw) assert.ok(!/token|email|cus_|sub_/.test(l));
  } finally { await srv.close(); }
});

test('checkout_started on Go Premium, checkout_completed once Stripe verifies the returned session (mock Stripe)', async () => {
  const mock = await new MockStripe().start();
  const billing = new Billing({ secretKey: SECRET, priceId: PRICE, apiBase: mock.url, timeoutMs: 2000 });
  const srv = await testServer({ billing });
  try {
    mock.addCustomer('cus_1', 'buyer@example.test');
    mock.addSub('sub_ok', 'cus_1', 'active');
    mock.addSession({ id: 'cs_test_paidsession1234567890', sub: 'sub_ok' });
    const { evs, raw } = await capture(async () => {
      const { c } = await connect(srv.port, 'Gus');
      c.send({ t: 'goPremium' });
      await c.waitFor((m) => m.t === 'checkout');
      c.send({ t: 'confirmPremium', sessionId: 'cs_test_paidsession1234567890' });
      assert.equal((await c.waitFor((m) => m.t === 'premiumResult')).ok, true);
      c.send({ t: 'confirmPremium', sessionId: 'cs_test_paidsession1234567890' }); // a repeat is not counted twice
      await c.waitFor((m) => m.t === 'premiumResult' && c.log.filter((x) => x.t === 'premiumResult').length === 2);
    });
    assert.deepEqual(evs.map((e) => e.ev).filter((k) => k.startsWith('checkout')), ['checkout_started', 'checkout_completed']);
    for (const l of raw) assert.ok(!/cs_test|sub_ok|cus_1|buyer@|sk_/.test(l), l);
  } finally { await srv.close(); await mock.stop(); }
});

test('every bracket size: best of 3 in every round but the final, best of 5 only in the final', () => {
  assert.deepEqual([...CONFIG.tournamentSizes], [4, 8, 16]);
  for (const size of CONFIG.tournamentSizes) {
    const t = new Tournament({ id: 's' + size, code: 'S', size, organizerId: 'org', isPublic: true, rng: mulberry32(size), host: { createMatchTable: () => ({ id: 'x', code: 'X' }), changed() {} } });
    t.start('org');
    const rounds = Math.log2(size);
    assert.equal(t.rounds.length, rounds, `size ${size}`);
    t.rounds.forEach((r, i) => {
      const bestOf = i === rounds - 1 ? 5 : 3;
      for (const m of r) assert.equal(2 * m.need - 1, bestOf, `size ${size} round ${i + 1}`);
      for (const m of r) assert.equal(Math.max(...m.wins), m.need); // simulated series ran to exactly that many wins
    });
    const view: any = t.view('org');
    assert.deepEqual(view.rounds.map((r: any) => r.bestOf), [...Array(rounds - 1).fill(3), 5], `size ${size} view`);
  }
});
