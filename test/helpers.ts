// Test helpers: a tiny WebSocket client and fast server timings.

import WebSocket from 'ws';
import { RunningServer, startServer } from '../src/server/server.js';
import type { HubOptions } from '../src/server/hub.js';

export const FAST = { botDelayMs: 0, trickPauseMs: 0, handPauseMs: 0, matchEndPauseMs: 0, abandonMs: 150, emptyTableTtlMs: 60000, seatHoldMs: 60000 };

export async function testServer(opts: HubOptions = {}): Promise<RunningServer> {
  return startServer({
    port: 0, host: '127.0.0.1', rateLimit: { burst: 100000, perSecond: 100000 }, ...opts,
    timings: { ...FAST, ...opts.timings },
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Client {
  ws: WebSocket;
  log: any[] = [];
  last: Record<string, any> = {};
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  closed = false;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      this.log.push(m);
      this.last[m.t] = m;
      for (const w of this.waiters.slice()) if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
    });
    this.ws.on('close', () => { this.closed = true; });
  }

  open(): Promise<void> {
    return new Promise((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
  }

  send(msg: object): void { this.ws.send(JSON.stringify(msg)); }

  /** Resolve with the first message (new or already received if `past`) matching the predicate. */
  waitFor(pred: (m: any) => boolean, ms = 8000, past = false): Promise<any> {
    if (past) { const hit = this.log.find(pred); if (hit) return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message; last types: ' + this.log.slice(-5).map((m) => m.t + (m.code ? ':' + m.code : '')).join(','))), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  async hello(nick: string, token?: string): Promise<any> {
    const w = this.waitFor((m) => m.t === 'welcome');
    this.send({ t: 'hello', nick, token });
    return w;
  }

  close(): void { this.ws.close(); }
}

export async function connect(port: number, nick: string, token?: string): Promise<{ c: Client; welcome: any }> {
  const c = new Client(port);
  await c.open();
  const welcome = await c.hello(nick, token);
  return { c, welcome };
}

/** Auto-play a seated client: bid 3, then play the first legal card. Stops when `stop()` returns true. */
export function autoPlay(c: Client): void {
  c.ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t !== 'table' || m.spectator) return;
    if (m.canBid) c.send({ t: 'bid', bid: 3 });
    else if (m.legal && m.legal.length > 0) c.send({ t: 'play', card: m.legal[0] });
  });
}
