// Canonical connector configuration.
// Single source of truth for all client-side connectors (Chrome extension, Android APK).
//
// WHY THIS EXISTS:
// In the pre-Hetzner architecture, backend URLs and externally_connectable origins
// were hardcoded across multiple client files (manifest.json, background.js,
// MainActivity.kt). When production migrated to Hetzner, those client-side endpoints
// remained pointing to Vercel/Supabase, breaking extension detection and Android pairing.
//
// This module defines the authoritative production origin and allowed origins so that
// build scripts, packaging tools, and regression tests enforce strict parity.

/** The authoritative production origin for all new connector operations. */
export const CONNECTOR_PRODUCTION_ORIGIN = 'https://46-225-2-111.sslip.io';

/**
 * All allowed origins for connector communications:
 * 1. The authoritative production host
 * 2. The dedicated custom domain (for a future DNS cutover)
 *
 * The retired Vercel origin was the third entry until 2026-09-06. It was kept
 * "for backward compatibility with historical links", but an origin on this
 * list is not a link — it is permission to drive a user's extension and to be
 * answered by their connector. That deployment was still live and still
 * serving an older build of everything, so the entry was not compatibility, it
 * was a second front door into every paired device. Removing it is the point
 * of the cutover, not a side effect of it.
 */
export const CONNECTOR_ALLOWED_ORIGINS = [
  'https://46-225-2-111.sslip.io',
  'https://sunocoverbot.com',
];

/**
 * THE DESKTOP CONNECTOR IS FROZEN (owner's decision, 2026-10-06).
 *
 * The desktop connector (SunoCoverBotConnect.exe on Windows, the Terminal-
 * installed app on macOS) opens its own Chrome window with an EMPTY profile and
 * waits for a manual Suno sign-in there. The owner connects through the Chrome
 * extension only, which reads the existing session silently, and does not want
 * that window to appear in any form. It surfaced on 2026-10-06 when the connect
 * page mistook an installed-but-unreloaded extension for a missing one and
 * offered the connector instead.
 *
 * Frozen, not deleted: connector/ and its built artifacts stay in the repo, but
 * while this is false the connect page never offers it, never fires the
 * sunocoverbot:// link that launches it, and the server refuses to serve its
 * downloads. Turning it back on is this one line. The Android connector is a
 * different product and is not affected.
 */
export const DESKTOP_CONNECTOR_ENABLED = false;

/** Public files that exist only to install or run the desktop connector. */
export const DESKTOP_CONNECTOR_PUBLIC_FILES = [
  '/SunoCoverBotConnect.exe',
  '/SunoCoverBotConnect-mac.dmg',
  '/SunoCoverBotConnect-mac-intel.dmg',
  '/connect-mac.command',
  '/build-intel-connector.sh',
  '/connector-src.zip',
  '/connect.html',
];
