#!/usr/bin/env sh
# Install dev-dashboard to ~/.local/bin (no sudo).
#   curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh
# Env: VERSION=vX.Y.Z (default: latest), BIN_DIR (default: ~/.local/bin), DRY_RUN=1
set -eu

REPO="diagridio/dev-dashboard"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "unsupported OS: $os (use scripts/install.ps1 on Windows)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -n1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
fi
[ -n "$VERSION" ] || { echo "could not resolve latest version" >&2; exit 1; }

num="${VERSION#v}"
file="dev-dashboard_${num}_${os}_${arch}.tar.gz"
url="https://github.com/$REPO/releases/download/$VERSION/$file"

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "$url"
  exit 0
fi

echo "downloading $file …"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/$file"
tar -xzf "$tmp/$file" -C "$tmp"
mkdir -p "$BIN_DIR"
install -m 0755 "$tmp/dev-dashboard" "$BIN_DIR/dev-dashboard"
echo "installed dev-dashboard $VERSION → $BIN_DIR/dev-dashboard"

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "note: $BIN_DIR is not on your PATH. Add it:"; echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
