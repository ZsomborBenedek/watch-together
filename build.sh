#!/bin/bash
# Builds clean extension directories for Chrome and Firefox.
#   build/chrome/  — load as unpacked extension in Chrome
#   build/firefox/ — load as temporary extension in Firefox (about:debugging)
#                    or package with: web-ext build --source-dir build/firefox
set -e

build_common() {
    local OUT=$1
    rm -rf "$OUT"
    mkdir -p "$OUT/src"
    cp -r external images static "$OUT/"
    cp src/content.js src/popup.html src/popup.js "$OUT/src/"
}

build_common build/chrome
cp manifest.json build/chrome/manifest.json
cp src/background.js src/offscreen.html src/offscreen.js build/chrome/src/
echo "Chrome build ready in build/chrome/"

build_common build/firefox
cp manifest.firefox.json build/firefox/manifest.json
cp src/background.firefox.js build/firefox/src/
echo "Firefox build ready in build/firefox/"
