# Blackcity Spades

Online partnership Spades in the browser: 4 players (N/S vs E/W), bots fill empty seats, a lobby with
host-created tables with rule toggles, brackets and multi-table tournaments, live spectating, and a phone-first UI. One Node process
serves the site and the WebSocket game server. The server is authoritative: clients only ever receive their own hand.

Status: v1 plus the UI redo, local only. Payments are a stub. Nothing is deployed.

## Run it

```bash
npm install
npm start                 # http://localhost:3000   (PORT=4000 npm start for another port)
```

- Open http://localhost:3000 and press **Practice** (you vs 3 bots, to 250 or 500 as toggled). **Play Online** opens the join / watch / host tiles.
- **Several players on one computer:** every tab of the same browser shares one saved player (the reconnect
  token lives in `localStorage`). Open each extra tab with a different slot: `http://localhost:3000/?slot=b`,
  `?slot=c`, ... or use a private/incognito window.
- **Phone on the same network:** the server listens on all interfaces. Find your computer's LAN address
  (for example `192.168.1.20`) and open `http://192.168.1.20:3000` on the phone.
- Prefill the join box with `?code=ABC234`.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm test` | Node's built-in test runner (engine, bots, tournaments, server, spectators, gating) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` / `npm run start:prod` | Compile to `dist/` and run it with plain `node` |
| `npm run dev` | `tsx watch` (restarts on change) |
| `npm run e2e` | Scripted end-to-end check against a running server (see below) |
| `npm run screenshots` | Headless Chrome screenshots into `screenshots/` (needs Chrome; set `CHROME=/path`) |

Fonts are self-hosted (no CDN) and both are SIL Open Font License 1.1, from the `google/fonts` GitHub repo, subset to Latin:
**DM Sans** (body; `public/fonts/dm-sans/DMSans.ttf`, source `ofl/dmsans/DMSans[opsz,wght].ttf`) and **Archivo** (the heavy condensed
headline, used at width 72% / weight 800; `public/fonts/archivo/Archivo.ttf`, source `ofl/archivo/Archivo[wdth,wght].ttf`).
Each folder keeps its `OFL.txt`. If a font file is missing the CSS falls back to the system font stack.

Environment variables: `PORT` (default 3000), `DEV_UNLOCK=1` (enables the dev-only subscription toggle),
`SPADES_FAST=1` (dev/testing only: removes the human-friendly pauses).

End-to-end check: `SPADES_FAST=1 DEV_UNLOCK=1 PORT=3377 npm start`, then in another shell
`E2E_URL=ws://localhost:3377/ws npm run e2e`, then stop the server.

## Free vs paid

Every business setting lives in **`src/config.ts`** (price, target scores, bracket sizes, limits, timings).
The server sends the values the UI needs (price, targets) in the `welcome` message; the client never hard-codes them.

| | Free | Host plan (`SUBSCRIPTION_PRICE_USD_PER_MONTH` = 1.99) |
| --- | --- | --- |
| Quick play, practice vs bots, public tables | yes | yes |
| Join any tournament with a code | yes | yes |
| Watch any table with a code | yes | yes |
| Create **private** tables | no | yes |
| **Host** tournaments | no | yes |

A free user who taps **Create Table / Create Tournament / Create Bracket / Host a Tournament** sees the "Premium feature" popup
("Creating tables requires Premium — subscribe for $1.99/mo. Joining with a friend's code is free."). The server still enforces the gate:
the error code is `upgrade_required` with the message "Upgrade to host — $1.99/month" (price from the config, 2 decimals), and the
client shows the same popup for it. The "Go Premium — $1.99/mo" labels are built from the server's config value too.

**What is real and what is stubbed**

- Real: the gate itself (server-side checks in `src/server/hub.ts`), the error code, the UI prompt, the subscription store
  (`src/server/subscriptions.ts`: in memory, optionally saved to `data/subscriptions.json`, which is git-ignored; `npm start`
  turns the file on), and stable host ids (the sha-256 of the player's reconnect token).
- Stubbed: payments. `src/server/billing.ts` has `createCheckoutSession(hostId)`, `handleWebhook(rawBody, signature)` and
  `createPortalSession(hostId)`, all of which throw "not implemented". `POST /billing/*` answers 501.
- Stubbed: **Go Premium** (`goPremium`) answers a `notice` "Billing is not set up yet" and **Restore Premium** (`restorePremium {email}`)
  answers "Restoring Premium is not available yet". With `DEV_UNLOCK=1` both just flip the subscription flag (no payment, nothing verified).
- Dev only: with `DEV_UNLOCK=1` the menu shows **Dev: toggle Premium** the lobby shows **Dev: toggle subscription**, the WebSocket message `devToggleSubscription` works,
  and `POST /dev/subscription` with `{"token": "<32 hex>", "active": true}` flips a flag. Without `DEV_UNLOCK` the message returns
  `not_allowed` and the endpoint returns 404.

## Stripe later (plan only, nothing here is built or verified against Stripe's current docs)

1. Create a Checkout session in **subscription mode** for the monthly price when a host presses "Start hosting"
   (`createCheckoutSession(hostId)`; pass the host id so the result can be matched to the player).
2. Receive Stripe's **webhook** at `POST /billing/webhook` (`handleWebhook`): verify the signature, then call
   `store.set(hostId, true)` when a subscription becomes active and `false` when it ends or payment fails.
   Use the raw request body for signature verification.
3. Offer the **customer portal** (`createPortalSession`) so hosts can update the card or cancel.
4. Persist subscriptions somewhere durable (the JSON file is a stand-in; a hosted database is better).
5. Keep the price in `src/config.ts`; the Stripe price id would be a second setting next to it.

What Raw must set up: a Stripe account; a product with a monthly price ($1.99/month as configured); the secret API key and the
webhook signing secret as environment variables on the server; a public HTTPS domain so Stripe can reach the webhook
(and so Checkout can return to the site). Also decide cancellation policy, any free trial, and tax handling.
Sign-in is nickname-only today, so a host's identity is their browser token; before taking money, add real accounts or at least
an email on the Checkout session so a subscription survives a cleared browser.

## Spectating

Anyone can enter a table's code and **watch live, read-only**: seat names, card counts, bids, the current trick, scores, and the
bracket for tournament matches. Enforced on the server:

- Spectator views are built without `hand` or `legal` fields, and no card appears except in the public trick / last trick.
- Any `bid`, `play`, `ready`, `startTable` or `rematch` from a spectator is rejected with `not_seated`.
- The table shows how many people are watching.
- A spectator can ask for a seat: before the game starts they sit immediately; mid-hand they are queued (still no hand data) and
  seated at the next hand if a bot seat is free.

Config flag **`SPECTATE_PRIVATE_TABLES`** (in `src/config.ts`, default `true`): when true, a code is enough to watch any table,
public or private. When false, private tables cannot be watched. The product spec left this open, so it is a one-line change.
(Watching from the lobby list by table id is only offered for public tables and tournament matches.)

## Rules implemented

- 52 cards, spades are trump, seats 0=N 1=E 2=S 3=W clockwise, partners 0&2 and 1&3. Dealer rotates; the player left of the dealer bids and leads first.
- Bids 0 to 13 (0 = nil). No blind nil. Must follow suit. **Break rule** (table setting, default on): spades cannot be led until a spade has been played (or the leader holds only spades); off = spades may lead any time.
- Score: 10 per bid trick made by the team (partners' bids combine), +1 per extra trick (bag), 10 bags = -100 and bags drop by 10.
  **Sandbags** (table setting, default on): off = no bag points, no bag counting, no penalty (contract and nil still score).
  Nil: +100 if made, -100 if failed. A nil bidder's tricks never count toward the team's bid; if the nil fails, those tricks count as bags.
  If a team's bid is not met it loses 10 per bid trick.
- Game ends at the target (500 default, 250 option; table setting) or at -200 (that team loses immediately). If both teams reach the target in the same hand,
  the higher score wins. If scores are exactly equal, more hands are played until one team is ahead.
- Tournaments: free to join; 4, 8 or 16 teams; random seeding; single elimination; matches go to **250**, the **final to 500**
  (`tournamentTargetEarly` / `tournamentTargetFinal`; set both to 250 for 250 everywhere). Solo joiners are paired in join order,
  a leftover solo gets a bot partner, empty team slots become bot teams. Bot-vs-bot matches are simulated instantly. Winners advance automatically.
  The bracket page shows the **champion and runner-up**. Only the organizer (creator) can start it.
- Multi-table tournament (**Create Tournament**, one to eight tables, premium host): players join with the event code. When the organizer
  starts it, entrants are seated at tables of four in join order (consecutive joiners are partners, human seats first, bots fill the rest).
  Only as many tables as needed are opened (at most the number chosen, e.g. 5 players on an 8-table event open 2 tables). Every table plays
  **one game** to the event target (250 by default) with tournament-table rules (forfeit / fast-forward when people leave); the event view
  lists every table live (with Watch buttons), then final scores and the **winning team of each table**. There is no second round.
  **Create Bracket** is the existing winner-advances single-elimination mode above.
- Dropped players: a bot takes the seat immediately. If the player comes back before the bot has made a move for that seat, they
  retake the seat at once; otherwise they retake it at the start of the next hand (reconnect token).
  Tournament tables: if every human of a team leaves, the other team advances; if a team's humans are all disconnected for
  `abandonMs` (60 s) the other team advances; if nobody is connected the bots finish the match instantly.

## Join codes

Tables, brackets and multi-table tournaments share one code space: **6 characters**, uppercase letters and digits without the confusing
`0 O 1 I` (and `L`): `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Codes are unique across everything on the server and entry is case-insensitive
(`abc234` works). 5-character codes are rejected as `bad_message`.

## The client

One page, no framework; the felt table is always on screen and everything else is a layer over it: the **home card** (Practice with a
250 | 500 toggle, Play Online, Go Premium / Restore Premium, Host a Tournament, Rules), the **Play Online** modal (display name, profile
photo, six tiles: Join Table, Watch Table, Join Tournament, Create Table, Create Tournament, Create Bracket), the **host lobby** modal
(table code, rule chips for target / break rule / sandbags that the host taps to change, four seat cards in two teams, Add Bots,
Swap partners, Start, enabled only when all 4 seats are filled), the Premium popup, the Restore Premium modal, a Rules modal written from
the engine's rules (numbers come from the server config), and a menu (Play Online, Rules, Leave table, Restore Premium).
Table board: seat pills with avatar, name, `Bid N · won N` (shown from the moment each bid is made) and a gold **D** on the dealer; Us / Them boxes
with bags and the partnership `bid 7 · won 3`; every card of the current trick stays at its player's position; a finished trick stays
visible for `trickPauseMs` (1.5 s, `src/config.ts`) with the winner highlighted while the next player may already lead (the last trick of a hand
still blocks until the summary). The hand is never overlapped: one row when every card can be at least about 62 px wide, otherwise two rows;
the bid panel sits above the hand and the page scrolls on very short screens.

**Profile photo:** chosen with a file input, cropped square and downscaled to 96 px with a canvas, kept in `sessionStorage`, and shown **only on
your own screen** (your seat pill and the lobby). It is never sent to the server or other players, so everyone else sees the first letter.

## Protocol overview

JSON over WebSocket at `/ws`. Client messages are `{t: "<type>", ...}`; each is validated, rate limited (burst 30, 15/s), and capped at 2 KB.

- Client to server: `hello {nick, token?}` (an empty nick keeps your saved name), `setNick {nick}`, `createTable {isPublic, target, breakRule?, sandbags?}`,
  `setRules {target?, breakRule?, sandbags?}` (host, before start), `addBots` and `swapPartners` (host, before start; swap rotates the three non-host seats), `joinTable {id}`, `joinCode {code}`, `watchTable {id}`,
  `watchCode {code}`, `quickPlay`, `startTable`, `bid {bid}`, `play {card}`, `ready`, `rematch`, `leaveTable`,
  `createTournament {size, isPublic}`, `joinTournament {id}`, `watchTournament {id}`, `startTournament`, `leaveTournament`,
  `createEvent {tables 1-8, target?}`, `startEvent`, `leaveEvent`, `goPremium`, `restorePremium {email}`, `devToggleSubscription`, `ping`. Cards are two characters, rank + suit, such as `AS`, `TH`, `2C`.
- Server to client: `welcome {token, id, nick, subscribed, config}`, `lobby {tables, tournaments}`, `table {...}` (a full snapshot for you: your
  hand and legal cards if you are seated; includes `rules {target, breakRule, sandbags}`, `hostSeat`, and `collect {plays, winner}` for the finished trick shown for `trickPauseMs`), `tournament {...}` (bracket), `event {...}` (multi-table tournament), `left`, `tournamentLeft`, `eventLeft`, `notice {kind, message}`, `nick`, `subscription`, `error {code, message}`, `pong`.
- Error codes: `bad_message`, `rate_limited`, `not_hello`, `upgrade_required`, `not_found`, `not_allowed`, `illegal`, `full`, `busy`,
  `too_many`, `not_seated`, `wrong_state`.
- Nicknames are sanitized on the server (length 16, control characters and `< > & " ' \`` removed); the client renders all text with `textContent`.

## File layout

```
src/config.ts            business + game settings (price, targets, limits, timings)
src/engine/cards.ts      deck, seeded RNG, shuffle
src/engine/game.ts       rules: bidding, play validation, tricks, scoring, game end
src/engine/bot.ts        heuristic bidder and legal-only play
src/engine/sim.ts        instant bot-vs-bot games
src/server/index.ts      entry point (PORT, DEV_UNLOCK)
src/server/server.ts     HTTP + WebSocket server, billing stubs, dev endpoint
src/server/static.ts     static files + security headers
src/server/hub.ts        players, lobby, routing, free/paid checks
src/server/table.ts      one table: seats, bots, timers, spectators, views
src/server/tournament.ts brackets, seeding, simulation, advancement
src/server/event.ts      multi-table tournament ("Create Tournament", 1-8 tables)
src/server/protocol.ts   message validation, nickname sanitizing, rate limiter
src/server/subscriptions.ts  subscription store (stub backing)
src/server/billing.ts    Stripe plug-in points (not implemented)
public/index.html, style.css, app.js   the single-page client
public/fonts/            self-hosted DM Sans and Archivo (SIL OFL, each with OFL.txt)
public/cards.js          card frame, corner indexes, pips, card back
public/court-art.js      the 12 J/Q/K characters (swappable)
public/svg.js            SVG helper; public/cards.html + gallery.js: card gallery page (/cards.html)
test/*.test.ts           engine, server, tournament tests
scripts/e2e.ts, scripts/screenshots.ts
screenshots/             output of npm run screenshots
```

## Card art and swapping it

All cards are inline SVG drawn in code: no images or CDNs. Suits use four colors (spades indigo with a gold outline,
hearts coral-red, diamonds amber, clubs emerald) **and** four different shapes, with dark outlines, big corner ranks
(duplicated upside-down), a plain light face and a single large pip on aces. Hands are laid out without overlap: one row of 13 when there is room, otherwise two rows of 7 and 6, so every corner index stays readable at 360 px wide. The card back is an original lattice pattern with a single spade.

The 12 court characters (the "Blackcity neighborhood" cast from the brief in `tournament-and-brand.md`) are in `public/court-art.js`.
To swap in a different set, replace that file with one that exports `drawCourt(suit, rank, ctx)` and returns an SVG element for a
40 x 98 panel (the contract is documented at the top of the file). Nothing else needs to change. Open `/cards.html` to review all 52 cards.

## Not in v1

Accounts, real payments, rankings or leaderboards, chat, blind nil, persistence of games or tables across restarts (only the
optional subscription file persists), scheduled tournament start times (the organizer starts it), players choosing their own tournament
partner, per-seat turn timers (a disconnected player's seat is played by a bot instead), sound, sharing profile photos with other players, a second round for multi-table tournaments, and any
analytics. The bot is a simple heuristic player, not a strong one.

## Deploying later (generic)

The app is one Node 20+ process with no database, so any host that runs a long-lived Node web service with WebSocket support
should work: `npm ci && npm run build`, start with `npm run start:prod`, set `PORT` if the host does not, serve over HTTPS
(the client picks `wss://` automatically). Game state is in memory, so a restart ends running games, and a single process means
one instance only. **Free-tier limits of any host were not checked**; many free plans sleep when idle or limit connections, so check
the current terms before choosing. For real use also add: a persistent store for subscriptions, a reverse proxy or host setting for a
real client IP (rate limiting is per connection today), and backups of `data/`.
