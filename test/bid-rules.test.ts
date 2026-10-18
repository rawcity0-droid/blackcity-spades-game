import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { connect, testServer } from './helpers.js';

// The only bid rule: a bid is at least CONFIG.rules.minBid (4) and at most 13; Nil (0) is still allowed while CONFIG.rules.allowNil.

test('the welcome config carries the bid limits for the client', async () => {
  const srv = await testServer();
  try {
    const { welcome } = await connect(srv.port, 'Bea');
    assert.equal(welcome.config.rules.minBid, 4);
    assert.equal(welcome.config.rules.maxBid, 13);
    assert.equal(welcome.config.rules.allowNil, true);
    assert.equal(CONFIG.rules.minBid, 4);
  } finally { await srv.close(); }
});

test('the server rejects bids of 1 to 3, and accepts 4 and Nil', async () => {
  const srv = await testServer({ timings: { botDelayMs: 0 } });
  try {
    for (const [bid, ok] of [[1, false], [2, false], [3, false], [4, true]] as const) {
      const { c } = await connect(srv.port, 'Bea');
      c.send({ t: 'quickPlay' }); // free users get a practice table with bots
      const t = await c.waitFor((m) => m.t === 'table' && m.canBid, 8000, true);
      assert.ok(t.canBid);
      c.send({ t: 'bid', bid });
      if (ok) {
        const after = await c.waitFor((m) => m.t === 'table' && m.seats[m.mySeat].bid === bid, 8000, true);
        assert.equal(after.seats[after.mySeat].bid, 4);
      } else {
        const err = await c.waitFor((m) => m.t === 'error' && /Bid must be 4 to 13/.test(m.message));
        assert.equal(err.t, 'error');
        assert.equal(c.last.table.canBid, true, 'still your turn to bid');
      }
      c.close();
    }
    const { c } = await connect(srv.port, 'Bea');
    c.send({ t: 'quickPlay' });
    await c.waitFor((m) => m.t === 'table' && m.canBid, 8000, true);
    c.send({ t: 'bid', bid: 0 });
    const nil = await c.waitFor((m) => m.t === 'table' && m.seats[m.mySeat].bid === 0, 8000, true);
    assert.equal(nil.seats[nil.mySeat].bid, 0);
    c.close();
  } finally { await srv.close(); }
});
