'use strict';

// Rasterises icon.svg into the PNG sizes the manifests reference. Uses the
// sharp that server/ already depends on, so there is nothing extra to
// install:
//
//   node images/make-icons.js
//
// Firefox can swap the toolbar icon with the theme (theme_icons in the
// manifest), so a slightly brighter variant is produced for dark themes; the
// standard one doubles as the light-theme icon.

const path = require('path');
const fs = require('fs');
const sharp = require(path.join(__dirname, '..', 'server', 'node_modules', 'sharp'));

const SIZES = [16, 32, 48, 64, 128];
const THEME_SIZES = [16, 32, 64];

const source = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
// Same shape, lifted a touch so it does not sink into a dark toolbar.
const forDarkTheme = source
    .replace('#ff5f6d', '#ff7a85')
    .replace('#d9243a', '#ef3a4c');

async function render(svg, size, file) {
    await sharp(Buffer.from(svg), { density: 1200 })
        .resize(size, size)
        .png({ compressionLevel: 9 })
        .toFile(path.join(__dirname, file));
    console.log('wrote', file);
}

(async () => {
    for (const size of SIZES) {
        await render(source, size, `icon${size}.png`);
    }
    for (const size of THEME_SIZES) {
        await render(forDarkTheme, size, `icon${size}-light.png`);
    }
})().catch(error => {
    console.error(error);
    process.exit(1);
});
