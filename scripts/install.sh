#!/bin/sh
# Rorca installer — macOS & Linux
# Usage: curl -fsSL https://get.rorca.app | sh
#        RORCA_VERSION=v0.2.0 curl -fsSL https://get.rorca.app | sh
set -eu

REPO="sysgazer/rorca"
VERSION="${RORCA_VERSION:-latest}"

# ── Detect OS & arch ──
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_TAG="darwin" ;;
  Linux)  OS_TAG="linux" ;;
  *)      echo "Error: Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)     ARCH_TAG="x64" ;;
  arm64|aarch64)     ARCH_TAG="arm64" ;;
  *)                 echo "Error: Unsupported architecture: $ARCH"; exit 1 ;;
esac

BINARY="rorca-${OS_TAG}-${ARCH_TAG}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY}"
fi

echo "Installing Rorca (${OS_TAG}/${ARCH_TAG})..."
# ── Pick download tool ──
if command -v curl >/dev/null 2>&1; then
  DOWNLOAD="curl -fSL -o"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD="wget -q -O"
else
  echo "Error: curl or wget required. Install one and retry."
  exit 1
fi

# ── Download to temp file ──
TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT

echo "Downloading ${URL}..."
if ! $DOWNLOAD "$TMPFILE" "$URL"; then
  echo "Error: Download failed. Check your network connection and that the release exists."
  rm -f "$TMPFILE"
  exit 1
fi
chmod +x "$TMPFILE"
# ── Install binary ──
INSTALL_DIR="/usr/local/bin"
INSTALLED=0

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/rorca"
  INSTALLED=1
else
  # Try sudo
  if command -v sudo >/dev/null 2>&1; then
    echo "Need sudo to install to ${INSTALL_DIR}..."
    if sudo mv "$TMPFILE" "${INSTALL_DIR}/rorca" && sudo chmod +x "${INSTALL_DIR}/rorca"; then
      INSTALLED=1
    fi
  fi
fi

# Fallback to ~/.local/bin (no sudo needed)
if [ "$INSTALLED" -eq 0 ]; then
  INSTALL_DIR="${HOME}/.local/bin"
  mkdir -p "$INSTALL_DIR"
  mv "$TMPFILE" "${INSTALL_DIR}/rorca"
  chmod +x "${INSTALL_DIR}/rorca"

  # Warn if not in PATH
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *) echo "Note: Add ${INSTALL_DIR} to your PATH:"
       echo "  export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
  esac
fi

# ── Verify ──
INSTALLED_VERSION="$("${INSTALL_DIR}/rorca" --version 2>/dev/null || echo "")"
echo ""
if [ -n "$INSTALLED_VERSION" ]; then
  echo "Rorca ${INSTALLED_VERSION} installed to ${INSTALL_DIR}/rorca"
else
  echo "Rorca installed to ${INSTALL_DIR}/rorca"
fi
echo ""
echo "Get started:"
echo "  rorca start"
