'use strict';
// Lays the raw captures out as Chrome Web Store images (HTML rendered by
// headless Chrome), then flattens each to a 24-bit PNG with no alpha channel.
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const CAP = path.join(__dirname, 'captures');
const OUT = __dirname;
fs.mkdirSync(OUT, { recursive: true });

const ICON_SVG = fs.readFileSync(path.join(__dirname, '..', 'images', 'icon.svg'), 'utf8');
const img = name => 'data:image/png;base64,' + fs.readFileSync(path.join(CAP, name)).toString('base64');
const iconUri = 'data:image/svg+xml;base64,' + Buffer.from(ICON_SVG).toString('base64');

const CREDIT = 'Video: Big Buck Bunny © 2008 Blender Foundation<br>CC BY 3.0 · creativecommons.org/licenses/by/3.0';

const BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    /* Inter (SIL Open Font License) for everything composed here, so no
       platform font ends up in marketing material. The captures inside keep
       whatever the extension itself renders with. */
    font-family: Inter, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased; color: #ecedef; overflow: hidden;
  }
  .canvas {
    position: relative; overflow: hidden;
    background:
      radial-gradient(900px 520px at 12% -10%, rgba(255, 79, 92, 0.22), transparent 60%),
      radial-gradient(700px 480px at 100% 110%, rgba(255, 95, 109, 0.14), transparent 60%),
      linear-gradient(180deg, #17181c 0%, #101114 100%);
  }
  .head { position: absolute; left: 72px; right: 72px; }
  .kicker {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 15px; font-weight: 600; color: #ff6873; letter-spacing: .02em;
  }
  .kicker img { width: 22px; height: 22px; }
  h1 { margin: 10px 0 0; font-size: 44px; line-height: 1.12; font-weight: 700; letter-spacing: -0.02em; color: #f4f5f7; }
  p.sub { margin: 12px 0 0; font-size: 20px; line-height: 1.4; color: #b4bac4; max-width: 760px; }
  .credit {
    position: absolute; right: 72px; top: 62px; text-align: right;
    font-size: 12px; line-height: 1.5; color: #7d8590; letter-spacing: .01em; max-width: 300px;
  }
  /* Neutral browser frame: no vendor branding. */
  .win {
    position: absolute; overflow: hidden; border-radius: 12px;
    background: #14161a; border: 1px solid rgba(255,255,255,0.09);
    box-shadow: 0 30px 80px rgba(0,0,0,0.55), 0 4px 16px rgba(0,0,0,0.35);
  }
  .bar {
    height: 46px; background: #23262c; border-bottom: 1px solid rgba(255,255,255,0.06);
    display: flex; align-items: center; gap: 12px; padding: 0 14px;
  }
  .dots { display: flex; gap: 7px; }
  .dots i { width: 11px; height: 11px; border-radius: 50%; background: #464b55; display: block; }
  .nav { display: flex; gap: 10px; color: #6f7681; }
  .nav svg { width: 16px; height: 16px; }
  .url {
    flex: 1; height: 30px; border-radius: 999px; background: #15171b;
    display: flex; align-items: center; gap: 8px; padding: 0 12px;
    font-size: 13px; color: #9aa1ab;
  }
  .url svg { width: 12px; height: 12px; color: #6f7681; }
  .ext { display: flex; align-items: center; gap: 8px; }
  .ext img { width: 20px; height: 20px; display: block; }
  .ext .badge {
    position: absolute; width: 8px; height: 8px; border-radius: 50%; background: #3ccf7a;
    border: 2px solid #23262c; transform: translate(12px, -12px);
  }
  .page { display: block; width: 100%; }
  .popup {
    position: absolute; width: 340px; border-radius: 12px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08);
    background: #141518;
  }
  .popup img { display: block; width: 340px; }
  .label {
    position: absolute; font-size: 14px; font-weight: 600; color: #9aa1ab; letter-spacing: .06em; text-transform: uppercase;
  }
`;

const NAV = `<span class="nav">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
</span>`;
const LOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

function win({ x, y, w, page, connected }) {
    return `<div class="win" style="left:${x}px;top:${y}px;width:${w}px">
      <div class="bar">
        <span class="dots"><i></i><i></i><i></i></span>
        ${NAV}
        <span class="url">${LOCK}example.com</span>
        <span class="ext"><img src="${iconUri}" alt="">${connected ? '<span class="badge"></span>' : ''}</span>
      </div>
      <img class="page" src="${img(page)}" alt="">
    </div>`;
}

function head({ kicker = 'Watch Together', title, sub, top = 60 }) {
    return `<div class="head" style="top:${top}px">
      <span class="kicker"><img src="${iconUri}" alt="">${kicker}</span>
      <h1>${title}</h1>
      ${sub ? `<p class="sub">${sub}</p>` : ''}
    </div>`;
}

const popup = (name, x, y, extra = '') => `<div class="popup" style="left:${x}px;top:${y}px;${extra}"><img src="${img(name)}" alt=""></div>`;

const shots = [
    {
        file: 'screenshot-1-in-sync.png', w: 1280, h: 800,
        body: `
          ${head({ title: 'Watch videos in sync with a friend', sub: 'Works on any site with a video. One of you plays, pauses or seeks, and the other follows.' })}
          ${win({ x: 40, y: 226, w: 1200, page: 'page-wide.png', connected: true })}
          ${popup('popup-connected-dark.png', 892, 280)}
          <div class="credit">${CREDIT}</div>`,
    },
    {
        file: 'screenshot-2-pause-here.png', w: 1280, h: 800,
        body: `
          ${head({ title: 'Pause here, it pauses there', sub: 'Playback stays on the same frame for both of you.' })}
          ${win({ x: 40, y: 226, w: 604, page: 'page-narrow-a.png', connected: true })}
          ${win({ x: 676, y: 226, w: 604, page: 'page-narrow-b.png', connected: true })}
          <span class="label" style="left:60px;top:200px">Alice</span>
          <span class="label" style="left:696px;top:200px">Bob</span>
          <div class="credit">${CREDIT}</div>`,
    },
    {
        file: 'screenshot-3-room-code.png', w: 1280, h: 800,
        body: `
          ${head({ title: 'Create a room, share the code', sub: 'No accounts, no sign-up. One of you creates a room and reads out the nine-character code; the other joins with it.' })}
          ${popup('popup-start-dark.png', 90, 310)}
          ${popup('popup-waiting-dark.png', 470, 310)}
          ${popup('popup-join-dark.png', 850, 310)}
          <span class="label" style="left:90px;top:280px">1 · Create</span>
          <span class="label" style="left:470px;top:280px">2 · Share the code</span>
          <span class="label" style="left:850px;top:280px">3 · Join</span>`,
    },
    {
        file: 'screenshot-4-private.png', w: 1280, h: 800,
        body: `
          ${head({ title: 'Private by design', sub: '<span style="display:block;max-width:660px">Everything you exchange is encrypted end to end. The relay only forwards sealed bytes, keeps no history, and is never told the room code. Host your own relay if you prefer.</span>' })}
          ${popup('popup-settings-dark.png', 800, 56)}
          <div style="position:absolute;left:72px;top:330px;width:660px;display:grid;gap:18px">
            ${feature('End-to-end encrypted', 'Keys are agreed directly between the two of you and are never sent to the relay.')}
            ${feature('Nothing stored', 'The relay forwards messages as they arrive and keeps no record of them.')}
            ${feature('Bring your own relay', 'A small Cloudflare Worker you can deploy yourself; the built-in one works out of the box.')}
            ${feature('Open source', 'Extension and relay are GPL-3.0 on GitHub, so you can read exactly what they do.')}
          </div>`,
    },
    {
        file: 'screenshot-5-light-dark.png', w: 1280, h: 800,
        body: `
          ${head({ title: 'Light or dark, your call', sub: 'Follows your system theme, or pin the one you like. Sync this page only, all tabs, or switch it off while you keep the room open.' })}
          ${popup('popup-connected-light.png', 270, 300)}
          ${popup('popup-connected-dark.png', 670, 300)}`,
    },
];

function feature(title, text) {
    return `<div style="display:flex;gap:16px;align-items:flex-start">
      <span style="flex:none;width:40px;height:40px;border-radius:12px;background:rgba(60,207,122,0.16);color:#3ccf7a;display:flex;align-items:center;justify-content:center">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
      </span>
      <div><div style="font-size:20px;font-weight:600;color:#f4f5f7">${title}</div><div style="font-size:16px;color:#9aa1ab;margin-top:4px;line-height:1.45">${text}</div></div>
    </div>`;
}

// Promo tiles: brand only, no screenshots, no text beyond the name, saturated
// fill that reads on the store's light grey background.
function tile(w, h, iconSize, showName) {
    const nameSize = Math.round(iconSize * 0.34);
    return `<div class="canvas" style="width:${w}px;height:${h}px;background:
        radial-gradient(${w * 0.7}px ${h * 0.9}px at 20% 0%, #ff6a76 0%, transparent 70%),
        radial-gradient(${w * 0.6}px ${h * 0.8}px at 90% 100%, #b81a2e 0%, transparent 70%),
        linear-gradient(135deg, #e93a49 0%, #c81f33 100%);">
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:${Math.round(iconSize * 0.28)}px">
        <img src="${iconUri}" style="width:${iconSize}px;height:${iconSize}px;filter:drop-shadow(0 ${Math.round(iconSize * 0.08)}px ${Math.round(iconSize * 0.18)}px rgba(0,0,0,0.35))" alt="">
        ${showName ? `<div style="font-size:${nameSize}px;font-weight:700;letter-spacing:-0.02em;color:#fff;line-height:1.05;text-shadow:0 2px 12px rgba(0,0,0,0.25)">Watch<br>Together</div>` : ''}
      </div>
    </div>`;
}

const tiles = [
    { file: 'promo-small-440x280.png', w: 440, h: 280, html: tile(440, 280, 150, true) },
    { file: 'promo-marquee-1400x560.png', w: 1400, h: 560, html: tile(1400, 560, 300, true) },
];

(async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
    const page = await browser.newPage();
    // Any arguments narrow the run to files whose name contains one of them,
    // e.g. `node compose.js private` for screenshot-4-private.png only.
    const only = process.argv.slice(2);
    const jobs = [
        ...shots.map(s => ({ ...s, html: `<div class="canvas" style="width:${s.w}px;height:${s.h}px">${s.body}</div>` })),
        ...tiles,
    ].filter(job => only.length === 0 || only.some(part => job.file.includes(part)));
    if (jobs.length === 0) throw new Error('no image matches ' + only.join(', '));
    for (const job of jobs) {
        await page.setViewport({ width: job.w, height: job.h, deviceScaleFactor: 1 });
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
            <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=block">
            <style>${BASE_CSS}</style></head><body>${job.html}</body></html>`, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(
            // Only faces the page actually uses get loaded, and every job uses the bold one.
            () => document.fonts.check('700 44px Inter'),
            { timeout: 15000 },
        ).catch(() => { throw new Error('Inter did not load for ' + job.file); });
        const raw = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: job.w, height: job.h } });
        const out = path.join(OUT, job.file);
        await sharp(raw).flatten({ background: '#101114' }).removeAlpha().png({ compressionLevel: 9 }).toFile(out);
        const meta = await sharp(out).metadata();
        console.log(job.file, `${meta.width}x${meta.height}`, meta.channels + 'ch', meta.hasAlpha ? 'ALPHA' : 'no alpha');
    }
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
