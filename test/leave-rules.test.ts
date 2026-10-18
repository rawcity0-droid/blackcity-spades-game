// Leave confirm texts (they must describe exactly what the server does, see test/host-back.test.ts) and the Back / Return to game navigation.
// Back itself never asks anything: it only changes the screen.

import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain browser module, no type declarations
import { activeGame, canGoBack, navAfterEnd, navAfterSheet, navAfterTable, nextHost, returnSummary, sheetLeaveConfirm, sheetLeaveLabel, tableLeaveConfirm } from '../public/leave-rules.js';

const seat = (kind: string, name = '', connected = true) => ({ kind, name, connected });
const table = (over: object = {}) => ({
  phase: 'waiting', mySeat: 0, isHost: true, spectators: 0, practice: false, tournament: undefined,
  seats: [seat('human', 'Hosty'), seat('empty'), seat('empty'), seat('empty')], ...over,
});

test('nextHost: first connected human in seat order, else the first human, else nobody', () => {
  const t = table({ seats: [seat('human', 'Hosty'), seat('human', 'Away', false), seat('bot', 'Ace'), seat('human', 'Here')] });
  assert.equal(nextHost(t), 'Here');
  assert.equal(nextHost(table({ seats: [seat('human', 'Hosty'), seat('human', 'Away', false), seat('bot'), seat('bot')] })), 'Away');
  assert.equal(nextHost(table()), null);
});

test('host with other people at the table: the confirm says who becomes host', () => {
  const lobby = table({ seats: [seat('human', 'Hosty'), seat('human', 'Gus'), seat('empty'), seat('empty')] });
  assert.equal(tableLeaveConfirm(lobby), 'Leave this table? Gus becomes the host and the table stays open for them.');
  const playing = table({ phase: 'playing', seats: [seat('human', 'Hosty'), seat('bot', 'Ace'), seat('human', 'Gus'), seat('bot', 'Duke')] });
  assert.equal(tableLeaveConfirm(playing), 'Leave this table? A bot takes your seat and Gus becomes the host. The game goes on for the others.');
  assert.equal(tableLeaveConfirm({ ...playing, phase: 'finished' }), null);
});

test('host who is the only person playing: the table closes, and watchers are mentioned', () => {
  const solo = table({ phase: 'playing', seats: [seat('human', 'Hosty'), seat('bot'), seat('bot'), seat('bot')] });
  assert.match(tableLeaveConfirm(solo), /this game ends and the table closes\.$/);
  assert.match(tableLeaveConfirm({ ...solo, spectators: 2 }), /closes for the 2 people watching\.$/);
  assert.match(tableLeaveConfirm({ ...solo, spectators: 1 }), /the 1 person watching\.$/);
  assert.equal(tableLeaveConfirm({ ...solo, practice: true }), 'Leave this table? Your practice game will end.');
  assert.equal(tableLeaveConfirm({ ...solo, practice: true, quick: true }), 'Leave this table? Your game will end.', 'a Quick play table is never called practice');
  assert.equal(tableLeaveConfirm(table()), null, 'an empty lobby with nobody else can just be left');
  assert.equal(tableLeaveConfirm(table({ spectators: 3 })), 'Leave this table? The table closes. The table also closes for the 3 people watching.');
});

test('players and watchers keep the old behaviour', () => {
  const seats = [seat('human', 'Hosty'), seat('human', 'Me'), seat('bot'), seat('bot')];
  assert.equal(tableLeaveConfirm(table({ isHost: false, mySeat: 1, phase: 'bidding', seats })), 'Leave this table? A bot will take your seat.');
  assert.equal(tableLeaveConfirm(table({ isHost: false, mySeat: 1, phase: 'waiting', seats })), null);
  assert.equal(tableLeaveConfirm(table({ isHost: false, mySeat: -1, phase: 'playing', seats })), null);
  assert.equal(tableLeaveConfirm(null), null);
});

test('bracket / event view: only an organizer leaving before the start cancels it; the button says Leave tournament', () => {
  const org = { joined: true, isOrganizer: true, state: 'registering' };
  assert.match(sheetLeaveConfirm(org), /^Leave the tournament\? You are the organizer, so it is cancelled for everyone who joined/);
  assert.equal(sheetLeaveLabel(org), 'Leave tournament');
  assert.match(sheetLeaveConfirm({ ...org, state: 'running' }), /it goes on for everyone else/);
  const player = { joined: true, isOrganizer: false, state: 'running' };
  assert.equal(sheetLeaveConfirm(player), 'Leave the tournament? A bot takes your place.');
  assert.equal(sheetLeaveLabel(player), 'Leave tournament');
  const viewer = { joined: false, isOrganizer: false, state: 'running' };
  assert.equal(sheetLeaveConfirm(viewer), null);
  assert.equal(sheetLeaveLabel(viewer), 'Close');
  assert.equal(sheetLeaveConfirm({ ...org, state: 'finished' }), null);
  assert.equal(sheetLeaveLabel({ ...org, state: 'finished' }), 'Close');
  assert.equal(JSON.stringify([sheetLeaveConfirm(org), tableLeaveConfirm(table({ seats: [seat('human', 'H'), seat('human', 'G'), seat('empty'), seat('empty')] }))]).includes('Go back'), false, 'no confirm text talks about going back any more');
});

test('Back is offered to the table host and the tournament / event organizer only', () => {
  const host = table({ phase: 'playing', seats: [seat('human', 'H'), seat('bot'), seat('bot'), seat('bot')] });
  assert.equal(canGoBack({ table: host }, 'table'), true);
  assert.equal(canGoBack({ table: { ...host, isHost: false } }, 'table'), false);
  assert.equal(canGoBack({ table: { ...host, mySeat: -1 } }, 'table'), false, 'watchers keep their current behaviour');
  assert.equal(canGoBack({ table: { ...host, tournament: { label: 'x' } } }, 'table'), false);
  const org = { joined: true, isOrganizer: true, state: 'running' };
  assert.equal(canGoBack({ tour: org }, 'tournament'), true);
  assert.equal(canGoBack({ event: org }, 'event'), true);
  assert.equal(canGoBack({ tour: { ...org, isOrganizer: false } }, 'tournament'), false);
  assert.equal(canGoBack({ tour: { ...org, state: 'finished' } }, 'tournament'), false);
  assert.equal(canGoBack({ table: host }, 'home'), false);
});

test('activeGame: a table (seated or watching), else an event / tournament the player is entered in', () => {
  assert.equal(activeGame({ table: table(), tour: null, event: null }), 'table');
  assert.equal(activeGame({ table: null, tour: { joined: true, state: 'running' }, event: null }), 'tournament');
  assert.equal(activeGame({ table: null, tour: null, event: { joined: true, state: 'registering' } }), 'event');
  assert.equal(activeGame({ table: null, tour: { joined: false, state: 'running' }, event: null }), null, 'watching a bracket is not "in" it');
  assert.equal(activeGame({ table: null, tour: { joined: true, state: 'finished' }, event: null }), null);
  assert.equal(activeGame({ table: null, tour: null, event: null }), null);
});

test('after Back, table updates do not pull the player back; a new table or Return does', () => {
  const home = { ui: 'home', away: true };
  assert.deepEqual(navAfterTable(home, false), home);
  assert.deepEqual(navAfterTable(home, true), { ui: 'table', away: false }, 'a new table (e.g. the next tournament round) opens');
  assert.deepEqual(navAfterTable({ ui: 'home', away: false }, false), { ui: 'table', away: false });
  assert.deepEqual(navAfterTable({ ui: 'tournament', away: false }, false), { ui: 'tournament', away: false }, 'a bracket view stays put');
  // bracket / event updates
  assert.deepEqual(navAfterSheet(home, 'tournament', true, false), home, 'updates do not pull an away organizer back');
  assert.deepEqual(navAfterSheet({ ui: 'home', away: false }, 'event', true, false), { ui: 'event', away: false });
  assert.deepEqual(navAfterSheet({ ui: 'table', away: false }, 'event', true, false), { ui: 'table', away: false });
  assert.deepEqual(navAfterSheet(home, 'tournament', false, true), { ui: 'tournament', away: false }, 'opening one on purpose always works');
});

test('when the game ends for the player: away stays on home only if something is left to return to', () => {
  const s = { table: null, tour: { joined: true, state: 'running' }, event: null };
  assert.deepEqual(navAfterEnd({ ui: 'home', away: true }, s), { ui: 'home', away: true, from: 'tournament' });
  assert.deepEqual(navAfterEnd({ ui: 'home', away: true }, { table: null, tour: null, event: null }), { ui: 'home', away: false });
  assert.deepEqual(navAfterEnd({ ui: 'table', away: false }, s), { ui: 'tournament', away: false });
  assert.deepEqual(navAfterEnd({ ui: 'table', away: false }, { table: null, tour: null, event: null }), { ui: 'home', away: false });
});

test('Return to game summary tells you whose turn it is and about unread chat', () => {
  const t = table({ phase: 'playing', turn: 0, handNo: 3, seats: [seat('human', 'H'), seat('bot'), seat('bot'), seat('bot')] });
  assert.equal(returnSummary({ table: t }), 'Your turn');
  assert.equal(returnSummary({ table: { ...t, turn: 2 } }), 'Hand 3');
  assert.equal(returnSummary({ table: { ...t, phase: 'waiting' } }), 'Waiting to start');
  assert.equal(returnSummary({ table: { ...t, phase: 'finished' } }), 'Game over');
  assert.equal(returnSummary({ table: { ...t, mySeat: -1 } }), 'Watching a table');
  assert.equal(returnSummary({ table: t }, 2), 'Your turn · 2 new messages');
  assert.equal(returnSummary({ table: t }, 1), 'Your turn · 1 new message');
  assert.equal(returnSummary({ tour: { joined: true, state: 'registering' } }), 'Tournament · signing up');
});
