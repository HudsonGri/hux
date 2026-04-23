#!/bin/sh
# hux installer — curl -fsSL https://hux.sh | sh
set -eu

REPO="HudsonGri/hux"
BIN_DIR="${HUX_BIN_DIR:-$HOME/.local/bin}"
LIBEXEC_DIR="${HUX_LIBEXEC_DIR:-$HOME/.hux/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'hux: %s\n' "$*" >&2; exit 1; }

uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
  Darwin)
    case "$uname_m" in
      arm64|aarch64) slug="darwin-arm64" ;;
      x86_64)        slug="darwin-x86_64" ;;
      *)             die "unsupported arch $uname_m on $uname_s" ;;
    esac ;;
  Linux)
    case "$uname_m" in
      x86_64)        slug="linux-x86_64" ;;
      aarch64|arm64) slug="linux-aarch64" ;;
      *)             die "unsupported arch $uname_m on $uname_s" ;;
    esac ;;
  *) die "unsupported OS $uname_s" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl not found"
command -v tar  >/dev/null 2>&1 || die "tar not found"

tag="${HUX_VERSION:-}"
if [ -z "$tag" ]; then
  say "finding latest hux release..."
  tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$tag" ] || die "could not find a release. see https://github.com/${REPO}/releases"
fi

asset="hux-${slug}.tar.gz"
url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

tmp=$(mktemp -d -t hux-install.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

say "downloading ${tag} (${slug})..."
curl -fsSL "$url" -o "$tmp/hux.tar.gz" || die "download failed: $url"

curl -fsSL "${url}.sha256" -o "$tmp/hux.tar.gz.sha256" || die "checksum download failed"
expected=$(awk '{print $1}' "$tmp/hux.tar.gz.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/hux.tar.gz" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/hux.tar.gz" | awk '{print $1}')
fi
[ "$expected" = "$actual" ] || die "checksum mismatch (expected $expected, got $actual)"

tar -xzf "$tmp/hux.tar.gz" -C "$tmp"
[ -f "$tmp/hux" ] || die "tarball missing client binary"

mkdir -p "$BIN_DIR"
install -d -m 0700 "$LIBEXEC_DIR"
install -m 0755 "$tmp/hux" "$BIN_DIR/hux"
[ -f "$tmp/hux-server" ] && install -m 0755 "$tmp/hux-server" "$LIBEXEC_DIR/hux-server"
[ -f "$tmp/hux-drag-daemon"      ] && install -m 0755 "$tmp/hux-drag-daemon"      "$LIBEXEC_DIR/hux-drag-daemon"

# strip gatekeeper quarantine so unsigned binaries run without the warning dialog
xattr -dr com.apple.quarantine "$BIN_DIR/hux" "$LIBEXEC_DIR" 2>/dev/null || true

say ""
say "hux ${tag} installed to ${BIN_DIR}/hux"

case ":$PATH:" in
  *:"$BIN_DIR":*) ;;
  *)
    shell_rc=""
    case "${SHELL:-}" in
      */zsh)  shell_rc="$HOME/.zshrc" ;;
      */bash) shell_rc="$HOME/.bashrc" ;;
      */fish) shell_rc="$HOME/.config/fish/config.fish" ;;
    esac
    say ""
    say "  note: ${BIN_DIR} is not on your PATH."
    if [ -n "$shell_rc" ]; then
      say "        add this to ${shell_rc}:"
    else
      say "        add this to your shell rc:"
    fi
    say ""
    say "    export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

say ""
say "run 'hux' to start. run 'hux update' to upgrade later."
