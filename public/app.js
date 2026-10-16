// Blackcity Spades client: one page, no framework. All text from the server or user is rendered with
// textContent (via the h() helper), never innerHTML. Screens: nickname, lobby, table, tournament bracket.

import { cardName, renderBack, renderCard } from './cards.js';

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
    else if (k === 'style') el.style.cssText = v; // CSSOM (the CSP forbids inline style attributes)
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const params = new URLSearchParams(location.search);
const slot = (params.get('slot') || '').replace(/[^a-z0-9]/gi, '').slice(0, 8); // ?slot=b lets several tabs be different players
const KEY_TOKEN = 'spades_token' + (slot ? '_' + slot : '');
const KEY_NICK = 'spades_nick' + (slot ? '_' + slot : '');
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- state ----------
const state = {
  nick: store.get(KEY_NICK) || '',
  token: store.get(KEY_TOKEN) || '',
  config: null,
  subscribed: false,
  connected: false,
  ui: 'nick',            // nick | lobby | table | tournament
  lobby: null,
  table: null,
  tour: null,
  openTour: false,       // user asked to open the bracket
  pendingStart: false,   // practice table: start as soon as it is created
  dismissed: 0,          // hand number whose summary was closed (spectators)
  form: { code: (params.get('code') || '').toUpperCase().slice(0, 5), target: 250, isPublic: true, size: 4, tPublic: true },
  prevTrickLen: 0,
};

const price = () => (state.config ? Number(state.config.priceUsdPerMonth).toFixed(2) : '');
const upgradeText = () => `Upgrade to host — $${price()}/month`;

// ---------- connection ----------
let ws = null;
let retry = 800;
let pingTimer = null;

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 800;
    state.connected = true;
    banner('');
    send({ t: 'hello', nick: state.nick, token: state.token || undefined });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: 'ping' }), 25000);
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = (e) => {
    state.connected = false;
    clearInterval(pingTimer);
    if (!state.nick) return;
    if (e.code === 4000) { banner('This player is open in another tab. Reload to take over.'); return; }
    banner('Reconnecting…');
    setTimeout(connect, retry);
    retry = Math.min(5000, retry * 1.6);
  };
}

function banner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.toggle('hidden', !text);
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------- server messages ----------
function handle(m) {
  switch (m.t) {
    case 'welcome':
      state.token = m.token;
      store.set(KEY_TOKEN, m.token);
      state.nick = m.nick;
      state.config = m.config;
      state.subscribed = m.subscribed;
      lobbyBuilt = false;
      if (state.ui === 'nick') state.ui = 'lobby';
      break;
    case 'lobby': state.lobby = m; break;
    case 'subscription': state.subscribed = m.subscribed; lobbyBuilt = false; toast(m.subscribed ? 'Host plan on (dev)' : 'Host plan off (dev)'); break;
    case 'table': {
      const isNew = !state.table || state.table.id !== m.id;
      state.table = m;
      if (isNew || state.ui !== 'tournament') state.ui = 'table'; // a new table pulls you in; the bracket view stays put otherwise
      if (state.pendingStart && m.phase === 'waiting' && m.isHost) { state.pendingStart = false; send({ t: 'startTable' }); }
      break;
    }
    case 'left':
      state.table = null;
      state.ui = state.tour ? 'tournament' : 'lobby';
      if (m.reason) toast(m.reason);
      break;
    case 'tournament':
      state.tour = m;
      if (state.ui !== 'table' && (m.joined || state.openTour)) state.ui = 'tournament';
      state.openTour = false;
      break;
    case 'tournamentLeft':
      state.tour = null;
      if (state.ui === 'tournament') state.ui = 'lobby';
      if (m.reason) toast(m.reason);
      break;
    case 'error':
      state.pendingStart = false;
      if (m.code === 'upgrade_required') showUpgrade(); else toast(m.message);
      return;
    default: return;
  }
  render();
}

// ---------- rendering root ----------
let lobbyBuilt = false;

function render() {
  for (const id of ['nick', 'lobby', 'table', 'tournament']) $('screen-' + id).classList.toggle('hidden', state.ui !== id);
  $('who').textContent = state.nick ? `${state.nick} · ${state.subscribed ? 'Host' : 'Free'}` : '';
  if (state.ui !== 'table') closeOverlay();
  if (state.ui !== 'lobby') lobbyBuilt = false;
  if (state.ui === 'nick') renderNick();
  else if (state.ui === 'lobby') { if (!lobbyBuilt) buildLobby(); fillLobbyLists(); }
  else if (state.ui === 'table') renderTable();
  else if (state.ui === 'tournament') renderTournament();
}

// ---------- nickname ----------
function renderNick() {
  const root = $('screen-nick');
  if (root.firstChild) return;
  const input = h('input', { type: 'text', maxlength: 16, placeholder: 'Your nickname', value: state.nick, autocomplete: 'nickname', 'aria-label': 'Nickname' });
  const go = () => {
    const nick = input.value.trim();
    if (!nick) { toast('Pick a nickname first'); return; }
    state.nick = nick;
    store.set(KEY_NICK, nick);
    if (ws && ws.readyState <= 1) { ws.onclose = null; ws.close(); }
    connect();
    root.replaceChildren();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.append(
    h('div', { class: 'hero' }, h('h1', { text: 'Play Spades. Win the bracket.' }),
      h('p', { text: 'Free online Spades with friends or strangers. No download. No account.' })),
    h('div', { class: 'card-box stack' }, input, h('button', { class: 'btn primary big', text: 'Play now', onclick: go })),
  );
  setTimeout(() => input.focus(), 50);
}

// ---------- lobby ----------
const lobbyRefs = {};

function buildLobby() {
  lobbyBuilt = true;
  const root = $('screen-lobby');
  root.replaceChildren();
  const f = state.form;

  const codeInput = h('input', { class: 'code-input', maxlength: 5, placeholder: 'CODE', value: f.code, 'aria-label': 'Table or tournament code', autocapitalize: 'characters', oninput: (e) => { f.code = e.target.value.toUpperCase(); e.target.value = f.code; } });
  const seg = (options, current, onPick) => {
    const wrap = h('div', { class: 'seg' });
    options.forEach(([val, label]) => {
      const b = h('button', { class: val === current ? 'on' : '', text: label, type: 'button' });
      b.addEventListener('click', () => { onPick(val); [...wrap.children].forEach((c) => c.classList.remove('on')); b.classList.add('on'); });
      wrap.append(b);
    });
    return wrap;
  };
  const cfg = state.config;
  const hostBadge = state.subscribed ? h('span', { class: 'badge done', text: 'Host plan active' }) : h('span', { class: 'badge gold', text: 'Host plan' });

  root.append(
    h('div', { class: 'card-box stack' },
      h('button', { class: 'btn primary big', text: 'Quick play', onclick: () => send({ t: 'quickPlay' }) }),
      h('div', { class: 'row grow' },
        h('button', { class: 'btn', text: 'Practice vs bots', onclick: () => { state.pendingStart = true; send({ t: 'createTable', isPublic: true, target: cfg.quickPlayTarget }); } }),
      ),
      h('p', { class: 'muted', text: 'Quick play seats you at a public table. Bots fill empty seats, so you never wait.' }),
    ),
    h('div', { class: 'card-box' },
      h('h2', { text: 'Have a code?' }),
      h('div', { class: 'row' }, codeInput,
        h('button', { class: 'btn primary', text: 'Join', onclick: () => codeAction('joinCode') }),
        h('button', { class: 'btn', text: 'Watch', onclick: () => codeAction('watchCode') })),
      h('p', { class: 'muted', text: 'Join a table or tournament, or watch any table live. Spectators never see hands.' }),
    ),
    h('div', { class: 'card-box' },
      h('h2', { text: 'Open tables' }),
      (lobbyRefs.tables = h('div', {})),
    ),
    h('div', { class: 'card-box' },
      h('h2', { text: 'Tournaments' }),
      (lobbyRefs.tours = h('div', {})),
    ),
    h('div', { class: 'card-box stack' },
      h('h2', {}, 'Host your own ', hostBadge),
      h('div', { class: 'row' }, h('span', { text: 'Table:' }),
        seg([[true, 'Public'], [false, 'Private']], f.isPublic, (v) => { f.isPublic = v; }),
        seg(cfg.tableTargets.map((n) => [n, 'To ' + n]), f.target, (v) => { f.target = v; })),
      h('button', { class: 'btn', text: 'Create table', onclick: () => send({ t: 'createTable', isPublic: f.isPublic, target: f.target }) }),
      h('div', { class: 'row' }, h('span', { text: 'Tournament:' }),
        seg(cfg.tournamentSizes.map((n) => [n, n + ' teams']), f.size, (v) => { f.size = v; }),
        seg([[true, 'Public'], [false, 'Code only']], f.tPublic, (v) => { f.tPublic = v; })),
      h('button', { class: 'btn', text: 'Create tournament', onclick: () => send({ t: 'createTournament', size: f.size, isPublic: f.tPublic }) }),
      h('p', { class: 'muted', text: `Matches go to ${cfg.tournamentTargetEarly}; the final goes to ${cfg.tournamentTargetFinal}. Brackets are seeded randomly.` }),
      state.subscribed ? null : h('div', { class: 'row' },
        h('span', { class: 'muted', text: 'Private tables and hosting tournaments need the host plan.' }),
        h('button', { class: 'btn small primary', text: upgradeText(), onclick: () => showUpgrade() })),
      cfg.devUnlock ? h('button', { class: 'btn small', text: 'Dev: toggle subscription', onclick: () => send({ t: 'devToggleSubscription' }) }) : null,
    ),
    h('div', { class: 'row', style: 'justify-content:center;margin-top:8px' },
      h('button', { class: 'btn small', text: 'Change name', onclick: () => { state.ui = 'nick'; $('screen-nick').replaceChildren(); render(); } }),
      h('button', { class: 'btn small', text: 'Card gallery', onclick: () => { location.href = '/cards.html'; } })),
  );
}

function codeAction(type) {
  const code = state.form.code.trim().toUpperCase();
  if (code.length !== 5) { toast('Codes are 5 letters or numbers'); return; }
  if (type === 'watchCode') state.openTour = true; // if it is a tournament code, open the bracket
  send({ t: type, code });
}

function fillLobbyLists() {
  const L = state.lobby || { tables: [], tournaments: [], online: 0 };
  lobbyRefs.tables.replaceChildren(...(L.tables.length ? L.tables.map((t) =>
    h('div', { class: 'list-item' },
      h('div', { class: 'info' },
        h('div', { class: 'title', text: `${t.host}'s table` }),
        h('div', { class: 'muted', text: `${t.humans}/4 people · to ${t.target} · ${t.status === 'waiting' ? 'not started' : 'in play'}${t.spectators ? ' · ' + t.spectators + ' watching' : ''}` })),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', text: 'Join', disabled: t.open <= 0, onclick: () => send({ t: 'joinTable', id: t.id }) }),
        h('button', { class: 'btn small', text: 'Watch', onclick: () => send({ t: 'watchTable', id: t.id }) })))) :
    [h('p', { class: 'muted', text: 'No public tables yet. Use Quick play to start one.' })]));
  lobbyRefs.tours.replaceChildren(...(L.tournaments.length ? L.tournaments.map((t) =>
    h('div', { class: 'list-item' },
      h('div', { class: 'info' },
        h('div', { class: 'title', text: `${t.organizer}'s ${t.size}-team bracket` }),
        h('div', { class: 'muted', text: `${t.state === 'registering' ? 'Open to join' : 'Running'} · ${t.entrants}/${t.capacity} players · code ${t.code}` })),
      t.state === 'registering'
        ? h('button', { class: 'btn small primary', text: 'Join', onclick: () => send({ t: 'joinTournament', id: t.id }) })
        : h('button', { class: 'btn small', text: 'View', onclick: () => { state.openTour = true; send({ t: 'watchTournament', id: t.id }); } }))) :
    [h('p', { class: 'muted', text: 'No open tournaments. Got a code? Enter it above.' })]));
}

// ---------- upgrade prompt (payments are a stub) ----------
function showUpgrade() {
  const cfg = state.config;
  openOverlay(h('div', { class: 'modal' },
    h('h2', { text: upgradeText() }),
    h('p', { text: 'The host plan lets you create private tables and host your own tournaments. Practice, quick play, public tables, joining tournaments and watching are always free.' }),
    h('div', { class: 'row grow' },
      h('button', { class: 'btn primary', text: 'Start hosting', onclick: async () => {
        try {
          const r = await fetch('/billing/checkout', { method: 'POST' });
          const j = await r.json();
          toast(j.message || 'Payments are not set up yet');
        } catch { toast('Payments are not set up yet'); }
      } }),
      h('button', { class: 'btn', text: 'Close', onclick: closeOverlay })),
    cfg && cfg.devUnlock ? h('p', {}, h('button', { class: 'btn small', text: 'Dev: toggle subscription', onclick: () => { send({ t: 'devToggleSubscription' }); closeOverlay(); } })) : null,
  ));
}

function openOverlay(node) { const o = $('overlay'); o.replaceChildren(node); o.classList.remove('hidden'); }
function closeOverlay() { const o = $('overlay'); o.classList.add('hidden'); o.replaceChildren(); }

// ---------- table ----------
const narrowMq = window.matchMedia('(max-width: 640px)');
narrowMq.addEventListener('change', () => { if (state.ui === 'table') renderTable(); });

const SEAT_DIR = ['North', 'East', 'South', 'West'];

function teamLabel(t, team) {
  if (t.mySeat >= 0) return team === t.mySeat % 2 ? 'Us' : 'Them';
  return team === 0 ? 'North/South' : 'East/West';
}

function bidText(s, t) {
  if (s.bid === null || s.bid === undefined) return t.phase === 'bidding' ? 'bidding…' : '';
  return s.bid === 0 ? 'Nil' : `bid ${s.bid}`;
}

function seatChip(t, i, cls) {
  const s = t.seats[i];
  const base = t.mySeat >= 0 ? t.mySeat : 2;
  const name = s.kind === 'empty' ? 'Open seat' : s.name;
  let meta = '';
  if (s.kind === 'human' && !s.connected) meta = 'away · bot plays';
  else if (s.botControlled) meta = 'bot plays this hand';
  else if (t.phase === 'bidding') meta = bidText(s, t);
  else if (t.phase !== 'waiting' && s.kind !== 'empty') meta = `${bidText(s, t) ? bidText(s, t) + ' · ' : ''}won ${s.tricks}`;
  else if (s.kind === 'bot') meta = 'bot';
  const chip = h('div', { class: `seat ${cls}${s.kind === 'empty' ? ' empty' : ''}${t.turn === i ? ' turn' : ''}${i === t.mySeat ? ' me' : ''}` },
    h('div', { class: 'name' }, h('span', { class: 'dir', text: 'NESW'[i], title: SEAT_DIR[i] }), (s.kind === 'bot' ? '🤖' : '') + name,
      t.dealer === i && t.phase !== 'waiting' ? h('span', { class: 'dealer', text: 'D', title: 'Dealer' }) : null),
    h('div', { class: 'meta', text: meta }));
  if (i !== base && t.phase !== 'waiting' && s.cards > 0) {
    const mini = renderBack();
    mini.setAttribute('class', 'card-svg mini');
    chip.append(h('div', { class: 'backs' }, h('div', { class: 'mini' }, mini), h('span', { text: String(s.cards) })));
  }
  return chip;
}

function teamStats(t, team) {
  const seats = [team, team + 2];
  const bids = seats.map((i) => t.seats[i].bid);
  const bidKnown = bids.every((b) => b !== null && b !== undefined);
  const bid = bids.reduce((a, b) => a + (b || 0), 0);
  const won = seats.reduce((a, i) => a + t.seats[i].tricks, 0);
  return t.phase === 'bidding' || t.phase === 'waiting' ? '' : bidKnown ? `bid ${bid} · won ${won}` : '';
}

function renderTable() {
  const t = state.table;
  const root = $('screen-table');
  root.replaceChildren();
  if (!t) return;
  const me = t.mySeat;
  const base = me >= 0 ? me : 2;
  const rel = (k) => (base + k) % 4;
  const myTeam = me >= 0 ? me % 2 : 0;
  const order = [myTeam, 1 - myTeam];

  // score bar
  const bar = h('div', { class: 'scorebar' });
  order.forEach((team) => bar.append(h('div', { class: 'score' + (me >= 0 && team === myTeam ? ' us' : '') },
    h('small', { text: teamLabel(t, team) }), h('b', { text: String(t.scores[team]) }),
    h('small', { text: `bags ${t.bags[team]}${teamStats(t, team) ? ' · ' + teamStats(t, team) : ''}` }))));
  bar.insertBefore(h('div', { class: 'mid-info' },
    t.tournament ? h('span', { text: t.tournament.label }) : h('span', { text: `to ${t.target}` }),
    t.phase !== 'waiting' ? h('span', { text: `hand ${t.handNo}` }) : null,
    t.spadesBroken ? h('span', { text: '♠ broken' }) : null),
    bar.children[1]);
  const actions = h('div', { class: 'mid-info' },
    t.tournament ? h('button', { class: 'btn small', text: 'Bracket', onclick: () => { state.openTour = true; state.ui = 'tournament'; render(); } }) : null,
    h('button', { class: 'btn small', text: me >= 0 ? 'Leave' : 'Stop', onclick: () => { if (me < 0 || t.phase === 'waiting' || t.phase === 'finished' || confirm('Leave this table? A bot will take your seat.')) send({ t: 'leaveTable' }); } }));
  bar.append(actions);

  // felt
  const felt = h('div', { class: 'felt' }, seatChip(t, rel(2), 'seat-top'), seatChip(t, rel(1), 'seat-left'), seatChip(t, rel(3), 'seat-right'));
  if (t.phase === 'waiting') {
    felt.append(waitingCenter(t));
  } else if (t.phase === 'bidding' && t.trick.length === 0) {
    felt.append(h('div', { class: 'center-msg' }, h('div', { class: 'muted', text: `Hand ${t.handNo} · bidding` }),
      h('div', { text: t.turn !== null ? `${t.seats[t.turn].name} to bid` : '' })));
  } else {
    const trick = h('div', { class: 'trick' });
    t.trick.forEach((p, idx) => {
      const pos = (p.seat - base + 4) % 4;
      const el = h('div', { class: `tc pos${pos}${t.trickWinner === p.seat ? ' win' : ''}${idx === t.trick.length - 1 && t.trick.length > state.prevTrickLen ? ' new' : ''}`, title: `${t.seats[p.seat].name}: ${cardName(p.card)}` }, renderCard(p.card));
      trick.append(el);
    });
    state.prevTrickLen = t.trick.length;
    felt.append(trick);
  }

  // status line
  const myTurn = t.legal && t.legal.length > 0;
  let status = '';
  if (t.queued) status = 'You are queued. You will be seated at the next hand.';
  else if (t.botControlled) status = 'A bot is playing your seat until the next hand.';
  else if (t.phase === 'waiting') status = t.isHost ? 'You are the host. Start when ready; bots fill empty seats.' : me >= 0 ? 'Waiting for the host to start…' : 'Watching the table.';
  else if (t.canBid) status = 'Your bid';
  else if (myTurn) status = 'Your turn: tap a card';
  else if (t.trickWinner !== null && t.trickWinner !== undefined) status = `${t.seats[t.trickWinner].name} takes the trick`;
  else if (t.turn !== null) status = `${t.seats[t.turn].name} to ${t.phase === 'bidding' ? 'bid' : 'play'}…`;
  else if (t.phase === 'handOver') status = 'Hand over';
  else if (t.phase === 'finished') status = 'Game over';
  root.append(bar, felt, h('div', { class: 'status' + (t.canBid || myTurn ? ' you' : ''), text: status }));
  if (t.phase !== 'waiting' && me >= 0) {
    const b = t.seats[base];
    root.append(h('div', { class: 'spec', text: `${me >= 0 ? 'You' : b.name} (${SEAT_DIR[base]}) · ${bidText(b, t) || 'no bid yet'} · won ${b.tricks}` }));
  }

  if (t.spectator) {
    if (t.phase !== 'waiting') root.append(seatChip(t, base, 'seat-bottom'));
    root.append(h('div', { class: 'spec' }, `👁 Watching${t.spectators ? ` · ${t.spectators} watching` : ''}`),
      t.openSeats > 0 && !t.queued && !t.tournament ? h('div', { class: 'row', style: 'justify-content:center;margin-top:6px' },
        h('button', { class: 'btn primary', text: 'Take a seat', onclick: () => send({ t: 'joinCode', code: t.code }) })) : null);
  } else {
    if (t.canBid) root.append(bidPanel(t));
    if (t.hand) root.append(handView(t));
    if (t.spectators) root.append(h('div', { class: 'spec', text: `👁 ${t.spectators} watching` }));
  }

  // overlays
  if (t.phase === 'handOver' && t.lastHand && !(t.spectator && state.dismissed === t.handNo)) openOverlay(handSummary(t));
  else if (t.phase === 'finished') openOverlay(gameOver(t));
  else closeOverlay();
}

function waitingCenter(t) {
  const humans = t.seats.filter((s) => s.kind === 'human').length;
  return h('div', { class: 'center-msg' },
    h('div', { class: 'muted', text: t.isPublic ? 'Public table code' : 'Private table code' }),
    h('div', { class: 'code-big', text: t.code }),
    h('div', { class: 'muted', text: `${humans}/4 players · to ${t.target}` }),
    h('div', { class: 'row', style: 'justify-content:center;margin-top:6px' },
      h('button', { class: 'btn small', text: 'Copy code', onclick: () => { navigator.clipboard?.writeText(t.code).then(() => toast('Code copied'), () => toast(t.code)); } }),
      t.isHost ? h('button', { class: 'btn small primary', text: 'Start with bots', onclick: () => send({ t: 'startTable' }) }) : null));
}

function bidPanel(t) {
  const partner = t.seats[(t.mySeat + 2) % 4];
  const grid = h('div', { class: 'bidgrid' });
  grid.append(h('button', { class: 'btn nil', text: 'Nil (0)', onclick: () => send({ t: 'bid', bid: 0 }) }));
  for (let n = 1; n <= 13; n++) grid.append(h('button', { class: 'btn', text: String(n), onclick: () => send({ t: 'bid', bid: n }) }));
  return h('div', { class: 'bidpanel' },
    h('div', { class: 'muted', text: `Your bid for the hand${partner.bid !== null ? ` · partner bid ${partner.bid === 0 ? 'Nil' : partner.bid}` : ''}` }), grid);
}

function handView(t) {
  const cards = t.hand;
  const interactive = t.legal && t.legal.length > 0;
  const legal = new Set(t.legal || []);
  const per = narrowMq.matches && cards.length > 7 ? Math.ceil(cards.length / 2) : cards.length;
  const rows = [];
  for (let i = 0; i < cards.length; i += per) rows.push(cards.slice(i, i + per));
  const wrap = h('div', { class: 'hand', 'aria-label': 'Your hand' });
  for (const row of rows) {
    const r = h('div', { class: 'hand-row', style: `--n:${row.length}` });
    for (const c of row) {
      const ok = interactive && legal.has(c);
      r.append(h('button', {
        class: `cbtn ${interactive ? (ok ? 'legal' : 'illegal') : 'idle'}`,
        disabled: interactive && !ok,
        'aria-label': cardName(c),
        onclick: () => { if (ok) send({ t: 'play', card: c }); },
      }, renderCard(c)));
    }
    wrap.append(r);
  }
  return wrap;
}

function seatName(t, i) { return t.seats[i].name || SEAT_DIR[i]; }

function handSummary(t) {
  const L = t.lastHand;
  const order = t.mySeat >= 0 ? [t.mySeat % 2, 1 - (t.mySeat % 2)] : [0, 1];
  const fmt = (n) => h('span', { class: n >= 0 ? 'pos' : 'neg', text: (n > 0 ? '+' : '') + n });
  const rows = order.map((team) => {
    const r = L.teams[team];
    return h('tr', {}, h('td', { text: teamLabel(t, team) }), h('td', { text: r.made === null ? '–' : String(r.bid) }), h('td', { text: String(r.tricks) }),
      h('td', {}, fmt(r.delta)), h('td', { text: `${L.scores[team]} (bags ${L.bags[team]})` }));
  });
  const notes = [];
  for (const team of order) {
    const r = L.teams[team];
    for (const n of r.nil) notes.push(`${seatName(t, n.seat)}: Nil ${n.made ? 'made +100' : 'failed −100'}`);
    if (r.bagPenalty < 0) notes.push(`${teamLabel(t, team)}: bags penalty ${r.bagPenalty}`);
    if (r.made === false) notes.push(`${teamLabel(t, team)} was set`);
  }
  const me = t.mySeat >= 0 ? t.seats[t.mySeat] : null;
  return h('div', { class: 'modal' },
    h('h2', { text: `Hand ${L.handNo} result` }),
    h('table', { class: 'sum' }, h('thead', {}, h('tr', {}, ...['', 'Bid', 'Won', 'Hand', 'Total'].map((x) => h('th', { text: x })))), h('tbody', {}, rows)),
    notes.length ? h('ul', {}, notes.map((n) => h('li', { text: n }))) : null,
    t.spectator
      ? h('button', { class: 'btn big', text: 'Keep watching', onclick: () => { state.dismissed = t.handNo; closeOverlay(); } })
      : h('button', { class: 'btn primary big', text: me && me.ready ? 'Waiting for others…' : 'Next hand', disabled: !!(me && me.ready), onclick: () => send({ t: 'ready' }) }),
    h('p', { class: 'muted', text: 'The next hand starts when everyone is ready, or after a short wait.' }));
}

function gameOver(t) {
  const w = t.winner;
  const mine = t.mySeat >= 0 ? t.mySeat % 2 : null;
  let title = `${teamLabel(t, w)} win`;
  if (mine !== null) title = w === mine ? 'You win! 🏆' : 'They win this one';
  const order = mine !== null ? [mine, 1 - mine] : [0, 1];
  return h('div', { class: 'modal' },
    h('h2', { text: title }),
    t.forfeit ? h('p', { text: 'The other team left the match, so this team advances.' }) : null,
    h('table', { class: 'sum' }, h('tbody', {}, order.map((team) => h('tr', {}, h('td', { text: teamLabel(t, team) }), h('td', { text: String(t.scores[team]) }))))),
    t.tournament
      ? h('p', { class: 'muted', text: 'Returning to the bracket in a moment…' })
      : h('div', { class: 'row grow' },
        t.isHost ? h('button', { class: 'btn primary', text: 'Rematch', onclick: () => send({ t: 'rematch' }) }) : null,
        h('button', { class: 'btn', text: 'Leave table', onclick: () => send({ t: 'leaveTable' }) })),
    t.tournament ? h('button', { class: 'btn', text: 'View bracket', onclick: () => { state.ui = 'tournament'; render(); } }) : null);
}

// ---------- tournament ----------
function renderTournament() {
  const T = state.tour;
  const root = $('screen-tournament');
  root.replaceChildren();
  if (!T) return;
  const head = h('div', { class: 'card-box' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('h2', { style: 'margin:0', text: `Tournament · ${T.size} teams` }),
      h('span', { class: `badge ${T.state === 'running' ? 'live' : T.state === 'finished' ? 'done' : 'gold'}`, text: T.state })),
    h('div', { class: 'muted', text: `Code ${T.code} · free to join · matches to ${T.rounds.length ? T.rounds[0].target : state.config.tournamentTargetEarly}, final to ${state.config.tournamentTargetFinal}` }));
  root.append(head);

  if (T.champion) {
    root.append(h('div', { class: 'champ' }, h('div', { class: 'muted', text: 'Champion' }), h('h2', { style: 'margin:4px 0', text: `🏆 ${T.champion.name}` }),
      T.runnerUp ? h('div', { text: `Runner-up: ${T.runnerUp.name}` }) : null));
  }

  if (T.state === 'registering') {
    root.append(h('div', { class: 'card-box' },
      h('h2', { text: `Players ${T.entrants.length}/${T.capacity}` }),
      ...T.entrants.map((e) => h('div', { class: 'list-item' }, h('span', { text: e.name }), e.organizer ? h('span', { class: 'badge gold', text: 'Organizer' }) : null)),
      h('p', { class: 'muted', text: 'Solo players are paired up when the organizer starts. A leftover player gets a bot partner, and empty teams become bot teams.' }),
      T.isOrganizer ? h('button', { class: 'btn primary big', text: 'Start tournament', onclick: () => send({ t: 'startTournament' }) })
        : h('p', { text: 'Waiting for the organizer to start…' })));
  } else {
    const br = h('div', { class: 'bracket' });
    T.rounds.forEach((r) => {
      const col = h('div', { class: 'round' }, h('h3', { text: `${r.name} · to ${r.target}` }));
      r.matches.forEach((m) => col.append(matchCard(m)));
      br.append(col);
    });
    root.append(br);
  }

  const row = h('div', { class: 'row grow' });
  if (state.table) row.append(h('button', { class: 'btn primary', text: 'Back to my table', onclick: () => { state.ui = 'table'; render(); } }));
  const active = T.state === 'registering' || T.state === 'running';
  row.append(h('button', { class: 'btn' + (active && T.joined ? ' danger' : ''), text: active && T.joined ? 'Leave tournament' : 'Back to lobby',
    onclick: () => { if (!(active && T.joined) || confirm('Leave the tournament? A bot takes your place.')) send({ t: 'leaveTournament' }); } }));
  root.append(row);
}

function matchCard(m) {
  const teamRow = (t, idx) => {
    if (!t) return h('div', { class: 'mteam lose' }, h('span', { class: 'tn muted', text: 'To be decided' }));
    const done = m.winner !== null;
    return h('div', { class: `mteam${t.mine ? ' mine' : ''}${done ? (m.winner === idx ? ' win' : ' lose') : ''}` },
      h('span', { class: 'tn', text: t.name }), h('span', { text: m.score ? String(m.score[idx]) : '' }));
  };
  const foot = h('div', { class: 'mfoot' });
  if (m.status === 'live') {
    const mine = m.teams.some((t) => t && t.mine);
    foot.append(h('span', { class: 'badge live', text: 'Live' }),
      mine ? h('span', { class: 'muted', text: 'your match' }) : h('button', { class: 'btn small', text: 'Watch', onclick: () => send({ t: 'watchTable', id: m.tableId }) }));
  } else if (m.status === 'done') {
    foot.append(h('span', { class: 'badge done', text: 'Final' }), h('span', { class: 'muted', text: m.simulated ? 'bots (auto)' : '' }));
  } else {
    foot.append(h('span', { class: 'muted', text: m.teams[0] && m.teams[1] ? 'Starting…' : 'Waiting' }));
  }
  return h('div', { class: `match ${m.status}` }, teamRow(m.teams[0], 0), teamRow(m.teams[1], 1), foot);
}

// ---------- boot ----------
render();
if (state.nick) connect();
