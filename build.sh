#!/bin/bash
# Builds clean extension directories for Chrome and Firefox.
#   build/chrome/  — load as unpacked extension in Chrome
#   build/firefox/ — load as temporary extension in Firefox (about:debugging)
#                    or package with: web-ext build --source-dir build/firefox
set -e

build_common() {
    local OUT=$1
    rm -rf "$OUT"
    mkdir -p "$OUT"
    cp background.js content.js popup.html popup.js "$OUT/"
    cp -r external images static "$OUT/"
}

build_common build/chrome
cp manifest.json build/chrome/manifest.json
echo "Chrome build ready in build/chrome/"

build_common build/firefox
cp manifest.firefox.json build/firefox/manifest.json
echo "Firefox build ready in build/firefox/"
