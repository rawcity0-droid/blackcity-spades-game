# Blackcity Spades — one-page plan (v1)

## Goal
Browser Spades, phone-friendly, no install, anyone can join from anywhere. 4-player partnership Spades, bots fill empty seats, a lobby, and tournament mode with a bracket.

## Stack (kept small on purpose)
- Server: Node.js + TypeScript, plain HTTP plus the `ws` WebSocket library. One process, game state held in memory. The server is the single source of truth (clients never see other hands).
- Client: static HTML/CSS + small TypeScript bundle (no framework needed for v1). Mobile-first layout, tap-to-play cards, cards drawn with CSS/SVG (no licensed art).
- Shared game engine module (rules, scoring, bot) used by the server and by unit tests.
- Tests: Node's built-in test runner for rules/scoring/bot legality.

## Hosting (free or cheapest)
- v1 runs locally with `npm start`, so there's zero hosting cost while we build.
- To go public, the simplest fit is any free Node web service host (e.g., Render's free tier) because the app is one process serving both the site and WebSockets. Free tiers usually sleep after inactivity and reset memory on restart, so the first visit can be slow. I haven't verified current free-tier limits; check them before choosing.
- Alternative later if we need always-on: a small paid VPS (a few dollars a month), or Cloudflare Workers + Durable Objects (needs a rewrite of the server layer).

## Multiplayer approach
- WebSocket per player. Table = 4 seats (N/S vs E/W). Players join with a nickname (no accounts in v1); a reconnect token in localStorage lets them rejoin their seat after a refresh.
- Server validates every action (turn order, follow suit, spades-broken rule, bid limits).
- Empty or dropped seats are filled by bots (simple heuristic bot: bids from hand strength, follows suit legally, wins cheaply, protects partner's bid). A human can take over a bot seat at the start of the next hand.
- Lobby: list of open tables, create table (private link code or public), quick-play (join any table with an empty seat).

## Rules in v1 (standard partnership Spades)
- 52 cards, spades are trump, bidding 0–13 per player, partners' bids combine.
- Nil (bid 0) +100 / -100. Blind nil not in v1.
- Score: 10 per bid trick, 1 per bag; 10 bags = -100. Game to 500 (table option 250 for short games). Lose at -200.
- Spades can't lead until broken (or a hand of only spades).

## Tournament mode (v1)
- Single-elimination bracket of 4, 8 or 16 teams. A team is 2 seats; a solo joiner is paired with another solo or a bot partner.
- Each match = one Spades game to 250 (shorter so rounds move). Bracket page shows rounds, live status, and winners advance automatically.
- Organizer creates a tournament with a join code; unfilled team slots are filled by bot teams at start time. Bot-vs-bot matches are simulated instantly so the bracket isn't stuck.

## First playable version includes
1. Complete engine + tests (rules, scoring, bags, nil).
2. Bot players.
3. Lobby, table, phone-friendly play screen, reconnect.
4. Tournament create/join, bracket view, auto-advance.
Not in v1: accounts, rankings, chat, blind nil, persistence across server restarts, payments/ads.

## Cost and usage
- Build: one focused build pass, no background jobs or watchers. Hosting: $0 to start.
- Open decisions for Raw: game name/branding, 500 vs 250 default, and when to pay for always-on hosting.

## Build order (Step 2)
engine + tests → bot → server/WebSocket → client table → lobby → tournament → local playtest with 4 browser tabs.
