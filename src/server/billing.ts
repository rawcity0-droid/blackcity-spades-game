// Stripe billing over plain fetch (no SDK, no webhook). Checkout Session in subscription mode for Go Premium, then the
// server VERIFIES the session (and its subscription) against the Stripe API before unlocking anything. Restore Premium by
// email looks the customer up on Stripe. Cancellations are noticed by periodic re-checks (see hub.ts), not by webhooks.
//
// Secrets: STRIPE_SECRET_KEY and STRIPE_PRICE_ID come from the environment only. The key is never logged, never copied
// into an error, and never sent to a client. Only status codes and Stripe request ids (Request-Id header) are logged.
//
// Stripe documentation relied on (checked 2026-10-16):
//   Authentication (Bearer auth is supported):  https://docs.stripe.com/api/authentication
//   Create a Checkout Session (mode, line_items[0][price|quantity], success_url, cancel_url, client_reference_id, metadata):
//                                               https://docs.stripe.com/api/checkout/sessions/create
//   Retrieve a Checkout Session (status, payment_status, mode, subscription, customer, customer_details, customer_email,
//   client_reference_id, metadata, url):         https://docs.stripe.com/api/checkout/sessions/retrieve
//                                               https://docs.stripe.com/api/checkout/sessions/object
//   {CHECKOUT_SESSION_ID} literal placeholder in success_url:
//                                               https://docs.stripe.com/payments/checkout/custom-success-page?payment-ui=stripe-hosted
//   expand[]=subscription:                       https://docs.stripe.com/api/expanding_objects
//   Retrieve / list subscriptions (status, items.data[].price.id, customer; list filters customer/status/limit):
//                                               https://docs.stripe.com/api/subscriptions/retrieve
//                                               https://docs.stripe.com/api/subscriptions/list
//                                               https://docs.stripe.com/api/subscriptions/object
//   List customers (email filter is exact and CASE-SENSITIVE) and Search customers (email:"..." is case-insensitive but
//   eventually consistent and not available in every region):
//                                               https://docs.stripe.com/api/customers/list
//                                               https://docs.stripe.com/api/customers/search
//                                               https://docs.stripe.com/search
//   Request ids (Request-Id response header):    https://docs.stripe.com/api/request_ids
// Not verified against a live account: this code has only been run against a local mock of the documented shapes.

import { CONFIG } from '../config.js';

export type BillingFailure = 'unreachable' | 'stripe_error' | 'bad_response';

/** Thrown when Stripe cannot be reached or answers with an error. Carries no secrets and no Stripe message text. */
export class BillingError extends Error {
  constructor(readonly kind: BillingFailure, readonly status = 0) { super(`billing ${kind}${status ? ' ' + status : ''}`); }
}

export interface BillingConfig {
  secretKey?: string;
  priceId?: string;
  /** Stripe API origin; override for tests (a local mock). Default https://api.stripe.com */
  apiBase?: string;
  timeoutMs?: number;
}

/** What a verified purchase or restored subscription tells us. */
export interface ActiveSubscription {
  customerId: string;
  subscriptionId: string;
  email: string;
}

export type VerifyOutcome =
  | { ok: true; sub: ActiveSubscription }
  | { ok: false; code: 'bad_session' | 'not_paid' | 'wrong_plan' | 'inactive' };

const ACTIVE = new Set(['active', 'trialing']);
export const APP_TAG = 'blackcity-spades';
export const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;

type Json = Record<string, any>;

export class Billing {
  private secretKey: string;
  private priceId: string;
  private apiBase: string;
  private timeoutMs: number;

  constructor(cfg: BillingConfig = {}) {
    this.secretKey = (cfg.secretKey ?? '').trim();
    this.priceId = (cfg.priceId ?? '').trim();
    this.apiBase = (cfg.apiBase ?? CONFIG.stripeApiBase).replace(/\/+$/, '');
    this.timeoutMs = cfg.timeoutMs ?? CONFIG.stripeTimeoutMs;
  }

  /** The only place the environment is read for secrets. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Billing {
    return new Billing({ secretKey: env.STRIPE_SECRET_KEY, priceId: env.STRIPE_PRICE_ID });
  }

  /** Billing needs both the key and the price id; without them Go Premium shows "not set up yet". */
  get enabled(): boolean { return !!this.secretKey && !!this.priceId; }

  // ---------- low-level request ----------

  private async call(label: string, method: 'GET' | 'POST', path: string, params: [string, string][] = []): Promise<Json> {
    const body = new URLSearchParams(params);
    let url = this.apiBase + path;
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (method === 'GET') { if (params.length) url += '?' + body.toString(); }
    else { init.body = body.toString(); (init.headers as Record<string, string>)['Content-Type'] = 'application/x-www-form-urlencoded'; }
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      console.warn(`[billing] ${label}: unreachable or timed out`);
      throw new BillingError('unreachable');
    }
    const reqId = res.headers.get('request-id') ?? '-';
    console.log(`[billing] ${label}: HTTP ${res.status} (${reqId})`);
    let json: Json;
    try { json = (await res.json()) as Json; } catch { throw new BillingError('bad_response', res.status); }
    if (!res.ok) throw new BillingError('stripe_error', res.status);
    if (typeof json !== 'object' || json === null) throw new BillingError('bad_response', res.status);
    return json;
  }

  // ---------- Go Premium ----------

  /** Create a subscription-mode Checkout Session for this player and return the hosted Checkout URL. */
  async createCheckoutSession(hostId: string, baseUrl: string): Promise<string> {
    const base = baseUrl.replace(/\/+$/, '');
    const s = await this.call('checkout.sessions.create', 'POST', '/v1/checkout/sessions', [
      ['mode', 'subscription'],
      ['line_items[0][price]', this.priceId],
      ['line_items[0][quantity]', '1'],
      // Stripe's own 400 error on this account says to pass this to turn off Managed Payments (which requires a product tax code) for this session.
      ['managed_payments[enabled]', 'false'],
      ['success_url', `${base}/?premium=success&session_id={CHECKOUT_SESSION_ID}`], // literal placeholder, Stripe fills it in
      ['cancel_url', `${base}/?premium=cancel`],
      ['client_reference_id', hostId],
      ['metadata[host_id]', hostId],
      ['metadata[app]', APP_TAG],
    ]);
    const url = typeof s.url === 'string' ? s.url : '';
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === 'https:' || (u.protocol === 'http:' && this.apiBase.startsWith('http:')); } catch { /* not a URL */ }
    if (!ok) throw new BillingError('bad_response');
    return url;
  }

  // ---------- return from Checkout ----------

  /**
   * Retrieve the Checkout Session (with its subscription expanded) and decide. Unlocks only if the session was created
   * by this app, is a completed + paid subscription-mode session, and its subscription is active/trialing on our price.
   */
  async verifyCheckoutSession(sessionId: string): Promise<VerifyOutcome> {
    if (!SESSION_ID_RE.test(sessionId)) return { ok: false, code: 'bad_session' };
    let s: Json;
    try {
      s = await this.call('checkout.sessions.retrieve', 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, [['expand[]', 'subscription']]);
    } catch (e) {
      if (e instanceof BillingError && e.kind === 'stripe_error' && (e.status === 404 || e.status === 400)) return { ok: false, code: 'bad_session' };
      throw e;
    }
    if (s.object !== 'checkout.session' || s.metadata?.app !== APP_TAG) return { ok: false, code: 'bad_session' };
    if (s.mode !== 'subscription') return { ok: false, code: 'bad_session' };
    if (s.status !== 'complete' || s.payment_status !== 'paid') return { ok: false, code: 'not_paid' };
    const sub = s.subscription;
    if (!sub || typeof sub !== 'object') return { ok: false, code: 'inactive' }; // an unexpanded id means we cannot check the plan
    if (!ACTIVE.has(sub.status)) return { ok: false, code: 'inactive' };
    if (!this.hasPrice(sub)) return { ok: false, code: 'wrong_plan' };
    const customerId = typeof s.customer === 'string' ? s.customer : (s.customer?.id ?? sub.customer);
    if (typeof customerId !== 'string' || typeof sub.id !== 'string') return { ok: false, code: 'bad_session' };
    const email = String(s.customer_details?.email ?? s.customer_email ?? '').trim().toLowerCase();
    return { ok: true, sub: { customerId, subscriptionId: sub.id, email } };
  }

  private hasPrice(sub: Json): boolean {
    const items = sub.items?.data;
    return Array.isArray(items) && items.some((i: Json) => i?.price?.id === this.priceId);
  }

  // ---------- re-check ----------

  /** Is this subscription still active/trialing on our price? Throws BillingError when Stripe cannot be asked. */
  async isSubscriptionActive(subscriptionId: string): Promise<boolean> {
    try {
      const sub = await this.call('subscriptions.retrieve', 'GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
      return ACTIVE.has(sub.status) && this.hasPrice(sub);
    } catch (e) {
      if (e instanceof BillingError && e.kind === 'stripe_error' && e.status === 404) return false; // gone
      throw e;
    }
  }

  // ---------- Restore Premium by email ----------

  /**
   * Find an active/trialing subscription on our price for customers with this email. `knownCustomerIds` are customers we
   * saw in verified checkouts (covers Stripe Search lag and email-case differences). Returns null when none is active.
   * Throws BillingError('unreachable' | ...) only when Stripe could not be asked and nothing was found.
   */
  async findActiveByEmail(emailRaw: string, knownCustomerIds: string[] = []): Promise<ActiveSubscription | null> {
    const email = emailRaw.trim().toLowerCase();
    const customers = new Map<string, string>(); // id -> email
    for (const id of knownCustomerIds) customers.set(id, email);
    let lookupsFailed = 0;
    const gather = async (label: string, path: string, params: [string, string][]) => {
      try {
        const r = await this.call(label, 'GET', path, params);
        for (const c of Array.isArray(r.data) ? r.data : []) {
          if (typeof c?.id === 'string' && String(c.email ?? '').trim().toLowerCase() === email) customers.set(c.id, email);
        }
      } catch { lookupsFailed += 1; }
    };
    // The list filter is exact and case-sensitive (so only lowercase-stored emails match); Search is case-insensitive but lags.
    // Customers seen in verified checkouts (knownCustomerIds) cover both gaps.
    await gather('customers.list', '/v1/customers', [['email', email], ['limit', '10']]);
    await gather('customers.search', '/v1/customers/search', [['query', `email:"${email.replace(/["\\]/g, '')}"`], ['limit', '10']]);
    let subsFailed = 0;
    for (const id of [...customers.keys()].slice(0, 10)) {
      try {
        const r = await this.call('subscriptions.list', 'GET', '/v1/subscriptions', [['customer', id], ['status', 'all'], ['limit', '100']]);
        const hit = (Array.isArray(r.data) ? r.data : []).find((s: Json) => ACTIVE.has(s.status) && this.hasPrice(s));
        if (hit && typeof hit.id === 'string') return { customerId: id, subscriptionId: hit.id, email };
      } catch { subsFailed += 1; }
    }
    if (subsFailed > 0) throw new BillingError('unreachable'); // could not check someone: do not claim "no Premium"
    if (customers.size === 0 && lookupsFailed >= 2) throw new BillingError('unreachable');
    return null;
  }
}
