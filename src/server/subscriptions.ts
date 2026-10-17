// Subscription store: remembers which host ids have Premium and why. In memory, with optional JSON-file persistence
// (data/subscriptions.json, gitignored). Keyed by the player id (a hash of their browser token), so Premium survives reconnects.
//
// Records come in two kinds:
//   - 'stripe': bought through Checkout or restored from a Stripe subscription. Carries the customer/subscription ids and the
//     time it was last verified against Stripe, so the hub can re-check it (cancellations are only noticed by re-checking).
//   - 'owner' / 'dev': OWNER_EMAILS restore, DEV_UNLOCK toggle, or an older file. These never expire.
// Also kept: which host first claimed each verified Checkout session id (replay guard) and email -> Stripe customer ids.

import fs from 'node:fs';
import path from 'node:path';

export type PremiumSource = 'stripe' | 'owner' | 'dev';

export interface PremiumRecord {
  source: PremiumSource;
  email?: string;
  customerId?: string;
  subscriptionId?: string;
  /** ms since epoch of the last successful verification against Stripe (stripe records only). */
  verifiedAt?: number;
}

export class SubscriptionStore {
  private hosts = new Map<string, PremiumRecord>();
  private sessions = new Map<string, string>(); // checkout session id -> host id that claimed it
  private emails = new Map<string, Set<string>>(); // lowercased email -> stripe customer ids

  constructor(private file: string | null = null) {
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(data.active)) for (const id of data.active) if (typeof id === 'string') this.hosts.set(id, { source: 'dev' }); // v1 file
        if (data.hosts && typeof data.hosts === 'object') {
          for (const [id, r] of Object.entries<any>(data.hosts)) {
            if (r && (r.source === 'stripe' || r.source === 'owner' || r.source === 'dev')) this.hosts.set(id, r as PremiumRecord);
          }
        }
        if (data.sessions && typeof data.sessions === 'object') for (const [k, v] of Object.entries<any>(data.sessions)) if (typeof v === 'string') this.sessions.set(k, v);
        if (data.emails && typeof data.emails === 'object') {
          for (const [k, v] of Object.entries<any>(data.emails)) if (Array.isArray(v)) this.emails.set(k, new Set(v.filter((x) => typeof x === 'string')));
        }
      } catch { /* a corrupt file just means nobody is subscribed */ }
    }
  }

  isSubscribed(hostId: string): boolean { return this.hosts.has(hostId); }
  get(hostId: string): PremiumRecord | undefined { return this.hosts.get(hostId); }

  /** Owner / dev unlock (no expiry), or lock (on=false). */
  set(hostId: string, on: boolean, source: 'owner' | 'dev' = 'dev'): void {
    if (on) { if (source === 'owner' || this.hosts.get(hostId)?.source !== 'stripe') this.hosts.set(hostId, { source }); } else this.hosts.delete(hostId);
    this.save();
  }

  toggle(hostId: string): boolean {
    this.set(hostId, !this.isSubscribed(hostId));
    return this.isSubscribed(hostId);
  }

  /** Record a Stripe-verified subscription for this host and index the email -> customer. */
  setStripe(hostId: string, rec: { email: string; customerId: string; subscriptionId: string }, now = Date.now()): void {
    this.hosts.set(hostId, { source: 'stripe', email: rec.email, customerId: rec.customerId, subscriptionId: rec.subscriptionId, verifiedAt: now });
    if (rec.email) {
      const set = this.emails.get(rec.email) ?? new Set<string>();
      set.add(rec.customerId);
      this.emails.set(rec.email, set);
    }
    this.save();
  }

  markVerified(hostId: string, now = Date.now()): void {
    const r = this.hosts.get(hostId);
    if (r && r.source === 'stripe') { r.verifiedAt = now; this.save(); }
  }

  /** Bind a verified Checkout session to the first host that claims it. Returns the host that owns the binding. */
  claimSession(sessionId: string, hostId: string): string {
    const owner = this.sessions.get(sessionId);
    if (owner) return owner;
    this.sessions.set(sessionId, hostId);
    this.save();
    return hostId;
  }

  customersForEmail(email: string): string[] { return [...(this.emails.get(email.trim().toLowerCase()) ?? [])]; }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({
      version: 2,
      hosts: Object.fromEntries(this.hosts),
      sessions: Object.fromEntries(this.sessions),
      emails: Object.fromEntries([...this.emails].map(([k, v]) => [k, [...v]])),
    }, null, 2));
  }
}
