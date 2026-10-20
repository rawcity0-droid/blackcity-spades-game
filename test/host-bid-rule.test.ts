import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, connectPremium, testServer } from './helpers.js';

// Premium hosts choose the bidding rule: teamMin4 true (default, partners bid at least 4 together) or false (regular spades bidding).

async function tableTeamMin(msg: object | null, start: object, extra?: object): Promise<number> {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 60000 } });
  try {
    const { c } = await connectPremium(srv.port, 'Host');
    if (msg) c.send(msg);
    if (extra) { await c.waitFor((m) => m.t === 'tournament' || m.t === 'event'); c.send(extra); }
    c.send(start);
    const t = await c.waitFor((m) => m.t === 'table' && m.bidRules, 8000, true);
    c.close();
    return t.bidRules.teamMin;
  } finally { await srv.close(); }
}

for (const [label, flag, want] of [['default', undefined, 4], ['teamMin4: true', true, 4], ['teamMin4: false', false, 0]] as const) {
  const f = flag === undefined ? {} : { teamMin4: flag };
  test(`hosted table, ${label}: team minimum ${want}`, async () => {
    assert.equal(await tableTeamMin({ t: 'createTable', isPublic: false, target: 250, ...f }, { t: 'startTable' }), want);
  });
  test(`bracket tournament, ${label}: every match table has team minimum ${want}`, async () => {
    assert.equal(await tableTeamMin({ t: 'createTournament', size: 4, isPublic: false, ...f }, { t: 'startTournament' }), want);
  });
  test(`multi-table event, ${label}: every table has team minimum ${want}`, async () => {
    assert.equal(await tableTeamMin({ t: 'createEvent', tables: 1, target: 250, ...f }, { t: 'startEvent' }), want);
  });
}

test('the host can switch the bidding rule in the table lobby before the game starts', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 60000 } });
  try {
    const { c } = await connectPremium(srv.port, 'Host');
    c.send({ t: 'createTable', isPublic: false, target: 250 });
    await c.waitFor((m) => m.t === 'table' && m.bidRules.teamMin === 4);
    c.send({ t: 'setRules', teamMin4: false });
    await c.waitFor((m) => m.t === 'table' && m.bidRules.teamMin === 0, 4000, true);
    c.send({ t: 'setRules', teamMin4: 'yes' });
    await c.waitFor((m) => m.t === 'error');
    c.close();
  } finally { await srv.close(); }
});

test('free Play now stays regular bidding even if a client sends teamMin4', async () => {
  const srv = await testServer({ timings: { botDelayMs: 60000 } });
  try {
    const { c } = await connect(srv.port, 'Bea');
    c.send({ t: 'quickPlay', teamMin4: true });
    const t = await c.waitFor((m) => m.t === 'table' && m.bidRules, 8000, true);
    assert.equal(t.bidRules.teamMin, 0);
    c.close();
  } finally { await srv.close(); }
});
