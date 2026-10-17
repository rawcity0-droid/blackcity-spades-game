// A tiny local stand-in for the parts of the Stripe API that billing.ts uses. Tests NEVER talk to the real Stripe.
// Shapes follow the documented objects (checkout.session, subscription, customer, list/search results).

import http from 'node:http';

export const SECRET = 'sk_test_MOCKSECRET0123456789';
export const PRICE = 'price_mock_monthly';

export interface MockRequest { method: string; path: string; query: URLSearchParams; form: URLSearchParams; headers: http.IncomingHttpHeaders }

export class MockStripe {
  server!: http.Server;
  url = '';
  requests: MockRequest[] = [];
  sessions = new Map<string, any>();
  subs = new Map<string, any>();
  customers = new Map<string, any>();
  mode: 'ok' | 'error500' | 'hang' = 'ok';
  private n = 0;

  async start(): Promise<this> { return this.start2(0); }

  async start2(port: number): Promise<this> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as any).port}`;
    return this;
  }
  stop(): Promise<void> { this.server.closeAllConnections?.(); return new Promise((r) => this.server.close(() => r())); }

  /** Requests whose path starts with `prefix`. */
  calls(prefix: string): MockRequest[] { return this.requests.filter((r) => r.path.startsWith(prefix)); }

  addCustomer(id: string, email: string): void { this.customers.set(id, { id, object: 'customer', email }); }
  addSub(id: string, customer: string, status: string, price = PRICE): any {
    const s = { id, object: 'subscription', customer, status, items: { object: 'list', data: [{ id: 'si_' + id, price: { id: price } }] } };
    this.subs.set(id, s);
    return s;
  }
  /** A completed checkout the way Stripe returns it after a successful subscription purchase. */
  addSession(o: { id: string; email?: string; customer?: string; sub?: string; mode?: string; status?: string; paymentStatus?: string; app?: string | null; hostId?: string }): any {
    const s = {
      id: o.id, object: 'checkout.session', mode: o.mode ?? 'subscription', status: o.status ?? 'complete', payment_status: o.paymentStatus ?? 'paid',
      customer: o.customer ?? 'cus_1', subscription: o.sub ?? 'sub_1', customer_details: { email: o.email ?? 'Buyer@Example.test' },
      customer_email: null, client_reference_id: o.hostId ?? null,
      metadata: o.app === null ? {} : { app: o.app ?? 'blackcity-spades', host_id: o.hostId ?? '' },
    };
    this.sessions.set(o.id, s);
    return s;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    const u = new URL(req.url ?? '/', 'http://x');
    const rec: MockRequest = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, form: new URLSearchParams(body), headers: req.headers };
    this.requests.push(rec);
    const send = (status: number, obj: object) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Request-Id': 'req_mock' + ++this.n }).end(JSON.stringify(obj)); };
    if (this.mode === 'hang') return; // never answers: the client's timeout must fire
    if (this.mode === 'error500') return send(500, { error: { type: 'api_error', message: 'boom ' + SECRET } });
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { error: { type: 'invalid_request_error', message: 'bad key' } });
    const p = u.pathname;
    if (rec.method === 'POST' && p === '/v1/checkout/sessions') {
      const id = 'cs_test_created' + ++this.n + 'abcdefgh';
      return send(200, { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, mode: rec.form.get('mode') });
    }
    let m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (m && rec.method === 'GET') {
      const s = this.sessions.get(decodeURIComponent(m[1]));
      if (!s) return send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
      const expand = u.searchParams.getAll('expand[]').includes('subscription');
      return send(200, { ...s, subscription: expand && s.subscription ? (this.subs.get(s.subscription) ?? s.subscription) : s.subscription });
    }
    m = p.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (m && rec.method === 'GET') {
      const s = this.subs.get(decodeURIComponent(m[1]));
      return s ? send(200, s) : send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
    }
    if (p === '/v1/subscriptions' && rec.method === 'GET') {
      const cus = u.searchParams.get('customer');
      const all = u.searchParams.get('status') === 'all';
      return send(200, { object: 'list', data: [...this.subs.values()].filter((s) => s.customer === cus && (all || s.status !== 'canceled')) });
    }
    if (p === '/v1/customers' && rec.method === 'GET') { // exact, case-sensitive like the real list filter
      const email = u.searchParams.get('email');
      return send(200, { object: 'list', data: [...this.customers.values()].filter((c) => c.email === email) });
    }
    if (p === '/v1/customers/search' && rec.method === 'GET') { // case-insensitive, like Search
      const q = u.searchParams.get('query') ?? '';
      const email = (q.match(/email:"([^"]*)"/)?.[1] ?? '').toLowerCase();
      return send(200, { object: 'search_result', data: [...this.customers.values()].filter((c) => String(c.email).toLowerCase() === email) });
    }
    send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } });
  }
}
