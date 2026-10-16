// Takes screenshots of the client with headless Chrome (puppeteer-core, no browser download).
// Starts its own server on a random port and stops it at the end. Output: screenshots/*.png
// Usage: npm run screenshots   (set CHROME=/path/to/chrome if it is not /usr/bin/google-chrome)

import fs from 'node:fs';
import puppeteer, { Page } from 'puppeteer-core';
import { startServer } from '../src/server/server.js';

const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clickText(page: Page, selector: string, text: string) {
  const ok = await page.evaluate((sel, txt) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim() === txt);
    el?.click();
    return !!el;
  }, selector, text);
  if (!ok) throw new Error(`no ${selector} with text ${text}`);
}

/** Click the first legal card via the DOM (re-renders can detach nodes between a lookup and a click). */
async function playLegal(page: Page) {
  await page.waitForSelector('.cbtn.legal', { timeout: 20000 });
  await page.evaluate(() => (document.querySelector('.cbtn.legal') as HTMLElement | null)?.click());
}

async function signIn(page: Page, base: string, nick: string, query = '') {
  await page.goto(base + '/' + query, { waitUntil: 'load' });
  await page.waitForSelector('#screen-nick input');
  await page.type('#screen-nick input', nick);
  await clickText(page, '.btn', 'Play now');
  await page.waitForSelector('#screen-lobby .btn');
}

async function main() {
  const srv = await startServer({ port: 0, host: '127.0.0.1', devUnlock: true, timings: { botDelayMs: 120, trickPauseMs: 700, handPauseMs: 60000 } });
  const base = `http://127.0.0.1:${srv.port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const shot = async (page: Page, name: string) => { await page.screenshot({ path: OUT + name }); console.log('saved', name); };
  try {
    // --- card art ---
    let page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 700, deviceScaleFactor: 2 });
    await page.goto(base + '/cards.html?ranks=JQK', { waitUntil: 'load' });
    await shot(page, 'cards-court.png');
    await page.setViewport({ width: 1100, height: 700, deviceScaleFactor: 1 });
    await page.goto(base + '/cards.html', { waitUntil: 'load' });
    await page.screenshot({ path: OUT + 'cards-all.png', fullPage: true });
    console.log('saved cards-all.png');
    await page.close();

    // --- phone 390x844 ---
    page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(base + '/', { waitUntil: 'load' });
    await shot(page, 'phone-1-nickname.png');
    await signIn(page, base, 'Ruby');
    await shot(page, 'phone-2-lobby.png');
    await clickText(page, '.btn', 'Practice vs bots');
    await page.waitForSelector('.bidgrid', { timeout: 20000 });
    await sleep(300);
    await shot(page, 'phone-3-bidding.png');
    await clickText(page, '.bidgrid .btn', '4');
    await page.waitForSelector('.cbtn.legal', { timeout: 20000 });
    await sleep(300);
    await shot(page, 'phone-4-playing.png');
    // play a couple of tricks, then capture a trick in the middle of the table
    for (let i = 0; i < 2; i++) { await playLegal(page); await sleep(1500); }
    await page.waitForSelector('.cbtn.legal', { timeout: 20000 });
    await shot(page, 'phone-5-midhand.png');
    await page.close();

    // --- small phone 360x740 with a full 13-card hand ---
    page = await browser.newPage();
    await page.setViewport({ width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await signIn(page, base, 'Tiny', '?slot=t');
    await clickText(page, '.btn', 'Practice vs bots');
    await page.waitForSelector('.bidgrid', { timeout: 20000 });
    await sleep(300);
    await shot(page, 'phone360-1-bidding.png');
    await clickText(page, '.bidgrid .btn', '3');
    await page.waitForSelector('.cbtn.legal', { timeout: 20000 });
    await sleep(300);
    await shot(page, 'phone360-2-playing.png');
    await page.close();

    // --- desktop 1280x800 ---
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await signIn(page, base, 'Dana', '?slot=d');
    await shot(page, 'desktop-1-lobby.png');
    await clickText(page, '.btn', 'Practice vs bots');
    await page.waitForSelector('.bidgrid', { timeout: 20000 });
    await clickText(page, '.bidgrid .btn', '3');
    await page.waitForSelector('.cbtn.legal', { timeout: 20000 });
    for (let i = 0; i < 3; i++) { await playLegal(page); await sleep(1500); }
    await page.waitForSelector('.cbtn.legal', { timeout: 20000 });
    await shot(page, 'desktop-2-table.png');
    const code = await page.evaluate(() => (document.querySelector('.spec') as HTMLElement | null)?.textContent ?? '');
    void code;
    await page.close();

    // --- spectator on a phone, watching a running table by its code ---
    const running = [...srv.hub.tables.values()].find((t) => t.status === 'playing' && !t.tournament);
    if (running) {
      page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await signIn(page, base, 'Viewer', '?slot=v');
      await page.type('.code-input', running.code);
      await clickText(page, '.btn', 'Watch');
      await page.waitForSelector('.spec');
      await sleep(600);
      await shot(page, 'phone-8-spectator.png');
      await page.close();
    }

    // --- host: tournament bracket (dev toggle), phone and desktop ---
    page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await signIn(page, base, 'Host', '?slot=h');
    await clickText(page, '.btn', 'Dev: toggle subscription');
    await sleep(300);
    await clickText(page, '.btn', 'Create tournament');
    await page.waitForSelector('#screen-tournament .btn.primary');
    await shot(page, 'phone-6-tournament-registering.png');
    await clickText(page, '.btn', 'Start tournament');
    await page.waitForSelector('.bracket, .bidgrid', { timeout: 15000 });
    await page.waitForSelector('.bidgrid', { timeout: 15000 });
    await clickText(page, '.btn', 'Bracket');
    await page.waitForSelector('.bracket');
    await sleep(300);
    await shot(page, 'phone-7-bracket.png');
    await page.close();
    // same player (saved token), desktop-size window: reconnects to the live match, then open the bracket
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(base + '/?slot=h', { waitUntil: 'load' });
    await page.waitForSelector('.bidgrid');
    await clickText(page, '.btn', 'Bracket');
    await page.waitForSelector('.bracket');
    await sleep(300);
    await shot(page, 'desktop-3-bracket.png');
    await page.close();
  } finally {
    await browser.close();
    await srv.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
