// Subscription store (STUB for payments): remembers which host ids have the paid "host" flag.
// In memory, with optional JSON-file persistence (data/subscriptions.json, gitignored).
// A real billing integration (see billing.ts) would call set() from its webhook handler.

import fs from 'node:fs';
import path from 'node:path';

export class SubscriptionStore {
  private active = new Set<string>();

  constructor(private file: string | null = null) {
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(data.active)) for (const id of data.active) if (typeof id === 'string') this.active.add(id);
      } catch { /* a corrupt file just means nobody is subscribed */ }
    }
  }

  isSubscribed(hostId: string): boolean {
    return this.active.has(hostId);
  }

  set(hostId: string, on: boolean): void {
    if (on) this.active.add(hostId); else this.active.delete(hostId);
    this.save();
  }

  toggle(hostId: string): boolean {
    this.set(hostId, !this.isSubscribed(hostId));
    return this.isSubscribed(hostId);
  }

  private save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ active: [...this.active] }, null, 2));
  }
}
