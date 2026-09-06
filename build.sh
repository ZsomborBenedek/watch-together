#!/bin/bash
# Builds clean extension directories for Chrome and Firefox.
#   build/chrome/  — load as unpacked extension in Chrome
#   build/firefox/ — load as temporary extension in Firefox (about:debugging)
#                    or package with: web-ext build --source-dir build/firefox
#
# Both browsers run the same src/background.js; only the manifest differs.
set -e

build_common() {
    local OUT=$1
    local MANIFEST=$2
    rm -rf "$OUT"
    mkdir -p "$OUT/src" "$OUT/images"

    # Every icon the manifests use is a PNG, so this glob ships all of them
    # while leaving icon.svg and make-icons.js behind. Keep non-icon PNGs
    # (store screenshots, promo tiles) out of images/ or they ship too.
    cp images/*.png "$OUT/images/"
    cp -r static "$OUT/"
    cp src/background.js src/content.js src/popup.html src/popup.js "$OUT/src/"
    cp "$MANIFEST" "$OUT/manifest.json"
}

build_common build/chrome manifest.json
echo "Chrome build ready in build/chrome/"

build_common build/firefox manifest.firefox.json
echo "Firefox build ready in build/firefox/"
