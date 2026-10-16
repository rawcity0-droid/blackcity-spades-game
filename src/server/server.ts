// HTTP + WebSocket server. Static files from public/, WebSocket at /ws, a /healthz probe,
// stubbed /billing/* routes (501) and a dev-only subscription endpoint (404 unless DEV_UNLOCK is set).

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CONFIG } from '../config.js';
import * as billing from './billing.js';
import { Hub, HubOptions } from './hub.js';
import { SECURITY_HEADERS, serveStatic } from './static.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

export interface RunningServer {
  port: number;
  hub: Hub;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

export function startServer(opts: { port?: number; host?: string } & HubOptions = {}): Promise<RunningServer> {
  const hub = new Hub(opts);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/healthz') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');

      // Billing plug-in points: not implemented in v1
      if (url.pathname.startsWith('/billing/')) {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const notImpl = () => json(res, 501, { error: 'not_implemented', message: 'Payments are not set up yet' });
        try {
          if (url.pathname === '/billing/checkout') await billing.createCheckoutSession('host');
          else if (url.pathname === '/billing/portal') await billing.createPortalSession('host');
          else if (url.pathname === '/billing/webhook') await billing.handleWebhook(Buffer.alloc(0), undefined);
          else return json(res, 404, { error: 'not_found' });
        } catch (e) {
          if (e instanceof billing.NotImplementedError) return notImpl();
          throw e;
        }
        return notImpl();
      }

      // Dev-only subscription toggle (disabled unless DEV_UNLOCK=1)
      if (url.pathname === '/dev/subscription') {
        if (!hub.devUnlock) return json(res, 404, { error: 'not_found' });
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        let body: { token?: unknown; active?: unknown } = {};
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad_json' }); }
        if (typeof body.token !== 'string' || !/^[a-f0-9]{32}$/.test(body.token)) return json(res, 400, { error: 'bad_token' });
        const on = hub.devSetSubscription(body.token, typeof body.active === 'boolean' ? body.active : undefined);
        return json(res, 200, { subscribed: on });
      }

      serveStatic(PUBLIC_DIR, req, res);
    } catch (e) {
      console.error('http error', e);
      if (!res.headersSent) json(res, 500, { error: 'server_error' });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: CONFIG.limits.maxPayloadBytes });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as typeof ws & { alive?: boolean };
      if (w.alive === false) { ws.terminate(); continue; }
      w.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  wss.on('connection', (ws) => {
    const w = ws as typeof ws & { alive?: boolean };
    w.alive = true;
    ws.on('pong', () => { w.alive = true; });
    const conn = hub.attach(ws);
    if (!conn) { ws.close(1013, 'server full'); return; }
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      hub.onMessage(conn, data.toString('utf8'));
    });
    ws.on('close', () => hub.onClose(conn));
    ws.on('error', () => { /* close follows */ });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        hub,
        close: () => new Promise<void>((done) => {
          clearInterval(heartbeat);
          hub.close();
          for (const c of wss.clients) c.terminate();
          wss.close(() => server.close(() => done()));
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
