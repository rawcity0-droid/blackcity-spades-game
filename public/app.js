// Blackcity Spades client: one page, no framework. All text from the server or the user is rendered with
// textContent (via the h() helper), never innerHTML. Inline styles go through the CSSOM (the CSP forbids style="").
// The felt table is always on screen. Screens are layers on top of it: home card, modals, and the
// bracket / event sheets.

import { cardName, renderBack, renderCard } from './cards.js';
import { s as svg } from './svg.js';
import { createMusic } from './music.js';
import { activeGame, canGoBack, navAfterEnd, navAfterSheet, navAfterTable, returnSummary, sheetLeaveConfirm, sheetLeaveLabel, tableLeaveConfirm } from './leave-rules.js';
import { shouldShowCover } from './cover-rules.js';
import { parseMusicPrefs, serializeMusicPrefs } from './music-state.js';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

/** h('div', {class: 'x', onclick: fn, text: '..'}, child, 'string') -> HTMLElement (strings become text nodes). */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const params = new URLSearchParams(location.search);
const slot = (params.get('slot') || '').replace(/[^a-z0-9]/gi, '').slice(0, 8); // ?slot=b lets several tabs be different players
const sfx = slot ? '_' + slot : '';
const KEY_TOKEN = 'spades_token' + sfx;
const KEY_NICK = 'spades_nick' + sfx;
const KEY_PRACTICE = 'spades_practice' + sfx;
const KEY_AVATAR = 'spades_avatar' + sfx;
const KEY_COVER = 'spades_cover' + sfx; // sessionStorage: the cover screen was already shown in this tab
const KEY_MUSIC = 'spades_music' + sfx; // {on, vol}: table music on/off and volume
const mkStore = (area) => ({
  get: (k) => { try { return area().getItem(k); } catch { return null; } },
  set: (k, v) => { try { area().setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { area().removeItem(k); } catch { /* private mode */ } },
});
const store = mkStore(() => localStorage);
const session = mkStore(() => sessionStorage);

const CODE_LEN_DEFAULT = 6;
const urlCode = (params.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
let urlCodeUsed = false;
// Back from Stripe Checkout: ?premium=success&session_id=cs_... (confirmed with the server) or ?premium=cancel
const urlPremium = params.get('premium') === 'success' || params.get('premium') === 'cancel' ? params.get('premium') : '';
const urlSession = (params.get('session_id') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 300);
let premiumReturnHandled = false;
function stripPremiumParams() {
  const u = new URL(location.href);
  u.searchParams.delete('premium');
  u.searchParams.delete('session_id');
  history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
}

// The name field always starts blank on every page load. Old saved names (including v1 'Player####') are deleted.
function savedNick() {
  store.del(KEY_NICK);
  return '';
}

// ---------- state ----------
const state = {
  matching: null, // Quick play queue for free players: {waiting, size, until, waitMs}
  nick: savedNick(),
  token: store.get(KEY_TOKEN) || '',
  avatar: session.get(KEY_AVATAR) || '', // profile photo: local only, never sent to the server
  config: null,
  subscribed: false,
  connected: false,
  ui: 'home',            // home | table | tournament | event
  away: false,           // pressed Back: still seated / entered, but looking at home; updates must not pull the view back
  awayFrom: 'table',     // the screen that Return to game goes back to
  lobby: null,
  table: null,
  tour: null,
  event: null,
  openSheet: false,      // the user asked to open a bracket / event view (e.g. by watching with a code)
  pendingStart: false,   // practice table: start as soon as it is created
  dismissed: 0,          // hand number whose summary was closed (spectators)
  practiceTarget: Number(store.get(KEY_PRACTICE)) === 250 ? 250 : 500,
  prevTrickLen: 0,
};

const price = () => (state.config ? Number(state.config.priceUsdPerMonth).toFixed(2) : '');
const premiumLabel = () => `Go Premium — $${price()}/mo`;
const codeLen = () => (state.config && state.config.codeLength) || CODE_LEN_DEFAULT;

// ---------- connection ----------
let ws = null;
let retry = 800;
let pingTimer = null;

function send(msg) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } return false; }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 800;
    state.connected = true;
    send({ t: 'hello', nick: state.nick, token: state.token || undefined });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
    renderConn();
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = (e) => {
    state.connected = false;
    clearInterval(pingTimer);
    if (restoreUi.busy) { restoreDone(); if (restoreUi.setMsg) restoreUi.setMsg('Connection lost. Try again once you are back online.'); }
    renderConn();
    if (e.code === 4000) { toast('This player is open in another tab. Reload to take over.', 8000); return; }
    setTimeout(connect, retry);
    retry = Math.min(5000, retry * 1.6);
  };
}

function renderConn() {
  const c = $('conn');
  c.classList.toggle('off', !state.connected);
  c.querySelector('b').textContent = state.connected ? 'Connected' : 'Reconnecting…';
  
  if (state.ui === 'home') renderHome();
}

let toastTimer = null;
function toast(text, ms = 4000) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- server messages ----------
function handle(m) {
  switch (m.t) {
    case 'welcome':
      state.token = m.token;
      setMatching(null); // the server re-sends the waiting state right after this if we are still queued
      store.set(KEY_TOKEN, m.token);
      state.config = m.config;
      state.subscribed = m.subscribed;
      if (!state.nick && m.nick) send({ t: 'setNick', nick: '' }); // this browser has no saved name: the server must not hold one either
      handlePremiumReturn();
      if (urlCode && !urlCodeUsed && !state.table) { urlCodeUsed = true; openCodeModal('join', urlCode); } // ?code=ABC234 opens the join box
      break;
    case 'matching': setMatching(m.active ? m : null); return;
    case 'nick': state.nick = m.nick; return;
    case 'lobby': state.lobby = m; fillOpenTables(); return;
    case 'notice': toast(m.message, 5500); return;
    case 'restoreResult': onRestoreResult(m); return;
    case 'premiumResult': onPremiumResult(m); return;
    case 'checkout': {
      let ok = false;
      try { const u = new URL(m.url); ok = u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === location.hostname); } catch { /* bad URL */ }
      if (ok) location.assign(m.url); else toast('Could not open checkout. Please try again.');
      return;
    }
    case 'subscription': {
      state.subscribed = m.subscribed;
      homeSig = '';
      if (modalOpen('play') && !modalOpen('restore')) { closeModal('play'); openPlayModal(); }
      break;
    }
    case 'table': {
      hideCover();
      if (state.matching) setMatching(null); // found players (or bots joined): the table replaces the waiting box // resuming a seat goes straight to the game
      const isNew = !state.table || state.table.id !== m.id;
      state.table = m;
      if (isNew) { closeAllModals(); chatReset(); }
      applyNav(navAfterTable(state, isNew)); // a bracket / event view stays put, and so does home after Back
      if (state.pendingStart && m.phase === 'waiting' && m.isHost) { state.pendingStart = false; send({ t: 'startTable' }); }
      break;
    }
    case 'chatHistory':
      if (state.table && m.table === state.table.id) chatSet(m.msgs);
      return;
    case 'chatMsg':
      if (state.table && m.table === state.table.id) chatAdd(m);
      return;
    case 'left':
      state.table = null;
      chatReset();
      applyNav(navAfterEnd(state, state));
      if (m.reason) toast(m.reason);
      break;
    case 'tournament':
      hideCover();
      state.tour = m;
      if (state.ui !== 'table' && (m.joined || state.openSheet)) { const n = navAfterSheet(state, 'tournament', m.joined, state.openSheet); if (n.ui !== state.ui) closeAllModals(); applyNav(n); }
      state.openSheet = false;
      break;
    case 'tournamentLeft':
      state.tour = null;
      if (state.ui === 'tournament') state.ui = 'home';
      if (state.away && !activeGame(state)) state.away = false;
      if (m.reason) toast(m.reason);
      break;
    case 'event':
      hideCover();
      state.event = m;
      if (state.ui !== 'table' && (m.joined || state.openSheet)) { const n = navAfterSheet(state, 'event', m.joined, state.openSheet); if (n.ui !== state.ui) closeAllModals(); applyNav(n); }
      state.openSheet = false;
      break;
    case 'eventLeft':
      state.event = null;
      if (state.ui === 'event') state.ui = 'home';
      if (state.away && !activeGame(state)) state.away = false;
      if (m.reason) toast(m.reason);
      break;
    case 'error':
      state.pendingStart = false;
      if (restoreUi.busy) { restoreDone(); if (modalOpen('restore') && restoreUi.setMsg) { restoreUi.setMsg(m.message); return; } }
      if (m.code === 'upgrade_required') openPremiumGate(m.message);
      else if (m.code === 'name_required' && state.ui !== 'table') nameRequired();
      else toast(m.message);
      return;
    default: return;
  }
  render();
}

// ---------- icons ----------
const icon = (paths, size = 22, extra = {}) => svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', ...extra },
  ...paths.map((d) => svg('path', { d })));
const iconHelp = () => svg('svg', { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
  svg('circle', { cx: 12, cy: 12, r: 9.5 }), svg('path', { d: 'M9.5 9.3a2.6 2.6 0 1 1 3.8 2.3c-.9.5-1.3 1-1.3 2' }), svg('circle', { cx: 12, cy: 17.2, r: .6, fill: 'currentColor' }));
const iconMenu = () => icon(['M4 7h16', 'M4 12h16', 'M4 17h16'], 24);
const iconClose = () => icon(['M6 6l12 12', 'M18 6L6 18'], 18);
const iconArrow = () => icon(['M5 12h14', 'M13 6l6 6-6 6'], 26);
const iconArrowUpRight = () => icon(['M7 17L17 7', 'M8 7h9v9'], 24);

const SPADE_PATH = 'M50 3C50 3 5 38 5 68c0 19 14 29 29 26 4-1 8-3 11-6-1 11-5 21-13 27h36c-8-6-12-16-13-27 3 3 7 5 11 6 15 3 29-7 29-26C95 38 50 3 50 3Z';
const spadeShape = (cls, fill) => svg('svg', { viewBox: '0 0 100 120', class: cls, 'aria-hidden': 'true' },
  svg('defs', {}, svg('linearGradient', { id: 'spadeGrad', x1: 0, y1: 0, x2: 1, y2: 1 },
    svg('stop', { offset: '0', 'stop-color': '#2e2e2e' }), svg('stop', { offset: '.55', 'stop-color': '#1a1a1a' }), svg('stop', { offset: '1', 'stop-color': '#0f0f0f' }))),
  svg('path', { d: SPADE_PATH, fill }));

// ---------- modal layers ----------
const modals = new Map(); // id -> layer element

function modalOpen(id) { return modals.has(id); }

function openModal(id, el, { dismiss = true, bare = false } = {}) {
  closeModal(id);
  const layer = h('div', { class: 'layer' + (bare ? ' bare' : ''), 'data-id': id }, el);
  layer.addEventListener('mousedown', (e) => { if (dismiss && e.target === layer) closeModal(id); });
  $('modal-layer').append(layer);
  modals.set(id, layer);
  return layer;
}
function closeModal(id) {
  const l = modals.get(id);
  if (l) { l.remove(); modals.delete(id); }
}
function closeAllModals() { for (const id of [...modals.keys()]) closeModal(id); }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (modals.size) { const top = [...modals.keys()].pop(); if (top === 'matching') cancelMatch(); else closeModal(top); }
  else if (chat.open) closeChat();
});

/** A light modal card: gold top edge, title, round close button. Returns {el, body}. */
function modalCard({ title, onClose, cls = '', id }) {
  const close = h('button', { class: 'xbtn', type: 'button', 'aria-label': 'Close', onclick: onClose || (() => closeModal(id)) }, iconClose());
  const body = h('div', { class: 'modal-body' });
  // append() would print the text "null" for an empty slot; skip null/undefined/false and flatten arrays
  const rawAppend = body.append.bind(body);
  body.append = (...kids) => rawAppend(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  const el = h('div', { class: 'modal ' + cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    close, title ? h('h2', { class: 'modal-title', text: title }) : null, body);
  return { el, body };
}

const btn = (cls, text, onclick, extra = {}) => h('button', { class: 'btn ' + cls, type: 'button', text, onclick, ...extra });
const link = (text, onclick) => h('button', { class: 'ulink', type: 'button', text, onclick });
function seg(options, current, onPick) {
  const wrap = h('div', { class: 'seg' });
  options.forEach(([val, label]) => {
    const b = h('button', { class: val === current ? 'on' : '', text: label, type: 'button' });
    b.addEventListener('click', () => { onPick(val); [...wrap.children].forEach((c) => c.classList.remove('on')); b.classList.add('on'); });
    wrap.append(b);
  });
  return wrap;
}

// ---------- display name and profile photo ----------
// The only name ever shown or prefilled is one this user typed (remembered in their own browser). There is no default.
function commitName(value) {
  const nick = (value ?? state.nick ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (nick !== state.nick) send({ t: 'setNick', nick });
  state.nick = nick;
}

/** Joining, watching and creating all need a name. Shows the inline message and focuses the field when it is empty. */
function requireName(input) {
  commitName(input ? input.value : undefined);
  if (state.nick) return true;
  nameRequired();
  return false;
}

function nameRequired() {
  const input = refs.nameInput && refs.nameInput.isConnected ? refs.nameInput : null;
  if (!input) { openPlayModal(); return nameRequired(); }
  if (refs.nameError) refs.nameError.hidden = false;
  input.classList.add('invalid');
  input.setAttribute('aria-invalid', 'true');
  input.focus();
}

/** Read an image file, crop to a centered square, downscale to 96px and keep it as a small JPEG data URL. */
function pickPhoto(file, done) {
  if (!file || !/^image\//.test(file.type)) { toast('Choose an image file'); return; }
  if (file.size > 12 * 1024 * 1024) { toast('That image is too large'); return; }
  const fr = new FileReader();
  fr.onerror = () => toast('Could not read that image');
  fr.onload = () => {
    const img = new Image();
    img.onerror = () => toast('Could not read that image');
    img.onload = () => {
      const S = 96;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const side = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      state.avatar = c.toDataURL('image/jpeg', 0.82);
      session.set(KEY_AVATAR, state.avatar);
      done && done();
      render();
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}

/** A bot's photo from the server's table view (an id like "marcus"); nothing is shown for an unknown id. */
function facePhoto(face) {
  if (!/^[a-z0-9]{1,20}$/.test(face || '')) return null;
  return h('img', { src: `/faces/${face}.jpg`, alt: '', loading: 'lazy', draggable: 'false' });
}

/** Round avatar: the first letter of a name, or the local profile photo for "me". */
function avatar(name, { me = false, cls = '', face = '' } = {}) {
  const el = h('div', { class: 'avatar ' + cls });
  if (me && state.avatar) el.append(h('img', { src: state.avatar, alt: '' }));
  else if (facePhoto(face)) el.append(facePhoto(face));
  else el.textContent = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  return el;
}

// ---------- premium ----------
function goPremium() {
  if (!send({ t: 'goPremium' })) { toast('You are offline. Reconnecting… try again in a moment.'); return; }
  toast('Opening secure checkout…', 6000);
}

// ---- return from Stripe Checkout ----
function confirmModal() {
  closeModal('premium-confirm');
  const { el, body } = modalCard({ title: 'Premium', id: 'premium-confirm', cls: 'small', onClose: () => closeModal('premium-confirm') });
  const line = h('p', { class: 'lead', text: 'Confirming your Premium…' });
  const actions = h('div', { class: 'btn-row' });
  body.append(line, actions);
  openModal('premium-confirm', el, { dismiss: false });
  return { line, actions };
}

let confirmUi = null;
function confirmPremiumReturn() {
  confirmUi = confirmUi || confirmModal();
  confirmUi.line.textContent = 'Confirming your Premium…';
  confirmUi.actions.replaceChildren();
  if (!send({ t: 'confirmPremium', sessionId: urlSession })) { premiumFailed('You are offline. Try again in a moment.', true); return; }
  clearTimeout(confirmUi.timer);
  confirmUi.timer = setTimeout(() => premiumFailed('No answer from the server. Try again.', true), 15000);
}

function premiumFailed(message, retry) {
  if (!confirmUi) confirmUi = confirmModal();
  clearTimeout(confirmUi.timer);
  confirmUi.line.textContent = message;
  confirmUi.actions.replaceChildren(
    ...(retry ? [btn('soft', 'Try again', confirmPremiumReturn)] : []),
    btn('gold', 'OK', () => { closeModal('premium-confirm'); confirmUi = null; if (!retry) stripPremiumParams(); }));
}

function onPremiumResult(m) {
  if (!confirmUi) return;
  clearTimeout(confirmUi.timer);
  if (m.ok) {
    state.subscribed = true;
    homeSig = '';
    confirmUi.line.textContent = 'Premium is active. Thank you!';
    confirmUi.actions.replaceChildren(btn('gold', 'Continue', () => { closeModal('premium-confirm'); confirmUi = null; }));
    stripPremiumParams();
    render();
  } else {
    premiumFailed(m.message || 'We could not confirm that purchase.', m.code === 'unreachable' || m.code === 'rate_limited');
  }
}

function handlePremiumReturn() {
  if (premiumReturnHandled || !urlPremium) return;
  premiumReturnHandled = true;
  if (urlPremium === 'cancel') { stripPremiumParams(); toast('No charge was made. You can go Premium any time.', 6000); return; }
  if (!urlSession) { stripPremiumParams(); return; }
  confirmPremiumReturn();
}

function requirePremium(fn) {
  if (!state.subscribed) { openPremiumGate(); return; }
  fn();
}

/** Free players only play bots, watch, and join a Premium host's game with its code. */
const freeLimited = () => !state.subscribed && !(state.config && state.config.playWithOthersNeedsInvite === false);

function openPremiumGate(message) {
  closeModal('gate');
  const { el, body } = modalCard({ title: 'Premium feature', id: 'gate', cls: 'small' });
  body.append(
    h('p', { class: 'lead', text: message || `Hosting tables, tournaments, and brackets needs Premium ($${price()}/mo).` }),
    h('p', { class: 'tiny', text: 'Anyone can watch any game. To play with friends, join a Premium host’s game with their code.' }),
    h('div', { class: 'btn-stack' },
      btn('soft', 'Not now', () => closeModal('gate')),
      btn('soft', 'Restore Premium / I’m the owner', () => { closeModal('gate'); openRestore(); }),
      btn('gold', premiumLabel(), () => { closeModal('gate'); goPremium(); })));
  openModal('gate', el);
}

// Restore Premium: every request gets exactly one `restoreResult` from the server. The button shows "Checking…" until
// it arrives (or an 8 s safety timeout), success closes the modal, anything else keeps it open with a clear message.
const restoreUi = { busy: false, timer: 0, setBusy: null, setMsg: null };

function openRestore() {
  const { el, body } = modalCard({ title: 'Restore Premium', id: 'restore', cls: 'small', onClose: () => { restoreDone(); closeModal('restore'); } });
  const input = h('input', { type: 'email', id: 'restore-email', placeholder: 'you@example.com', autocomplete: 'email', maxlength: 254, 'aria-label': 'Email address used for Premium', 'aria-describedby': 'restore-msg' });
  const msg = h('div', { class: 'field-error', id: 'restore-msg', role: 'alert' });
  msg.hidden = true;
  const goBtn = btn('gold', 'Restore Premium', () => go());
  restoreUi.setMsg = (text) => { msg.textContent = text || ''; msg.hidden = !text; input.classList.toggle('invalid', !!text); };
  restoreUi.setBusy = (on) => { goBtn.disabled = on; input.disabled = on; goBtn.textContent = on ? 'Checking…' : 'Restore Premium'; };
  const go = () => {
    if (restoreUi.busy) return;
    const email = input.value.trim();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email)) { restoreUi.setMsg('Enter the email address you used for Premium.'); input.focus(); return; }
    restoreUi.setMsg('');
    restoreUi.busy = true;
    restoreUi.setBusy(true);
    clearTimeout(restoreUi.timer);
    restoreUi.timer = setTimeout(() => { if (restoreUi.busy) { restoreDone(); restoreUi.setMsg('No answer from the server. Check your connection and try again.'); } }, 8000);
    if (!send({ t: 'restorePremium', email })) { restoreDone(); restoreUi.setMsg('You are offline. Reconnecting… try again in a moment.'); }
  };
  input.addEventListener('input', () => restoreUi.setMsg(''));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  body.append(
    h('p', { class: 'lead', text: 'Enter the email used for your active Blackcity Premium subscription.' }),
    h('label', { class: 'field-label', for: 'restore-email', text: 'Email address used for Premium' }),
    input, msg,
    h('div', { class: 'btn-row' }, btn('soft', 'Cancel', () => { restoreDone(); closeModal('restore'); }), goBtn));
  openModal('restore', el);
  setTimeout(() => input.focus(), 60);
}

function restoreDone() {
  restoreUi.busy = false;
  clearTimeout(restoreUi.timer);
  if (restoreUi.setBusy) restoreUi.setBusy(false);
}

function onRestoreResult(m) {
  restoreDone();
  if (m.ok) {
    state.subscribed = true;
    homeSig = '';
    closeModal('restore');
    closeModal('gate');
    if (modalOpen('play')) { closeModal('play'); openPlayModal(); } // back to Play Online with the host tiles enabled
    toast(m.message || 'Premium restored', 4000);
    render();
  } else if (modalOpen('restore') && restoreUi.setMsg) {
    restoreUi.setMsg(m.message || 'That email doesn’t have active Premium on this server yet.');
  } else {
    toast(m.message);
  }
}

// ---------- home ----------
let homeSig = '';

function renderHome() {
  const root = $('home-layer');
  const game = activeGame(state);
  const summary = game ? returnSummary(state, chat.unread) : '';
  const sig = [state.subscribed, state.connected, state.config ? price() : '', state.config && state.config.devUnlock, game, summary].join('|');
  if (sig === homeSig && root.firstChild) return;
  homeSig = sig;
  const card = h('div', { class: 'home-card' },
    spadeShape('big-spade', 'url(#spadeGrad)'),
    h('div', { class: 'home-top' },
      h('span', { class: 'brandmark', text: 'BLACKCITY' }),
      h('span', { class: 'tbl-open' + (state.connected ? '' : ' off'), text: state.connected ? 'Table open' : 'Connecting…' })),
    game ? h('button', { class: 'return-card', type: 'button', onclick: returnToGame },
      h('span', { class: 'rc-text' }, h('b', { text: 'Return to game' }), h('span', { text: summary })), iconArrow()) : null,
    h('div', { class: 'home-hero' },
      h('div', { class: 'spade-tile' }, spadeShape('', '#2a2a2a')),
      h('h1', { text: 'Spades, built for the table.' })),
    h('p', { class: 'home-sub', text: 'Call your books, protect your partner, and win the game.' }),
    h('hr', { class: 'gold-rule' }),
    h('div', { class: 'chips' }, h('span', { text: 'Random players' }), h('span', { text: 'Full rules' }), h('span', { text: 'Fast matching' })),
    h('div', { class: 'big-btns' },
      h('button', { class: 'bigbtn gold', type: 'button', onclick: openPlayModal }, h('span', { text: 'Play now' }), iconArrow())),
    h('div', { class: 'prem-row' },
      state.subscribed
        ? h('span', { class: 'pill-gold static', text: 'Premium active' })
        : [h('button', { class: 'pill-gold', type: 'button', text: premiumLabel(), onclick: goPremium }), link('Restore Premium', openRestore)]),
    h('div', { class: 'host-row' }, h('button', { class: 'pill-gold', type: 'button', text: 'Host a Tournament', onclick: () => requirePremium(openEventModal) })),
    h('div', { class: 'rules-row' }, link('How to Play / Rules', openRules)));
  root.replaceChildren(card);
}

// ---------- Play Online modal ----------
const refs = {};

function openPlayModal() {
  closeModal('menu');
  const { el, body } = modalCard({ title: 'Play Online', id: 'play', cls: 'wide' });
  // Starts empty for a new visitor; only a name this user typed before is restored. autocomplete stays off so a browser can't fill a stranger's name.
  const nameInput = h('input', { type: 'text', id: 'display-name', maxlength: 16, placeholder: 'Enter your name', value: state.nick || '', autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', 'aria-label': 'Your display name', 'aria-describedby': 'name-error' });
  const nameError = h('div', { class: 'field-error', id: 'name-error', role: 'alert', text: 'Enter your name first' });
  nameError.hidden = true;
  const clearNameError = () => { nameError.hidden = true; nameInput.classList.remove('invalid'); nameInput.removeAttribute('aria-invalid'); };
  nameInput.addEventListener('input', () => { if (nameInput.value.trim()) clearNameError(); });
  nameInput.addEventListener('change', () => commitName(nameInput.value));
  nameInput.addEventListener('blur', () => commitName(nameInput.value));
  refs.nameInput = nameInput;
  refs.nameError = nameError;
  const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden', 'aria-label': 'Choose profile photo' });
  fileInput.addEventListener('change', () => pickPhoto(fileInput.files[0], () => { closeModal('play'); openPlayModal(); }));
  const me = h('div', { class: 'avatar big' });
  if (state.avatar) me.append(h('img', { src: state.avatar, alt: 'Your profile photo' })); else me.textContent = 'YOU';
  const limited = freeLimited();
  const sub = state.subscribed
    ? 'Premium active — host tables, tournaments, and brackets, or join with a code.'
    : 'Play now with random players, watch any game, or join a Premium host’s game with their code.';
  const tile = (title, desc, fn) => h('button', { class: 'tile', type: 'button', onclick: () => { if (requireName(nameInput)) fn(); } },
    h('b', { text: title }), h('span', { text: desc }));
  refs.openTables = h('div', { class: 'open-tables' });
  body.append(
    activeGame(state) ? h('button', { class: 'return-card on-paper', type: 'button', onclick: () => { closeModal('play'); returnToGame(); } },
      h('span', { class: 'rc-text' }, h('b', { text: 'Return to game' }), h('span', { text: returnSummary(state, chat.unread) })), iconArrow()) : null,
    h('p', { class: 'lead', text: sub }),
    h('label', { class: 'field-label', for: 'display-name', text: 'Your display name' }),
    nameInput,
    nameError,
    h('div', { class: 'photo-row' }, me,
      h('div', {}, btn('outline', 'Choose profile photo', () => fileInput.click()),
        h('div', { class: 'tiny', text: 'Shown at your seat for this session.' })), fileInput),
    ...(limited ? [] : state.subscribed ? [] : [h('div', { class: 'prem-row light' },
      h('button', { class: 'pill-gold', type: 'button', text: premiumLabel(), onclick: goPremium }), link('Restore Premium', openRestore))]),
    limited
      ? h('div', { class: 'tiles' },
        h('button', { class: 'tile wide quick', type: 'button', onclick: () => { if (requireName(nameInput)) send({ t: 'quickPlay' }); } },
          h('b', { text: 'Play now: random players' }), h('span', { text: 'Enter your name and you are matched with random players.' })),
        tile('Watch a game', 'Any table or tournament, by code or from the list below.', () => openCodeModal('watch')),
        h('button', { class: 'tile wide', type: 'button', onclick: () => { if (requireName(nameInput)) openCodeModal('join'); } },
          h('b', { text: 'Join with a code' }), h('span', { text: 'Got an invite from a Premium host? Enter the code to play with friends.' })),
        h('div', { class: 'tile upgrade' },
          h('b', { text: 'Host a table or tournament' }),
          h('span', { text: 'Premium hosts create tables, tournaments, and brackets, and choose who plays by inviting friends with a code.' }),
          h('div', { class: 'prem-row light' },
            h('button', { class: 'pill-gold', type: 'button', text: premiumLabel(), onclick: goPremium }), link('Restore Premium', openRestore))))
      : h('div', { class: 'tiles' },
        tile('Join Table — Free', `Enter the ${codeLen()}-character code from the host.`, () => openCodeModal('join')),
        tile('Watch Table — Free', 'Enter a code for a no-hands spectator view, great for streaming.', () => openCodeModal('watch')),
        tile('Join Tournament — Free', 'Enter the tournament code from the host.', () => openCodeModal('tournament')),
        tile('Create Table', 'Premium host: make a private code and choose the rules.', () => requirePremium(createTable)),
        tile('Create Tournament', 'Premium host: run one to eight tables.', () => requirePremium(openEventModal)),
        tile('Create Bracket', 'Premium host: run a winner-advances bracket.', () => requirePremium(openBracketModal))),
    limited ? null : h('div', { class: 'quick-row' }, link('Quick play at a public table', () => { if (requireName(nameInput)) send({ t: 'quickPlay' }); })),
    refs.openTables);
  openModal('play', el);
  fillOpenTables();
}

function fillOpenTables() {
  const box = refs.openTables;
  if (!box || !box.isConnected) return;
  const limited = freeLimited(); // free players watch from the list; they join with a Premium host's code instead
  const tables = state.lobby && state.lobby.tables ? state.lobby.tables : [];
  const tours = state.lobby && state.lobby.tournaments ? state.lobby.tournaments : [];
  const note = limited ? h('div', { class: 'tiny', text: 'Ask a Premium host for a table code to play with friends.' }) : null;
  if (!tables.length && !tours.length) { box.replaceChildren(...(note ? [note] : [])); return; }
  const needName = (fn) => () => { if (requireName(refs.nameInput)) fn(); };
  box.replaceChildren(
    h('div', { class: 'field-label', text: limited ? 'Live games to watch' : 'Open public tables' }),
    ...tables.slice(0, 6).map((t) =>
      h('div', { class: 'list-item' },
        h('div', { class: 'info' },
          h('div', { class: 'title', text: `${t.host}’s table` }),
          h('div', { class: 'muted', text: `${t.humans}/4 people · to ${t.target} · ${t.status === 'waiting' ? 'not started' : 'in play'}` })),
        h('div', { class: 'row' },
          limited ? null : btn('small gold', 'Join', needName(() => send({ t: 'joinTable', id: t.id })), { disabled: t.open <= 0 }),
          btn(limited ? 'small gold' : 'small soft', 'Watch', needName(() => send({ t: 'watchTable', id: t.id })))))),
    ...tours.slice(0, 4).map((t) =>
      h('div', { class: 'list-item' },
        h('div', { class: 'info' },
          h('div', { class: 'title', text: `${t.organizer}’s bracket` }),
          h('div', { class: 'muted', text: `${t.entrants}/${t.capacity} teams · ${t.state === 'registering' ? 'signing up' : 'in play'}` })),
        h('div', { class: 'row' }, btn(limited ? 'small gold' : 'small soft', 'Watch', needName(() => { state.openSheet = true; send({ t: 'watchTournament', id: t.id }); }))))),
    note);
}

function createTable() {
  if (!requireName(refs.nameInput)) return;
  closeModal('play');
  send({ t: 'createTable', isPublic: false, target: (state.config && state.config.defaultTarget) || 500, teamMin4: true }); // the host can switch to regular bidding in the table lobby
}

function openCodeModal(kind, prefill = '') {
  const titles = { join: 'Join Table', watch: 'Watch Table', tournament: 'Join Tournament' };
  const { el, body } = modalCard({ title: titles[kind], id: 'code', cls: 'small' });
  const input = h('input', { class: 'code-input', id: 'code-input', type: 'text', maxlength: codeLen(), placeholder: 'CODE', value: prefill, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Code' });
  input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  // Reached directly (e.g. a ?code= link) without a name yet: ask for it here.
  const nameBox = state.nick ? null : h('input', { type: 'text', id: 'code-name', maxlength: 16, placeholder: 'Enter your name', autocomplete: 'off', 'aria-label': 'Your display name' });
  const nameMsg = h('div', { class: 'field-error', role: 'alert', text: 'Enter your name first' });
  nameMsg.hidden = true;
  const go = () => {
    if (nameBox) {
      commitName(nameBox.value);
      if (!state.nick) { nameMsg.hidden = false; nameBox.classList.add('invalid'); nameBox.focus(); return; }
    }
    const code = input.value.trim().toUpperCase();
    if (code.length !== codeLen()) { toast(`Codes are ${codeLen()} letters or numbers`); input.focus(); return; }
    if (kind === 'watch') state.openSheet = true; // a bracket / event code opens its view
    send({ t: kind === 'watch' ? 'watchCode' : 'joinCode', code });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  body.append(
    h('p', { class: 'lead', text: kind === 'watch' ? 'Enter the code for a no-hands spectator view.' : kind === 'tournament' ? 'Enter the tournament code from the host.' : `Enter the ${codeLen()}-character code from the host.` }),
    ...(nameBox ? [nameBox, nameMsg] : []),
    input,
    h('div', { class: 'btn-row' }, btn('soft', 'Cancel', () => closeModal('code')), btn('gold', kind === 'watch' ? 'Watch' : 'Join', go)));
  openModal('code', el);
  setTimeout(() => input.focus(), 60);
}

function openEventModal() {
  closeModal('play');
  const cfg = state.config || {};
  const opts = cfg.eventTableOptions || [1, 2, 3, 4, 5, 6, 7, 8];
  const f = { tables: 2, target: cfg.eventTarget || 250, teamMin4: true };
  const { el, body } = modalCard({ title: 'Create Tournament', id: 'event', cls: 'small' });
  body.append(
    h('p', { class: 'lead', text: 'Run one to eight tables. Players join with your code and are seated four to a table; bots fill empty seats. Each table plays one game.' }),
    h('div', { class: 'field-label', text: 'Number of tables' }),
    seg(opts.map((n) => [n, String(n)]), f.tables, (v) => { f.tables = v; }),
    h('div', { class: 'field-label', text: 'Each game goes to' }),
    seg((cfg.tableTargets || [250, 500]).map((n) => [n, String(n)]), f.target, (v) => { f.target = v; }),
    ...bidRuleField(f),
    h('div', { class: 'btn-row' }, btn('soft', 'Cancel', () => closeModal('event')),
      btn('gold', 'Create', () => { if (!requireName()) return; send({ t: 'createEvent', tables: f.tables, target: f.target, teamMin4: f.teamMin4 }); })));
  openModal('event', el);
}

/** Premium host's bidding rule: partners must bid at least 4 together (default) or regular spades bidding. */
function bidRuleField(f) {
  return [
    h('div', { class: 'field-label', text: 'Bidding' }),
    seg([[true, 'Team min 4'], [false, 'Regular bidding']], f.teamMin4, (v) => { f.teamMin4 = v; }),
  ];
}
const bidRuleLabel = (teamMin) => (teamMin ? `Team min ${teamMin}` : 'Regular bidding');

function openBracketModal() {
  closeModal('play');
  const cfg = state.config || {};
  const f = { size: (cfg.tournamentSizes || [4, 8, 16])[0], teamMin4: true };
  const { el, body } = modalCard({ title: 'Create Bracket', id: 'bracket', cls: 'small' });
  body.append(
    h('p', { class: 'lead', text: `A winner-advances bracket. Matches go to ${cfg.tournamentTargetEarly}; the final goes to ${cfg.tournamentTargetFinal}. Solo players are paired up and bots fill empty teams.` }),
    h('div', { class: 'field-label', text: 'Teams' }),
    seg((cfg.tournamentSizes || [4, 8, 16]).map((n) => [n, String(n)]), f.size, (v) => { f.size = v; }),
    ...bidRuleField(f),
    h('div', { class: 'btn-row' }, btn('soft', 'Cancel', () => closeModal('bracket')),
      btn('gold', 'Create', () => { if (!requireName()) return; send({ t: 'createTournament', size: f.size, isPublic: false, teamMin4: f.teamMin4 }); })));
  openModal('bracket', el);
}

// ---------- Quick play queue (free players): "Finding players…" ----------
let matchTick = 0;
const matchRefs = {};
function setMatching(m) {
  state.matching = m ? { waiting: m.waiting, size: m.size || 4, until: Date.now() + (m.remainingMs || 0), waitMs: m.waitMs || 0 } : null;
  if (!state.matching) {
    clearInterval(matchTick);
    matchTick = 0;
    closeModal('matching');
    return;
  }
  closeModal('play');
  if (!modalOpen('matching')) openMatchingModal();
  renderMatching();
  if (!matchTick) matchTick = setInterval(renderMatching, 500);
}
function cancelMatch() {
  send({ t: 'cancelMatch' });
  setMatching(null);
}
function openMatchingModal() {
  const { el, body } = modalCard({ title: 'Finding players…', id: 'matching', cls: 'small', onClose: cancelMatch });
  matchRefs.count = h('p', { class: 'finding-count', role: 'status' });
  matchRefs.note = h('p', { class: 'tiny finding-note' });
  body.append(
    h('div', { class: 'finding-ring', 'aria-hidden': 'true' }),
    matchRefs.count,
    matchRefs.note,
    h('div', { class: 'btn-row' }, btn('outline', 'Cancel', cancelMatch)));
  openModal('matching', el, { dismiss: false });
}
function renderMatching() {
  const m = state.matching;
  if (!m || !matchRefs.count) return;
  matchRefs.count.textContent = 'Matching you with random players…';
  matchRefs.note.textContent = 'Hang tight, your table will be ready in a moment.';
}

// ---------- rules ----------
function openRules() {
  closeModal('menu');
  const cfg = state.config || {};
  const r = cfg.rules || { loseScore: -200, bagLimit: 10, bagPenalty: 100, nilBonus: 100 };
  const targets = (cfg.tableTargets || [250, 500]).join(' or ');
  const bid = bidRules();
  const sec = (title, ...items) => h('section', { class: 'rule-sec' }, h('h3', { text: title }), h('ul', {}, items.map((t) => h('li', { text: t }))));
  const { el, body } = modalCard({ title: 'How to Play', id: 'rules', cls: 'wide rules' });
  body.append(
    sec('The game',
      'Four players in two partnerships: you and the player across from you against the other pair. One 52-card deck, 13 cards each. Spades are always trump.',
      `A game is played over several hands. The first team to reach the target score wins. Tables play to ${targets}.`),
    sec('Bidding',
      `Starting left of the dealer, each player bids how many tricks they expect to win. You can bid from ${bid.minBid} to ${bid.maxBid}${bid.allowNil ? ', or bid Nil (0)' : ''}. You can’t change a bid.`,
      'Premium hosts choose the bidding rule for their tables, tournaments and brackets. With Team min 4 (the default) there is no Nil: each player bids 0 to 13 and the two partners must bid at least 4 together. The first partner can bid anything, including 0; the second can’t go below what is needed (after a 0 that means 4 or more). A 0 there is a plain zero: no bonus or penalty, and that player’s tricks count toward the team bid. With Regular bidding there is no minimum and Nil works as below. Free Play now games always use regular spades bidding.',
      `Partners’ bids are added together into one team contract.${bid.allowNil ? ' A Nil bid is separate from the contract.' : ''}`),
    sec('Playing a hand',
      'The player left of the dealer leads. You must follow the suit that was led if you can. If you can’t, play any card, including a spade.',
      'The highest card of the led suit wins the trick, unless a spade was played: then the highest spade wins. The winner leads the next trick.',
      'Break rule: spades can’t be led until a spade has been played on an earlier trick (broken), unless you only hold spades. The host can turn this off so spades can lead any time.'),
    sec('Scoring a hand',
      'Making your team bid scores 10 points per bid trick. Falling short loses 10 points per bid trick.',
      `Each trick over the bid is a bag: +1 point each. With sandbags on, collecting ${r.bagLimit} bags costs ${r.bagPenalty} points and takes ${r.bagLimit} off your bag count. The host can turn sandbags off: then bags are not counted and there is no penalty.`,
      ...(bid.allowNil ? [`Nil (regular bidding tables): a player who bids Nil and takes no tricks scores +${r.nilBonus}. If they take any trick it is −${r.nilBonus}. A Nil bidder’s tricks never count toward their partner’s bid; if the Nil fails those tricks become bags.`] : [])),
    sec('Winning',
      `The first team to reach ${targets} points (set by the table) wins. A team that falls to ${r.loseScore} or lower loses at once.`,
      'If both teams reach the target in the same hand, the higher score wins. If the scores are exactly equal, play continues with more hands until one team is ahead.'),
    sec('Tournaments',
      `Bracket: single elimination, random seeding. Matches go to ${cfg.tournamentTargetEarly}; the final goes to ${cfg.tournamentTargetFinal}. A team whose players all leave forfeits.`,
      'Tournament (one to eight tables): everyone joins with the host’s code and is seated four to a table; bots fill empty seats. Each table plays one game and the winners are listed.',
      'Watching is always free. Free players can also tap Play now: you are matched with random players and seated at a table, but you cannot choose who you play with. To play with friends you join a Premium host’s game with their code. Premium hosts create tables, tournaments, and brackets and choose who plays.'));
  openModal('rules', el);
}

// ---------- menu ----------
function openMenu() {
  if (modalOpen('menu')) { closeModal('menu'); return; }
  const inGame = activeGame(state);
  const items = [];
  if (inGame && state.ui === 'home') items.push(['Return to game', () => { closeModal('menu'); returnToGame(); }]);
  items.push(['Play Online', openPlayModal], ['Rules', openRules]);
  if (state.tour || state.event) items.push([state.event ? 'Tournament view' : 'Bracket view', () => { closeModal('menu'); state.away = false; state.ui = state.event ? 'event' : 'tournament'; render(); }]);
  if (state.table) items.push(['Leave table', () => { closeModal('menu'); leaveTable(); }]);
  if (tournamentKind()) items.push(['Leave tournament', () => { closeModal('menu'); leaveTournament(); }]);
  if (!state.subscribed) items.push(['Restore Premium', () => { closeModal('menu'); openRestore(); }]);
  items.push(['Card gallery', () => { location.href = '/cards.html'; }]);
  if (state.config && state.config.devUnlock) items.push(['Dev: toggle Premium', () => { closeModal('menu'); send({ t: 'devToggleSubscription' }); }]);
  const pop = h('div', { class: 'menu-pop', role: 'menu' },
    items.map(([label, fn]) => h('button', { class: 'menu-item', type: 'button', role: 'menuitem', text: label, onclick: fn })));
  openModal('menu', pop, { bare: true });
}

/** Apply a navigation result from leave-rules.js. */
function applyNav(n) {
  state.ui = n.ui;
  state.away = !!n.away;
  if (n.away && n.from) state.awayFrom = n.from;
  homeSig = '';
}

/** Back: only navigation. The player stays seated / entered and connected; the server keeps the seat and the game goes on. */
function goBack() {
  const kind = activeGame(state);
  if (!kind || state.away) return;
  state.awayFrom = state.ui === 'tournament' || state.ui === 'event' || state.ui === 'table' ? state.ui : kind;
  state.away = true;
  state.ui = 'home';
  homeSig = '';
  closeAllModals();
  render();
}

/** Return to game: straight back to the same table / bracket / event view with its current state. */
function returnToGame() {
  const kind = activeGame(state);
  if (!kind) { state.away = false; render(); return; }
  const want = state.awayFrom;
  state.ui = (want === 'table' && state.table) || (want === 'event' && state.event) || (want === 'tournament' && state.tour) ? want : kind;
  state.away = false;
  homeSig = '';
  closeAllModals();
  render();
}

/** 'event' | 'tournament' when the player is entered in one that is still going, else null. */
const tournamentKind = () => activeGame({ event: state.event, tour: state.tour });

/** Really leave the tournament / event (with the confirm from leave-rules.js). */
/** In-app confirm (native confirm() is blocked in some phone in-app browsers and returns false). onOk runs only on the confirm tap. */
function askConfirm(message, okLabel, onOk) {
  const { el, body } = modalCard({ title: 'Are you sure?', id: 'askconfirm', cls: 'small' });
  body.append(
    h('p', { class: 'lead', text: message }),
    h('div', { class: 'btn-row' },
      btn('soft', 'Cancel', () => closeModal('askconfirm')),
      btn('gold', okLabel, () => { closeModal('askconfirm'); onOk(); }, { 'data-confirm': 'ok' })));
  openModal('askconfirm', el);
}

function leaveTournament() {
  // A finished (or cancelled) bracket / event is no longer "active", but its sheet's Close button still has to leave it
  const kind = tournamentKind() || (state.ui === 'event' && state.event ? 'event' : state.ui === 'tournament' && state.tour ? 'tournament'
    : state.event ? 'event' : state.tour ? 'tournament' : null);
  if (!kind) { state.ui = 'home'; render(); return; }
  const x = kind === 'event' ? state.event : state.tour;
  const ask = sheetLeaveConfirm(x);
  const go = () => send({ t: kind === 'event' ? 'leaveEvent' : 'leaveTournament' });
  if (ask) askConfirm(ask, 'Leave', go); else go();
}

function leaveTable() {
  const t = state.table;
  if (!t) return;
  const msg = tableLeaveConfirm(t);
  const go = () => send({ t: 'leaveTable' });
  if (msg) askConfirm(msg, 'Leave', go); else go();
}

// ---------- rendering root ----------
function render() {
  const ui = state.ui;
  $('home-layer').classList.toggle('hidden', ui !== 'home');
  $('sheet-layer').classList.toggle('hidden', ui !== 'tournament' && ui !== 'event');
  const t = ui === 'table' ? state.table : null;
  renderTop(t);
  renderBoard(t);
  renderStatus(t);
  renderHandZone(t);
  renderAuto(t);
  renderDock(t);
  if (ui === 'home') renderHome();
  else if (ui === 'tournament') renderBracketSheet();
  else if (ui === 'event') renderEventSheet();
}

// ---------- top bar ----------
const SEAT_DIR = ['North', 'East', 'South', 'West'];
const teamOfSeat = (i) => i % 2;

/** On team-minimum tables a 0 is a plain zero, not Nil. */
function bidLabel(bid, t) { return bid === 0 && !bidRules(t).teamMin ? 'Nil' : `Bid ${bid}`; }

/** "bid 7 · won 3" for a partnership; the bid shows from the moment each partner has bid. */
function teamStats(t, team) {
  const seats = [team, team + 2];
  const made = seats.filter((i) => t.seats[i].bid !== null && t.seats[i].bid !== undefined);
  if (!made.length) return '';
  const bid = made.reduce((a, i) => a + t.seats[i].bid, 0);
  const text = `bid ${bid}${made.length < 2 ? '…' : ''}`;
  if (t.phase === 'bidding' || t.phase === 'waiting' || made.length < 2) return text;
  return `${text} · won ${seats.reduce((a, i) => a + t.seats[i].tricks, 0)}`;
}

function renderTop(t) {
  const sc = $('scores');
  const me = t ? t.mySeat : -1;
  const myTeam = me >= 0 ? teamOfSeat(me) : 0;
  const labels = !t || me >= 0 ? ['Us', 'Them'] : ['N/S', 'E/W'];
  const order = [myTeam, 1 - myTeam];
  sc.replaceChildren(...order.map((team, k) => {
    const bags = t ? t.bags[team] : 0;
    const noBags = t && t.rules && !t.rules.sandbags;
    const stats = t ? teamStats(t, team) : '';
    return h('div', { class: 'sbox', 'data-team': k },
      h('div', { class: 'sbox-main' }, h('b', { class: 'num', text: String(t ? t.scores[team] : 0) }), h('span', { class: 'lab', text: labels[k] })),
      h('div', { class: 'sbox-bags', text: noBags ? 'no sandbags' : `${bags} bags` }),
      stats ? h('div', { class: 'sbox-stats', text: stats }) : null);
  }));
  const label = t ? (t.tournament ? t.tournament.label : `First to ${t.target}`) : 'First to 500';
  $('target-label').textContent = label;
  const acts = $('top-actions');
  if (!acts.firstChild) {
    acts.append(
      h('button', { class: 'roundbtn', type: 'button', 'aria-label': 'How to play', onclick: openRules }, iconHelp()),
      h('button', { class: 'roundbtn', type: 'button', 'aria-label': 'Menu', onclick: openMenu }, iconMenu()));
  }
}

// ---------- board ----------
function seatStatus(t, i) {
  if (!t) return { text: 'Waiting to bid' };
  const s = t.seats[i];
  if (s.kind === 'empty') return { text: 'Open seat' };
  if (s.kind === 'human' && !s.connected) return { text: 'Away · bot plays' };
  if (t.phase === 'waiting') return { text: s.kind === 'bot' ? 'Bot' : i === t.hostSeat ? 'Host' : 'Joined' };
  const hasBid = s.bid !== null && s.bid !== undefined;
  const parts = [];
  if (hasBid) parts.push(['bid', bidLabel(s.bid, t)]);
  else if (t.phase === 'bidding') parts.push(['', t.turn === i ? 'Bidding…' : 'Waiting to bid']);
  if (hasBid && t.phase !== 'bidding') parts.push(['won', `won ${s.tricks}`]);
  if (s.botControlled && t.phase !== 'finished') parts.push(['', 'bot']);
  return { parts };
}

function pill(t, i, pos) {
  const me = !!t && i === t.mySeat;
  const idle = !t;
  const s = t ? t.seats[i] : { kind: 'bot', name: pos === 's' ? (state.nick || 'You') : { n: 'North', w: 'West', e: 'East' }[pos] };
  const name = s.kind === 'empty' ? 'Open seat' : s.name;
  const st = seatStatus(t, i);
  const stat = h('div', { class: 'pstat' });
  if (st.text) stat.textContent = st.text;
  else st.parts.forEach(([cls, text], k) => { if (k) stat.append(' · '); stat.append(h('span', { class: cls, text })); });
  const winner = t && ((t.collect && t.collect.winner === i) || (t.trickWinner !== null && t.trickWinner !== undefined && t.trickWinner === i));
  const dealer = idle ? pos === 'e' : t.dealer === i && t.phase !== 'waiting';
  return h('div', { class: `pill ${pos}${t && t.turn === i ? ' turn' : ''}${me ? ' me' : ''}${s.kind === 'empty' ? ' empty' : ''}${winner ? ' trickwin' : ''}`, 'data-seat': i },
    avatar(name, { me: me || (idle && pos === 's'), face: s.face }),
    h('div', { class: 'ptext' }, h('div', { class: 'pname', text: name }), stat),
    dealer ? h('span', { class: 'dbadge', title: 'Dealer', text: 'D' }) : null);
}

function trickCards(t, base) {
  const winnerSeat = t.collect && t.trick.length === 0 ? t.collect.winner : t.trickWinner;
  const plays = t.trick.length === 0 && t.collect ? t.collect.plays : t.trick;
  const box = h('div', { class: 'trick' });
  plays.forEach((p, idx) => {
    const pos = (p.seat - base + 4) % 4;
    const fresh = idx === plays.length - 1 && plays.length > state.prevTrickLen;
    box.append(h('div', { class: `tc pos${pos}${winnerSeat === p.seat ? ' win' : ''}${fresh ? ' new' : ''}`, title: `${t.seats[p.seat].name}: ${cardName(p.card)}` }, renderCard(p.card)));
  });
  state.prevTrickLen = plays.length;
  return box;
}

function renderBoard(t) {
  const board = $('board');
  const me = t ? t.mySeat : -1;
  const base = me >= 0 ? me : 2;
  const rel = (k) => (base + k) % 4;
  let center;
  if (!t) center = h('div', { class: 'center' });
  else if (t.phase === 'waiting') center = h('div', { class: 'center' }, h('div', { class: 'center-msg', text: 'Waiting for players…' }));
  else if (t.phase === 'bidding' && t.trick.length === 0) {
    center = h('div', { class: 'center' }, h('div', { class: 'center-msg' },
      h('div', { class: 'muted', text: `Hand ${t.handNo} · bidding` }),
      h('div', { class: 'big', text: t.turn !== null ? (t.turn === me ? 'Your bid' : `${t.seats[t.turn].name} to bid`) : '' })));
  } else {
    center = h('div', { class: 'center' }, trickCards(t, base));
  }
  if (!t || t.phase === 'waiting' || (t.phase === 'bidding' && t.trick.length === 0)) state.prevTrickLen = 0;
  const felt = h('div', { class: 'felt' },
    pill(t, rel(2), 'n'), pill(t, rel(1), 'w'), center, pill(t, rel(3), 'e'), pill(t, base, 's'));
  board.replaceChildren(felt);
}

// ---------- status line ----------
function renderStatus(t) {
  const box = $('status');
  if (!t) { box.replaceChildren(); return; }
  const me = t.mySeat;
  const myTurn = t.legal && t.legal.length > 0;
  let text = '';
  if (t.queued) text = 'You are queued. You will be seated at the next hand.';
  else if (t.botControlled) text = 'A bot is playing your seat until the next hand.';
  else if (t.phase === 'waiting') text = '';
  else if (t.canBid) text = '';
  else if (myTurn) text = 'Your turn: tap a card';
  else if (t.collect && t.trick.length === 0) text = `${t.seats[t.collect.winner].name} takes the trick`;
  else if (t.trickWinner !== null && t.trickWinner !== undefined) text = `${t.seats[t.trickWinner].name} takes the trick`;
  else if (t.turn !== null) text = `${t.seats[t.turn].name} to ${t.phase === 'bidding' ? 'bid' : 'play'}…`;
  else if (t.phase === 'handOver') text = 'Hand over';
  else if (t.phase === 'finished') text = 'Game over';
  const kids = [];
  if (t.collect && t.trick.length > 0) {
    kids.push(h('div', { class: 'collect', 'aria-label': 'Previous trick' },
      h('span', { text: `${t.seats[t.collect.winner].name} won` }),
      ...t.collect.plays.map((p) => h('div', { class: 'mini' + (p.seat === t.collect.winner ? ' win' : ''), title: `${t.seats[p.seat].name}: ${cardName(p.card)}` }, renderCard(p.card)))));
  }
  kids.push(h('div', { class: 'status-text' + (t.canBid || myTurn ? ' you' : ''), text }));
  if (t.spectator && t.phase !== 'waiting') kids.push(h('div', { class: 'spec', text: `Watching${t.spectators ? ` · ${t.spectators} watching` : ''}` }));
  else if (t.spectators && me >= 0) kids.push(h('div', { class: 'spec', text: `${t.spectators} watching` }));
  box.replaceChildren(...kids);
}

// ---------- bid panel and hand ----------
let lastBidKey = '';

/** Bid limits come from the table (and the server config); teamMin is the partners' combined minimum on Premium-hosted tables, 0 otherwise. */
function bidRules(t) {
  const r = (t && t.bidRules) || (state.config && state.config.rules) || {};
  return { minBid: r.minBid ?? 1, maxBid: r.maxBid ?? 13, allowNil: r.allowNil ?? true, teamMin: (t && t.bidRules && t.bidRules.teamMin) ?? 0 };
}

function bidPanel(t) {
  const partner = t.seats[(t.mySeat + 2) % 4];
  const grid = h('div', { class: 'bidgrid' });
  const { minBid, maxBid, allowNil, teamMin } = bidRules(t);
  const partnerBid = partner.bid !== null && partner.bid !== undefined ? partner.bid : null;
  const needed = teamMin && partnerBid !== null ? Math.max(0, teamMin - partnerBid) : 0; // lowest bid that still lets the pair reach the team minimum
  if (teamMin) grid.append(h('button', { class: 'bidbtn', type: 'button', text: '0', 'aria-label': 'Bid 0 (no books, not Nil)', disabled: needed > 0, onclick: () => send({ t: 'bid', bid: 0 }) }));
  else if (allowNil) grid.append(h('button', { class: 'bidbtn nil', type: 'button', text: 'Nil', 'aria-label': 'Bid Nil (zero)', disabled: needed > 0, onclick: () => send({ t: 'bid', bid: 0 }) }));
  for (let n = Math.max(minBid, 1); n <= maxBid; n++) grid.append(h('button', { class: 'bidbtn', type: 'button', text: String(n), disabled: n < needed, onclick: () => send({ t: 'bid', bid: n }) }));
  const teamNote = teamMin ? (needed > 0 ? `Your team must bid at least ${teamMin} together, so bid ${needed} or more` : `Your team must bid at least ${teamMin} together. 0 means no books (no Nil at this table)`) : null;
  return h('div', { class: 'bidpanel' },
    h('div', { class: 'bid-title' }, h('b', { text: 'Your bid' }),
      h('span', { text: partnerBid !== null ? `Partner bid ${partnerBid === 0 && !teamMin ? 'Nil' : partnerBid}` : 'Partner has not bid yet' })),
    grid,
    teamNote ? h('div', { class: 'tiny center-text', text: teamNote }) : null);
}

/** One long row when every card can be at least ~62px wide, otherwise two rows. Cards never overlap. */
function handRows(cards) {
  const W = Math.min(window.innerWidth, 1000) - 24;
  const per = W / cards.length >= 62 ? cards.length : Math.ceil(cards.length / 2);
  const rows = [];
  for (let i = 0; i < cards.length; i += per) rows.push(cards.slice(i, i + per));
  return { rows, per };
}

function handView(t) {
  const cards = t.hand;
  const interactive = t.legal && t.legal.length > 0;
  const legal = new Set(t.legal || []);
  const { rows, per } = handRows(cards);
  const wrap = h('div', { class: 'hand', 'aria-label': 'Your hand' });
  for (const row of rows) {
    const r = h('div', { class: 'hand-row', style: `--n:${per}` });
    for (const c of row) {
      const ok = interactive && legal.has(c);
      r.append(h('button', {
        class: `cbtn ${interactive ? (ok ? 'legal' : 'illegal') : 'idle'}`,
        type: 'button',
        disabled: interactive && !ok,
        'aria-label': cardName(c),
        onclick: () => { if (ok) send({ t: 'play', card: c }); },
      }, renderCard(c)));
    }
    wrap.append(r);
  }
  return wrap;
}

function renderHandZone(t) {
  const zone = $('handzone');
  zone.replaceChildren();
  if (!t) return;
  if (t.spectator) {
    if (t.openSeats > 0 && !t.queued && !t.tournament && t.phase !== 'waiting') {
      zone.append(h('div', { class: 'row center-row' }, btn('gold', 'Take a seat', () => { if (!requireName()) return; send({ t: 'joinCode', code: t.code }); })));
    }
    return;
  }
  if (t.canBid) zone.append(bidPanel(t));
  if (t.hand && t.phase !== 'waiting') zone.append(handView(t));
  const key = t.canBid ? `${t.id}:${t.handNo}` : '';
  if (key && key !== lastBidKey) { // a new bid is due: make sure the bid panel and the whole hand are in view
    lastBidKey = key;
    requestAnimationFrame(() => { const st = $('stage'); st.scrollTop = st.scrollHeight; });
  }
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.ui === 'table') renderHandZone(state.table); }, 120);
});

// ---------- table-driven modals (host lobby, hand summary, game over) ----------
let autoSig = '';

function setAuto(sig, build) {
  if (sig === autoSig) return;
  autoSig = sig;
  const layer = $('auto-layer');
  layer.replaceChildren();
  if (build) layer.append(h('div', { class: 'layer' }, build()));
}

function renderAuto(t) {
  if (!t) { setAuto('', null); return; }
  if (t.phase === 'waiting') {
    const sig = ['lobby', t.id, t.code, JSON.stringify(t.rules), t.bidRules && t.bidRules.teamMin, t.isHost, t.hostSeat, t.mySeat, JSON.stringify(t.seats.map((s) => [s.kind, s.name]))].join('|');
    setAuto(sig, () => hostLobby(t));
  } else if (t.phase === 'handOver' && t.lastHand && !(t.spectator && state.dismissed === t.handNo)) {
    const me = t.mySeat >= 0 ? t.seats[t.mySeat] : null;
    setAuto(['sum', t.id, t.handNo, me && me.ready].join('|'), () => handSummary(t));
  } else if (t.phase === 'finished') {
    setAuto(['over', t.id, t.winner, t.isHost].join('|'), () => gameOver(t));
  } else setAuto('', null);
}

function seatCard(t, i) {
  const s = t.seats[i];
  const team = i % 2;
  const pos = i < 2 ? 1 : 2; // N and E are position 1, S and W position 2
  const filled = s.kind !== 'empty';
  const isMe = i === t.mySeat;
  const initials = filled ? s.name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() : String(i + 1);
  const circle = h('div', { class: 'avatar sm' });
  if (isMe && state.avatar) circle.append(h('img', { src: state.avatar, alt: '' }));
  else if (filled && facePhoto(s.face)) circle.append(facePhoto(s.face));
  else circle.textContent = initials;
  const label = `Team ${team + 1} · Position ${pos}${isMe ? ' · You' : s.kind === 'bot' ? ' · Bot' : ''}`;
  return h('div', { class: 'seatcard' + (filled ? '' : ' vacant') }, circle,
    h('div', { class: 'sc-text' }, h('b', { text: filled ? s.name : 'Open seat' }), h('span', { text: label })));
}

function hostLobby(t) {
  const { el, body } = modalCard({ title: 'Play Online', id: 'lobby', cls: 'wide', onClose: t.isHost && t.mySeat >= 0 ? goBack : leaveTable }); // the host's X goes back to the menu without leaving
  const r = t.rules || { target: t.target, breakRule: true, sandbags: true };
  const cfg = state.config || {};
  const targets = cfg.tableTargets || [250, 500];
  const chip = (text, on) => (t.isHost && t.mySeat >= 0
    ? h('button', { class: 'rchip tap', type: 'button', text, onclick: on })
    : h('span', { class: 'rchip', text }));
  const other = targets.find((n) => n !== r.target) || r.target;
  const copy = () => { (navigator.clipboard ? navigator.clipboard.writeText(t.code) : Promise.reject()).then(() => toast('Code copied'), () => toast(t.code)); };
  const seatOrder = [0, 2, 1, 3]; // Team 1 on top (N, S), Team 2 below (E, W)
  const nameOf = (i) => (t.seats[i].kind === 'empty' ? 'Open seat' : t.seats[i].name);
  const allFilled = t.seats.every((s) => s.kind !== 'empty');
  const anyEmpty = t.seats.some((s) => s.kind === 'empty');
  const host = t.isHost && t.mySeat >= 0;
  body.append(
    h('p', { class: 'lead', text: state.subscribed || host ? 'Premium active — host tables, tournaments, and brackets, or join with a code.' : 'You joined with a host’s code. The host chooses the rules and starts the game.' }),
    h('div', { class: 'codebox' }, h('div', { class: 'cb-label', text: 'TABLE CODE' }), h('div', { class: 'cb-code', 'aria-label': 'Table code', text: t.code }),
      h('button', { class: 'ulink', type: 'button', text: 'Copy code', onclick: copy })),
    h('div', { class: 'rchips' },
      chip(`First to ${r.target}`, () => send({ t: 'setRules', target: other })),
      chip(`Break rule ${r.breakRule ? 'on' : 'off'}`, () => send({ t: 'setRules', breakRule: !r.breakRule })),
      chip(`Sandbags ${r.sandbags ? 'on' : 'off'}`, () => send({ t: 'setRules', sandbags: !r.sandbags })),
      ...(t.quick || t.practice ? [] : [chip(bidRuleLabel(t.bidRules && t.bidRules.teamMin), () => send({ t: 'setRules', teamMin4: !(t.bidRules && t.bidRules.teamMin) }))]),
      h('span', { class: 'rchip', text: t.quick ? 'Quick play' : t.practice ? 'Practice vs bots' : t.isPublic ? 'Public table' : 'Private · Premium host' })),
    h('div', { class: 'tiny center-text', text: host ? 'Host controls · tap a rule to change it' : 'Host controls · only the host can change the rules' }),
    h('div', { class: 'seatgrid' }, seatOrder.map((i) => seatCard(t, i))),
    h('div', { class: 'teambox' },
      h('div', { text: `Team 1: ${nameOf(0)} + ${nameOf(2)}` }),
      h('div', { text: `Team 2: ${nameOf(1)} + ${nameOf(3)}` })),
    host
      ? h('div', { class: 'btn-row three' },
        btn('soft', 'Add Bots', () => send({ t: 'addBots' }), { disabled: !anyEmpty }),
        btn('soft', 'Swap partners', () => send({ t: 'swapPartners' })),
        btn('gold', 'Start', () => send({ t: 'startTable' }), { disabled: !allFilled }))
      : h('div', { class: 'tiny center-text', text: 'Waiting for the host to start…' }),
    host ? h('div', { class: 'tiny center-text', text: 'Add bots or invite players to fill all 4 seats, then start.' }) : null,
    host ? h('div', { class: 'btn-row' }, btn('outline', '‹ Back', goBack)) : null);
  return el;
}

function handSummary(t) {
  const L = t.lastHand;
  const order = t.mySeat >= 0 ? [t.mySeat % 2, 1 - (t.mySeat % 2)] : [0, 1];
  const teamLabel = (team) => (t.mySeat >= 0 ? (team === t.mySeat % 2 ? 'Us' : 'Them') : team === 0 ? 'North/South' : 'East/West');
  const fmt = (n) => h('span', { class: n >= 0 ? 'pos' : 'neg', text: (n > 0 ? '+' : '') + n });
  const sandbags = !t.rules || t.rules.sandbags;
  const rows = order.map((team) => {
    const r = L.teams[team];
    return h('tr', {}, h('td', { text: teamLabel(team) }), h('td', { text: r.made === null ? '–' : String(r.bid) }), h('td', { text: String(r.tricks) }),
      h('td', {}, fmt(r.delta)), h('td', { text: sandbags ? `${L.scores[team]} (bags ${L.bags[team]})` : String(L.scores[team]) }));
  });
  const notes = [];
  const seatName = (i) => t.seats[i].name || SEAT_DIR[i];
  for (const team of order) {
    const r = L.teams[team];
    for (const n of r.nil) notes.push(`${seatName(n.seat)}: Nil ${n.made ? 'made +100' : 'failed −100'}`);
    if (r.bagPenalty < 0) notes.push(`${teamLabel(team)}: bags penalty ${r.bagPenalty}`);
    if (r.made === false) notes.push(`${teamLabel(team)} was set`);
  }
  const me = t.mySeat >= 0 ? t.seats[t.mySeat] : null;
  const { el, body } = modalCard({ title: `Hand ${L.handNo} result`, id: 'sum', cls: 'small', onClose: () => { if (t.spectator) { state.dismissed = t.handNo; autoSig = ''; renderAuto(state.table); } } });
  body.append(
    h('table', { class: 'sum' }, h('thead', {}, h('tr', {}, ...['', 'Bid', 'Won', 'Hand', 'Total'].map((x) => h('th', { text: x })))), h('tbody', {}, rows)),
    notes.length ? h('ul', { class: 'notes' }, notes.map((n) => h('li', { text: n }))) : null,
    t.spectator
      ? btn('soft wide', 'Keep watching', () => { state.dismissed = t.handNo; autoSig = ''; renderAuto(state.table); })
      : btn('gold wide', me && me.ready ? 'Waiting for others…' : 'Next hand', () => send({ t: 'ready' }), { disabled: !!(me && me.ready) }),
    h('p', { class: 'tiny center-text', text: 'The next hand starts when everyone is ready, or after a short wait.' }));
  return el;
}

function gameOver(t) {
  const w = t.winner;
  const mine = t.mySeat >= 0 ? t.mySeat % 2 : null;
  const teamLabel = (team) => (mine !== null ? (team === mine ? 'Us' : 'Them') : team === 0 ? 'North/South' : 'East/West');
  let title = `${teamLabel(w)} win`;
  if (mine !== null) title = w === mine ? 'You win!' : 'They win this one';
  const order = mine !== null ? [mine, 1 - mine] : [0, 1];
  const { el, body } = modalCard({ title, id: 'over', cls: 'small', onClose: () => send({ t: 'leaveTable' }) });
  body.append(
    t.forfeit ? h('p', { class: 'lead', text: 'The other team left the match, so this team advances.' }) : null,
    h('table', { class: 'sum' }, h('tbody', {}, order.map((team) => h('tr', {}, h('td', { text: teamLabel(team) }), h('td', { text: String(t.scores[team]) }))))),
    t.tournament
      ? h('p', { class: 'tiny center-text', text: 'Returning to the tournament in a moment…' })
      : h('div', { class: 'btn-row' },
        t.isHost ? btn('gold', 'Rematch', () => send({ t: 'rematch' })) : null,
        btn('soft', 'Leave table', () => send({ t: 'leaveTable' }))),
    t.tournament ? btn('soft wide', state.event ? 'View tournament' : 'View bracket', () => { state.ui = state.event ? 'event' : 'tournament'; render(); }) : null);
  return el;
}

// ---------- bracket and event sheets ----------
function sheetShell(title, badgeText, badgeCls) {
  return h('div', { class: 'sheet' },
    h('div', { class: 'sheet-head' }, h('h2', { text: title }), h('span', { class: `badge ${badgeCls}`, text: badgeText })));
}

function codeBox(code, label) {
  return h('div', { class: 'codebox small' }, h('div', { class: 'cb-label', text: label }), h('div', { class: 'cb-code', text: code }),
    h('button', { class: 'ulink', type: 'button', text: 'Copy code', onclick: () => { (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(() => toast('Code copied'), () => toast(code)); } }));
}

const stateBadge = (st) => (st === 'running' ? 'live' : st === 'finished' ? 'done' : 'gold');

function renderBracketSheet() {
  const T = state.tour;
  const root = $('sheet-layer');
  root.replaceChildren();
  if (!T) return;
  const sh = sheetShell(`Bracket · ${T.size} teams`, T.state, stateBadge(T.state));
  sh.append(codeBox(T.code, 'TOURNAMENT CODE'),
    h('div', { class: 'muted', text: `Free to join · matches to ${T.rounds.length ? T.rounds[0].target : state.config.tournamentTargetEarly}, final to ${state.config.tournamentTargetFinal} · ${bidRuleLabel(T.teamMin)}` }));
  if (T.champion) {
    sh.append(h('div', { class: 'champ' }, h('div', { class: 'muted', text: 'Champion' }), h('h3', { text: `🏆 ${T.champion.name}` }),
      T.runnerUp ? h('div', { text: `Runner-up: ${T.runnerUp.name}` }) : null));
  }
  if (T.state === 'registering') {
    sh.append(h('div', { class: 'panel' },
      h('h3', { text: `Players ${T.entrants.length}/${T.capacity}` }),
      ...T.entrants.map((e) => h('div', { class: 'list-item' }, h('span', { text: e.name }), e.organizer ? h('span', { class: 'badge gold', text: 'Organizer' }) : null)),
      h('p', { class: 'muted', text: 'Solo players are paired up when the organizer starts. A leftover player gets a bot partner, and empty teams become bot teams.' }),
      T.isOrganizer ? btn('gold wide', 'Start tournament', () => send({ t: 'startTournament' })) : h('p', { text: 'Waiting for the organizer to start…' })));
  } else {
    const br = h('div', { class: 'bracket' });
    T.rounds.forEach((r) => {
      const col = h('div', { class: 'round' }, h('h3', { text: `${r.name} · to ${r.target}` }));
      r.matches.forEach((m) => col.append(matchCard(m)));
      br.append(col);
    });
    sh.append(br);
  }
  const row = h('div', { class: 'btn-row' });
  if (state.table) row.append(btn('gold', 'Back to my table', () => { state.ui = 'table'; state.away = false; render(); }));
  const ask = sheetLeaveConfirm(T);
  const cancels = T.isOrganizer && T.state === 'registering';
  if (canGoBack(state, 'tournament')) row.append(btn('outline', '‹ Back', goBack)); // the organizer can look around and come back
  row.append(btn(ask ? (cancels || !T.isOrganizer ? 'danger' : 'soft') : 'soft', sheetLeaveLabel(T), leaveTournament));
  sh.append(row);
  root.append(sh);
}

/** The two players' small avatars (bot pictures, or first letters) in front of a team name. */
function teamFaces(t) {
  return h('span', { class: 'mfaces' }, (t.players || []).map((p) => avatar(p.name, { cls: 'mini', face: p.bot ? p.face : '' })));
}

function matchCard(m) {
  const teamRow = (t, idx) => {
    if (!t) return h('div', { class: 'mteam lose' }, h('span', { class: 'tn muted', text: 'To be decided' }));
    const done = m.winner !== null;
    return h('div', { class: `mteam${t.mine ? ' mine' : ''}${done ? (m.winner === idx ? ' win' : ' lose') : ''}` },
      teamFaces(t), h('span', { class: 'tn', text: t.name }), h('span', { text: m.score ? String(m.score[idx]) : '' }));
  };
  const foot = h('div', { class: 'mfoot' });
  if (m.status === 'live') {
    const mine = m.teams.some((t) => t && t.mine);
    foot.append(h('span', { class: 'badge live', text: 'Live' }),
      mine ? h('span', { class: 'muted', text: 'your match' }) : btn('small soft', 'Watch', () => send({ t: 'watchTable', id: m.tableId })));
  } else if (m.status === 'done') {
    foot.append(h('span', { class: 'badge done', text: 'Final' }), h('span', { class: 'muted', text: m.simulated ? 'bots (auto)' : '' }));
  } else {
    foot.append(h('span', { class: 'muted', text: m.teams[0] && m.teams[1] ? 'Starting…' : 'Waiting' }));
  }
  return h('div', { class: `match ${m.status}` }, teamRow(m.teams[0], 0), teamRow(m.teams[1], 1), foot);
}

function renderEventSheet() {
  const E = state.event;
  const root = $('sheet-layer');
  root.replaceChildren();
  if (!E) return;
  const sh = sheetShell(`Tournament · ${E.tables} ${E.tables === 1 ? 'table' : 'tables'}`, E.state, stateBadge(E.state));
  sh.append(codeBox(E.code, 'TOURNAMENT CODE'),
    h('div', { class: 'muted', text: `Free to join · each table plays one game to ${E.target} · ${bidRuleLabel(E.teamMin)} · up to ${E.capacity} players` }));
  if (E.state === 'registering') {
    sh.append(h('div', { class: 'panel' },
      h('h3', { text: `Players ${E.entrants.length}/${E.capacity}` }),
      ...E.entrants.map((e) => h('div', { class: 'list-item' }, h('span', { text: e.name }), e.organizer ? h('span', { class: 'badge gold', text: 'Organizer' }) : null)),
      h('p', { class: 'muted', text: 'When the organizer starts, players are seated four to a table in the order they joined (partners are neighbours in the list). Bots fill empty seats, and only the tables needed are opened.' }),
      E.isOrganizer ? btn('gold wide', 'Start tournament', () => send({ t: 'startEvent' })) : h('p', { text: 'Waiting for the organizer to start…' })));
  } else {
    if (E.state === 'finished') {
      sh.append(h('div', { class: 'champ' }, h('h3', { text: 'Winners' }),
        ...E.winners.map((w) => h('div', { class: 'winrow' }, h('b', { text: `Table ${w.table}` }), h('span', { text: ` ${w.team.name}` }), h('span', { class: 'muted', text: w.scores ? ` · ${w.scores[0]}–${w.scores[1]}` : '' })))));
    }
    const list = h('div', { class: 'eventtables' });
    E.results.forEach((r) => list.append(eventTableCard(r)));
    sh.append(list);
  }
  const row = h('div', { class: 'btn-row' });
  if (state.table) row.append(btn('gold', 'Back to my table', () => { state.ui = 'table'; state.away = false; render(); }));
  const ask = sheetLeaveConfirm(E);
  const cancels = E.isOrganizer && E.state === 'registering';
  if (canGoBack(state, 'event')) row.append(btn('outline', '‹ Back', goBack)); // the organizer can look around and come back
  row.append(btn(ask ? (cancels || !E.isOrganizer ? 'danger' : 'soft') : 'soft', sheetLeaveLabel(E), leaveTournament));
  sh.append(row);
  root.append(sh);
}

function eventTableCard(r) {
  const teamRow = (tm, idx) => h('div', { class: `mteam${tm.mine ? ' mine' : ''}${r.winner !== null ? (r.winner === idx ? ' win' : ' lose') : ''}` },
    teamFaces(tm), h('span', { class: 'tn', text: tm.name }), h('span', { text: r.scores ? String(r.scores[idx]) : '' }));
  const foot = h('div', { class: 'mfoot' });
  if (r.status === 'live') {
    const mine = r.teams.some((t) => t.mine);
    foot.append(h('span', { class: 'badge live', text: 'Live' }),
      mine ? h('span', { class: 'muted', text: 'your table' }) : btn('small soft', 'Watch', () => send({ t: 'watchTable', id: r.tableId })));
  } else foot.append(h('span', { class: 'badge done', text: 'Final' }), ...(r.forfeit ? [h('span', { class: 'muted', text: 'forfeit' })] : []));
  return h('div', { class: `match ${r.status}` }, h('div', { class: 'mhead', text: `Table ${r.no}` }), teamRow(r.teams[0], 0), teamRow(r.teams[1], 1), foot);
}

// ---------- dock: table music ----------
// Procedural Web Audio (music.js), nothing downloaded. Off by default; it starts only from a tap. A saved "on" is
// remembered, but browsers block sound until the page gets a tap, so it begins with the first tap anywhere.
const music = createMusic();
const musicPrefs = parseMusicPrefs(store.get(KEY_MUSIC));
const saveMusic = () => store.set(KEY_MUSIC, serializeMusicPrefs(musicPrefs));
const iconSpeaker = (on) => icon(on ? ['M4 9v6h4l5 4V5L8 9H4z', 'M16.5 8.5a5 5 0 010 7', 'M19 6a8.5 8.5 0 010 12'] : ['M4 9v6h4l5 4V5L8 9H4z', 'M17 9.5l4 5', 'M21 9.5l-4 5'], 20);

async function startMusic() {
  const ok = await music.start(musicPrefs.vol);
  if (!ok) toast('Music could not start on this device');
  renderMusic();
}
function toggleMusic() {
  if (musicPrefs.on && !music.playing) { startMusic(); return; } // saved "on", waiting for its first tap
  musicPrefs.on = !musicPrefs.on;
  saveMusic();
  if (musicPrefs.on) startMusic(); else { music.stop(); renderMusic(); }
}
function renderMusic() {
  const btn = $('music-btn');
  const vol = $('music-vol');
  if (!music.supported) { btn.classList.add('hidden'); vol.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.setAttribute('aria-pressed', String(musicPrefs.on));
  btn.setAttribute('aria-label', musicPrefs.on ? 'Turn table music off' : 'Turn table music on');
  btn.title = btn.getAttribute('aria-label');
  btn.replaceChildren(iconSpeaker(musicPrefs.on));
  vol.classList.toggle('hidden', !musicPrefs.on);
  vol.value = String(Math.round(musicPrefs.vol * 100));
}
$('music-btn').addEventListener('click', toggleMusic);
$('music-vol').addEventListener('input', (e) => {
  musicPrefs.vol = parseMusicPrefs(JSON.stringify({ on: true, vol: Number(e.target.value) / 100 })).vol;
  music.setVolume(musicPrefs.vol);
  saveMusic();
});
document.addEventListener('click', (e) => { // the first tap after a reload resumes a saved "on"
  if (musicPrefs.on && !music.playing && music.supported && !e.target.closest('#music-btn')) startMusic();
}, true);

// ---------- dock: table chat ----------
// The server is authoritative (name, length, rate limit, history). Text is only ever shown with textContent.
const CHAT_MAX = 200;
const chat = { open: false, msgs: [], unread: 0 };
const chatRefs = {};
const iconChat = () => icon(['M4 5h16v11H9l-5 4V5z'], 20);

function chatReset() { chat.msgs = []; chat.unread = 0; if (chat.open && !state.table) closeChat(); renderChatList(); renderChatButton(); }
function chatSet(msgs) { chat.msgs = Array.isArray(msgs) ? msgs.slice(-50) : []; chat.unread = 0; renderChatList(); renderChatButton(); }
function chatAdd(m) {
  chat.msgs.push(m);
  if (chat.msgs.length > 50) chat.msgs.shift();
  if (!chat.open && !m.mine) chat.unread += 1;
  renderChatList();
  renderChatButton();
  if (state.ui === 'home' && state.away) renderHome(); // the Return to game button shows new messages
}
function openChat() {
  if (!state.table) return;
  chat.open = true;
  chat.unread = 0;
  buildChat();
  $('chat-sheet').classList.remove('hidden');
  $('app').classList.add('chat-open');
  renderChatList();
  renderChatButton();
}
function closeChat() {
  chat.open = false;
  $('chat-sheet').classList.add('hidden');
  $('app').classList.remove('chat-open');
  renderChatButton();
}
function buildChat() {
  const sheet = $('chat-sheet');
  if (chatRefs.built) return;
  chatRefs.built = true;
  chatRefs.list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
  chatRefs.input = h('input', { type: 'text', maxlength: String(CHAT_MAX), placeholder: 'Message the table', 'aria-label': 'Message', autocomplete: 'off', enterkeyhint: 'send' });
  const form = h('form', { class: 'chat-form' }, chatRefs.input, h('button', { class: 'btn gold', type: 'submit', text: 'Send' }));
  form.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
  sheet.replaceChildren(
    h('div', { class: 'chat-head' }, h('h2', { text: 'Table chat' }), h('button', { class: 'chat-x', type: 'button', 'aria-label': 'Close chat', onclick: closeChat }, iconClose())),
    chatRefs.list, form);
}
function sendChat() {
  const text = chatRefs.input.value.replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (!state.nick) { toast('Enter your name on the home screen to chat'); return; }
  if (send({ t: 'chat', text })) chatRefs.input.value = '';
  else toast('Not connected yet');
  chatRefs.input.focus();
}
const chatTime = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
function renderChatList() {
  if (!chatRefs.list) return;
  const list = chatRefs.list;
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.replaceChildren(...(chat.msgs.length ? chat.msgs.map((m) => h('div', { class: `cmsg${m.mine ? ' mine' : ''}${m.role === 'watcher' ? ' watcher' : ''}` },
    h('div', { class: 'cmeta' }, h('b', { text: m.mine ? 'You' : m.from }), m.role === 'watcher' ? h('span', { class: 'tag', text: 'watcher' }) : null, h('span', { text: chatTime(m.ts) })),
    h('div', { class: 'ctext', text: m.text }))) : [h('div', { class: 'chat-empty', text: 'No messages yet. Say hello.' })]));
  if (stick || chat.msgs.length === 1) list.scrollTop = list.scrollHeight;
}
function renderChatButton() {
  const b = $('chat-btn');
  b.replaceChildren(...[iconChat(), h('span', { text: 'Chat' }), chat.unread ? h('span', { class: 'cbadge', text: chat.unread > 9 ? '9+' : String(chat.unread) }) : null].filter(Boolean));
  b.setAttribute('aria-expanded', String(chat.open));
  b.setAttribute('aria-label', chat.unread ? `Table chat, ${chat.unread} unread` : 'Table chat');
}
$('back-btn').append(icon(['M19 12H5', 'M11 6l-6 6 6 6'], 18), h('span', { text: 'Back' }));
$('back-btn').addEventListener('click', goBack);
$('chat-btn').addEventListener('click', () => (chat.open ? closeChat() : openChat()));
function renderDock(t) {
  renderMusic();
  // Back: the host's way out of a table screen (leave with the host hand-over / close described in leave-rules.js)
  const back = $('back-btn');
  const showBack = !!t && canGoBack(state, 'table');
  back.classList.toggle('hidden', !showBack);
  $('footbar').classList.toggle('has-back', showBack);
  const show = !!t; // chat belongs to the table you are seated at or watching
  $('chat-btn').classList.toggle('hidden', !show);
  if (!show && chat.open) closeChat();
}

// ---------- cover screen ----------
let coverEl = null;
function hideCover() {
  if (!coverEl) return;
  coverEl.remove();
  coverEl = null;
  $('app').inert = false;
}
function showCover() {
  const play = h('button', { class: 'cover-play', type: 'button', 'aria-label': 'Play Blackcity Spades', onclick: hideCover },
    h('span', { text: 'Play' }), iconArrow());
  coverEl = h('section', { class: 'cover', 'aria-label': 'Blackcity Spades' },
    h('img', { class: 'cover-img', src: '/cover.jpg', alt: 'Four friends playing cards around a green table', decoding: 'async', draggable: 'false' }),
    h('div', { class: 'cover-copy' },
      h('h1', { class: 'cover-title', text: 'Blackcity Spades' }),
      h('p', { class: 'cover-tag', text: 'Spades with friends' })),
    h('div', { class: 'cover-actions' }, play));
  $('app').inert = true; // keyboard and screen readers stay on the cover until Play
  document.body.append(coverEl);
  play.focus();
}

// ---------- boot ----------
render();
connect();
if (shouldShowCover({ forced: params.get('cover') === '1', seen: !!session.get(KEY_COVER), deepLink: !!(urlCode || urlPremium) })) {
  session.set(KEY_COVER, '1');
  showCover();
}
