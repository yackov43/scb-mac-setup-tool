// Quiet macOS install of the setup .app. The app ships as a .tar.gz (owner, 2026-10-26: "why a DMG when we have a command
// line?"): curl downloads it, so it never carries the quarantine flag a browser puts on a download, and there is no disk image
// to mount. The script verifies the published SHA-256, refuses an archive that holds anything but the app bundle, unpacks into
// ~/Applications (the place the setup tool looks, scripts/setup-tool/engine.mjs) and runs the core directly. No app or Terminal window
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
export function macSetupInstallScript(origin,{packages}={}) {
  const base = String(origin || '').replace(/\/$/, '');
  if (!ORIGIN_RE.test(base)) throw new Error('refusing install script origin');
  let download=MAC_DEFAULT_DOWNLOAD;
  if(packages){
    if(!Array.isArray(packages)||!packages.length||packages.length>2)throw Error('invalid_pinned_mac_package');
    const seen=new Set();
    const cases=packages.map(p=>{
      if(!['arm64','x64'].includes(p.architecture)||seen.has(p.architecture)||!/^\d+(\.\d+){1,3}$/.test(p.version||'')||
        !/^[a-f0-9]{64}$/.test(p.sha256||'')||!/^\/[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(p.url||'')||p.url.includes('..'))throw Error('invalid_pinned_mac_package');
      seen.add(p.architecture);
      return `  ${p.architecture}) expected='${p.sha256}'; scb_pinned_version='${p.version}'; scb_package_url='${base}${p.url}';;`;
    });
    download=`case "$scb_arch" in\n${cases.join('\n')}\n  *) echo 'SCB_ERROR: PACKAGE_ARCHITECTURE_UNAVAILABLE' >&2; exit 1;;\nesac\nprintf 'SunoCoverBotSetup v%s (%s)\\n' "$scb_pinned_version" "$scb_arch"\ncurl -fsSL --retry 3 --retry-delay 1 -o "$TMP/setup.tar.gz" "$scb_package_url"`;
  }
  return MAC_INSTALL_TEMPLATE.replace('__DOWNLOAD__',download)
    .replaceAll('__PKG__', `${base}${MAC_SETUP_PKG_PATH}`)
    .replaceAll('__SHA__', `${base}${MAC_SETUP_SHA_PATH}`)
    .replaceAll('__BASE__', base);
}

const MAC_DEFAULT_DOWNLOAD = String.raw`curl -fsSL --retry 3 --retry-delay 1 -o "$TMP/setup.sha256" "__SHA__?arch=$scb_arch"
expected=$(awk 'NR==1 { print $1; exit }' "$TMP/setup.sha256")
if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Could not read the published checksum." >&2
  exit 1
fi
short=$(printf '%.16s' "$expected")
curl -fsSL --retry 3 --retry-delay 1 -o "$TMP/setup.tar.gz" "__PKG__?v=$short&arch=$scb_arch"`;

const MAC_INSTALL_TEMPLATE = String.raw`#!/bin/bash
# Terminal-only install. The bundle registers URL schemes; setup runs through its CLI core.
set -euo pipefail
TMP=$(mktemp -d)
trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT
scb_arch=$(uname -m)
case "$scb_arch" in arm64) ;; x86_64) scb_arch=x64 ;; *) echo 'SCB_ERROR: UNSUPPORTED_ARCHITECTURE' >&2; exit 1 ;; esac
__DOWNLOAD__
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
chmod -R u+w "$TMP/unpacked" 2>/dev/null || true
APP="$TMP/unpacked/SunoCoverBotSetup.app"
if [[ ! -d "$APP" ]]; then
  echo "Setup app was not in the package." >&2
  exit 1
fi
# The core must run on this processor. An Intel Mac cannot start an Apple-silicon-only core, and a quiet
# "installed successfully" with nothing running is worse than saying so before anything is installed.
case "$scb_arch" in arm64) scb_slice=arm64 ;; *) scb_slice=x86_64 ;; esac
if ! /usr/bin/file -b "$APP/Contents/Resources/SunoCoverBotSetup-core" 2>/dev/null | grep -q "$scb_slice"; then
  echo 'SCB_ERROR: UNSUPPORTED_ARCHITECTURE' >&2
  echo "This setup package does not support this Mac's processor ($scb_slice) yet." >&2
  exit 1
fi
pkill -9 -f "SunoCoverBotSetup" 2>/dev/null || true
pkill -9 -f "scb-bridge" 2>/dev/null || true
# Target ~/Library/Application Support/SunoCoverBot/setup (instead of $HOME/Applications) avoids macOS TCC app management prompt
APP_SUPPORT="$HOME/Library/Application Support/SunoCoverBot/setup"
mkdir -p "$APP_SUPPORT"
rm -f "$APP_SUPPORT/setup-operation.json" "$APP_SUPPORT/cdp-bridge.ready" "$APP_SUPPORT/update-operation.json" 2>/dev/null || true
DEST="$APP_SUPPORT/SunoCoverBotSetup.app"
chmod +x "$APP/Contents/Resources/SunoCoverBotSetup-core" "$APP/Contents/MacOS/applet" 2>/dev/null || true
rm -rf "$APP/Contents/_CodeSignature" 2>/dev/null || true
rm -rf "$APP/Contents/_CodeSignature" 2>/dev/null || true
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep -s - "$APP" 2>/dev/null || true
codesign --verify --deep --strict "$APP" || { echo 'SCB_ERROR: MAC_SIGNATURE_REQUIRED' >&2; exit 1; }
chmod -R u+w "$DEST" 2>/dev/null || true
rm -rf "$DEST"
ditto "$APP" "$DEST"
chmod -R u+w "$DEST" 2>/dev/null || true
chmod +x "$DEST/Contents/Resources/SunoCoverBotSetup-core" "$DEST/Contents/MacOS/applet" 2>/dev/null || true
rm -rf "$DEST/Contents/_CodeSignature" 2>/dev/null || true
chmod -R u+w "$DEST" 2>/dev/null || true
rm -rf "$DEST/Contents/_CodeSignature" 2>/dev/null || true
xattr -cr "$DEST" 2>/dev/null || true
codesign --force --deep -s - "$DEST" 2>/dev/null || true
codesign --verify --deep --strict "$DEST" || { echo 'SCB_ERROR: MAC_SIGNATURE_REQUIRED' >&2; exit 1; }
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true
CORE="$DEST/Contents/Resources/SunoCoverBotSetup-core"
chmod +x "$CORE" 2>/dev/null || true
if [[ ! -x "$CORE" ]]; then
  echo 'SCB_ERROR: SETUP_CORE_MISSING' >&2
  exit 1
fi
APP_CORE="$APP_SUPPORT/SunoCoverBotSetup-core"
cp -f "$CORE" "$APP_CORE" 2>/dev/null || true
chmod +x "$APP_CORE" 2>/dev/null || true
CORE="$APP_CORE"

CHROME_PREF_ROOT="$HOME/Library/Application Support/Google/Chrome"
DETECTED_PROFILE=""
DETECTED_DIR=""
if [[ -d "$CHROME_PREF_ROOT" ]]; then
  for pdir in "$CHROME_PREF_ROOT"/Default "$CHROME_PREF_ROOT"/Profile*; do
    if [[ -d "$pdir" ]]; then
      pname=$(basename "$pdir")
      for pf in "$pdir/Preferences" "$pdir/Secure Preferences"; do
        if [[ -f "$pf" ]] && grep -q "geokjdngpomhdgjamobhgokjgphnjaed" "$pf" 2>/dev/null; then
          DETECTED_PROFILE="$pname"
          match_path=$(grep -o '"geokjdngpomhdgjamobhgokjgphnjaed"[^}]*"path":"[^"]*"' "$pf" 2>/dev/null | sed -E 's/.*"path":"([^"]*)".*/\1/' || true)
          if [[ -n "$match_path" && -d "$match_path" ]]; then
            DETECTED_DIR="$match_path"
          fi
          break 2
        fi
      done
    fi
  done
  if [[ -z "$DETECTED_PROFILE" && -f "$CHROME_PREF_ROOT/Local State" ]]; then
    last_used=$(grep -o '"last_used":"[^"]*"' "$CHROME_PREF_ROOT/Local State" 2>/dev/null | sed -E 's/.*"last_used":"([^"]*)".*/\1/' || true)
    if [[ -n "$last_used" && -d "$CHROME_PREF_ROOT/$last_used" ]]; then
      DETECTED_PROFILE="$last_used"
    fi
  fi
  if [[ -z "$DETECTED_PROFILE" ]]; then
    if [[ -d "$CHROME_PREF_ROOT/Default" ]]; then
      DETECTED_PROFILE="Default"
    else
      for pdir in "$CHROME_PREF_ROOT"/Profile*; do
        if [[ -d "$pdir" ]]; then
          DETECTED_PROFILE=$(basename "$pdir")
          break
        fi
      done
    fi
  fi
fi
[[ -z "$DETECTED_PROFILE" ]] && DETECTED_PROFILE="Default"
[[ -z "$DETECTED_DIR" ]] && DETECTED_DIR="$HOME/Library/Application Support/SunoCoverBot/extension"

echo "Installing Suno CoverBot Extension..."
mkdir -p "$TMP/ext"
curl -fsSL --retry 3 --retry-delay 1 -o "$TMP/ext.zip" "__BASE__/scb-extension.zip" 2>/dev/null || true
if [[ -f "$TMP/ext.zip" ]]; then
  unzip -q -o "$TMP/ext.zip" -d "$TMP/ext" 2>/dev/null || true
  for target in "$HOME/Library/Application Support/SunoCoverBot/extension" "$HOME/Documents/SunoCoverBot/extension" "$DETECTED_DIR"; do
    mkdir -p "$target"
    cp -R "$TMP/ext/"* "$target/" 2>/dev/null || true
  done
  if [[ -d "$CHROME_PREF_ROOT" ]]; then
    while IFS= read -r pref_file; do
      match_path=$(grep -o '"geokjdngpomhdgjamobhgokjgphnjaed"[^}]*"path":"[^"]*"' "$pref_file" 2>/dev/null | sed -E 's/.*"path":"([^"]*)".*/\1/' || true)
      if [[ -n "$match_path" && -d "$match_path" ]]; then
        mkdir -p "$match_path"
        cp -R "$TMP/ext/"* "$match_path/" 2>/dev/null || true
      fi
    done < <(find "$CHROME_PREF_ROOT" -maxdepth 3 \( -name "Preferences" -o -name "Secure Preferences" \) 2>/dev/null)
  fi
  while IFS= read -r manifest_file; do
    dir=$(dirname "$manifest_file")
    if grep -q "geokjdngpomhdgjamobhgokjgphnjaed" "$manifest_file" 2>/dev/null || grep -q "Suno Downloader" "$manifest_file" 2>/dev/null; then
      cp -R "$TMP/ext/"* "$dir/" 2>/dev/null || true
    fi
  done < <(find "$HOME/Documents" "$HOME/Downloads" "$HOME/Desktop" "$HOME/Library/Application Support" -maxdepth 4 -name "manifest.json" 2>/dev/null)
  mkdir -p "$APP_SUPPORT"
  cat <<EOF_UPDATER > "$APP_SUPPORT/updater.json"
{
  "base": "__BASE__",
  "directory": "$DETECTED_DIR",
  "userData": "$HOME/Library/Application Support/Google/Chrome",
  "profile": "$DETECTED_PROFILE",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvf144CDL9IZrSvkgOSsTBkIJ5DKBIY8fcnwWaKzVgAy+rJ/+wyptRwM1LBqIPJIukGaVN/Yyizf4ljQtTVC7JD/xpIytvjPei36/DPO/RMXZWL9p5y3HA4hDP6txP39VRgoMfWQLtxZP/K3aiFuLgXJrA4FEVmaOIm9bdRnuTpy17RjnfpyDF5Liiyy9Ee8anEmlRBjk4VgT3sX140OWBjfNlqks30SCS+AM30iXGbGI9g2OqxjsTogkQ4p+QUMz1gi3ReRyIOJ7QpwoNHMMVt5i+jlRiqXylTgHtwj4rXz5/ks8GPJouQsL2KS18Oq+3oCNZjamq9PI+hN/3gxlmwIDAQAB"
}
EOF_UPDATER
fi

# Each Mac mints its OWN updater identity (the setup core does it on first run) and the setup engine writes the extension
# marker from that identity. This script must never pre-seed either. Between 2026-11-03 and 2026-11-04 it did: every Mac got
# one shared identity whose private key was published inside this script. Retire that identity and its markers wherever an
# earlier run left them, so this run mints a fresh one.
SCB_RETIRED_ID="e600e46c-07f6-4d65-bf69-0a04b6c77b60"
if grep -q "$SCB_RETIRED_ID" "$APP_SUPPORT/monitor-identity.json" 2>/dev/null; then
  rm -f "$APP_SUPPORT/monitor-identity.json"
fi
while IFS= read -r marker_file; do
  if grep -q "$SCB_RETIRED_ID" "$marker_file" 2>/dev/null; then rm -f "$marker_file"; fi
done < <(find "$HOME/Documents" "$HOME/Downloads" "$HOME/Desktop" "$HOME/Library/Application Support" -maxdepth 4 -name "scb-native-updater.json" 2>/dev/null)

ENT="$TMP/ent.plist"
cat <<'EOF_ENT' > "$ENT"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
EOF_ENT
codesign --force --entitlements "$ENT" --sign - "$CORE" 2>/dev/null || codesign --force --sign - "$CORE" 2>/dev/null || true
codesign --force --entitlements "$ENT" --sign - "$DEST/Contents/Resources/SunoCoverBotSetup-core" 2>/dev/null || true

LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_AGENT_DIR"
launchctl bootout "gui/$(id -u)/io.sslip.sunocoverbot.update" 2>/dev/null || true
launchctl unload "$LAUNCH_AGENT_DIR/io.sslip.sunocoverbot.update.plist" 2>/dev/null || true
cat <<EOF_PLIST > "$LAUNCH_AGENT_DIR/io.sslip.sunocoverbot.update.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.sslip.sunocoverbot.update</string>
  <key>ProgramArguments</key>
  <array><string>$CORE</string><string>--update</string></array>
  <key>RunAtLoad</key><false/>
  <key>StartInterval</key><integer>900</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$APP_SUPPORT/launchd.log</string>
  <key>StandardErrorPath</key><string>$APP_SUPPORT/launchd.log</string>
</dict>
</plist>
EOF_PLIST
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_DIR/io.sslip.sunocoverbot.update.plist" 2>/dev/null || launchctl load -w "$LAUNCH_AGENT_DIR/io.sslip.sunocoverbot.update.plist" 2>/dev/null || true

echo "Installing Suno CoverBot Setup..."
# Runs right here in this Terminal (no extra windows): every step, and the one or two clicks Chrome asks for, are printed
# here in the person's language. Chrome is never closed or restarted.
"$CORE" --headless --progress || true
`;
