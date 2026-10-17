// Single place for business and game settings. Change values here only; the server sends the
// ones the UI needs (price, targets) to clients in the "welcome" message, so nothing is hard-coded elsewhere.

/** Price of the host subscription in USD. The UI always reads this from the server config and shows 2 decimals. */
export const SUBSCRIPTION_PRICE_USD_PER_MONTH = 1.99;

/** Anyone with a table's code may watch it read-only, including private tables. Set false to allow
 *  watching public tables (and tournament matches) only. Spec question still open; default true. */
export const SPECTATE_PRIVATE_TABLES = true;

/** Comma-separated OWNER_EMAILS environment variable -> trimmed, lowercased, non-empty list. Empty by default (no address is built in). */
export function parseOwnerEmails(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export const CONFIG = {
  /** Emails that can unlock Premium through "Restore Premium" while payments are stubbed. Set OWNER_EMAILS on the host. */
  ownerEmails: parseOwnerEmails(process.env.OWNER_EMAILS),
  restoreAttemptsPerMinute: 5,

  // Stripe billing (secrets are read from the environment in billing.ts / index.ts only, never kept here)
  stripeApiBase: process.env.STRIPE_API_BASE ?? 'https://api.stripe.com',
  stripeTimeoutMs: 10000,
  /** Re-verify a Stripe-backed Premium against Stripe at the next gated action once it is this old. */
  stripeRecheckMs: 24 * 3600 * 1000,
  /** If Stripe cannot be reached, keep Premium until this long after the last good verification (then lock). */
  stripeGraceMs: 7 * 24 * 3600 * 1000,
  /** Optional fixed origin for Checkout success/cancel URLs (otherwise derived from the request). */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, ''),
  spectatePrivateTables: SPECTATE_PRIVATE_TABLES,
  subscriptionPriceUsdPerMonth: SUBSCRIPTION_PRICE_USD_PER_MONTH,

  // Rules
  loseScore: -200,        // a team at or below this loses immediately
  bagLimit: 10,           // this many bags costs bagPenalty and resets bags by bagLimit
  bagPenalty: 100,
  nilBonus: 100,

  // Targets
  defaultTarget: 500,
  tableTargets: [250, 500],
  quickPlayTarget: 250,
  tournamentSizes: [4, 8, 16],
  eventTableOptions: [1, 2, 3, 4, 5, 6, 7, 8], // "Create Tournament": a multi-table event of one to eight tables
  eventTarget: 250,      // each event table plays one game to this score
  codeLength: 6,         // table / tournament / event join codes (letters and digits, no 0 O 1 I)
  tournamentTargetEarly: 250, // every round except the final
  tournamentTargetFinal: 500, // the final (set equal to the early value for "250 everywhere")

  // Free vs paid. Anyone can WATCH any game and play Practice vs bots. Playing with other humans needs an invite from a
  // Premium host (their table / tournament code); Premium customers host tables, tournaments, brackets and invite others.
  //   privateTables / hostTournaments: only a subscribed host may create private tables and host tournaments.
  //   playWithOthersNeedsInvite: a free user cannot create a table with others, quick-match into other people's tables or join by
  //     table id from the lobby; they can only join by code, and only when the table's host is a current Premium member.
  //     Set false to let free users create / join public tables like before.
  hostOnly: { privateTables: true, hostTournaments: true, playWithOthersNeedsInvite: true },

  // Server limits and timings (milliseconds)
  /** Table chat: players and watchers share one chat per table (also tournament tables). */
  chat: {
    maxChars: 200,
    history: 50,        // last N messages kept per table and sent to anyone who joins or watches
    burst: 5,           // messages allowed per connection ...
    windowMs: 10000,    // ... in this many ms
  },
  limits: {
    maxPayloadBytes: 2048,
    maxNickLength: 16,
    maxConnections: 1000,
    maxTables: 300,
    maxTournaments: 60,
    maxEvents: 40,
    maxEntrantsPerTournamentTeam: 2,
  },
  timing: {
    botDelayMs: 800,        // pause before a bot plays when humans are watching
    trickPauseMs: 1500,     // a finished trick stays visible this long (the next player may already lead)
    handPauseMs: 20000,     // time on the hand summary before the next deal (humans can press Ready)
    emptyTableTtlMs: 300000,// destroy a normal table when no human is connected for this long
    abandonMs: 60000,       // tournament table: forfeit/fast-forward after this long without humans
    matchEndPauseMs: 7000,  // show the game-over screen before returning to the bracket
    seatHoldMs: 120000,     // a disconnected human's seat can be released to a waiting player after this
  },
} as const;

/** Match target for a tournament round (0-based); the last round uses the final target. */
export function tournamentTarget(round: number, totalRounds: number): number {
  return round === totalRounds - 1 ? CONFIG.tournamentTargetFinal : CONFIG.tournamentTargetEarly;
}

/** "1.99" style text for prompts and messages. */
export const formatPrice = (usd: number): string => usd.toFixed(2);
