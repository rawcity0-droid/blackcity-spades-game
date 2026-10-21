import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, connectPremium, testServer } from './helpers.js';

test('host End game mid-hand closes the table for everyone; nobody is put back in it on reconnect', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 60000 } });
  try {
    const host = await connectPremium(srv.port, 'Host');
    host.c.send({ t: 'createTable', isPublic: false, target: 500 });
    const t = await host.c.waitFor((m) => m.t === 'table');
    const g = (await connect(srv.port, 'Guest')).c;
    g.send({ t: 'joinCode', code: t.code });
    await g.waitFor((m) => m.t === 'table' && m.mySeat >= 0);
    host.c.send({ t: 'addBots' });
    host.c.send({ t: 'startTable' });
    await g.waitFor((m) => m.t === 'table' && m.phase === 'bidding');
    g.send({ t: 'endGame' }); // a guest cannot end it for everyone
    assert.equal((await g.waitFor((m) => m.t === 'error')).code, 'not_allowed');
    host.c.send({ t: 'endGame' });
    assert.equal((await host.c.waitFor((m) => m.t === 'left')).reason, 'The host ended the game');
    assert.equal((await g.waitFor((m) => m.t === 'left', 8000, true)).reason, 'The host ended the game');
    assert.equal(srv.hub['tables'].size, 0);
    g.send({ t: 'leaveTable' }); // guest Leave after the end is harmless
  } finally { await srv.close(); }
});

test('organizer End game mid-tournament ends the bracket and every table for everyone', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 60000 } });
  try {
    const org = await connectPremium(srv.port, 'Org');
    org.c.send({ t: 'createTournament', size: 4, isPublic: false });
    const tour = await org.c.waitFor((m) => m.t === 'tournament');
    const g = (await connect(srv.port, 'Guest')).c;
    g.send({ t: 'joinCode', code: tour.code });
    await g.waitFor((m) => m.t === 'tournament' && m.joined);
    org.c.send({ t: 'startTournament' });
    await org.c.waitFor((m) => m.t === 'table');
    org.c.send({ t: 'endGame' });
    await org.c.waitFor((m) => m.t === 'tournamentLeft');
    assert.equal((await g.waitFor((m) => m.t === 'tournamentLeft', 8000, true)).reason, 'The host ended the game');
    assert.equal(srv.hub['tournaments'].size, 0);
    assert.equal([...srv.hub['tables'].values()].length, 0);
  } finally { await srv.close(); }
});

test('Premium is enforced on the server: free players cannot host, run events, or pick Jokers even in practice', async () => {
  const srv = await testServer({ timings: { botDelayMs: 60000 } });
  try {
    const { c } = await connect(srv.port, 'Free');
    const tries: object[] = [
      { t: 'createTable', isPublic: false, target: 500 },
      { t: 'createTable', isPublic: true, target: 500 },
      { t: 'createTable', isPublic: true, target: 500, practice: true, jokers: true },
      { t: 'createTournament', size: 4, isPublic: true },
      { t: 'createEvent', tables: 2 },
    ];
    for (const m of tries) {
      c.send(m);
      assert.equal((await c.waitFor((x) => x.t === 'error')).code, 'upgrade_required', JSON.stringify(m));
    }
    assert.equal(srv.hub['tables'].size, 0);
  } finally { await srv.close(); }
});
