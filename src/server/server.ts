// HTTP + WebSocket server. Static files from public/, WebSocket at /ws, a /healthz probe,
// and a dev-only subscription endpoint (404 unless DEV_UNLOCK is set). Billing runs over the WebSocket (see hub.ts / billing.ts).

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CONFIG } from '../config.js';
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

/** Public origin of this server as the browser sees it (behind Render's proxy: x-forwarded-*), for Stripe return URLs. */
export function originOf(req: http.IncomingMessage): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v ?? '').split(',')[0].trim();
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
  const proto = first(req.headers['x-forwarded-proto']).toLowerCase();
  if (/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return `${proto === 'https' || proto === 'http' ? proto : (req.socket as any).encrypted ? 'https' : 'http'}://${host}`;
  return `http://localhost:${req.socket.localPort ?? 3000}`;
}

export function startServer(opts: { port?: number; host?: string } & HubOptions = {}): Promise<RunningServer> {
  const hub = new Hub(opts);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/healthz') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');

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

  wss.on('connection', (ws, req) => {
    const w = ws as typeof ws & { alive?: boolean };
    w.alive = true;
    ws.on('pong', () => { w.alive = true; });
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim(); // Render's proxy puts the client first
    const conn = hub.attach(ws, originOf(req), fwd || req.socket.remoteAddress || '');
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
