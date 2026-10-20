// Activity log: one line per event on stdout, `[activity] {json}`, so usage can be counted from the Render logs.
// Never includes tokens, player ids, emails or Stripe ids. The only personal detail is a nickname's test flag.

export const ACTIVITY_PREFIX = '[activity]';

/** Health checks and live tests use nicknames like LiveCheck1 / HealthCheck / Health-3. */
export function isTestNick(nick: string | null | undefined): boolean {
  return !!nick && /^(LiveCheck|HealthCheck|Health)/i.test(nick.trim());
}

export function logActivity(ev: string, fields: Record<string, unknown> = {}): void {
  const line: Record<string, unknown> = { ev, ...fields, at: new Date().toISOString() };
  if (line.test !== true) delete line.test; // only present when true
  console.log(`${ACTIVITY_PREFIX} ${JSON.stringify(line)}`);
}
