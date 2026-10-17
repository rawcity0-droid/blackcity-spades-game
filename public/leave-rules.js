// What the Back / Leave buttons tell the user before they walk away. Pure functions so they can be unit tested.
// They only describe what the server already does (Table.leave and Tournament / TableEvent.leave); nothing here changes the rules.

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
      ? `Go back? A bot takes your seat and ${heir} becomes the host. The game goes on for the others.`
      : t.phase === 'waiting' ? `Go back? ${heir} becomes the host and the table stays open for them.` : null;
  }
  const watching = t.spectators ? ` The table also closes for the ${t.spectators} ${t.spectators === 1 ? 'person' : 'people'} watching.` : '';
  if (inPlay) return t.practice ? 'Go back? Your practice game will end.' : `Go back? You are the only person playing, so this game ends and the table closes.${watching}`;
  if (t.phase === 'waiting' && t.spectators) return `Go back? The table closes.${watching}`;
  return null;
}

/** Back from a bracket / event view. Only the organizer of a tournament that has not started cancels it by leaving. */
export function sheetLeaveConfirm(s) {
  if (!s || !s.joined || (s.state !== 'registering' && s.state !== 'running')) return null;
  if (s.isOrganizer && s.state === 'registering') return 'Go back? You are the organizer, so the tournament is cancelled for everyone who joined.';
  if (s.isOrganizer) return 'Go back? A bot takes your place and the tournament goes on for everyone else.';
  return 'Leave the tournament? A bot takes your place.';
}

/** Button label for the sheet's leave button: organizers get "Back", everyone else keeps "Leave tournament". */
export function sheetLeaveLabel(s) {
  const active = s && s.joined && (s.state === 'registering' || s.state === 'running');
  if (!active) return 'Close';
  return s.isOrganizer ? 'Back' : 'Leave tournament';
}
