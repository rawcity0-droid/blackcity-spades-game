// Leaving and going back, as the client sees it. Pure functions so they can be unit tested.
//
//  * BACK is navigation only: the player stays seated (or in the tournament) and connected, the server keeps the seat, the game goes on and
//    the host stays host. The home screen then offers "Return to game".
//  * LEAVE really leaves (Table.leave / Tournament.leave / TableEvent.leave on the server) and asks first when that affects other people.
//    The confirm texts below only describe what the server already does; nothing here changes the rules.

const IN_PLAY = new Set(['bidding', 'playing', 'handOver']);

/** The person who becomes host when the host leaves: the first connected human in seat order, else the first human (as on the server). */
export function nextHost(t) {
  const others = t.seats.map((s, i) => ({ s, i })).filter(({ s, i }) => i !== t.mySeat && s.kind === 'human');
  const pick = others.find(({ s }) => s.connected) || others[0];
  return pick ? pick.s.name : null;
}

/**
 * Confirm text for leaving a table, or null when leaving loses nothing and can happen at once.
 *  - host with other people seated: host passes to them, a bot takes the seat once the game is under way
 *  - host who is the only person playing: the table closes (watchers are sent back)
 *  - ordinary player in a running game: a bot takes the seat
 *  - watchers, and anyone before the start / after the end: no confirm
 */
export function tableLeaveConfirm(t) {
  if (!t || t.mySeat < 0) return null;
  const inPlay = IN_PLAY.has(t.phase);
  if (!t.isHost) return inPlay ? 'Leave this table? A bot will take your seat.' : null;
  const heir = nextHost(t);
  if (heir) {
    return inPlay
      ? `Leave this table? A bot takes your seat and ${heir} becomes the host. The game goes on for the others.`
      : t.phase === 'waiting' ? `Leave this table? ${heir} becomes the host and the table stays open for them.` : null;
  }
  const watching = t.spectators ? ` The table also closes for the ${t.spectators} ${t.spectators === 1 ? 'person' : 'people'} watching.` : '';
  if (inPlay) return t.practice ? (t.quick ? 'Leave this table? Your game will end.' : 'Leave this table? Your practice game will end.') : `Leave this table? You are the only person playing, so this game ends and the table closes.${watching}`;
  if (t.phase === 'waiting' && t.spectators) return `Leave this table? The table closes.${watching}`;
  return null;
}

/** Leaving a bracket / event view. Only an organizer leaving before the start cancels the tournament. */
export function sheetLeaveConfirm(s) {
  if (!s || !s.joined || (s.state !== 'registering' && s.state !== 'running')) return null;
  if (s.isOrganizer && s.state === 'registering') return 'Leave the tournament? You are the organizer, so it is cancelled for everyone who joined.';
  if (s.isOrganizer) return 'Leave the tournament? A bot takes your place and it goes on for everyone else.';
  return 'Leave the tournament? A bot takes your place.';
}

/** Label of the sheet's leave button. */
export function sheetLeaveLabel(s) {
  return s && s.joined && (s.state === 'registering' || s.state === 'running') ? 'Leave tournament' : 'Close';
}

// ---------- navigation: which game the player is still in, and which screen to show ----------

const active = (x) => !!x && x.joined && (x.state === 'registering' || x.state === 'running');

/** The game the player is still part of (seated or watching a table, or entered in a tournament / event), or null. */
export function activeGame(s) {
  if (s.table) return 'table';
  if (active(s.event)) return 'event';
  if (active(s.tour)) return 'tournament';
  return null;
}

/** Back is offered to the host of a table and to the organizer of a tournament / event. */
export function canGoBack(s, ui) {
  if (ui === 'table') return !!s.table && s.table.isHost && s.table.mySeat >= 0 && !s.table.tournament;
  if (ui === 'tournament') return active(s.tour) && s.tour.isOrganizer;
  if (ui === 'event') return active(s.event) && s.event.isOrganizer;
  return false;
}

/** Screen after a `table` message. A new table always opens; an update never pulls someone away from home. */
export function navAfterTable(nav, isNew) {
  if (isNew) return { ui: 'table', away: false };
  if (nav.away) return nav;
  return { ui: nav.ui === 'tournament' || nav.ui === 'event' ? nav.ui : 'table', away: false };
}

/** Screen after a `tournament` / `event` message: joined players are taken to the view unless they went Back; an explicit open always works. */
export function navAfterSheet(nav, kind, joined, wantOpen) {
  if (nav.ui === 'table') return nav;
  if (wantOpen || (!nav.away && joined)) return { ui: kind, away: false };
  return nav;
}

/** Screen after the table / tournament / event ends for this player. */
export function navAfterEnd(nav, s) {
  const next = activeGame(s);
  if (nav.away) return next ? { ui: 'home', away: true, from: next } : { ui: 'home', away: false };
  return { ui: next || 'home', away: false };
}

/** Text for the Return to game button's second line. */
export function returnSummary(s, unread = 0) {
  const kind = activeGame(s);
  let text = '';
  if (kind === 'table') {
    const t = s.table;
    if (t.tournament) text = t.tournament.label;
    else if (t.mySeat < 0) text = 'Watching a table';
    else if (t.phase === 'waiting') text = 'Waiting to start';
    else if (t.phase === 'finished') text = 'Game over';
    else text = t.turn === t.mySeat ? 'Your turn' : `Hand ${t.handNo}`;
  } else if (kind) {
    const x = kind === 'event' ? s.event : s.tour;
    text = `Tournament · ${x.state === 'registering' ? 'signing up' : 'in play'}`;
  }
  return unread ? `${text} · ${unread} new ${unread === 1 ? 'message' : 'messages'}` : text;
}
