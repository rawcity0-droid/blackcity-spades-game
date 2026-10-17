// Table chat: players and watchers share a per-table chat. Server-authoritative, name required, sanitized, rate limited,
// last 50 kept and sent to anyone who joins or watches. Spectators still never receive hands.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeChat, parseClientMessage } from '../src/server/protocol.js';
import { Client, connect, connectPremium, sleep, testServer } from './helpers.js';

async function tableWithHost(srv: { port: number }, nick = 'Hosty') {
  const host = await connectPremium(srv.port, nick); // only a Premium host can create a table others can join
  host.c.send({ t: 'createTable', isPublic: true, target: 250 });
  const t = await host.c.waitFor((m) => m.t === 'table');
  return { ...host, table: t };
}
async function watcher(srv: { port: number }, code: string, nick = 'Watcher') {
  const w = await connect(srv.port, nick);
  w.c.send({ t: 'watchCode', code });
  await w.c.waitFor((m) => m.t === 'table' && m.spectator);
  return w;
}
const chatMsgs = (c: Client) => c.log.filter((m) => m.t === 'chatMsg');

test('sanitizeChat: control chars and newlines become spaces, whitespace collapses, trimmed, 200 chars max, markup kept as text', () => {
  assert.equal(sanitizeChat('  hello \n\t  world\u0000!  '), 'hello world !');
  assert.equal(sanitizeChat('a\u202eb\u200bc'), 'a b c');
  assert.equal(sanitizeChat('x'.repeat(500)).length, 200);
  assert.equal(sanitizeChat('<b>hi</b>'), '<b>hi</b>'); // clients render with textContent
  assert.equal(sanitizeChat('   '), '');
  assert.equal(sanitizeChat(42), '');
  assert.ok('error' in parseClientMessage(JSON.stringify({ t: 'chat', text: '   ' })));
  assert.ok('error' in parseClientMessage(JSON.stringify({ t: 'chat', text: 5 })));
  assert.equal((parseClientMessage(JSON.stringify({ t: 'chat', text: ' hi   there ' })) as any).msg.text, 'hi there');
});

test('a player posts and everyone at the table gets it, with role and own-message flag', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await tableWithHost(srv);
    const w = await watcher(srv, host.table.code, 'Eve');
    host.c.send({ t: 'chat', text: '  Good   luck <3 ' });
    const a = await host.c.waitFor((m) => m.t === 'chatMsg');
    const b = await w.c.waitFor((m) => m.t === 'chatMsg');
    for (const m of [a, b]) {
      assert.equal(m.from, 'Hosty');
      assert.equal(m.role, 'player');
      assert.equal(m.text, 'Good luck <3');
      assert.equal(m.table, host.table.id);
      assert.ok(Math.abs(m.ts - Date.now()) < 5000);
    }
    assert.equal(a.mine, true);
    assert.equal(b.mine, false);
  } finally { await srv.close(); }
});

test('a spectator can chat (labelled watcher) and still never receives a hand', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await tableWithHost(srv);
    const w = await watcher(srv, host.table.code, 'Eve');
    host.c.send({ t: 'startTable' });
    await host.c.waitFor((m) => m.t === 'table' && m.phase !== 'waiting');
    w.c.send({ t: 'chat', text: 'nice bid' });
    const m = await host.c.waitFor((x) => x.t === 'chatMsg');
    assert.equal(m.role, 'watcher');
    assert.equal(m.from, 'Eve');
    assert.equal((await w.c.waitFor((x) => x.t === 'chatMsg')).mine, true);
    await sleep(100);
    const views = w.c.log.filter((x) => x.t === 'table');
    assert.ok(views.length > 0);
    for (const v of views) { assert.equal(v.spectator, true); assert.equal(v.hand === undefined || v.hand.length === 0, true); assert.equal(v.legal === undefined || v.legal.length === 0, true); }
    assert.equal(JSON.stringify(w.c.log.filter((x) => x.t === 'chatMsg' || x.t === 'chatHistory')).includes('"hand"'), false);
  } finally { await srv.close(); }
});

test('chat needs a name and a table', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const nameless = (await connect(srv.port, '')).c;
    nameless.send({ t: 'chat', text: 'hi' });
    assert.equal((await nameless.waitFor((m) => m.t === 'error')).code, 'name_required');
    // practice lets a nameless player sit as "You", but chatting still needs a name
    nameless.send({ t: 'createTable', isPublic: true, target: 250, practice: true });
    await nameless.waitFor((m) => m.t === 'table');
    nameless.send({ t: 'chat', text: 'hi' });
    assert.equal((await nameless.waitFor((m) => m.t === 'error' && m.code === 'name_required' && nameless.log.filter((x) => x.code === 'name_required').length === 2)).code, 'name_required');
    assert.equal(chatMsgs(nameless).length, 0);
    const lobby = (await connect(srv.port, 'Lobbyist')).c;
    lobby.send({ t: 'chat', text: 'anyone?' });
    assert.equal((await lobby.waitFor((m) => m.t === 'error')).code, 'not_seated');
  } finally { await srv.close(); }
});

test('over-long and messy text is trimmed to 200 characters; empty messages are rejected', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await tableWithHost(srv);
    host.c.send({ t: 'chat', text: 'a\u0007b\n' + 'z'.repeat(400) });
    const m = await host.c.waitFor((x) => x.t === 'chatMsg');
    assert.equal(m.text.length, 200);
    assert.ok(m.text.startsWith('a b zzz'));
    host.c.send({ t: 'chat', text: '  \n ' });
    assert.equal((await host.c.waitFor((x) => x.t === 'error')).code, 'bad_message');
    assert.equal(chatMsgs(host.c).length, 1);
  } finally { await srv.close(); }
});

test('rate limit: 5 messages per 10 seconds per connection, then a friendly slow-down notice', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await tableWithHost(srv);
    const w = await watcher(srv, host.table.code);
    for (let i = 0; i < 7; i++) host.c.send({ t: 'chat', text: 'm' + i });
    const notice = await host.c.waitFor((m) => m.t === 'notice' && /Slow down/.test(m.message));
    assert.match(notice.message, /5 messages every 10 seconds/);
    await sleep(100);
    assert.equal(chatMsgs(host.c).length, 5);
    assert.equal(chatMsgs(w.c).length, 5);
    // a different connection has its own allowance
    w.c.send({ t: 'chat', text: 'still here' });
    assert.equal((await host.c.waitFor((m) => m.t === 'chatMsg' && m.text === 'still here')).role, 'watcher');
  } finally { await srv.close(); }
});

test('history: the last 50 messages are kept and sent to anyone who joins or watches (once, with own flag)', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const host = await tableWithHost(srv);
    // the per-connection limit is 5 per 10 s, so use several connections to fill the history
    const talkers: Client[] = [host.c];
    for (let i = 0; i < 12; i++) { const w = await watcher(srv, host.table.code, 'W' + i); talkers.push(w.c); }
    let n = 0;
    for (const c of talkers) for (let k = 0; k < 5 && n < 60; k++, n++) c.send({ t: 'chat', text: 'line ' + n });
    await host.c.waitFor((m) => m.t === 'chatMsg' && m.text === 'line 59', 8000);
    const late = await watcher(srv, host.table.code, 'Late');
    const hist = await late.c.waitFor((m) => m.t === 'chatHistory', 8000, true);
    assert.equal(hist.table, host.table.id);
    assert.equal(hist.msgs.length, 50);
    assert.equal(hist.msgs[0].text, 'line 10');
    assert.equal(hist.msgs[49].text, 'line 59');
    assert.equal(hist.msgs.every((m: any) => m.mine === false), true);
    assert.equal(late.c.log.filter((m) => m.t === 'chatHistory').length, 1); // not repeated on every table update
    // a reconnecting player gets the history again (their own earlier lines are out of the last 50 here)
    host.c.ws.close();
    await sleep(60);
    const again = await connect(srv.port, 'Hosty', host.welcome.token);
    const h2 = await again.c.waitFor((m) => m.t === 'chatHistory', 8000, true);
    assert.equal(h2.msgs.length, 50);
    // a player who joins a table by code gets it too
    const joiner = await connect(srv.port, 'Joiner');
    joiner.c.send({ t: 'joinCode', code: host.table.code });
    assert.equal((await joiner.c.waitFor((m) => m.t === 'chatHistory', 8000, true)).msgs.length, 50);
  } finally { await srv.close(); }
});

test('chat works at a tournament table, and is dropped with the table', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const org = await connectPremium(srv.port, 'Orga');
    org.c.send({ t: 'createTable', isPublic: false, target: 250 });
    const t = await org.c.waitFor((m) => m.t === 'table');
    org.c.send({ t: 'chat', text: 'first' });
    await org.c.waitFor((m) => m.t === 'chatMsg');
    assert.equal(srv.hub['tables'].get(t.id).chat.length, 1);
    org.c.send({ t: 'leaveTable' });
    await org.c.waitFor((m) => m.t === 'left');
    // an empty private table is destroyed: no chat is left behind
    await sleep(100);
    const gone = srv.hub['tables'].get(t.id);
    assert.ok(!gone || gone.chat.length === 0);
    // a new person at a new table starts with an empty history
    const h = await tableWithHost(srv, 'Newhost');
    const hist = await h.c.waitFor((m) => m.t === 'chatHistory', 8000, true);
    assert.equal(hist.msgs.length, 0);
  } finally { await srv.close(); }
});
