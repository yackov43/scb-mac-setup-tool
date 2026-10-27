// Quiet macOS install of the setup .app. The app ships as a .tar.gz (owner, 2026-10-26: "why a DMG when we have a command
// line?"): curl downloads it, so it never carries the quarantine flag a browser puts on a download, and there is no disk image
// to mount. The script verifies the published SHA-256, refuses an archive that holds anything but the app bundle, unpacks into
// ~/Applications (the place the setup tool looks, scripts/setup-tool/engine.mjs) and opens only that app. No Terminal window
// is launched from here; the page only copies this one-liner into the Terminal the user already opened.
import { CONNECTOR_ALLOWED_ORIGINS, CONNECTOR_PRODUCTION_ORIGIN } from './connectorConfig.js';

// Keep the path identical to SETUP_TOOL_URL_MAC in api/connect.js (test pins both). The cache-buster after ?v= is taken from
// the published checksum at install time, so republishing the package never needs a script change.
export const MAC_SETUP_PKG_PATH = '/SunoCoverBotSetup-mac.tar.gz';
export const MAC_SETUP_SHA_PATH = '/SunoCoverBotSetup-mac.tar.gz.sha256';

const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+$/;

export function macSetupScriptOrigin(hostHeader) {
  const raw = String(hostHeader || '').split(',')[0].trim().toLowerCase();
  const host = raw.replace(/:\d+$/, '');
  if (!/^[a-z0-9.-]+$/.test(host)) return CONNECTOR_PRODUCTION_ORIGIN;
  for (const origin of CONNECTOR_ALLOWED_ORIGINS) {
    let allowed = '';
    try { allowed = new URL(origin).host; } catch { continue; }
    if (allowed === host) return `https://${host}`;
  }
  return CONNECTOR_PRODUCTION_ORIGIN;
}

/** Bash script. `origin` must be an allowlisted https origin with no path. */
export function macSetupInstallScript(origin) {
  const base = String(origin || '').replace(/\/$/, '');
  if (!ORIGIN_RE.test(base)) throw new Error('refusing install script origin');
  return MAC_INSTALL_TEMPLATE
    .replaceAll('__PKG__', `${base}${MAC_SETUP_PKG_PATH}`)
    .replaceAll('__SHA__', `${base}${MAC_SETUP_SHA_PATH}`);
}

const MAC_INSTALL_TEMPLATE = String.raw`#!/bin/bash
# Install Suno CoverBot Setup. Unpack the app into ~/Applications, then open only the app.
set -euo pipefail
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL --retry 3 --retry-delay 1 -o "$TMP/setup.sha256" '__SHA__'
expected=$(awk 'NR==1 { print $1; exit }' "$TMP/setup.sha256")
if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Could not read the published checksum." >&2
  exit 1
fi
short=$(printf '%.16s' "$expected")
curl -fsSL --retry 3 --retry-delay 1 -o "$TMP/setup.tar.gz" "__PKG__?v=$short"
xattr -d com.apple.quarantine "$TMP/setup.tar.gz" >/dev/null 2>&1 || true
actual=$(shasum -a 256 "$TMP/setup.tar.gz" | awk '{ print $1; exit }')
if [[ "$actual" != "$expected" ]]; then
  echo "Setup download did not match the published checksum." >&2
  exit 1
fi
# Only the app bundle may come out of the archive, and nothing may point outside it.
while IFS= read -r entry; do
  case "$entry" in
    *..*|/*) echo "Setup package has an unexpected path." >&2; exit 1 ;;
    SunoCoverBotSetup.app|SunoCoverBotSetup.app/*) ;;
    *) echo "Setup package has an unexpected entry." >&2; exit 1 ;;
  esac
done < <(tar -tzf "$TMP/setup.tar.gz")
mkdir -p "$TMP/unpacked"
tar -xzf "$TMP/setup.tar.gz" -C "$TMP/unpacked"
APP="$TMP/unpacked/SunoCoverBotSetup.app"
if [[ ! -d "$APP" ]]; then
  echo "Setup app was not in the package." >&2
  exit 1
fi
mkdir -p "$HOME/Applications"
DEST="$HOME/Applications/SunoCoverBotSetup.app"
rm -rf "$DEST"
ditto "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true
open "$DEST"
`;
