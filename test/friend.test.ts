import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { connect, connectPremium, testServer } from './helpers.js';

test('free Play with a friend: code, friend joins as partner, 2 computer players, free rules at 500; 3rd person is turned away', async () => {
  const srv = await testServer({ timings: { botDelayMs: 60000 } });
  try {
    const { c: a } = await connect(srv.port, 'Ann');
    a.send({ t: 'createFriend' });
    const w = await a.waitFor((m) => m.t === 'table' && m.friend);
    assert.equal(w.phase, 'waiting'); assert.equal(w.code.length, CONFIG.codeLength);
    const { c: b } = await connect(srv.port, 'Ben');
    b.send({ t: 'joinCode', code: w.code });
    const t = await b.waitFor((m) => m.t === 'table' && m.phase && m.phase !== 'waiting');
    assert.equal(t.seats[0].name, 'Ann'); assert.equal(t.seats[2].name, 'Ben');
    assert.equal(t.seats[0].kind, 'human'); assert.equal(t.seats[2].kind, 'human');
    assert.equal(t.seats.filter((s: any) => s.kind === 'bot').length, 2);
    assert.equal(t.target, 500); assert.equal(t.bidRules.teamMin, 0); assert.equal(t.bidRules.jokers, false); assert.equal(t.rules.sandbags, true);
    const { c: x } = await connect(srv.port, 'Cal');
    x.send({ t: 'joinCode', code: w.code });
    const e = await x.waitFor((m) => m.t === 'error');
    assert.equal(e.code, 'full'); assert.match(e.message, /This game is full.*Host with Premium/);
    a.close(); b.close(); x.close();
  } finally { await srv.close(); }
});

test('the creator can cancel; free players still cannot host 4-person tables or pick Team min 4 / Jokers', async () => {
  const srv = await testServer({ timings: { botDelayMs: 60000 } });
  try {
    const { c } = await connect(srv.port, 'Ann');
    c.send({ t: 'createFriend' });
    const w = await c.waitFor((m) => m.t === 'table' && m.friend);
    c.send({ t: 'setRules', jokers: true });
    assert.equal((await c.waitFor((m) => m.t === 'error')).code, 'not_allowed');
    c.send({ t: 'leaveTable' });
    await c.waitFor((m) => m.t === 'left');
    const { c: b } = await connect(srv.port, 'Ben');
    b.send({ t: 'joinCode', code: w.code });
    assert.equal((await b.waitFor((m) => m.t === 'error')).code, 'not_found');
    c.send({ t: 'createTable', isPublic: false, target: 500, jokers: true });
    assert.equal((await c.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required')).code, 'upgrade_required');
    c.close(); b.close();
  } finally { await srv.close(); }
});

test('Premium hosting is unchanged', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 60000 } });
  try {
    const { c } = await connectPremium(srv.port, 'Host');
    c.send({ t: 'createTable', isPublic: false, target: 250 });
    const t = await c.waitFor((m) => m.t === 'table' && m.bidRules.teamMin === 4);
    assert.ok(!t.friend);
    c.close();
  } finally { await srv.close(); }
});
