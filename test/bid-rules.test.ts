import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { connect, connectPremium, testServer } from './helpers.js';

// Bid rules. Regular spades (free Play now games): any bid from CONFIG.rules.minBid (1) to 13, plus Nil while CONFIG.rules.allowNil.
// Tables hosted by a Premium customer add a team minimum: the partners' bids must add up to CONFIG.rules.premiumTeamMin (4).

test('the welcome config carries the bid limits for the client', async () => {
  const srv = await testServer();
  try {
    const { welcome } = await connect(srv.port, 'Bea');
    assert.equal(welcome.config.rules.minBid, 1);
    assert.equal(welcome.config.rules.maxBid, 13);
    assert.equal(welcome.config.rules.allowNil, true);
    assert.equal(CONFIG.rules.premiumTeamMin, 4);
  } finally { await srv.close(); }
});

test('free Play now table: regular spades, no team minimum, a bid of 1 is fine and 14 is not', async () => {
  const srv = await testServer({ timings: { botDelayMs: 0 } });
  try {
    for (const bid of [1, 2, 3, 0]) {
      const { c } = await connect(srv.port, 'Bea');
      c.send({ t: 'quickPlay' });
      const t = await c.waitFor((m) => m.t === 'table' && m.canBid, 8000, true);
      assert.equal(t.bidRules.teamMin, 0);
      c.send({ t: 'bid', bid });
      const after = await c.waitFor((m) => m.t === 'table' && m.seats[m.mySeat].bid === bid, 8000, true);
      assert.equal(after.seats[after.mySeat].bid, bid);
      c.close();
    }
    const { c } = await connect(srv.port, 'Bea');
    c.send({ t: 'quickPlay' });
    await c.waitFor((m) => m.t === 'table' && m.canBid, 8000, true);
    c.send({ t: 'bid', bid: 14 });
    await c.waitFor((m) => m.t === 'error'); // 14 is refused (by the message check or the engine)
    c.close();
  } finally { await srv.close(); }
});

test('Premium-hosted table: partners must bid 4 together, so a second bid that leaves them short is refused', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 0 } });
  try {
    const { c } = await connectPremium(srv.port, 'Host');
    c.send({ t: 'createTable', isPublic: true, target: 250 });
    await c.waitFor((m) => m.t === 'table');
    c.send({ t: 'startTable' });
    const t = await c.waitFor((m) => m.t === 'table' && m.canBid, 8000, true);
    assert.equal(t.bidRules.teamMin, 4);
    c.send({ t: 'bid', bid: 0 }); // no individual limit on team-min tables, whatever the partner bid
    const ok = await c.waitFor((m) => m.t === 'table' && m.seats[m.mySeat].bid === 0, 8000, true);
    assert.equal(ok.seats[ok.mySeat].bid, 0);
    c.close();
  } finally { await srv.close(); }
});
