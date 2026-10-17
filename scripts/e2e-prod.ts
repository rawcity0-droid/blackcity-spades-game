// End-to-end check of a PRODUCTION-MODE server (no DEV_UNLOCK) against a LOCAL MOCK of Stripe. Usage:
//   (shell 1)  SPADES_FAST=1 PORT=3388 OWNER_EMAILS=owner@example.test STRIPE_SECRET_KEY=sk_test_mock STRIPE_PRICE_ID=price_mock_monthly \
//              STRIPE_API_BASE=http://127.0.0.1:3389 npm start
//   (shell 2)  E2E_URL=ws://localhost:3388/ws E2E_MOCK_PORT=3389 npm run e2e:prod
// The script itself serves the mock Stripe on E2E_MOCK_PORT. It never contacts the real Stripe and needs no real key.
// Checks: name required; Practice with no name plays a whole hand; owner restore then Create Table; Stripe checkout ->
// verified return -> Premium; restore by email; wrong/replayed sessions refused.

import WebSocket from 'ws';
import { MockStripe, PRICE } from '../test/mock-stripe.js';

const URL_ = process.env.E2E_URL ?? 'ws://localhost:3388/ws';
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 3389);
const OWNER = 'owner@example.test';
let failures = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

class Client {
  ws!: WebSocket; log: any[] = []; welcome: any;
  waiters: { p: (m: any) => boolean; r: (m: any) => void }[] = [];
  async connect(nick: string, token?: string) {
    this.ws = new WebSocket(URL_);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); this.log.push(m);
      for (const w of this.waiters.slice()) if (w.p(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.r(m); }
    });
    await new Promise((r) => this.ws.once('open', r));
    const w = this.wait((m) => m.t === 'welcome');
    this.send({ t: 'hello', nick, token });
    this.welcome = await w;
    return this;
  }
  send(o: object) { this.ws.send(JSON.stringify(o)); }
  wait(p: (m: any) => boolean, ms = 30000): Promise<any> {
    return new Promise((r, j) => { const t = setTimeout(() => j(new Error('timeout; last: ' + this.log.slice(-4).map((x) => x.t + (x.code ?? '')).join(','))), ms); this.waiters.push({ p, r: (m) => { clearTimeout(t); r(m); } }); });
  }
  async ask(msg: any, reply: string): Promise<any> { const n = this.log.length; const w = this.wait((m) => m.t === reply && this.log.indexOf(m) >= n); this.send(msg); return w; }
}

async function main() {
  const mock = await new MockStripe().start2(MOCK_PORT);
  try {
    // 1. A brand-new visitor has no name; joining / creating needs one
    const n1 = await new Client().connect('');
    check(n1.welcome.nick === '', 'hello with an empty name leaves the name empty (no default)');
    check(n1.welcome.subscribed === false && n1.welcome.config.devUnlock === false, 'production mode: DEV_UNLOCK is off, new visitor is not premium');
    const e1 = await n1.ask({ t: 'quickPlay' }, 'error');
    check(e1.code === 'name_required', 'Quick play without a name is refused (name_required)');
    const e2 = await n1.ask({ t: 'createTable', isPublic: false, target: 500 }, 'error');
    check(e2.code === 'name_required', 'Create Table without a name is refused (name_required)');

    // 2. Practice needs no name: seated as "You", plays a full hand (bid, 13 tricks) to the hand summary
    n1.send({ t: 'createTable', isPublic: true, target: 250, practice: true });
    const t0 = await n1.wait((m) => m.t === 'table');
    check(t0.seats[t0.mySeat].name === 'You', 'Practice with no name seats the player as "You"');
    n1.send({ t: 'startTable' });
    let plays = 0; let bids = 0; let acted = '';
    n1.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t !== 'table' || m.spectator || m.handNo !== 1) return;
      const key = `${m.handNo}:${m.hand.length}:${m.canBid}:${m.trick?.length ?? 0}`;
      if (key === acted) return;
      if (m.canBid) { acted = key; bids++; setTimeout(() => n1.send({ t: 'bid', bid: 3 }), 40); }
      else if (m.legal?.length) { acted = key; plays++; setTimeout(() => n1.send({ t: 'play', card: m.legal[0] }), 40); }
    });
    const after = await n1.wait((m) => m.t === 'table' && (m.phase === 'handOver' || m.handNo >= 2), 60000);
    check(bids === 1 && plays === 13, `Practice hand played through: ${bids} bid and ${plays} cards played, then ${after.phase === 'handOver' ? 'hand summary' : 'next hand'} (scores ${after.scores.join('-')})`);
    n1.send({ t: 'leaveTable' });
    await n1.wait((m) => m.t === 'left');

    // 3. Owner restore (OWNER_EMAILS) then Create Table works
    const owner = await new Client().connect('Olive');
    const g1 = await owner.ask({ t: 'createTable', isPublic: false, target: 500 }, 'error');
    check(g1.code === 'upgrade_required', 'a free player is refused a private table before restoring');
    const bad = await owner.ask({ t: 'restorePremium', email: 'stranger@example.test' }, 'restoreResult');
    check(bad.ok === false && /doesn.t have active Premium/.test(bad.message), 'a non-owner email gets the friendly message and the modal can stay open');
    const good = await owner.ask({ t: 'restorePremium', email: '  OWNER@Example.Test ' }, 'restoreResult');
    check(good.ok === true, 'owner email (mixed case, spaces) restores Premium');
    const tbl = await owner.ask({ t: 'createTable', isPublic: false, target: 500 }, 'table');
    check(tbl.isHost === true && /^[A-Z0-9]{6}$/.test(tbl.code), `Create Table works after the owner restore (code ${tbl.code})`);
    owner.send({ t: 'leaveTable' });
    // survives reconnect
    owner.ws.close();
    const owner2 = await new Client().connect('Olive', owner.welcome.token);
    check(owner2.welcome.subscribed === true, 'Premium persists across a reconnect (same token)');

    // 4. Stripe: Go Premium -> checkout URL -> verified return
    const buyer = await new Client().connect('Bea');
    const co = await buyer.ask({ t: 'goPremium' }, 'checkout');
    const created = mock.calls('/v1/checkout/sessions').pop()!;
    check(/^https:\/\/checkout\.stripe\.com\//.test(co.url) && created.form.get('mode') === 'subscription' && created.form.get('line_items[0][price]') === PRICE, 'Go Premium returns a Stripe Checkout URL (subscription mode, configured price)');
    check(/\/\?premium=success&session_id=\{CHECKOUT_SESSION_ID\}$/.test(created.form.get('success_url') ?? ''), 'success_url carries the {CHECKOUT_SESSION_ID} placeholder');
    mock.addCustomer('cus_bea', 'bea@example.test');
    mock.addSub('sub_bea', 'cus_bea', 'active');
    const sid = 'cs_test_e2ebuyer1234567890';
    mock.addSession({ id: sid, customer: 'cus_bea', sub: 'sub_bea', email: 'Bea@Example.test', hostId: buyer.welcome.id });
    const unpaid = 'cs_test_e2eunpaid1234567890';
    mock.addSession({ id: unpaid, customer: 'cus_bea', sub: 'sub_bea', paymentStatus: 'unpaid' });
    check((await buyer.ask({ t: 'confirmPremium', sessionId: unpaid }, 'premiumResult')).ok === false, 'an unpaid session does not unlock Premium');
    const refused = await buyer.ask({ t: 'createTable', isPublic: false, target: 500 }, 'error');
    check(refused.code === 'upgrade_required', 'still no private table before verification');
    const done = await buyer.ask({ t: 'confirmPremium', sessionId: sid }, 'premiumResult');
    check(done.ok === true, 'a paid, active, matching session unlocks Premium after server-side verification');
    const t2 = await buyer.ask({ t: 'createTable', isPublic: false, target: 500 }, 'table');
    check(t2.isHost === true, 'Create Table works after the Stripe purchase');
    buyer.send({ t: 'leaveTable' });
    const thief = await new Client().connect('Mallory');
    const claimed = await thief.ask({ t: 'confirmPremium', sessionId: sid }, 'premiumResult');
    check(claimed.ok === false && claimed.code === 'claimed', 'the same session id from another browser is refused');
    const relink = await thief.ask({ t: 'restorePremium', email: 'bea@example.test' }, 'restoreResult');
    check(relink.ok === true, 'Restore by email re-links an active Stripe subscription to another device');
    mock.subs.get('sub_bea').status = 'canceled';
    const cancelled = await new Client().connect('Cy');
    const lost = await cancelled.ask({ t: 'restorePremium', email: 'bea@example.test' }, 'restoreResult');
    check(lost.ok === false && lost.code === 'not_found', 'after cancelling, restore by that email no longer unlocks');
    const wire = JSON.stringify([buyer.log, thief.log, cancelled.log, owner.log]);
    check(!/sk_test|Bearer/.test(wire), 'no key material in anything the clients received');
  } finally {
    await mock.stop();
  }
  console.log(failures ? `\n${failures} E2E CHECK(S) FAILED` : '\nALL PRODUCTION E2E CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
