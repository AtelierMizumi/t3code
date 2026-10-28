#!/usr/bin/env bash
# Build the local pacman package from a freshly built fork AppImage.
# Usage: zcode-maintenance/build-and-install.sh [path/to/T3-Code-<ver>-x86_64.AppImage]
#
# Produces t3code-bin-<epoch:ver>-1-x86_64.pkg.tar.zst in zcode-maintenance/packaging/build/.
# Installing requires root, which this script does not assume; it prints the
# exact pacman command when it cannot install by itself.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGING_DIR="$REPO_ROOT/zcode-maintenance/packaging"
BUILD_DIR="$PACKAGING_DIR/build"
# electron-builder writes to <repo>/release/ on Linux; older layout kept as fallback.
APPIMAGE="${1:-$REPO_ROOT/release/T3-Code-*-x86_64.AppImage}"
LICENSE="$REPO_ROOT/LICENSE"

shopt -s nullglob
APPIMAGE_PATHS=($APPIMAGE)
shopt -u nullglob
if [[ ${#APPIMAGE_PATHS[@]} -ne 1 ]]; then
  echo "Expected exactly one AppImage, found ${#APPIMAGE_PATHS[@]} for pattern: $APPIMAGE" >&2
  echo "Build one first:  pnpm dist:desktop:linux" >&2
  exit 1
fi
APPIMAGE_PATH="${APPIMAGE_PATHS[0]}"

PKGVER="$(node -p "require('$REPO_ROOT/apps/desktop/package.json').version")"
APPIMAGE_NAME="$(basename "$APPIMAGE_PATH")"
SHA256="$(sha256sum "$APPIMAGE_PATH" | cut -d' ' -f1)"
LICENSE_SHA256="$(sha256sum "$LICENSE" | cut -d' ' -f1)"

echo "==> pkgver $PKGVER, artifact $APPIMAGE_NAME (sha256 ${SHA256:0:12}...)"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cp "$APPIMAGE_PATH" "$BUILD_DIR/$APPIMAGE_NAME"
cp "$LICENSE" "$BUILD_DIR/LICENSE"

sed -e "s/__PKGVER__/$PKGVER/g" \
    -e "s/__APPIMAGE_NAME__/$APPIMAGE_NAME/g" \
    -e "s/__APPIMAGE_SHA256__/$SHA256/g" \
    -e "s/__LICENSE_SHA256__/$LICENSE_SHA256/g" \
    "$PACKAGING_DIR/PKGBUILD.template" > "$BUILD_DIR/PKGBUILD"

cd "$BUILD_DIR"
makepkg -f

PKGFILE="t3code-bin-1:${PKGVER}-1-x86_64.pkg.tar.zst"
if [[ ! -f "$PKGFILE" ]]; then
  PKGFILE="$(ls -t t3code-bin-*-x86_64.pkg.tar.zst | head -1)"
fi

echo
echo "==> Package ready: $BUILD_DIR/$PKGFILE"
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo pacman -U --noconfirm "$PKGFILE"
  echo "==> Installed. Verify with: pacman -Qi t3code-bin"
else
  echo "==> Install it with:"
  echo "    sudo pacman -U \"$BUILD_DIR/$PKGFILE\""
  echo
  echo "Back to the stock AUR build at any time:"
  echo "    sudo pacman -Rdd t3code-bin && paru -S t3code-bin"
fi
