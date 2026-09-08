'use strict';
// Drives two independent Chrome profiles, each with the extension loaded,
// through a real create/join session over the relay and captures the popup
// states plus the synced demo page at 2x. Raw captures land in ./captures.
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const BUILD = path.join(__dirname, '..', 'build', 'chrome');
const EXT = path.join(__dirname, 'profiles', 'extension');
const OUT = path.join(__dirname, 'captures');
const DEMO = 'http://localhost:8080/';
const HEADLESS = process.env.HEADFUL ? false : true;
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The images show the extension after the user has allowed All tabs. That
// grant comes from Chrome's own permission prompt, native UI puppeteer cannot
// press, so the copy loaded here carries it in its manifest instead. The
// scripts and popup are the shipped build, untouched.
function prepareExtension() {
    fs.rmSync(EXT, { recursive: true, force: true });
    fs.cpSync(BUILD, EXT, { recursive: true });
    const manifestPath = path.join(EXT, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.host_permissions = manifest.optional_host_permissions;
    delete manifest.optional_host_permissions;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4));
}

async function launch(name) {
    const userDataDir = path.join(__dirname, 'profiles', name);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    const browser = await puppeteer.launch({
        headless: HEADLESS,
        enableExtensions: [EXT],
        userDataDir,
        defaultViewport: null,
        args: ['--hide-scrollbars', '--force-color-profile=srgb'],
    });
    const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
    const id = new URL(sw.url()).host;
    return { browser, id, name };
}

async function openDemo(b, width, height, extraCss) {
    const page = await b.browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.goto(DEMO, { waitUntil: 'load' });
    await page.waitForSelector('#loading[hidden]', { timeout: 60000 });
    if (extraCss) await page.addStyleTag({ content: extraCss });
    return page;
}

async function openPopup(b) {
    const page = await b.browser.newPage();
    await page.setViewport({ width: 340, height: 700, deviceScaleFactor: 2 });
    // The stylesheet's reduced-motion rule jumps every animation to its end
    // state, which is exactly what a still capture needs.
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(`chrome-extension://${b.id}/src/popup.html`, { waitUntil: 'load' });
    await sleep(300);
    return page;
}

async function storage(page, key, value) {
    await page.evaluate((k, v) => new Promise(res => chrome.storage.local.set({ [k]: v }, res)), key, value);
}

async function getStorage(page, keys) {
    return page.evaluate(k => new Promise(res => chrome.storage.local.get(k, res)), keys);
}

async function waitStorage(page, key, pred, timeout = 30000) {
    const t0 = Date.now();
    for (;;) {
        const r = await getStorage(page, [key]);
        if (pred(r[key])) return r[key];
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${key}: ${JSON.stringify(r)}`);
        await sleep(200);
    }
}

// The popup is 340px wide; in a tab the viewport is wider, so clip to the
// document box. Animations (link dots, pill pulse) are frozen first so the
// capture is deterministic.
async function shotPopup(page, file, opts = {}) {
    await sleep(150);
    const height = await page.evaluate(() => document.documentElement.getBoundingClientRect().height);
    await page.screenshot({
        path: path.join(OUT, file),
        clip: { x: 0, y: 0, width: 340, height: Math.ceil(height) },
        omitBackground: false,
    });
    console.log('  wrote', file, `340x${Math.ceil(height)}`);
}

async function shotPage(page, file) {
    await page.screenshot({ path: path.join(OUT, file) });
    console.log('  wrote', file);
}

(async () => {
    prepareExtension();
    const A = await launch('alice');
    const B = await launch('bob');
    console.log('extension ids', A.id, B.id);

    // Demo pages first (they must be the active http tab when the peers
    // connect, since that is where the content script is injected).
    const demoCss = '.note{display:none}';
    const demoA = await openDemo(A, 1200, 520, demoCss + 'body{align-items:flex-start;padding-left:64px}video{width:640px}');
    const demoB = await openDemo(B, 604, 500, demoCss + 'video{width:540px}');

    const popA = await openPopup(A);
    const popB = await openPopup(B);

    // Names and theme.
    await storage(popA, 'displayName', 'Alice');
    await storage(popB, 'displayName', 'Bob');
    await storage(popA, 'theme', 'dark');
    await storage(popB, 'theme', 'dark');
    await sleep(300);

    console.log('start states');
    await shotPopup(popA, 'popup-start-dark.png');
    await storage(popA, 'theme', 'light');
    await sleep(200);
    await shotPopup(popA, 'popup-start-light.png');
    await storage(popA, 'theme', 'dark');
    await sleep(200);

    console.log('create room');
    await popA.click('#newSessionBtn');
    const code = await waitStorage(popA, 'roomCode', v => v && v !== '…');
    await waitStorage(popA, 'relayOpen', v => v === true);
    await sleep(500);
    console.log('  room', code);
    await shotPopup(popA, 'popup-waiting-dark.png');

    console.log('join view');
    await popB.click('#joinSessionBtn');
    await popB.type('#joinCode', code, { delay: 20 });
    await sleep(200);
    await shotPopup(popB, 'popup-join-dark.png');

    console.log('connect');
    await popB.click('#connectBtn');
    await waitStorage(popA, 'connected', v => v === true);
    await waitStorage(popB, 'connected', v => v === true);
    await waitStorage(popA, 'peerName', v => v === 'Bob');
    await waitStorage(popB, 'peerName', v => v === 'Alice');
    await sleep(600);
    console.log('  connected');

    // Sync is opt-in: a mode is picked in the popup, on the page with the
    // video. Loaded in a tab, the popup takes "the page it is on" from the
    // active tab at load time, so each popup is reloaded while its demo tab
    // is in front, and All tabs chosen on it. The access it asks for is
    // already held (see prepareExtension), so no prompt appears and the
    // background injects the content script into the demo tab.
    console.log('turn sync on');
    for (const [demo, pop] of [[demoA, popA], [demoB, popB]]) {
        await demo.bringToFront();
        await pop.reload({ waitUntil: 'load' });
        await sleep(300);
        await pop.bringToFront();
        await pop.click('.sync-btn[data-sync="all"]');
        await waitStorage(pop, 'syncedTabs', v => Array.isArray(v) && v.length > 0);
    }
    await sleep(600);
    console.log('  syncing');

    await shotPopup(popA, 'popup-connected-dark.png');
    await storage(popA, 'theme', 'light');
    await sleep(200);
    await shotPopup(popA, 'popup-connected-light.png');
    await storage(popA, 'theme', 'dark');
    await sleep(200);
    await popA.click('#settings summary');
    await sleep(300);
    await shotPopup(popA, 'popup-settings-dark.png');
    await popA.click('#settings summary');
    await sleep(200);

    // Drive playback from Alice's side and let Bob's page follow.
    console.log('sync playback');
    await demoA.bringToFront();
    await demoB.bringToFront();
    await sleep(800);
    await demoA.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 10; return v.play(); });
    await sleep(2500);
    await demoA.evaluate(() => document.getElementById('v').pause());
    await sleep(800);
    // A second, larger seek while paused makes both sides land on exactly
    // the same frame (small differences under the sync tolerance are kept).
    await demoA.evaluate(() => { document.getElementById('v').currentTime = 24; });
    await sleep(1500);
    const tA = await demoA.evaluate(() => [document.getElementById('v').currentTime, document.getElementById('v').paused]);
    const tB = await demoB.evaluate(() => [document.getElementById('v').currentTime, document.getElementById('v').paused]);
    console.log('  A', tA, 'B', tB);
    if (Math.abs(tA[0] - tB[0]) > 0.01 || !tA[1] || !tB[1]) throw new Error('pages not in sync');

    await demoA.bringToFront();
    await shotPage(demoA, 'page-wide.png');
    await demoB.bringToFront();
    await shotPage(demoB, 'page-narrow-b.png');
    // Alice's page at the narrow size too, for the side-by-side shot.
    await demoA.setViewport({ width: 604, height: 500, deviceScaleFactor: 2 });
    await demoA.evaluate(() => { document.querySelector('video').style.width = '540px'; document.body.style.alignItems = ''; document.body.style.paddingLeft = ''; });
    await sleep(400);
    await shotPage(demoA, 'page-narrow-a.png');

    // Leave cleanly so the relay room closes.
    await popA.bringToFront();
    await popA.click('#backBtn');
    await sleep(500);
    await A.browser.close();
    await B.browser.close();
    console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
