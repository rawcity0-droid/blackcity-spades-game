// Entry point: `npm start`. PORT from env (default 3000). DEV_UNLOCK=1 enables the dev subscription toggle.
// OWNER_EMAILS=first@example.test,second@example.test (comma-separated) lets those emails unlock Premium via Restore Premium (stopgap, unverified).
// SPADES_FAST=1 (dev/testing only) shortens all game pauses.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';
import { Billing } from './billing.js';
import { startServer } from './server.js';
import { SubscriptionStore } from './subscriptions.js';

const port = Number(process.env.PORT ?? 3000);
const devUnlock = process.env.DEV_UNLOCK === '1';
const dataFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/subscriptions.json');

// SPADES_FAST=1 removes the human-friendly pauses (used by the scripted end-to-end check)
const timings = process.env.SPADES_FAST === '1' ? { botDelayMs: 15, trickPauseMs: 0, handPauseMs: 0, matchEndPauseMs: 300, matchWaitMs: 800, botChatPace: 0 } : undefined;
const billing = Billing.fromEnv(); // STRIPE_SECRET_KEY + STRIPE_PRICE_ID (env only)
const running = await startServer({ port, devUnlock, billing, store: new SubscriptionStore(dataFile), timings });
console.log(`Stripe billing: ${billing.enabled ? 'enabled' : 'not configured (Go Premium shows "not set up yet")'}`);
console.log(`Owner emails configured: ${CONFIG.ownerEmails.length} (OWNER_EMAILS)`);
console.log(`Blackcity Spades listening on http://localhost:${running.port}${devUnlock ? '  (DEV_UNLOCK on)' : ''}`);

const stop = () => { running.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
