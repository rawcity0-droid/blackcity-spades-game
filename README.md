# Blackcity Spades

Online partnership Spades in the browser: 4 players (N/S vs E/W), bots fill empty seats, a lobby with
host-created tables with rule toggles, brackets and multi-table tournaments, live spectating, and a phone-first UI. One Node process
serves the site and the WebSocket game server. The server is authoritative: clients only ever receive their own hand.

Status: v1 plus the UI redo, Stripe billing (needs env vars; see Billing), name rules, table chat and table music. Nothing is deployed from here.

## Run it

```bash
npm install
npm start                 # http://localhost:3000   (PORT=4000 npm start for another port)
```

- Open http://localhost:3000 and press **Play now**. It opens the display name, the **Play now: random players** tile (random players, bots fill empty seats after 10 s) and the join / watch / host tiles.
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
| `npm run e2e:prod` | Production-mode check (no DEV_UNLOCK) against a local Stripe mock |
| `npm run screenshots` | Headless Chrome screenshots into `screenshots/` (needs Chrome; set `CHROME=/path`) |

Fonts are self-hosted (no CDN) and both are SIL Open Font License 1.1, from the `google/fonts` GitHub repo, subset to Latin:
**DM Sans** (body; `public/fonts/dm-sans/DMSans.ttf`, source `ofl/dmsans/DMSans[opsz,wght].ttf`) and **Archivo** (the heavy condensed
headline, used at width 72% / weight 800; `public/fonts/archivo/Archivo.ttf`, source `ofl/archivo/Archivo[wdth,wght].ttf`).
Each folder keeps its `OFL.txt`. If a font file is missing the CSS falls back to the system font stack.

Environment variables: `PORT` (default 3000), `DEV_UNLOCK=1` (enables the dev-only subscription toggle),
`SPADES_FAST=1` (dev/testing only: removes the human-friendly pauses), and the billing settings in **Billing** below
(`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `OWNER_EMAILS`, `PUBLIC_BASE_URL`, `STRIPE_API_BASE`).

End-to-end check: `SPADES_FAST=1 DEV_UNLOCK=1 PORT=3377 npm start`, then in another shell
`E2E_URL=ws://localhost:3377/ws npm run e2e`, then stop the server. Production-mode check against a local Stripe mock (no `DEV_UNLOCK`):
`SPADES_FAST=1 PORT=3388 OWNER_EMAILS=owner@example.test STRIPE_SECRET_KEY=sk_test_MOCKSECRET0123456789 STRIPE_PRICE_ID=price_mock_monthly STRIPE_API_BASE=http://127.0.0.1:3389 npm start`,
then `E2E_URL=ws://localhost:3388/ws E2E_MOCK_PORT=3389 npm run e2e:prod` (fake key, never sent anywhere real).

## Free vs paid

Every business setting lives in **`src/config.ts`** (price, target scores, bracket sizes, limits, timings).
The server sends the values the UI needs (price, targets) in the `welcome` message; the client never hard-codes them.

**The rule (from the owner): anyone can watch any game; free players can play random players (bots fill empty seats) but cannot choose who they play with.
To pick who you play with you need an invite from a Premium customer.**
A free user's play is **Play now** (random players with bots filling empty seats, see below), or a Premium host's game by code. Premium customers host tables,
tournaments and brackets and choose who plays by inviting others with a code.

| | Free | Premium (`SUBSCRIPTION_PRICE_USD_PER_MONTH` = 1.99) |
| --- | --- | --- |
| Practice vs bots (solo table, bots fill, nobody else can join) | yes | yes |
| Quick play | **random-match queue** with other free Quick-play players; bots fill empty seats after a short wait | matches into open public tables, or starts one at once |
| **Watch** any table or tournament (by code, or from the lobby list) | yes | yes |
| Chat as a watcher or player | yes | yes |
| **Join by code** a table, tournament, bracket or event | only if its host is **Premium right now** (the invitation) | yes |
| Join a table or tournament **by id** from the lobby list | no (Watch only) | yes |
| Create tables (public or private), tournaments, brackets, events | no | yes |

Server-enforced in `src/server/hub.ts`, controlled by one setting, `CONFIG.hostOnly.playWithOthersNeedsInvite` (default `true`; `false` brings back
free public tables and joining by id). For a free player:

- `createTable` (not practice) and quick-match, `joinTable` by id and `joinTournament` by id are refused with `upgrade_required`
  ("Playing with others needs an invite from a Premium host, or go Premium to host your own"); `createTournament` / `createEvent` with
  "Upgrade to host — $1.99/month". `quickPlay` is the random-match queue below.
- `joinCode` (table, tournament, bracket or event) works only when whoever **created** it (the table's creator, which does not change when the
  host leaves; the organizer for tournaments and their tables) is subscribed at that moment; otherwise `not_allowed` with "That game was not
  made by a Premium host...". A watcher's "Take a seat" is a `joinCode` too, so the same rule applies.
- A Practice table (`createTable {practice: true}`) is `practice: true` in the table view, never public or listed, and joining it by code is refused.
- **Quick play for free players is a random-match queue** (`CONFIG.freeRandomMatch`, default `true`; `false` = the old solo game against bots).
  The player sees "Finding players…" (`matching {active, waiting, size: 4, remainingMs}`), a neutral "Matching you with random players…" message (no count, no mention of bots) and a Cancel button
  (`cancelMatch`; Escape and the X also cancel). When **four** free players are queued they start together with no bots. Otherwise, once the oldest
  waiting player has waited `CONFIG.timing.matchWaitMs` (10 s), everyone queued starts together and **bots fill the empty seats**, with no
  notice at all: the table just appears with everyone's names. Bot names come from a large pool of street-style nicknames in `BOT_NAMES` (`src/server/table.ts`). One player
  alone gets a practice table as before. A matched table is private and unlisted (nobody picks it from the lobby), and the players are seated in queue order.
  Cancelling, disconnecting or closing the tab leaves the queue; a reload or second tab while queued shows the waiting state again. While queued a
  player cannot create, join or watch tables (`busy`: "You are finding players. Cancel that first"); pressing Quick play again just re-shows the wait.
  The pool is free Quick-play seekers only: a Premium player's Quick play is unchanged (an open public table, or a new public table with bots), so free
  players are not randomly seated at Premium hosts' tables and Premium players are not pulled into the free queue.
- Watching is unchanged: `watchTable`, `watchCode`, `watchTournament`, and spectators still never receive hands.
- Premium users and the email restore flow are unchanged.

UI: a free user's **Play Online** modal shows **"Play now: random players"** (gold tile), Watch a game, Join with a code,
and an upgrade card ("Host a table or tournament", Go Premium / Restore Premium). The lobby list is titled "Live games to watch", has **Watch** buttons only (tables and public brackets), and says
"Ask a Premium host for a table code to play with friends". Premium users keep the full tile set and Join / Watch buttons.
The "Premium feature" popup appears when a free user tries to host (the home card's Host a Tournament, or an `upgrade_required` reply) and shows the
server's message. The "Go Premium — $1.99/mo" labels are built from the server's config value.

**Display names.** There is no default or generated name anywhere. A new visitor sees an empty "Enter your name" field (autocomplete
off). A name the user typed is remembered in that browser's `localStorage` only. Join, Watch, Create Table,
Create Tournament, Create Bracket and Quick play are blocked until a non-empty name (after trimming) is entered: the client shows
"Enter your name first" and focuses the field, and the server refuses the same actions with error code `name_required` and changes
nothing. **Practice** (vs bots) does not need a name: it uses the name if one is set, otherwise the seat is "You"
(`createTable {isPublic: true, practice: true}` is the one exemption).

## Billing

Real Stripe billing over plain `fetch` (no SDK) in `src/server/billing.ts`, with **no webhook**. Everything is configured by environment
variables, never committed and never logged:

| Variable | Meaning |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe secret (or restricted) key. Without it, billing is off. |
| `STRIPE_PRICE_ID` | The recurring $1.99/month price (`price_...`). Without it, billing is off. |
| `OWNER_EMAILS` | Comma-separated owner emails that unlock Premium through Restore Premium (trimmed, lowercased). Default: none. |
| `PUBLIC_BASE_URL` | Optional, e.g. `https://spades.example.com`. Fixes the origin used in Checkout's success/cancel URLs. Default: derived from the request (`x-forwarded-host`/`x-forwarded-proto`, then `Host`), falling back to `http://localhost:PORT`. Set it on the real site. |
| `STRIPE_API_BASE` | Testing only: points billing at a mock server. Default `https://api.stripe.com`. |

If `STRIPE_SECRET_KEY` or `STRIPE_PRICE_ID` is missing, **Go Premium** shows "Billing is not set up yet" (and `DEV_UNLOCK=1` still flips the flag).

**How it works**

1. **Go Premium** (`goPremium`): the server creates a Checkout Session in `subscription` mode with `STRIPE_PRICE_ID`, quantity 1,
   `success_url=<origin>/?premium=success&session_id={CHECKOUT_SESSION_ID}`, `cancel_url=<origin>/?premium=cancel`, and the player's host id
   (not the secret token) in `client_reference_id` and `metadata`. The client gets `checkout {url}` and redirects to Stripe.
2. **Return** (`?premium=success&session_id=...`): the page shows "Confirming your Premium…", sends `confirmPremium {sessionId}`, and the
   server **retrieves the session from Stripe** (with the subscription expanded). It unlocks only if the session was created by this app,
   is `mode=subscription`, `status=complete`, `payment_status=paid`, and its subscription is `active` or `trialing` with an item on
   `STRIPE_PRICE_ID`. The buyer email and Stripe customer id are stored with that host, and an email to customer index is kept.
   Verification is idempotent; a verified session is bound to the first host that claims it, so another browser replaying the same id
   gets `claimed` (use Restore by email on the other device). The client then strips `premium` and `session_id` from the URL.
   The cancel return shows "No charge was made".
3. **Restore Premium by email** (`restorePremium {email}`): an email in `OWNER_EMAILS` unlocks (never expires). Otherwise the server asks
   Stripe for customers with that email (list filter and Search, plus customers seen in earlier verified checkouts) and unlocks if any has an
   `active`/`trialing` subscription on `STRIPE_PRICE_ID`. Otherwise the answer is always the same friendly message. Every request gets exactly
   one `restoreResult {ok, code, message}` (`ok`, `not_found`, `bad_email`, `rate_limited`, `unreachable`); the modal shows "Checking…" until it
   arrives and stays open on failures. 5 tries per minute per connection (and a server-wide cap).
4. **Re-checks** (no webhook, so this is how cancellations are noticed): a Stripe-backed Premium last verified more than `stripeRecheckMs`
   (24 h, `src/config.ts`) ago is re-verified against Stripe at the next gated action (private table, bracket, tournament) and when the player
   reconnects. Cancelled, past due, unpaid or incomplete locks it. If Stripe cannot be reached the old state is kept for `stripeGraceMs`
   (7 days) after the last good verification, then it locks. Owner unlocks never expire. Premium is stored against the browser token in
   `data/subscriptions.json` (git-ignored; it holds buyer emails and Stripe customer ids, so keep that file private).

**Verified vs not verified.** Verified by Stripe: that a Checkout Session exists, was paid, is a subscription on our price, and that the
subscription is active. Not verified: who is typing an email into Restore Premium. **Email-only restore is unverified: anyone who knows a
subscriber's (or an owner's) email can unlock Premium on their own browser.** `OWNER_EMAILS` is the same stopgap for the owner. The proper
upgrade is to email a one-time code to that address and require it. Other limits: cancellations are seen only by the periodic re-check
(there is no webhook), Stripe Customer Search can lag up to about a minute and the list filter is case-sensitive (earlier purchases are
also found through the local email index), and one subscription can be restored on any number of devices.

**Render setup.** In the service's Environment tab add `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `OWNER_EMAILS`, and `PUBLIC_BASE_URL`
(your https URL). Do not set `DEV_UNLOCK` in production. Create the product and the $1.99/month recurring price in the Stripe Dashboard
and copy the price id. Use a restricted key limited to Checkout Sessions (write), Customers (read) and Subscriptions (read) if you can.

**Test it safely.** First use a Stripe **test-mode** secret key (`sk_test_...`) and a test-mode price, and pay with the test card
`4242 4242 4242 4242`. Only switch to live keys after the whole flow works (go premium, return, restore on a second browser, cancel in the
Dashboard and wait for the re-check). The automated tests and `npm run e2e:prod` use a local mock of Stripe and never call the real API.

**Owner-only stopgap** (before any Stripe setup): set `OWNER_EMAILS` and use "Restore Premium / I'm the owner".

**Dev only:** with `DEV_UNLOCK=1` the menu shows **Dev: toggle Premium**, the lobby shows **Dev: toggle subscription**, the WebSocket message
`devToggleSubscription` works, and `POST /dev/subscription` with `{"token": "<32 hex>", "active": true}` flips a flag. Without `DEV_UNLOCK`
the message returns `not_allowed` and the endpoint returns 404. With `DEV_UNLOCK=1` and no Stripe keys, Go Premium and Restore Premium just flip
the flag (nothing is verified, no payment).

## Cover screen

Opening the game shows a full-screen cover first: the photo `public/cover.jpg` (about 240 KB, `object-fit: cover` around the man in black, fading to
black at the top and bottom), the title "Blackcity Spades", "Spades with friends" and a large **Play** button (focused, so Enter works). Play reveals the
normal home screen.

- Shown once per browser tab (a `sessionStorage` flag), so a reload does not show it again. `?cover=1` forces it for testing.
- Not shown when you are resuming a table, tournament or event (the client hides it as soon as the server sends one), or when the link has a purpose
  (`?code=...` invite, or the return from Stripe Checkout).
- Logic: `public/cover-rules.js` (tested in `test/cover.test.ts`). Safe-area insets are respected and the entrance animation is off with reduced motion.
  To swap the picture, replace `public/cover.jpg` (landscape, about 16:9, empty dark space in the top fifth for the title).

## Back, Return to game and Leave

Going back and leaving are two different things, so you can go back and forth in the same game:

- **Back** (the host's button in the bar under the hand, the host lobby's "‹ Back" and its X, and the organizer's "‹ Back" in the bracket / tournament
  view) only changes your screen. It sends nothing to the server and asks nothing: you stay seated and connected, the game goes on, and you are still
  the host / organizer. It takes you to the home screen.
- **Return to game** is a prominent gold button at the top of the home screen (also at the top of Play Online, and the first item in the menu) while you
  are in a table, a tournament or an event. It shows where things stand ("Your turn", "Hand 3", "Waiting to start", "Tournament · in play", plus
  "· N new messages") and takes you straight back to the same table or bracket with the current state.
- **Leave** is the menu's **Leave table** / **Leave tournament** (and the bracket view's "Leave tournament" button). It asks first when it affects
  other people, then really leaves. The texts are in `public/leave-rules.js` (unit tested) and the server rules are unchanged:
  - Other people seated: "Leave this table? *Name* becomes the host and the table stays open for them." (before the start) or "Leave this table? A bot
    takes your seat and *Name* becomes the host. The game goes on for the others." (mid-game). The host passes to the first connected human in seat order.
  - Host is the only person playing: "Leave this table? You are the only person playing, so this game ends and the table closes." (adds the number of
    people watching; watchers are sent back with "The table closed"). A practice game says "Your practice game will end."
  - An organizer leaving a tournament before the start cancels it for everyone who joined; once it runs a bot takes the organizer's place.

How it works: Back is client-only. The server keeps sending `table` / `tournament` / `event` updates and chat to a seated player no matter which screen
they are looking at, and the client keeps the latest state, so Return to game needs nothing from the server. A new table (for example the next
tournament round) opens by itself even when you are on the home screen. Others at the table, and watchers, see no difference.

Things to know:

- There is no turn timer for connected players. If you are away on your turn the table waits for you (the others can chat, but the hand does not move).
  The idle rules only apply to people who disconnect (closed tab, lost connection): a bot plays for them at once, a tournament forfeits after
  `abandonMs`, a free seat can be released to a waiter after `seatHoldMs`, and an empty table closes after `emptyTableTtlMs`. Leave your table first if you
  want to play Practice or join another one (Practice / Play Online on the home screen say "Leave your current table first").
- Reloading the page resumes you with your saved token: the server sends the table again with your seat, host role and chat history, and you land
  on the table. Return to game is only needed within one page load.

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

## Table chat

Every table (including bracket and tournament tables) has a live chat that seated players **and spectators** can read and post to.
Spectators still never receive hands; chat carries only names and text. The server is authoritative:

- Client `{t: "chat", text}`; the server broadcasts `{t: "chatMsg", table, from, role: "player" | "watcher", text, ts, mine}` to everyone at that table.
- **A display name is required** to post (`name_required`); you must be seated at or watching a table (`not_seated`).
- Text is trimmed, whitespace (including newlines) collapsed, control and zero-width characters removed, and cut to **200 characters**. An empty message is rejected.
  The client shows it with `textContent` only, so markup is just text. There is no profanity filter.
- **Rate limit: 5 messages per 10 seconds per connection.** Over that you get a friendly "Slow down" notice and the message is dropped.
- The **last 50 messages** per table are kept in memory and sent (`chatHistory {table, msgs}`) to anyone who joins, watches or reconnects.
  Nothing is written to disk: history is cleared when the table is destroyed and lost on a server restart. Limits live in `CONFIG.chat` (`src/config.ts`).
- UI: a **Chat** button (with an unread badge) in the bar under the hand opens a bottom sheet on phones and a right-hand drawer on wide screens.
  Watcher messages carry a "watcher" tag and a blue dashed style; your own messages are gold and right-aligned. Enter sends. The table makes
  room for the sheet instead of sitting under it, so the hand and the bid buttons stay visible (checked at 390x844 and 360x740); the X or Escape closes it.

## Table music

An optional soft lounge / jazz-ish background loop (slow chords, warm pad, electric-piano pulses, a gentle bass, brush-like noise).
It is **generated in the browser with the Web Audio API: there are no audio files and nothing is downloaded** (`public/music.js`; the chord chart and
saved settings are in `public/music-state.js`).

- A speaker button in the bar under the hand turns it on or off; when on, a volume slider appears. **Default is off**, and it starts only when you tap.
- On/off and volume are remembered in `localStorage` under `spades_music` (with the usual `_slot` suffix for `?slot=`). Browsers block sound until the page gets a tap,
  so a saved "on" begins at your first tap after a reload.
- Fades in and out (about 1.5 s), then ends every note and suspends the audio context, so nothing keeps running. It pauses while the tab is hidden and resumes when you are back.

## Rules implemented

- 52 cards, spades are trump, seats 0=N 1=E 2=S 3=W clockwise, partners 0&2 and 1&3. Dealer rotates; the player left of the dealer bids and leads first.
- **Bids: regular spades is 1 to 13 books plus Nil** (`CONFIG.rules.minBid` / `maxBid` / `allowNil` in `src/config.ts`; the server rejects anything else and the bid panel only offers valid bids). **On a table hosted by a Premium customer (and in their tournaments) there is a team minimum:** the two partners' bids must add up to at least 4 (`CONFIG.rules.premiumTeamMin`, 0 turns it off). Either partner can bid 1, 2 or 3 as long as the pair reaches 4; the partner who bids second can't go below what is needed (after a partner's 1 the bid is 3 or more, after a Nil it is 4 or more, and Nil is only open when the partner has already bid 4). Free Play now (random match) tables use regular spades with no minimum. No forced bid, no blind nil. Bots follow the same rules. Must follow suit. **Break rule** (table setting, default on): spades cannot be led until a spade has been played (or the leader holds only spades); off = spades may lead any time.
- Score: 10 per bid trick made by the team (partners' bids combine), +1 per extra trick (bag), 10 bags = -100 and bags drop by 10.
  **Sandbags** (table setting, default on): off = no bag points, no bag counting, no penalty (contract and nil still score).
  Nil: +100 if made, -100 if failed. A nil bidder's tricks never count toward the team's bid; if the nil fails, those tricks count as bags.
  If a team's bid is not met it loses 10 per bid trick.
- Game ends at the target (500 default, 250 option; table setting) or at -200 (that team loses immediately). If both teams reach the target in the same hand,
  the higher score wins. If scores are exactly equal, more hands are played until one team is ahead.
- Tournaments: free to watch, and free to join with a Premium host's code; 4, 8 or 16 teams; random seeding; single elimination; matches go to **250**, the **final to 500**
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

One page, no framework; the felt table is always on screen and everything else is a layer over it: the **home card** (a single Play now button, Go Premium / Restore Premium, Host a Tournament, Rules), the **Play Online** modal (display name, profile
photo, six tiles for Premium: Join Table, Watch Table, Join Tournament, Create Table, Create Tournament, Create Bracket; free users get Watch a game, Join with a code and an upgrade card), the **host lobby** modal
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

- Client to server: `hello {nick, token?}` (an empty nick keeps a returning player's name; a new player has none), `setNick {nick}`, `createTable {isPublic, target, breakRule?, sandbags?, practice?}`,
  `setRules {target?, breakRule?, sandbags?}` (host, before start), `addBots` and `swapPartners` (host, before start; swap rotates the three non-host seats), `joinTable {id}`, `joinCode {code}`, `watchTable {id}`,
  `watchCode {code}`, `quickPlay`, `cancelMatch`, `startTable`, `bid {bid}`, `play {card}`, `ready`, `rematch`, `leaveTable`,
  `createTournament {size, isPublic}`, `joinTournament {id}`, `watchTournament {id}`, `startTournament`, `leaveTournament`,
  `createEvent {tables 1-8, target?}`, `startEvent`, `leaveEvent`, `chat {text}`, `goPremium`, `confirmPremium {sessionId}`, `restorePremium {email}`, `devToggleSubscription`, `ping`. Cards are two characters, rank + suit, such as `AS`, `TH`, `2C`.
- Server to client: `welcome {token, id, nick, subscribed, config}`, `lobby {tables, tournaments}`, `table {...}` (a full snapshot for you: your
  hand and legal cards if you are seated; includes `rules {target, breakRule, sandbags}`, `hostSeat`, and `collect {plays, winner}` for the finished trick shown for `trickPauseMs`), `tournament {...}` (bracket), `event {...}` (multi-table tournament), `chatMsg {table, from, role, text, ts, mine}`, `chatHistory {table, msgs}`, `matching {active, waiting, size, remainingMs, waitMs}`, `left`, `tournamentLeft`, `eventLeft`, `notice {kind, message}`, `nick`, `subscription {subscribed}`, `checkout {url}`, `premiumResult {ok, code, message}`, `restoreResult {ok, code, message}`, `error {code, message}`, `pong`.
- Error codes: `bad_message`, `rate_limited`, `not_hello`, `upgrade_required`, `not_found`, `not_allowed`, `illegal`, `full`, `busy`,
  `too_many`, `not_seated`, `wrong_state`, `name_required`.
- Nicknames are sanitized on the server (length 16, control characters and `< > & " ' \`` removed; may end up empty, there is no default); the client renders all text with `textContent`.

## File layout

```
src/config.ts            business + game settings (price, targets, limits, timings)
src/engine/cards.ts      deck, seeded RNG, shuffle
src/engine/game.ts       rules: bidding, play validation, tricks, scoring, game end
src/engine/bot.ts        heuristic bidder and legal-only play
src/engine/sim.ts        instant bot-vs-bot games
src/server/index.ts      entry point (PORT, DEV_UNLOCK, Stripe / OWNER_EMAILS env)
src/server/server.ts     HTTP + WebSocket server, dev endpoint
src/server/static.ts     static files + security headers
src/server/hub.ts        players, lobby, routing, free/paid checks
src/server/table.ts      one table: seats, bots, timers, spectators, views
src/server/tournament.ts brackets, seeding, simulation, advancement
src/server/event.ts      multi-table tournament ("Create Tournament", 1-8 tables)
src/server/protocol.ts   message validation, nickname sanitizing, rate limiter
src/server/subscriptions.ts  subscription store (Premium records, Stripe ids, session claims)
src/server/billing.ts    Stripe Checkout, verification, restore, re-check (plain fetch, no webhook)
public/index.html, style.css, app.js   the single-page client
public/fonts/            self-hosted DM Sans and Archivo (SIL OFL, each with OFL.txt)
public/cards.js          card frame, corner indexes, pips, card back
public/court-art.js      the 12 J/Q/K characters (swappable)
public/music.js, music-state.js  table music (Web Audio, no files) and its saved settings / chord chart
public/svg.js            SVG helper; public/cards.html + gallery.js: card gallery page (/cards.html)
test/*.test.ts           engine, server, tournament, billing, chat, invite-only play and music-settings tests
scripts/e2e.ts, scripts/e2e-prod.ts, scripts/screenshots.ts
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

## Bot faces and bot chat

- Bots get names from `BOT_NAMES` (street-style nicknames) in `src/server/table.ts`. Most bots (about 65%) come with a picture from `public/faces/<id>.jpg` (`FACE_BOTS`): portraits plus cars, graphics, pets and cartoon avatars,
  and the owner's own "Raw 1" bot (`RAW_ONE`, `public/faces/raw1.jpg`) joins about half of the bot-filled tables (`CONFIG.botFaces`). The table view carries
  `face` for bot seats only; the client shows the photo, or the first letter of the name when a bot has none.
- Bots talk in the table chat (`src/server/botchat.ts`): hellos, short back-and-forth conversations between two bots, reactions to big bids, Nil, tricks,
  sets and the final score, and replies when a person writes. Speed comes from `CONFIG.timing.botChatPace` (1 = normal, 0 = silent; tests use 0).
  If asked whether they are bots they joke and change the subject; they never claim to be human.
- Personalities (`CONFIG.botPersonality`, picked when a bot sits down, never sent to clients): about a third of bots are trash talkers
  (`chatStyle: 'trash'`) who also use the clean card-table smack in `TRASH_LINES` (taunts on sets, Nil busts, big bids and tricks, light roasting);
  the rest stay chill. About a third are strong players (`skill: 'strong'` in `src/engine/bot.ts`): they remember every card played this hand
  (`GameState.played`), read voids, never overtake a partner who already has the trick, duck under an opponent's Nil, shed high cards when their own
  Nil is in danger, avoid bags once the bid is made and bid Nil a bit more often on weak hands. `npx tsx scripts/sim-strong.ts 1000 500` plays
  strong vs normal teams (sides swapped every game); strong won about 60%. Tournament bot-only matches and bots covering for people play normally.

## Bidding rule for Premium hosts

Premium hosts pick the bidding rule: **Team min 4** (default; partners must bid at least `CONFIG.rules.premiumTeamMin` together) or **Regular bidding**
(no minimum). Clients send `teamMin4` (boolean, missing = true) on `createTable`, `createTournament` and `createEvent`; a hosted table's host can also
flip it with `setRules { teamMin4 }` in the table lobby before the game starts. Tournament and event tables all use the organizer's choice, and their
views carry `teamMin` for the label. Free Play now (quick) and practice tables always use regular bidding; Premium "Quick play at a public table" is unchanged (team min 4).
