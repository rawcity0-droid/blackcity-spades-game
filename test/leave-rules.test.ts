// The Back / Leave confirm texts: they must describe exactly what the server does (see test/host-back.test.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain browser module, no type declarations
import { nextHost, sheetLeaveConfirm, sheetLeaveLabel, tableLeaveConfirm } from '../public/leave-rules.js';

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
  assert.equal(tableLeaveConfirm(lobby), 'Go back? Gus becomes the host and the table stays open for them.');
  const playing = table({ phase: 'playing', seats: [seat('human', 'Hosty'), seat('bot', 'Ace'), seat('human', 'Gus'), seat('bot', 'Duke')] });
  assert.equal(tableLeaveConfirm(playing), 'Go back? A bot takes your seat and Gus becomes the host. The game goes on for the others.');
  assert.equal(tableLeaveConfirm({ ...playing, phase: 'finished' }), null);
});

test('host who is the only person playing: the table closes, and watchers are mentioned', () => {
  const solo = table({ phase: 'playing', seats: [seat('human', 'Hosty'), seat('bot'), seat('bot'), seat('bot')] });
  assert.match(tableLeaveConfirm(solo), /this game ends and the table closes\.$/);
  assert.match(tableLeaveConfirm({ ...solo, spectators: 2 }), /closes for the 2 people watching\.$/);
  assert.match(tableLeaveConfirm({ ...solo, spectators: 1 }), /the 1 person watching\.$/);
  assert.equal(tableLeaveConfirm({ ...solo, practice: true }), 'Go back? Your practice game will end.');
  assert.equal(tableLeaveConfirm(table()), null, 'an empty lobby with nobody else can just be left');
  assert.equal(tableLeaveConfirm(table({ spectators: 3 })), 'Go back? The table closes. The table also closes for the 3 people watching.');
});

test('players and watchers keep the old behaviour', () => {
  const seats = [seat('human', 'Hosty'), seat('human', 'Me'), seat('bot'), seat('bot')];
  assert.equal(tableLeaveConfirm(table({ isHost: false, mySeat: 1, phase: 'bidding', seats })), 'Leave this table? A bot will take your seat.');
  assert.equal(tableLeaveConfirm(table({ isHost: false, mySeat: 1, phase: 'waiting', seats })), null);
  assert.equal(tableLeaveConfirm(table({ isHost: false, mySeat: -1, phase: 'playing', seats })), null);
  assert.equal(tableLeaveConfirm(null), null);
});

test('bracket / event view: only an organizer leaving before the start cancels it', () => {
  const org = { joined: true, isOrganizer: true, state: 'registering' };
  assert.match(sheetLeaveConfirm(org), /tournament is cancelled for everyone who joined/);
  assert.equal(sheetLeaveLabel(org), 'Back');
  assert.match(sheetLeaveConfirm({ ...org, state: 'running' }), /tournament goes on for everyone else/);
  const player = { joined: true, isOrganizer: false, state: 'running' };
  assert.equal(sheetLeaveConfirm(player), 'Leave the tournament? A bot takes your place.');
  assert.equal(sheetLeaveLabel(player), 'Leave tournament');
  const viewer = { joined: false, isOrganizer: false, state: 'running' };
  assert.equal(sheetLeaveConfirm(viewer), null);
  assert.equal(sheetLeaveLabel(viewer), 'Close');
  assert.equal(sheetLeaveConfirm({ ...org, state: 'finished' }), null);
  assert.equal(sheetLeaveLabel({ ...org, state: 'finished' }), 'Close');
});
