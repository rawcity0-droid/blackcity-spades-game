import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Players never see the word "bot": scan every string literal in public/ and in the server/engine sources
// (comments and code identifiers are skipped; only quoted text is checked).
const BOT = /\bbots?\b/i;
const ALLOW = new Set(['bot', 'addBots', 'Bot']); // internal kinds/message types used as values, never shown
// Regex literal in botchat that recognises players asking "are you a bot?"
const ALLOW_LINE = /BOTQ_BACK|by: `bot:/;

function strings(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !ALLOW_LINE.test(l)).map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  return [...noComments.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

test('no user-facing "bot" text in public/ or server messages', () => {
  const files = [
    ...readdirSync('public').filter((f) => /\.(js|html)$/.test(f)).map((f) => 'public/' + f),
    ...readdirSync('src/server').map((f) => 'src/server/' + f),
    ...readdirSync('src/engine').map((f) => 'src/engine/' + f),
  ];
  const hits: string[] = [];
  for (const f of files) for (const s of strings(readFileSync(f, 'utf8'))) {
    if (!BOT.test(s) || ALLOW.has(s)) continue;
    if (/^\.\.?\/.*bot(chat)?\.js$/.test(s)) continue; // import paths
    hits.push(`${f}: ${s.slice(0, 80)}`);
  }
  assert.deepEqual(hits, []);
});
