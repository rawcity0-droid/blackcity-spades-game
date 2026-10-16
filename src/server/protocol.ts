// WebSocket JSON protocol: message shapes, validation and nickname sanitizing.
// Every client message is {t: "<type>", ...fields}. Every server message is {t: "<type>", ...fields}.

import { CONFIG } from '../config.js';
import { isCard } from '../engine/cards.js';

export type ClientMsg =
  | { t: 'hello'; nick: string; token?: string }
  | { t: 'ping' }
  | { t: 'createTable'; isPublic: boolean; target: number }
  | { t: 'joinTable'; id: string }
  | { t: 'watchTable'; id: string }
  | { t: 'joinCode'; code: string }
  | { t: 'watchCode'; code: string }
  | { t: 'quickPlay' }
  | { t: 'startTable' }
  | { t: 'bid'; bid: number }
  | { t: 'play'; card: string }
  | { t: 'ready' }
  | { t: 'rematch' }
  | { t: 'leaveTable' }
  | { t: 'createTournament'; size: number; isPublic: boolean }
  | { t: 'joinTournament'; id: string }
  | { t: 'watchTournament'; id: string }
  | { t: 'startTournament' }
  | { t: 'leaveTournament' }
  | { t: 'devToggleSubscription' };

export type ErrorCode =
  | 'bad_message' | 'rate_limited' | 'not_hello' | 'upgrade_required' | 'not_found' | 'not_allowed'
  | 'illegal' | 'full' | 'busy' | 'too_many' | 'not_seated' | 'wrong_state';

export const ID_RE = /^[a-f0-9]{8}$/;
export const CODE_RE = /^[A-Z0-9]{5}$/;
export const TOKEN_RE = /^[a-f0-9]{32}$/;

/** Strip control characters and angle brackets, collapse spaces, cap the length. Clients also use textContent. */
export function sanitizeNick(raw: unknown): string {
  let s = typeof raw === 'string' ? raw : '';
  s = s.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff<>&"'`\\]/g, '');
  s = s.replace(/\s+/g, ' ').trim().slice(0, CONFIG.limits.maxNickLength).trim();
  return s || 'Player' + Math.floor(1000 + Math.random() * 9000);
}

const str = (v: unknown): v is string => typeof v === 'string';

/** Parse and validate one raw message. Returns the typed message or an error string. */
export function parseClientMessage(raw: string): { msg: ClientMsg } | { error: string } {
  if (raw.length > CONFIG.limits.maxPayloadBytes) return { error: 'Message too large' };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { error: 'Invalid JSON' }; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'Message must be an object' };
  const o = v as Record<string, unknown>;
  const bad = (m: string) => ({ error: m });
  switch (o.t) {
    case 'hello':
      if (o.token !== undefined && !(str(o.token) && TOKEN_RE.test(o.token))) return bad('Bad token');
      return { msg: { t: 'hello', nick: sanitizeNick(o.nick), token: o.token as string | undefined } };
    case 'ping': case 'quickPlay': case 'startTable': case 'ready': case 'rematch': case 'leaveTable':
    case 'startTournament': case 'leaveTournament': case 'devToggleSubscription':
      return { msg: { t: o.t } as ClientMsg };
    case 'createTable':
      if (typeof o.isPublic !== 'boolean') return bad('isPublic must be boolean');
      if (!(CONFIG.tableTargets as readonly number[]).includes(o.target as number)) return bad('Bad target score');
      return { msg: { t: 'createTable', isPublic: o.isPublic, target: o.target as number } };
    case 'joinTable': case 'watchTable': case 'joinTournament': case 'watchTournament':
      if (!(str(o.id) && ID_RE.test(o.id))) return bad('Bad id');
      return { msg: { t: o.t, id: o.id } as ClientMsg };
    case 'joinCode': case 'watchCode': {
      const code = str(o.code) ? o.code.trim().toUpperCase() : '';
      if (!CODE_RE.test(code)) return bad('Codes are 5 letters/numbers');
      return { msg: { t: o.t, code } as ClientMsg };
    }
    case 'bid':
      if (!Number.isInteger(o.bid) || (o.bid as number) < 0 || (o.bid as number) > 13) return bad('Bid must be 0-13');
      return { msg: { t: 'bid', bid: o.bid as number } };
    case 'play':
      if (!isCard(o.card)) return bad('Bad card');
      return { msg: { t: 'play', card: o.card } };
    case 'createTournament':
      if (!(CONFIG.tournamentSizes as readonly number[]).includes(o.size as number)) return bad('Bad bracket size');
      if (typeof o.isPublic !== 'boolean') return bad('isPublic must be boolean');
      return { msg: { t: 'createTournament', size: o.size as number, isPublic: o.isPublic } };
    default:
      return bad('Unknown message type');
  }
}

/** Token bucket: `burst` messages at once, refilled at `perSecond`. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  constructor(private burst = 30, private perSecond = 15) { this.tokens = burst; }
  allow(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
