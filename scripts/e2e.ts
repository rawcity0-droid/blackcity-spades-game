// Scripted end-to-end check against a RUNNING server (npm start). Usage:
//   SPADES_FAST=1 DEV_UNLOCK=1 PORT=3377 npm start   (in another shell)
//   E2E_URL=ws://localhost:3377/ws npm run e2e
// Checks: (A) 1 human + 3 bots play a full game to 250; (B) 4 humans play a full game;
// (C) a spectator of (B) never receives a hand; (D) free-tier gating message; (E) a tournament with 1 human.

import WebSocket from 'ws';

const URL_ = process.env.E2E_URL ?? 'ws://localhost:3000/ws';
const CARD = /^[2-9TJQKA][SHDC]$/;
let failures = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

class Bot {
  ws!: WebSocket; log: any[] = []; token = ''; last: any = {};
  waiters: { p: (m: any) => boolean; r: (m: any) => void }[] = [];
  auto = false;
  acted = '';
  async connect(nick: string) {
    this.ws = new WebSocket(URL_);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); this.log.push(m); this.last[m.t] = m;
      if (m.t === 'welcome') this.token = m.token;
      for (const w of this.waiters.slice()) if (w.p(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.r(m); }
      if (this.auto && m.t === 'table' && !m.spectator && (m.canBid || m.legal?.length)) {
        // act once per game state (a real player taps once; duplicate updates must not cause duplicate sends)
        const key = `${m.id}:${m.handNo}:${m.hand.length}:${m.canBid}`;
        if (key === this.acted) return;
        this.acted = key;
        // paced like a fast human (the server rate-limits to ~15 messages/second per connection)
        const move = m.canBid ? { t: 'bid', bid: 3 } : { t: 'play', card: m.legal[Math.floor(Math.random() * m.legal.length)] };
        setTimeout(() => { if (this.ws.readyState === 1) this.send(move); }, 70);
      }
    });
    await new Promise((r) => this.ws.once('open', r));
    const w = this.wait((m) => m.t === 'welcome');
    this.send({ t: 'hello', nick });
    return w;
  }
  send(o: object) { this.ws.send(JSON.stringify(o)); }
  wait(p: (m: any) => boolean, ms = 60000): Promise<any> {
    return new Promise((r, j) => { const t = setTimeout(() => j(new Error('timeout; last table: ' + JSON.stringify(this.last.table && { phase: this.last.table.phase, turn: this.last.table.turn, seat: this.last.table.mySeat, hand: this.last.table.handNo, scores: this.last.table.scores, legal: this.last.table.legal, bot: this.last.table.botControlled, last: this.log.slice(-3).map((x: any) => x.t + (x.code ?? '')) }))), ms); this.waiters.push({ p, r: (m) => { clearTimeout(t); r(m); } }); });
  }
}

async function main() {
  // A: one human + bots to the end
  const a = new Bot(); await a.connect('Solo');
  a.auto = true;
  a.send({ t: 'createTable', isPublic: true, target: 250, practice: true }); // free users play bots only
  await a.wait((m) => m.t === 'table');
  a.send({ t: 'startTable' });
  const endA = await a.wait((m) => m.t === 'table' && m.phase === 'finished');
  check(endA.scores.some((s: number) => s >= 250 || s <= -200) && endA.winner !== null, `A: 1 human + 3 bots finished a game (${endA.scores.join('-')} after ${endA.handNo} hands)`);
  check(a.log.filter((m) => m.t === 'error').length === 0, 'A: no protocol errors while playing');
  a.send({ t: 'leaveTable' }); await a.wait((m) => m.t === 'left');

  // B: four humans, with a spectator watching by code
  const hostB = new Bot(); await hostB.connect('Host');
  hostB.send({ t: 'devToggleSubscription' });
  const sub = await hostB.wait((m) => m.t === 'subscription').catch(() => null);
  check(!!sub, 'D: dev subscription toggle works when DEV_UNLOCK=1 (skipped if the server runs without it)');
  if (!sub) throw new Error('this check needs a server started with DEV_UNLOCK=1 (only a Premium host can invite other humans)');
  hostB.send({ t: 'createTable', isPublic: true, target: 250 });
  const t0 = await hostB.wait((m) => m.t === 'table');
  const others = [] as Bot[];
  for (const n of ['Bea', 'Cy', 'Di']) { const b = new Bot(); await b.connect(n); b.send({ t: 'joinCode', code: t0.code }); await b.wait((m) => m.t === 'table' && m.mySeat >= 0); others.push(b); }
  const spec = new Bot(); await spec.connect('Eye'); spec.send({ t: 'watchCode', code: t0.code });
  await spec.wait((m) => m.t === 'table');
  for (const b of [hostB, ...others]) b.auto = true;
  hostB.send({ t: 'startTable' });
  const endB = await hostB.wait((m) => m.t === 'table' && m.phase === 'finished', 170000);
  check(endB.seats.every((s: any) => s.kind === 'human'), `B: four humans finished a game (${endB.scores.join('-')} after ${endB.handNo} hands)`);
  const specTables = spec.log.filter((m) => m.t === 'table');
  check(specTables.length > 50 && specTables.every((m) => m.spectator && !('hand' in m) && !('legal' in m)), `C: spectator got ${specTables.length} table updates, none with a hand`);
  check(spec.log.filter((m) => m.t === 'error').length === 0, 'C: spectator saw no errors');
  spec.send({ t: 'play', card: 'AS' });
  const rej = await spec.wait((m) => m.t === 'error');
  check(rej.code === 'not_seated', 'C: spectator action rejected (not_seated)');
  for (const b of [hostB, ...others, spec]) b.ws.close();

  // D: free-tier gating
  const free = new Bot(); await free.connect('Freebie');
  free.send({ t: 'createTable', isPublic: false, target: 250 });
  const up = await free.wait((m) => m.t === 'error');
  check(up.code === 'upgrade_required' && /Upgrade to host — \$\d+\.\d{2}\/month/.test(up.message), `D: free user gets "${up.message}"`);
  // free users cannot make a table for others, match into other people's tables, or join by id; they get a solo game from quick play
  const nTables = free.log.length;
  free.send({ t: 'createTable', isPublic: true, target: 250 });
  const inv = await free.wait((m) => m.t === 'error' && free.log.indexOf(m) >= nTables);
  check(inv.code === 'upgrade_required' && /invite from a Premium host/.test(inv.message), `D: free user cannot create a public table ("${inv.message}")`);
  free.send({ t: 'joinTable', id: 'deadbeef' });
  const byId = await free.wait((m) => m.t === 'error' && free.log.indexOf(m) > free.log.indexOf(inv));
  check(byId.code === 'upgrade_required', 'D: free user cannot join a table by id');
  free.send({ t: 'quickPlay' });
  const solo = await free.wait((m) => m.t === 'table');
  check(solo.practice === true && solo.seats.filter((x: any) => x.kind === 'human').length === 1, 'D: free quickPlay is a solo practice table with bots');
  free.send({ t: 'leaveTable' }); await free.wait((m) => m.t === 'left');

  // E: tournament (needs the dev toggle)
  if (sub) {
    const org = new Bot(); await org.connect('Org');
    org.send({ t: 'devToggleSubscription' }); await org.wait((m) => m.t === 'subscription');
    org.send({ t: 'createTournament', size: 4, isPublic: true });
    await org.wait((m) => m.t === 'tournament');
    org.auto = true;
    org.send({ t: 'startTournament' });
    const fin = await org.wait((m) => m.t === 'tournament' && m.state === 'finished', 120000);
    check(!!fin.champion && !!fin.runnerUp, `E: tournament finished; champion "${fin.champion?.name}", runner-up "${fin.runnerUp?.name}"`);
    org.ws.close();
  }
  free.ws.close();
  console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} E2E CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('E2E error', e); process.exit(1); });
