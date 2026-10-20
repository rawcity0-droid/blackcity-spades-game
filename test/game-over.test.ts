// After a game is over the player must never be stuck: starting something new leaves the finished table automatically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoPlay, connect, connectPremium, testServer } from './helpers.js';

async function finishSoloGame(c: any): Promise<any> {
  c.send({ t: 'quickPlay' });
  autoPlay(c);
  return c.waitFor((m: any) => m.t === 'table' && m.phase === 'finished', 60000, true);
}

test('Play now after a finished game (without tapping Leave) starts a new game instead of "Leave your current table first"', async () => {
  const srv = await testServer();
  try {
    const { c } = await connect(srv.port, 'Bea');
    const over = await finishSoloGame(c);
    const msgs: any[] = [];
    c.ws.on('message', (d: any) => msgs.push(JSON.parse(d.toString())));
    c.send({ t: 'quickPlay' });
    await c.waitFor((m: any) => m.t === 'table' && m.id !== over.id, 10000, true);
    assert.ok(msgs.some((m) => m.t === 'left'), 'the finished table was left');
    assert.ok(!msgs.some((m) => m.t === 'error'), 'no error');
    c.close();
  } finally { await srv.close(); }
});

test('a Premium host can create a new table straight from a finished one', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { c } = await connectPremium(srv.port, 'Host');
    const over = await finishSoloGame(c);
    c.send({ t: 'createTable', isPublic: false, target: 250 });
    const fresh = await c.waitFor((m: any) => m.t === 'table' && m.id !== over.id, 10000, true);
    assert.equal(fresh.phase, 'waiting');
    c.close();
  } finally { await srv.close(); }
});

test('a table still being played keeps blocking (no accidental leave)', async () => {
  const srv = await testServer({ timings: { botDelayMs: 60000 } });
  try {
    const { c } = await connect(srv.port, 'Bea');
    c.send({ t: 'quickPlay' });
    await c.waitFor((m: any) => m.t === 'table' && m.phase !== 'waiting', 8000, true);
    c.send({ t: 'quickPlay' });
    const e = await c.waitFor((m: any) => m.t === 'error', 5000, true);
    assert.match(e.message, /Leave your current table first/);
    c.close();
  } finally { await srv.close(); }
});
