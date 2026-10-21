// Takes screenshots of the redesigned client with headless Chrome (puppeteer-core, no browser download).
// Starts its own server on a random port and stops it at the end. Output: screenshots/ui-*.png and cards-*.png
// Usage: npm run screenshots   (set CHROME=/path/to/chrome if it is not /usr/bin/google-chrome)

import fs from 'node:fs';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import WebSocket from 'ws';
import { startServer } from '../src/server/server.js';
import { Billing } from '../src/server/billing.js';
import { MockStripe, PRICE, SECRET } from '../test/mock-stripe.js';

const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const TMP = OUT + 'tmp/';
fs.mkdirSync(TMP, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Free player: Play now with a name, then wait for bots to fill the table (10 s). */
async function startSolo(page: Page) {
  await clickText(page, '.bigbtn', 'Play now');
  await setName(page, 'Solo');
  await page.waitForSelector('.tile.quick');
  await page.evaluate(() => (document.querySelector('.tile.quick') as HTMLElement).click());
}

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
  await page.waitForSelector('.cbtn.legal', { timeout: 30000 });
  await page.evaluate(() => (document.querySelector('.cbtn.legal') as HTMLElement | null)?.click());
}

/** With the chat sheet open, no card (and no bid button) may sit under it. Returns the geometry for the log. */
async function chatFits(page: Page, label: string) {
  await page.evaluate(() => (document.getElementById('chat-btn') as HTMLElement).click());
  await page.waitForFunction(() => !document.getElementById('chat-sheet')!.classList.contains('hidden'));
  await sleep(250);
  const g = await page.evaluate(() => {
    const sh = document.getElementById('chat-sheet')!.getBoundingClientRect();
    const hit = [...document.querySelectorAll('.hand .cbtn, .bidbtn')].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.right > sh.left + 0.5 && r.left < sh.right - 0.5 && r.bottom > sh.top + 0.5 && r.top < sh.bottom - 0.5;
    }).length;
    return { top: sh.top, left: sh.left, covered: hit };
  });
  console.log(label, 'chat sheet at', g.left, g.top, 'covered controls:', g.covered);
  if (g.covered) throw new Error(`${label}: chat sheet covers play: ${JSON.stringify(g)}`);
}

type Size = { tag: string; width: number; height: number; mobile: boolean };
const SIZES: Size[] = [
  { tag: 'ph390', width: 390, height: 844, mobile: true },
  { tag: 'ph360', width: 360, height: 740, mobile: true },
  { tag: 'tab820p', width: 820, height: 1180, mobile: true },
  { tag: 'tab1180l', width: 1180, height: 820, mobile: true },
];

async function newPage(browser: Browser, base: string, s: { width: number; height: number; mobile: boolean }, slot: string, dpr = 2): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: s.width, height: s.height, deviceScaleFactor: dpr, isMobile: s.mobile, hasTouch: s.mobile });
  // the cover screen shows once per tab: mark it as seen so the other shots go straight to the home screen
  await page.evaluateOnNewDocument((k) => { try { sessionStorage.setItem(k, '1'); } catch { /* ignore */ } }, 'spades_cover_' + slot);
  await page.goto(base + '/?slot=' + slot, { waitUntil: 'load' });
  await page.waitForSelector('.home-card');
  await page.waitForFunction(() => document.querySelector('.tbl-open')?.textContent === 'Table open');
  return page;
}

async function setName(page: Page, name: string) {
  await page.waitForSelector('#display-name');
  await page.type('#display-name', name);
  await page.evaluate(() => (document.querySelector('#display-name') as HTMLElement).blur());
}

async function menuItem(page: Page, label: string) {
  await page.click('.roundbtn[aria-label="Menu"]');
  await page.waitForSelector('.menu-pop');
  await clickText(page, '.menu-item', label);
}

const state = (page: Page) => page.evaluate(() => ({
  tc: document.querySelectorAll('.trick .tc').length,
  legal: document.querySelectorAll('.cbtn.legal').length,
  status: document.querySelector('.status-text')?.textContent ?? '',
  bid: !!document.querySelector('.bidpanel'),
  cards: document.querySelectorAll('.hand .cbtn').length,
}));

async function main() {
  const srv = await startServer({ port: 0, host: '127.0.0.1', devUnlock: true, timings: { botDelayMs: 650, trickPauseMs: 1500, handPauseMs: 60000, matchEndPauseMs: 30000, matchWaitMs: 4000 } });
  const base = `http://127.0.0.1:${srv.port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const shot = async (page: Page, name: string, full = false) => { await page.bringToFront(); await page.screenshot({ path: OUT + name, fullPage: full }); console.log('saved', name); };
  try {
    // --- card art (unchanged) ---
    let page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 700, deviceScaleFactor: 2 });
    await page.goto(base + '/cards.html?ranks=JQK', { waitUntil: 'load' });
    await shot(page, 'cards-court.png');
    await page.setViewport({ width: 1100, height: 700, deviceScaleFactor: 1 });
    await page.goto(base + '/cards.html', { waitUntil: 'load' });
    await page.screenshot({ path: OUT + 'cards-all.png', fullPage: true });
    console.log('saved cards-all.png');
    await page.close();

    // --- board checks at every size: home, bidding with a full hand, mid-trick, trick complete ---
    for (const sz of SIZES) {
      page = await newPage(browser, base, sz, sz.tag);
      await shot(page, `ui-${sz.tag}-01-home.png`);
      await startSolo(page);
      await page.waitForSelector('.bidpanel', { timeout: 30000 });
      await sleep(250);
      const st = await state(page);
      if (st.cards !== 13) throw new Error(`${sz.tag}: expected 13 cards, saw ${st.cards}`);
      await shot(page, `ui-${sz.tag}-02-bidding-13cards.png`);
      const bidLabels = await page.evaluate(() => [...document.querySelectorAll('.bidbtn')].map((b) => b.textContent));
      console.log(sz.tag, 'bid buttons:', bidLabels.join(' '));
      if (bidLabels.join(',') !== 'Nil,4,5,6,7,8,9,10,11,12,13') throw new Error('bid choices should start at 4 (plus Nil): ' + bidLabels.join(','));
      if (sz.tag === 'ph390') await shot(page, 'ui-ph390-bid-min4.png');
      await chatFits(page, sz.tag + ' bidding');
      await shot(page, `ui-${sz.tag}-chat-open-bidding.png`);
      await page.evaluate(() => (document.querySelector('.chat-x') as HTMLElement).click());
      await clickText(page, '.bidbtn', '4');
      let gotMid = false;
      let gotDone = false;
      const t0 = Date.now();
      while ((!gotMid || !gotDone) && Date.now() - t0 < 120000) {
        const s = await state(page);
        if (!gotMid && s.tc >= 2 && s.tc <= 3 && s.legal > 0 && !/takes the trick/.test(s.status)) { await sleep(120); await shot(page, `ui-${sz.tag}-03-mid-trick.png`); gotMid = true; await playLegal(page); continue; }
        if (!gotDone && /takes the trick/.test(s.status) && s.tc === 4) { await sleep(260); await shot(page, `ui-${sz.tag}-04-trick-complete.png`); gotDone = true; continue; }
        if (s.legal > 0 && s.tc < 2 && !/takes the trick/.test(s.status)) await playLegal(page);
        await sleep(60);
      }
      if (!gotMid || !gotDone) throw new Error(`${sz.tag}: mid=${gotMid} done=${gotDone}`);
      await page.close();
    }

    // --- phone flow: modals, host lobby, premium gate, restore ---
    const P = { width: 390, height: 844, mobile: true };

    // --- cover screen: phone, tablet portrait, tablet landscape (and Play reveals the unchanged home screen) ---
    const coverSizes: [string, number, number, boolean][] = [['ui-cover-phone.png', 390, 844, true], ['ui-cover-tablet.png', 768, 1024, true], ['ui-cover-tablet-landscape.png', 1024, 768, true]];
    for (const [name, width, height, mobile] of coverSizes) {
      const cp = await browser.newPage();
      await cp.setViewport({ width, height, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
      await cp.goto(base + '/?slot=cov&cover=1', { waitUntil: 'load' });
      await cp.waitForSelector('.cover .cover-play');
      await cp.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>('.cover-img'); return !!i && i.complete && i.naturalWidth > 0; });
      await sleep(1200); // let the entrance animation finish
      const fit = await cp.evaluate(() => {
        const play = document.querySelector<HTMLElement>('.cover-play')!;
        return { title: document.querySelector('.cover-title')!.getBoundingClientRect().toJSON(), tag: document.querySelector('.cover-tag')!.getBoundingClientRect().toJSON(), play: play.getBoundingClientRect().toJSON(), vw: innerWidth, vh: innerHeight, focused: document.activeElement === play, label: play.getAttribute('aria-label'), alt: document.querySelector('.cover-img')!.getAttribute('alt'), inert: (document.getElementById('app') as HTMLElement & { inert: boolean }).inert };
      });
      console.log(name, JSON.stringify(fit));
      if (fit.title.left < 0 || fit.title.right > fit.vw || fit.play.left < 0 || fit.play.right > fit.vw || fit.play.bottom > fit.vh || fit.tag.bottom > fit.play.top || fit.title.bottom > fit.tag.top || !fit.focused || !fit.label || !fit.alt || !fit.inert) throw new Error('cover layout/a11y problem: ' + JSON.stringify(fit));
      await shot(cp, name);
      if (name === 'ui-cover-phone.png') {
        await cp.reload({ waitUntil: 'load' }); // forced again by ?cover=1
        await cp.waitForSelector('.cover');
        await cp.keyboard.press('Enter'); // keyboard: the focused Play button
        await cp.waitForSelector('.home-card');
        if (await cp.$('.cover')) throw new Error('Play should hide the cover');
        await cp.goto(base + '/?slot=cov', { waitUntil: 'load' }); // same tab, session flag set: no cover on a reload
        await cp.waitForSelector('.home-card');
        if (await cp.$('.cover')) throw new Error('cover shown twice in one session');
      }
      await cp.close();
    }
    page = await newPage(browser, base, P, 'main');
    await clickText(page, '.bigbtn', 'Play now');
    await page.waitForSelector('.tiles');
    await page.type('#display-name', 'Avery');
    await page.evaluate(() => (document.querySelector('#display-name') as HTMLElement).blur());
    // profile photo: draw a test picture, upload it through the file input
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 240; c.height = 160;
      const g = c.getContext('2d')!; const grad = g.createLinearGradient(0, 0, 240, 160);
      grad.addColorStop(0, '#2c7be5'); grad.addColorStop(1, '#f2994a'); g.fillStyle = grad; g.fillRect(0, 0, 240, 160);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(120, 62, 28, 0, 7); g.fill(); g.fillRect(80, 100, 80, 60);
      return c.toDataURL('image/png').split(',')[1];
    });
    fs.writeFileSync(TMP + 'avatar.png', Buffer.from(png, 'base64'));
    const input = await page.$('.photo-row input[type=file]');
    await input!.uploadFile(TMP + 'avatar.png');
    await page.waitForSelector('.photo-row .avatar img');
    await sleep(300);
    await shot(page, 'ui-ph390-05-play-online-modal.png');
    await page.keyboard.press('Escape'); // free users have no Create tiles: hosting is offered from the home card and the upgrade card
    await sleep(150);
    await clickText(page, '.pill-gold', 'Host a Tournament');
    await page.waitForSelector('.modal.small');
    await sleep(200);
    await shot(page, 'ui-ph390-06-premium-popup.png');
    await clickText(page, '.btn', 'Restore Premium / I’m the owner');
    await page.waitForSelector('#restore-email');
    await sleep(200);
    await shot(page, 'ui-ph390-07-restore-premium-modal.png');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // Go Premium without DEV_UNLOCK shows "Billing is not set up yet"; here DEV_UNLOCK is on, so use the dev menu entry
    await menuItem(page, 'Rules');
    await page.waitForSelector('.rules');
    await sleep(200);
    await shot(page, 'ui-ph390-08-rules-modal.png');
    await page.keyboard.press('Escape');
    await page.click('.roundbtn[aria-label="Menu"]');
    await page.waitForSelector('.menu-pop');
    await shot(page, 'ui-ph390-09-menu.png');
    await clickText(page, '.menu-item', 'Dev: toggle Premium');
    await page.waitForSelector('.pill-gold.static');
    await clickText(page, '.bigbtn', 'Play now');
    await page.waitForSelector('.tiles');
    await sleep(200);
    await shot(page, 'ui-ph390-10-play-online-premium-active.png');
    await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Create Table')))!.click());
    await page.waitForSelector('.codebox');
    const code = await page.$eval('.cb-code', (e) => e.textContent!);
    await sleep(200);
    await shot(page, 'ui-ph390-11-host-lobby-empty.png');
    // second player joins with the code
    const guest = await newPage(browser, base, P, 'gus');
    await clickText(guest, '.bigbtn', 'Play now');
    await guest.waitForSelector('#display-name');
    await guest.type('#display-name', 'Gus');
    await guest.evaluate(() => (document.querySelector('#display-name') as HTMLElement).blur());
    await guest.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Join')))!.click());
    await guest.waitForSelector('#code-input');
    await guest.type('#code-input', code.toLowerCase());
    await shot(guest, 'ui-ph390-12-join-code-modal.png');
    await clickText(guest, '.modal.small .btn', 'Join');
    await guest.waitForSelector('.seatgrid');
    await page.waitForFunction(() => document.querySelectorAll('.seatcard:not(.vacant)').length === 2);
    await clickText(page, '.rchip', 'Sandbags on');
    await clickText(page, '.rchip', 'First to 500');
    await sleep(300);
    await shot(page, 'ui-ph390-13-host-lobby-2-players-rules-changed.png');
    await shot(guest, 'ui-ph390-14-guest-lobby.png');
    await clickText(page, '.btn', 'Fill seats');
    await page.waitForFunction(() => document.querySelectorAll('.seatcard.vacant').length === 0);
    await sleep(300);
    await shot(page, 'ui-ph390-15-host-lobby-full.png');
    await clickText(page, '.btn', 'Start');
    await page.waitForSelector('.hand .cbtn', { timeout: 30000 });
    await sleep(500);
    await shot(page, 'ui-ph390-16-private-table-started.png');
    // the host gets a Back button in the bar under the hand; check it fits next to music + chat at 390 and 360 (even with the volume slider shown)
    await page.click('#music-btn');
    await sleep(200);
    for (const [w, h] of [[390, 844], [360, 740]] as const) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await sleep(300);
      const fit = await page.evaluate(() => {
        const bar = document.getElementById('footbar')!;
        const items = ['back-btn', 'music-btn', 'music-vol', 'chat-btn', 'conn'].map((id) => document.getElementById(id)!).filter((e) => e && !e.classList.contains('hidden')).map((e) => e.getBoundingClientRect());
        const overlap = items.some((a, i) => items.some((b, j) => j > i && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5));
        return { overflow: bar.scrollWidth > bar.clientWidth + 1, overlap, back: !document.getElementById('back-btn')!.classList.contains('hidden'), right: Math.max(...items.map((r) => r.right)), vw: window.innerWidth };
      });
      console.log(`host footbar at ${w}:`, JSON.stringify(fit));
      if (!fit.back || fit.overflow || fit.overlap || fit.right > fit.vw) throw new Error(`host Back bar does not fit at ${w}: ${JSON.stringify(fit)}`);
    }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.click('#music-btn'); // music back off
    await sleep(300);
    await shot(page, 'ui-ph390-host-back.png');

    // spectator on a phone, watching that table by its code
    const viewer = await newPage(browser, base, P, 'view');
    await clickText(viewer, '.bigbtn', 'Play now');
    await setName(viewer, 'Vic');
    await viewer.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Watch')))!.click());
    await viewer.waitForSelector('#code-input');
    await viewer.type('#code-input', code);
    await clickText(viewer, '.modal.small .btn', 'Watch');
    await viewer.waitForSelector('.spec');
    await sleep(900);
    await shot(viewer, 'ui-ph390-17-spectator.png');

    // table chat: the spectator and a player talk, the host sees the badge, then opens the sheet
    const say = async (pg: Page, text: string) => {
      if (await pg.$eval('#chat-sheet', (e) => e.classList.contains('hidden'))) await pg.evaluate(() => (document.getElementById('chat-btn') as HTMLElement).click());
      await pg.type('.chat-form input', text);
      await pg.keyboard.press('Enter'); // Enter sends
      await sleep(250);
      await pg.evaluate(() => (document.querySelector('.chat-x') as HTMLElement).click());
    };
    await say(viewer, 'Nice bid, good luck!');
    await say(guest, 'Thanks Vic, we need it');
    await page.waitForFunction(() => document.querySelector('#chat-btn .cbadge')?.textContent === '2');
    await sleep(200);
    await shot(page, 'ui-ph390-chat-closed.png');
    await page.evaluate(() => (document.getElementById('chat-btn') as HTMLElement).click());
    await page.waitForSelector('.cmsg.watcher');
    await page.type('.chat-form input', 'Ha, watch and learn');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.cmsg.mine').length === 1);
    await sleep(300);
    const overlap = await page.evaluate(() => {
      const sheet = document.getElementById('chat-sheet')!.getBoundingClientRect();
      const cards = [...document.querySelectorAll('.hand .cbtn')].map((c) => c.getBoundingClientRect());
      return { sheetTop: sheet.top, cards: cards.length, lowest: Math.max(...cards.map((c) => c.bottom)), highest: Math.min(...cards.map((c) => c.top)) };
    });
    console.log('chat sheet top', overlap.sheetTop, 'lowest card bottom', overlap.lowest);
    if (overlap.cards && overlap.lowest > overlap.sheetTop + 0.5) await shot(page, 'debug-fail.png');
    if (overlap.cards && overlap.lowest > overlap.sheetTop + 0.5) throw new Error('chat sheet covers the hand: ' + JSON.stringify(overlap));
    await shot(page, 'ui-ph390-chat-open.png');
    await page.evaluate(() => (document.querySelector('.chat-x') as HTMLElement).click());
    const hidden = await page.$eval('#chat-sheet', (e) => e.classList.contains('hidden'));
    if (!hidden) throw new Error('chat did not close');

    // Back is navigation only: the host goes home but stays seated; Return to game comes back to the same table; Leave still confirms
    await page.evaluate(() => { (window as any).__confirms = []; window.confirm = (m) => { (window as any).__confirms.push(m); return false; }; });
    await page.click('#back-btn');
    await page.waitForSelector('.home-card .return-card');
    await say(guest, 'Back soon?'); // an update arrives while the host is away
    await page.waitForFunction(() => /new message/.test(document.querySelector('.return-card')?.textContent ?? ''));
    await sleep(300);
    const away = await page.evaluate(() => ({
      home: !document.getElementById('home-layer')!.classList.contains('hidden'),
      confirms: (window as any).__confirms.length,
      card: document.querySelector('.return-card')?.textContent,
    }));
    console.log('host went Back:', JSON.stringify(away));
    if (!away.home || away.confirms) throw new Error('Back should only navigate: ' + JSON.stringify(away));
    await shot(page, 'ui-ph390-home-return-to-game.png');
    await page.evaluate(() => (document.querySelector('.return-card') as HTMLElement).click());
    await page.waitForSelector('.hand .cbtn');
    const back = await page.evaluate(() => ({ home: !document.getElementById('home-layer')!.classList.contains('hidden'), cards: document.querySelectorAll('.hand .cbtn').length, back: !document.getElementById('back-btn')!.classList.contains('hidden'), host: !!document.querySelector('.hand') }));
    console.log('host returned:', JSON.stringify(back));
    if (back.home || back.cards < 1 || !back.back) throw new Error('Return to game did not restore the table: ' + JSON.stringify(back));
    // the menu's Leave table still asks (and "Cancel" keeps the seat)
    await menuItem(page, 'Leave table');
    const asked = await page.evaluate(() => (window as any).__confirms as string[]);
    console.log('Leave table asked:', JSON.stringify(asked));
    if (asked.length !== 1 || !/^Leave this table\? A bot takes your seat and Gus becomes the host/.test(asked[0])) throw new Error('unexpected leave confirm: ' + JSON.stringify(asked));
    await sleep(300);
    if (await page.$eval('#home-layer', (e) => !e.classList.contains('hidden'))) throw new Error('declining the confirm must keep the player at the table');
    await viewer.close();
    await guest.close();
    await page.evaluate(() => { window.confirm = () => true; });
    await menuItem(page, 'Leave table'); // free the host's seat before the next scenarios
    await page.waitForSelector('.home-card');
    await page.close();

    // --- bracket (Create Bracket) ---
    page = await newPage(browser, base, P, 'main'); // same token: Premium stays on
    await clickText(page, '.bigbtn', 'Play now');
    await setName(page, 'Avery'); // a name is required to host
    await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Create Bracket')))!.click());
    await page.waitForSelector('.modal.small').catch(async (e) => { await shot(page, 'debug-fail.png'); throw e; });
    await sleep(200);
    await shot(page, 'ui-ph390-18-create-bracket-modal.png');
    await clickText(page, '.modal.small .btn', 'Create');
    await page.waitForSelector('.sheet');
    await sleep(200);
    await shot(page, 'ui-ph390-19-bracket-registering.png');
    await clickText(page, '.btn', 'Start tournament');
    await page.waitForSelector('.bidpanel', { timeout: 30000 });
    await menuItem(page, 'Bracket view');
    await page.waitForSelector('.bracket');
    await sleep(300);
    await shot(page, 'ui-ph390-20-bracket.png');
    // the organizer's Back on the bracket only navigates: Return to game brings the bracket back, still organizer, no confirm
    await page.evaluate(() => { (window as any).__confirms = 0; window.confirm = () => { (window as any).__confirms++; return true; }; });
    await clickText(page, '.btn', '‹ Back');
    await page.waitForSelector('.home-card .return-card');
    await page.evaluate(() => (document.querySelector('.return-card') as HTMLElement).click());
    await page.waitForSelector('.bracket');
    if (await page.evaluate(() => (window as any).__confirms)) throw new Error('organizer Back must not ask');
    await clickText(page, '.btn', 'Back to my table');
    await menuItem(page, 'Leave table');
    await page.waitForSelector('.sheet');
    await clickText(page, '.btn', 'Leave tournament');
    await page.waitForSelector('.home-card');
    await page.close();

    // --- Create Tournament (one to eight tables) ---
    page = await newPage(browser, base, P, 'main');
    await page.evaluate(() => { window.confirm = () => true; });
    await clickText(page, '.bigbtn', 'Play now');
    await setName(page, 'Avery'); // a name is required to host
    await page.keyboard.press('Escape');
    await sleep(150);
    await clickText(page, '.pill-gold', 'Host a Tournament');
    await page.waitForSelector('.modal.small');
    await sleep(200);
    await shot(page, 'ui-ph390-21-create-tournament-modal.png');
    await clickText(page, '.modal.small .btn', 'Create');
    await page.waitForSelector('.sheet .codebox');
    const ecode = await page.$eval('.cb-code', (e) => e.textContent!);
    const ej = await newPage(browser, base, P, 'ej');
    await clickText(ej, '.bigbtn', 'Play now');
    await setName(ej, 'Eve');
    await ej.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Join')))!.click());
    await ej.waitForSelector('#code-input');
    await ej.type('#code-input', ecode);
    await clickText(ej, '.modal.small .btn', 'Join');
    await ej.waitForSelector('.sheet');
    await page.waitForFunction(() => document.querySelectorAll('.panel .list-item').length === 2);
    await shot(page, 'ui-ph390-22-tournament-registering.png');
    await clickText(page, '.btn', 'Start tournament');
    await page.waitForSelector('.hand .cbtn', { timeout: 30000 });
    await menuItem(page, 'Tournament view');
    await page.waitForSelector('.eventtables');
    await sleep(300);
    await shot(page, 'ui-ph390-23-tournament-running.png');
    await ej.close();
    await page.evaluate(() => { (window as any).__confirms = 0; window.confirm = () => { (window as any).__confirms++; return true; }; });
    await clickText(page, '.btn', '‹ Back');
    await page.waitForSelector('.home-card .return-card');
    await page.evaluate(() => (document.querySelector('.return-card') as HTMLElement).click());
    await page.waitForSelector('.eventtables');
    if (await page.evaluate(() => (window as any).__confirms)) throw new Error('organizer Back must not ask');
    await clickText(page, '.btn', 'Back to my table');
    await menuItem(page, 'Leave table');
    await page.waitForSelector('.sheet');
    await clickText(page, '.btn', 'Leave tournament');
    await page.waitForSelector('.home-card');
    await page.close();

    // --- free user: Go Premium without a premium account, and tapping Host a Tournament opens the popup ---
    page = await newPage(browser, base, P, 'free');
    await clickText(page, '.pill-gold', 'Host a Tournament');
    await page.waitForSelector('.modal.small');
    await sleep(150);
    await shot(page, 'ui-ph390-24-host-tournament-gate.png');
    await page.close();

    // --- free user Quick play: random players, "Finding players…", cancel, then two free players are matched with bots in the other seats ---
    page = await newPage(browser, base, P, 'fq');
    await clickText(page, '.bigbtn', 'Play now');
    await setName(page, 'Frankie');
    await page.waitForSelector('.tile.quick');
    const quickText = await page.$eval('.tile.quick', (e) => e.textContent);
    if (!/Play now: random players/.test(quickText ?? '')) throw new Error('quick play tile text: ' + quickText);
    const freeTiles = await page.evaluate(() => [...document.querySelectorAll('.tiles .tile')].map((e) => e.querySelector('b')!.textContent));
    console.log('free Play Online tiles:', JSON.stringify(freeTiles));
    if (freeTiles.some((t) => /Create|Host a/.test(t ?? '') && !/Host a table or tournament/.test(t ?? ''))) throw new Error('free players must not see create tiles: ' + freeTiles);
    await sleep(250);
    await shot(page, 'ui-ph390-free-quickplay-modal.png');
    await clickText(page, '.tile.quick', quickText!);
    await page.waitForSelector('.finding-ring');
    await sleep(300);
    const finding = await page.evaluate(() => ({ title: document.querySelector('.modal-title')?.textContent, count: document.querySelector('.finding-count')?.textContent, note: document.querySelector('.finding-note')?.textContent, cancel: !![...document.querySelectorAll('.btn')].find((b) => b.textContent === 'Cancel') }));
    console.log('finding players:', JSON.stringify(finding));
    if (!/Finding players/.test(finding.title ?? '') || !/^1 of 4 players found/.test(finding.count ?? '') || !finding.cancel) throw new Error('Finding players state: ' + JSON.stringify(finding));
    await shot(page, 'ui-ph390-free-quickplay-finding.png');
    await clickText(page, '.btn', 'Cancel');
    await page.waitForFunction(() => !document.querySelector('.finding-ring'));
    if (!(await page.$('.home-card'))) throw new Error('cancel should leave you on the home screen');
    // two free players: matched together, bots fill the other two seats after the wait
    const fq2 = await newPage(browser, base, P, 'fq2');
    await clickText(fq2, '.bigbtn', 'Play now');
    await setName(fq2, 'Gabe');
    await clickText(fq2, '.tile.quick', quickText!);
    await clickText(page, '.bigbtn', 'Play now');
    await page.waitForSelector('.tile.quick');
    await clickText(page, '.tile.quick', quickText!);
    await page.waitForSelector('.bidpanel, .hand .cbtn', { timeout: 30000 });
    await fq2.waitForSelector('.bidpanel, .hand .cbtn', { timeout: 30000 });
    const withGabe = await page.evaluate(() => document.body.innerText.includes('Gabe'));
    console.log('Frankie sees Gabe at the table:', withGabe);
    if (!withGabe) throw new Error('Frankie should be seated with Gabe');
    await fq2.close();
    await page.close();


    // --- display name: a brand-new visitor sees an empty field; joining without a name is blocked ---
    page = await newPage(browser, base, P, 'newbie');
    await clickText(page, '.bigbtn', 'Play now');
    await page.waitForSelector('#display-name');
    const prefilled = await page.$eval('#display-name', (e) => (e as HTMLInputElement).value);
    const placeholder = await page.$eval('#display-name', (e) => (e as HTMLInputElement).placeholder);
    const ac = await page.$eval('#display-name', (e) => (e as HTMLInputElement).autocomplete);
    if (prefilled !== '' || placeholder !== 'Enter your name' || ac !== 'off') throw new Error(`name field: value=${prefilled} placeholder=${placeholder} autocomplete=${ac}`);
    await sleep(200);
    await shot(page, 'ui-ph390-name-blank.png');
    await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Join')))!.click());
    await page.waitForFunction(() => !document.querySelector('#name-error')?.hasAttribute('hidden'));
    const focused = await page.evaluate(() => document.activeElement?.id);
    if (focused !== 'display-name') throw new Error('name input not focused: ' + focused);
    await sleep(200);
    await shot(page, 'ui-ph390-name-required.png');
    await page.close();

    // --- production mode (no DEV_UNLOCK): Restore Premium with an owner email, then Create Table is unlocked ---
    const prod = await startServer({ port: 0, host: '127.0.0.1', ownerEmails: ['owner@example.test'], timings: { botDelayMs: 650, trickPauseMs: 1500, handPauseMs: 60000, matchEndPauseMs: 30000 } });
    const pbase = `http://127.0.0.1:${prod.port}`;
    page = await newPage(browser, pbase, P, 'rs');
    await clickText(page, '.bigbtn', 'Play now');
    await setName(page, 'Avery');
    await page.keyboard.press('Escape');
    await sleep(150);
    await clickText(page, '.pill-gold', 'Host a Tournament'); // free users meet the Premium gate when they try to host
    await page.waitForSelector('.modal.small');
    await clickText(page, '.btn', 'Restore Premium / I’m the owner');
    await page.waitForSelector('#restore-email');
    await page.type('#restore-email', 'someone@example.test');
    await clickText(page, '.modal.small .btn', 'Restore Premium');
    await page.waitForSelector('#restore-msg:not([hidden])');
    await sleep(200);
    await shot(page, 'ui-ph390-restore-not-found.png');
    await page.$eval('#restore-email', (e) => { (e as HTMLInputElement).value = ''; e.dispatchEvent(new Event('input')); });
    await page.type('#restore-email', ' Owner@Example.test ');
    await clickText(page, '.modal.small .btn', 'Restore Premium');
    await page.waitForFunction(() => !document.querySelector('#restore-email'));
    await clickText(page, '.bigbtn', 'Play now'); // the host tiles are unlocked now
    await page.waitForFunction(() => /Premium active/.test(document.querySelector('.modal .lead')?.textContent ?? '') && !!document.querySelector('.tiles'));
    await sleep(500);
    await shot(page, 'ui-ph390-restore-success.png');
    await page.close();
    await prod.close();

    // --- Stripe return (mocked Stripe): confirming -> "Premium is active", and the cancel note ---
    const mock = await new MockStripe().start();
    mock.addCustomer('cus_demo', 'demo@example.test');
    mock.addSub('sub_demo', 'cus_demo', 'active');
    mock.addSession({ id: 'cs_test_shotsession1234567890', customer: 'cus_demo', sub: 'sub_demo' });
    const sp = await startServer({ port: 0, host: '127.0.0.1', billing: new Billing({ secretKey: SECRET, priceId: PRICE, apiBase: mock.url }) });
    page = await browser.newPage();
    await page.setViewport({ width: P.width, height: P.height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`http://127.0.0.1:${sp.port}/?slot=ret&premium=success&session_id=cs_test_shotsession1234567890`, { waitUntil: 'load' });
    await page.waitForFunction(() => /Premium is active/.test(document.querySelector('.modal .lead')?.textContent ?? ''));
    await sleep(300);
    const cleaned = await page.evaluate(() => location.search);
    if (/premium|session_id/.test(cleaned)) throw new Error('query params not stripped: ' + cleaned);
    await shot(page, 'ui-ph390-premium-return-success.png');
    await page.close();
    page = await browser.newPage();
    await page.setViewport({ width: P.width, height: P.height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`http://127.0.0.1:${sp.port}/?slot=ret2&premium=cancel`, { waitUntil: 'load' });
    await page.waitForSelector('.toast');
    await sleep(300);
    await shot(page, 'ui-ph390-premium-return-cancel.png');
    await page.close();
    await sp.close();
    await mock.stop();

    // --- free user: Play Online shows Practice / Watch / Join with a code / upgrade card; the list is watch-only ---
    const hosts: WebSocket[] = [];
    const premiumHost = async (nick: string, msg: object) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ t: 'hello', nick }));
      ws.send(JSON.stringify({ t: 'devToggleSubscription' }));
      await sleep(250);
      ws.send(JSON.stringify(msg));
      await sleep(250);
      hosts.push(ws);
    };
    await premiumHost('Marlo', { t: 'createTable', isPublic: true, target: 250 });
    await premiumHost('Dina', { t: 'createTournament', size: 8, isPublic: true });
    page = await newPage(browser, base, P, 'freeuser');
    await clickText(page, '.bigbtn', 'Play now');
    await page.waitForSelector('.tile.upgrade');
    await page.waitForFunction(() => document.querySelectorAll('.open-tables .list-item').length === 2);
    await sleep(300);
    await shot(page, 'ui-ph390-free-play-online.png');
    const free = await page.evaluate(() => ({
      tiles: [...document.querySelectorAll('.tiles .tile b')].map((e) => e.textContent),
      joinButtons: [...document.querySelectorAll('.open-tables .btn')].filter((e) => e.textContent === 'Join').length,
      watchButtons: [...document.querySelectorAll('.open-tables .btn')].filter((e) => e.textContent === 'Watch').length,
      note: document.querySelector('.open-tables .tiny')?.textContent,
    }));
    console.log('free play-online:', JSON.stringify(free));
    if (free.joinButtons !== 0 || free.watchButtons !== 2 || !/Premium host/.test(free.note ?? '')) throw new Error('free lobby list is not watch-only');
    await page.evaluate(() => { const m = document.querySelector('.modal') as HTMLElement; m.scrollTop = m.scrollHeight; document.querySelectorAll('.modal-body, .layer').forEach((e) => { (e as HTMLElement).scrollTop = (e as HTMLElement).scrollHeight; }); });
    await sleep(300);
    await shot(page, 'ui-ph390-free-lobby-watch-only.png');
    await page.close();
    for (const w of hosts) w.close();
    await sleep(200);

    // --- desktop 1280x800 ---
    const D = { width: 1280, height: 800, mobile: false };
    page = await newPage(browser, base, D, 'dsk', 1);
    await shot(page, 'ui-desktop-01-home.png');
    await clickText(page, '.bigbtn', 'Play now');
    await page.waitForSelector('.tiles');
    await sleep(200);
    await shot(page, 'ui-desktop-02-play-online.png');
    await page.keyboard.press('Escape');
    await startSolo(page);
    await page.waitForSelector('.bidpanel', { timeout: 30000 });
    await clickText(page, '.bidbtn', '4');
    for (let i = 0; i < 30; i++) {
      const s = await state(page);
      if (s.tc >= 2 && s.legal > 0) break;
      if (s.legal > 0) await playLegal(page);
      await sleep(80);
    }
    await shot(page, 'ui-desktop-03-table.png');
    await page.close();
  } finally {
    await browser.close();
    await srv.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
