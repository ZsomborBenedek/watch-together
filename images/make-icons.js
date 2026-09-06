'use strict';

// Rasterises icon.svg into the PNG sizes the manifests reference. Needs
// sharp, picked up from wherever it is installed: a normal `npm install
// sharp` anywhere up the tree, or the copy that server/'s dependencies
// happen to pull in.
//
//   node images/make-icons.js
//
// Firefox can swap the toolbar icon with the theme (theme_icons in the
// manifest), so a slightly brighter variant is produced for dark themes; the
// standard one doubles as the light-theme icon.

const path = require('path');
const fs = require('fs');
function loadSharp() {
    const candidates = [
        'sharp',
        path.join(__dirname, '..', 'server', 'node_modules', 'sharp')
    ];
    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
        }
    }
    console.error(
        'sharp is not installed. Run `npm install sharp` in the repository root ' +
        '(or `npm install` in server/, whose dependencies include it) and retry.'
    );
    process.exit(1);
}

const sharp = loadSharp();

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
