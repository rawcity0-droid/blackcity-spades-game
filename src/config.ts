// Single place for business and game settings. Change values here only; the server sends the
// ones the UI needs (price, targets) to clients in the "welcome" message, so nothing is hard-coded elsewhere.

/** Price of the host subscription in USD. The UI always reads this from the server config and shows 2 decimals. */
export const SUBSCRIPTION_PRICE_USD_PER_MONTH = 1.99;

/** Anyone with a table's code may watch it read-only, including private tables. Set false to allow
 *  watching public tables (and tournament matches) only. Spec question still open; default true. */
export const SPECTATE_PRIVATE_TABLES = true;

export const CONFIG = {
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
  tournamentTargetEarly: 250, // every round except the final
  tournamentTargetFinal: 500, // the final (set equal to the early value for "250 everywhere")

  // Free vs paid: free users can play bots, join public tables and tournaments;
  // only a subscribed host may create PRIVATE tables and HOST tournaments.
  hostOnly: { privateTables: true, hostTournaments: true },

  // Server limits and timings (milliseconds)
  limits: {
    maxPayloadBytes: 2048,
    maxNickLength: 16,
    maxConnections: 1000,
    maxTables: 300,
    maxTournaments: 60,
    maxEntrantsPerTournamentTeam: 2,
  },
  timing: {
    botDelayMs: 800,        // pause before a bot plays when humans are watching
    trickPauseMs: 1400,     // show the finished trick before clearing it
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
