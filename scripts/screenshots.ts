// Takes screenshots of the redesigned client with headless Chrome (puppeteer-core, no browser download).
// Starts its own server on a random port and stops it at the end. Output: screenshots/ui-*.png and cards-*.png
// Usage: npm run screenshots   (set CHROME=/path/to/chrome if it is not /usr/bin/google-chrome)

import fs from 'node:fs';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { startServer } from '../src/server/server.js';
import { Billing } from '../src/server/billing.js';
import { MockStripe, PRICE, SECRET } from '../test/mock-stripe.js';

const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const TMP = OUT + 'tmp/';
fs.mkdirSync(TMP, { recursive: true });

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
  await page.waitForSelector('.cbtn.legal', { timeout: 30000 });
  await page.evaluate(() => (document.querySelector('.cbtn.legal') as HTMLElement | null)?.click());
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
  const srv = await startServer({ port: 0, host: '127.0.0.1', devUnlock: true, timings: { botDelayMs: 650, trickPauseMs: 1500, handPauseMs: 60000, matchEndPauseMs: 30000 } });
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
      await clickText(page, '.bigbtn', 'Practice');
      await page.waitForSelector('.bidpanel', { timeout: 30000 });
      await sleep(250);
      const st = await state(page);
      if (st.cards !== 13) throw new Error(`${sz.tag}: expected 13 cards, saw ${st.cards}`);
      await shot(page, `ui-${sz.tag}-02-bidding-13cards.png`);
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
    page = await newPage(browser, base, P, 'main');
    await clickText(page, '.bigbtn', 'Play Online');
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
    await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Create Table')))!.click());
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
    await clickText(page, '.bigbtn', 'Play Online');
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
    await clickText(guest, '.bigbtn', 'Play Online');
    await guest.waitForSelector('#display-name');
    await guest.type('#display-name', 'Gus');
    await guest.evaluate(() => (document.querySelector('#display-name') as HTMLElement).blur());
    await guest.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Join Table')))!.click());
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
    await clickText(page, '.btn', 'Add Bots');
    await page.waitForFunction(() => document.querySelectorAll('.seatcard.vacant').length === 0);
    await sleep(300);
    await shot(page, 'ui-ph390-15-host-lobby-full.png');
    await clickText(page, '.btn', 'Start');
    await page.waitForSelector('.hand .cbtn', { timeout: 30000 });
    await sleep(500);
    await shot(page, 'ui-ph390-16-private-table-started.png');

    // spectator on a phone, watching that table by its code
    const viewer = await newPage(browser, base, P, 'view');
    await clickText(viewer, '.bigbtn', 'Play Online');
    await setName(viewer, 'Vic');
    await viewer.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Watch Table')))!.click());
    await viewer.waitForSelector('#code-input');
    await viewer.type('#code-input', code);
    await clickText(viewer, '.modal.small .btn', 'Watch');
    await viewer.waitForSelector('.spec');
    await sleep(900);
    await shot(viewer, 'ui-ph390-17-spectator.png');
    await viewer.close();
    await guest.close();
    await page.evaluate(() => { window.confirm = () => true; });
    await menuItem(page, 'Leave table'); // free the host's seat before the next scenarios
    await page.waitForSelector('.home-card');
    await page.close();

    // --- bracket (Create Bracket) ---
    page = await newPage(browser, base, P, 'main'); // same token: Premium stays on
    await clickText(page, '.bigbtn', 'Play Online');
    await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Create Bracket')))!.click());
    await page.waitForSelector('.modal.small');
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
    await page.evaluate(() => { window.confirm = () => true; });
    await clickText(page, '.btn', 'Back to my table');
    await menuItem(page, 'Leave table');
    await page.waitForSelector('.sheet');
    await clickText(page, '.btn', 'Leave tournament');
    await page.waitForSelector('.home-card');
    await page.close();

    // --- Create Tournament (one to eight tables) ---
    page = await newPage(browser, base, P, 'main');
    await page.evaluate(() => { window.confirm = () => true; });
    await clickText(page, '.pill-gold', 'Host a Tournament');
    await page.waitForSelector('.modal.small');
    await sleep(200);
    await shot(page, 'ui-ph390-21-create-tournament-modal.png');
    await clickText(page, '.modal.small .btn', 'Create');
    await page.waitForSelector('.sheet .codebox');
    const ecode = await page.$eval('.cb-code', (e) => e.textContent!);
    const ej = await newPage(browser, base, P, 'ej');
    await clickText(ej, '.bigbtn', 'Play Online');
    await setName(ej, 'Eve');
    await ej.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Join Tournament')))!.click());
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


    // --- display name: a brand-new visitor sees an empty field; joining without a name is blocked ---
    page = await newPage(browser, base, P, 'newbie');
    await clickText(page, '.bigbtn', 'Play Online');
    await page.waitForSelector('#display-name');
    const prefilled = await page.$eval('#display-name', (e) => (e as HTMLInputElement).value);
    const placeholder = await page.$eval('#display-name', (e) => (e as HTMLInputElement).placeholder);
    const ac = await page.$eval('#display-name', (e) => (e as HTMLInputElement).autocomplete);
    if (prefilled !== '' || placeholder !== 'Enter your name' || ac !== 'off') throw new Error(`name field: value=${prefilled} placeholder=${placeholder} autocomplete=${ac}`);
    await sleep(200);
    await shot(page, 'ui-ph390-name-blank.png');
    await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Join Table')))!.click());
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
    await clickText(page, '.bigbtn', 'Play Online');
    await setName(page, 'Avery');
    await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.tile')].find((e) => e.textContent!.startsWith('Create Table')))!.click());
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
    await page.waitForFunction(() => !document.querySelector('#restore-email') && /Premium active/.test(document.querySelector('.modal .lead')?.textContent ?? ''));
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

    // --- desktop 1280x800 ---
    const D = { width: 1280, height: 800, mobile: false };
    page = await newPage(browser, base, D, 'dsk', 1);
    await shot(page, 'ui-desktop-01-home.png');
    await clickText(page, '.bigbtn', 'Play Online');
    await page.waitForSelector('.tiles');
    await sleep(200);
    await shot(page, 'ui-desktop-02-play-online.png');
    await page.keyboard.press('Escape');
    await clickText(page, '.bigbtn', 'Practice');
    await page.waitForSelector('.bidpanel', { timeout: 30000 });
    await clickText(page, '.bidbtn', '3');
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
