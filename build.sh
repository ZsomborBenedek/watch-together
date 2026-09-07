#!/bin/bash
# Builds clean extension directories for Chrome and Firefox, and packages
# each as a store-ready zip.
#   build/chrome/  — load as unpacked extension in Chrome
#   build/firefox/ — load as temporary extension in Firefox (about:debugging)
#   web-ext-artifacts/watch_together-<version>-{chrome,firefox}.zip
#                  — upload to the Chrome Web Store / addons.mozilla.org
#
# The version in the filename is read from the manifest, so the two can never
# disagree. Both browsers run the same src/background.js; only the manifest
# differs.
set -e

ARTIFACTS=web-ext-artifacts

manifest_version() {
    sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' "$1" | head -n 1
}

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

# Zips from inside the build directory so manifest.json sits at the archive
# root, which both stores require. -X drops macOS resource forks; the
# exclusions keep .DS_Store and Finder metadata out.
package() {
    local DIR=$1
    local BROWSER=$2
    local VERSION
    VERSION=$(manifest_version "$DIR/manifest.json")
    if [ -z "$VERSION" ]; then
        echo "error: no version found in $DIR/manifest.json" >&2
        exit 1
    fi
    local ZIP="$ARTIFACTS/watch_together-$VERSION-$BROWSER.zip"
    mkdir -p "$ARTIFACTS"
    rm -f "$ZIP"
    (cd "$DIR" && zip -rXq "../../$ZIP" . -x '.*' '__MACOSX/*')
    echo "$BROWSER package: $ZIP"
}

CHROME_VERSION=$(manifest_version manifest.json)
FIREFOX_VERSION=$(manifest_version manifest.firefox.json)
if [ "$CHROME_VERSION" != "$FIREFOX_VERSION" ]; then
    echo "error: manifest.json is $CHROME_VERSION but manifest.firefox.json is $FIREFOX_VERSION" >&2
    exit 1
fi

build_common build/chrome manifest.json
echo "Chrome build ready in build/chrome/"
package build/chrome chrome

build_common build/firefox manifest.firefox.json
echo "Firefox build ready in build/firefox/"
package build/firefox firefox
