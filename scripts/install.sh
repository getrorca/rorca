#!/bin/sh
# Rorca user installer — macOS & Linux
# Usage: curl -fsSL https://get.rorca.app | sh
#        RORCA_VERSION=v0.2.0 RORCA_INSTALL_DIR="$HOME/bin" sh install.sh
# This installer never invokes sudo or changes services. Existing binaries are
# retained as rorca.previous for an operator-controlled rollback.
set -eu

REPO="getrorca/rorca"
VERSION="${RORCA_VERSION:-latest}"
INSTALL_DIR="${RORCA_INSTALL_DIR:-${HOME}/.local/bin}"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) OS_TAG="darwin" ;;
  Linux) OS_TAG="linux" ;;
  *) echo "Error: Unsupported OS: $OS" >&2; exit 1 ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH_TAG="x64" ;;
  arm64|aarch64) ARCH_TAG="arm64" ;;
  *) echo "Error: Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

BINARY="rorca-${OS_TAG}-${ARCH_TAG}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"
fi

mkdir -p "$INSTALL_DIR"
if [ ! -w "$INSTALL_DIR" ]; then
  echo "Error: install directory is not writable: $INSTALL_DIR" >&2
  echo "Choose a user-owned directory with RORCA_INSTALL_DIR. This installer never invokes sudo." >&2
  exit 1
fi

STAGED="${INSTALL_DIR}/.rorca.new.$$"
DESTINATION="${INSTALL_DIR}/rorca"
PREVIOUS="${INSTALL_DIR}/rorca.previous"
cleanup() { rm -f "$STAGED"; }
trap cleanup EXIT HUP INT TERM

echo "Downloading Rorca (${OS_TAG}/${ARCH_TAG}) from ${URL}..."
if command -v curl >/dev/null 2>&1; then
  curl -fSL -o "$STAGED" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$STAGED" "$URL"
else
  echo "Error: curl or wget is required." >&2
  exit 1
fi
chmod 755 "$STAGED"

# Verify the staged artifact before replacing a working installation. No
# provider, editor, database, or service process is started by this check.
if ! "$STAGED" --version >/dev/null 2>&1; then
  echo "Error: downloaded Rorca artifact failed its version check." >&2
  exit 1
fi

if [ -e "$DESTINATION" ]; then
  rm -f "$PREVIOUS"
  mv "$DESTINATION" "$PREVIOUS"
fi
if ! mv "$STAGED" "$DESTINATION"; then
  [ ! -e "$PREVIOUS" ] || mv "$PREVIOUS" "$DESTINATION"
  echo "Error: installation failed; the previous binary was restored." >&2
  exit 1
fi

INSTALLED_VERSION="$("$DESTINATION" --version 2>/dev/null || true)"
echo "Rorca ${INSTALLED_VERSION} installed to ${DESTINATION}"
[ ! -e "$PREVIOUS" ] || echo "Previous binary retained at ${PREVIOUS}"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "Add ${INSTALL_DIR} to PATH: export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
echo "No service was registered or started. Run 'rorca start' explicitly when ready."
