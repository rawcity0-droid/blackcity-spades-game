// WebSocket JSON protocol: message shapes, validation and nickname sanitizing.
// Every client message is {t: "<type>", ...fields}. Every server message is {t: "<type>", ...fields}.

import { CONFIG } from '../config.js';
import { isCard } from '../engine/cards.js';

export type ClientMsg =
  | { t: 'hello'; nick: string; token?: string }
  | { t: 'ping' }
  | { t: 'setNick'; nick: string }
  | { t: 'createTable'; isPublic: boolean; target: number; breakRule?: boolean; sandbags?: boolean; practice?: boolean; teamMin4?: boolean; jokers?: boolean }
  | { t: 'setRules'; target?: number; breakRule?: boolean; sandbags?: boolean; teamMin4?: boolean; jokers?: boolean }
  | { t: 'addBots' }
  | { t: 'swapPartners' }
  | { t: 'joinTable'; id: string }
  | { t: 'watchTable'; id: string }
  | { t: 'joinCode'; code: string }
  | { t: 'watchCode'; code: string }
  | { t: 'quickPlay' }
  | { t: 'createFriend' }
  | { t: 'cancelMatch' }
  | { t: 'startTable' }
  | { t: 'bid'; bid: number }
  | { t: 'play'; card: string }
  | { t: 'ready' }
  | { t: 'rematch' }
  | { t: 'leaveTable' }
  | { t: 'createTournament'; size: number; isPublic: boolean; teamMin4?: boolean; jokers?: boolean }
  | { t: 'joinTournament'; id: string }
  | { t: 'watchTournament'; id: string }
  | { t: 'startTournament' }
  | { t: 'leaveTournament' }
  | { t: 'createEvent'; tables: number; target?: number; teamMin4?: boolean; jokers?: boolean }
  | { t: 'startEvent' }
  | { t: 'leaveEvent' }
  | { t: 'goPremium' }
  | { t: 'restorePremium'; email: string }
  | { t: 'ownerCode'; code: string }
  | { t: 'confirmPremium'; sessionId: string }
  | { t: 'chat'; text: string }
  | { t: 'devToggleSubscription' };

export type ErrorCode =
  | 'bad_message' | 'rate_limited' | 'not_hello' | 'upgrade_required' | 'not_found' | 'not_allowed'
  | 'illegal' | 'full' | 'busy' | 'too_many' | 'not_seated' | 'wrong_state' | 'name_required';

export const ID_RE = /^[a-f0-9]{8}$/;
/** Join codes: CODE_LENGTH characters from CODE_ALPHABET (no 0, O, 1, I, L). Entry is case-insensitive. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = new RegExp('^[A-Z0-9]{' + CONFIG.codeLength + '}$');
export const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>]{2,24}$/;
export const TOKEN_RE = /^[a-f0-9]{32}$/;

/** Strip control characters and markup characters, collapse spaces, cap the length. Returns '' when nothing is left:
 *  there is never a default or generated name. Clients also use textContent. */
export function sanitizeNick(raw: unknown): string {
  let s = typeof raw === 'string' ? raw : '';
  s = s.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff<>&"'`\\]/g, '');
  s = s.replace(/\s+/g, ' ').trim().slice(0, CONFIG.limits.maxNickLength).trim();
  return s;
}

/** Chat text: control / invisible-direction characters become spaces, whitespace collapses, trimmed, capped. May return ''. */
export function sanitizeChat(raw: unknown): string {
  let s = typeof raw === 'string' ? raw : '';
  s = s.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, ' ');
  return Array.from(s.replace(/\s+/g, ' ').trim()).slice(0, CONFIG.chat.maxChars).join('').trim();
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
      // An empty nick means "no name": a returning player keeps their saved name, a new one has none (no default is ever assigned)
      return { msg: { t: 'hello', nick: sanitizeNick(o.nick), token: o.token as string | undefined } };
    case 'ping': case 'quickPlay': case 'createFriend': case 'cancelMatch': case 'startTable': case 'ready': case 'rematch': case 'leaveTable':
    case 'startTournament': case 'leaveTournament': case 'devToggleSubscription':
    case 'addBots': case 'swapPartners': case 'startEvent': case 'leaveEvent': case 'goPremium':
      return { msg: { t: o.t } as ClientMsg };
    case 'createTable':
      if (typeof o.isPublic !== 'boolean') return bad('isPublic must be boolean');
      if (!(CONFIG.tableTargets as readonly number[]).includes(o.target as number)) return bad('Bad target score');
      if (o.breakRule !== undefined && typeof o.breakRule !== 'boolean') return bad('breakRule must be boolean');
      if (o.sandbags !== undefined && typeof o.sandbags !== 'boolean') return bad('sandbags must be boolean');
      if (o.practice !== undefined && typeof o.practice !== 'boolean') return bad('practice must be boolean');
      if (o.teamMin4 !== undefined && typeof o.teamMin4 !== 'boolean') return bad('teamMin4 must be boolean');
      if (o.jokers !== undefined && typeof o.jokers !== 'boolean') return bad('jokers must be boolean');
      return { msg: { t: 'createTable', isPublic: o.isPublic, target: o.target as number,
        breakRule: o.breakRule as boolean | undefined, sandbags: o.sandbags as boolean | undefined, practice: o.practice as boolean | undefined, teamMin4: o.teamMin4 as boolean | undefined, jokers: o.jokers as boolean | undefined } };
    case 'setNick':
      return { msg: { t: 'setNick', nick: sanitizeNick(o.nick) } };
    case 'setRules':
      if (o.target !== undefined && !(CONFIG.tableTargets as readonly number[]).includes(o.target as number)) return bad('Bad target score');
      if (o.breakRule !== undefined && typeof o.breakRule !== 'boolean') return bad('breakRule must be boolean');
      if (o.sandbags !== undefined && typeof o.sandbags !== 'boolean') return bad('sandbags must be boolean');
      if (o.teamMin4 !== undefined && typeof o.teamMin4 !== 'boolean') return bad('teamMin4 must be boolean');
      if (o.jokers !== undefined && typeof o.jokers !== 'boolean') return bad('jokers must be boolean');
      return { msg: { t: 'setRules', target: o.target as number | undefined,
        breakRule: o.breakRule as boolean | undefined, sandbags: o.sandbags as boolean | undefined, teamMin4: o.teamMin4 as boolean | undefined, jokers: o.jokers as boolean | undefined } };
    case 'createEvent':
      if (!(CONFIG.eventTableOptions as readonly number[]).includes(o.tables as number)) return bad('Choose 1 to 8 tables');
      if (o.target !== undefined && !(CONFIG.tableTargets as readonly number[]).includes(o.target as number)) return bad('Bad target score');
      if (o.teamMin4 !== undefined && typeof o.teamMin4 !== 'boolean') return bad('teamMin4 must be boolean');
      if (o.jokers !== undefined && typeof o.jokers !== 'boolean') return bad('jokers must be boolean');
      return { msg: { t: 'createEvent', tables: o.tables as number, target: o.target as number | undefined, teamMin4: o.teamMin4 as boolean | undefined, jokers: o.jokers as boolean | undefined } };
    case 'chat': {
      if (!str(o.text)) return bad('Message must be text');
      const text = sanitizeChat(o.text);
      if (!text) return bad('Type a message first');
      return { msg: { t: 'chat', text } };
    }
    case 'confirmPremium': // validated by the hub, which answers every attempt with exactly one premiumResult
      return { msg: { t: 'confirmPremium', sessionId: str(o.sessionId) ? o.sessionId.trim().slice(0, 300) : '' } };
    case 'ownerCode': // the hub answers every attempt with exactly one ownerCodeResult; a malformed code is just a wrong code
      return { msg: { t: 'ownerCode', code: str(o.code) ? o.code.trim().slice(0, 12) : '' } };
    case 'restorePremium': {
      // Not validated here: the hub answers every attempt with exactly one restoreResult (bad_email, not_found, rate_limited or ok)
      const email = str(o.email) ? o.email.trim().toLowerCase().slice(0, 300) : '';
      return { msg: { t: 'restorePremium', email } };
    }
    case 'joinTable': case 'watchTable': case 'joinTournament': case 'watchTournament':
      if (!(str(o.id) && ID_RE.test(o.id))) return bad('Bad id');
      return { msg: { t: o.t, id: o.id } as ClientMsg };
    case 'joinCode': case 'watchCode': {
      const code = str(o.code) ? o.code.trim().toUpperCase() : '';
      if (!CODE_RE.test(code)) return bad(`Codes are ${CONFIG.codeLength} letters/numbers`);
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
      if (o.teamMin4 !== undefined && typeof o.teamMin4 !== 'boolean') return bad('teamMin4 must be boolean');
      if (o.jokers !== undefined && typeof o.jokers !== 'boolean') return bad('jokers must be boolean');
      return { msg: { t: 'createTournament', size: o.size as number, isPublic: o.isPublic, teamMin4: o.teamMin4 as boolean | undefined, jokers: o.jokers as boolean | undefined } };
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
