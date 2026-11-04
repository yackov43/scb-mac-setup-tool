// Read-only readiness checks for the customer's existing Chrome. No CDP, browser restarts or preference edits.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE, chromeInstalls } from './lib.mjs';
import { nativeHeartbeat, nativeIdentity, nativeDirectoryScope, approvedComponent, schedulerHealth } from './update-control.mjs';
import { installedVersion } from '../setup-pilot/install-package.mjs';
import {collectRuntimeDiagnostics} from './runtime-diagnostics.mjs';

export function selectExtensionDirectory({ home, installs, fallback, read = file => readFileSync(file, 'utf8') }) {
  let config;
  try { config = JSON.parse(read(path.join(home, 'updater.json')).replace(/^\uFEFF/, '')); } catch (error) { if (error.code !== 'ENOENT') throw Error('invalid_updater_config'); }
  if (config?.directory) {
    if (!path.isAbsolute(config.directory)) throw Error('invalid_directory');
    return config.directory;
  }
  const unique = new Map(installs.map(c => [path.resolve(c.path).toLowerCase(), c.path]));
  if (unique.size > 1) throw Error('chrome_profile_selection_required');
  return unique.values().next().value || fallback;
}

export function createChromeVerifier({ home, toolVersion, deps = {} }) {
  const d = { chromeInstalls, nativeHeartbeat, nativeIdentity, nativeDirectoryScope, approvedComponent, schedulerHealth, installedVersion, collectRuntimeDiagnostics, now: Date.now, platform: process.platform, ...deps };
  let last = null;
  const flights=new Map();
  return async (directory, { expectedVersion, userData, profile } = {}) => {
    const scopeKey=JSON.stringify([userData||'',profile||'']);
    const flightKey=JSON.stringify([directory,expectedVersion,scopeKey]);
    if (last && d.now() - last.at < 15_000 && last.directory === directory && last.expectedVersion === expectedVersion && last.scopeKey===scopeKey) return last.result;
    if (flights.has(flightKey)) return flights.get(flightKey);
    const flight = (async () => {
      const same = c => path.resolve(c.path).toLowerCase() === path.resolve(directory).toLowerCase();
      const matches=d.chromeInstalls(userData).filter(same);
      const profiles = matches.filter(item=>!profile||item.profile===profile);
      let result;
      if (!profiles.length) result = { ok: false, reason: 'extension_missing' };
      else if (profiles.length !== 1 || matches.length!==1) result = { ok: false, reason: 'chrome_profile_selection_required', userActionRequired: true };
      else if (profiles[0].enabled === false) result = { ok: false, reason: 'extension_disabled' };
      else if (profiles[0].developerMode === false) result = { ok: false, reason: 'developer_mode_off' };
      // A brand-new Mac whose extension was added by hand is not pinned yet; pinning is cosmetic there (see below).
      else if (!profiles[0].pinned && !(d.platform === 'darwin' && !d.nativeIdentity(home).accepted_at)) result = { ok: false, reason: 'extension_not_pinned', userActionRequired: true };
      else try {
        let diagnostic;try{diagnostic=d.collectRuntimeDiagnostics({directory,userData,installationId:d.nativeIdentity(home).installation_id});}catch{}
        const response = await d.nativeHeartbeat({ home, base: BASE, report: {
          updater_version: toolVersion, installed_version: d.installedVersion(directory) || '', updater_health: d.schedulerHealth(home),
          directory_scope:d.nativeDirectoryScope(home,directory),
          ...(diagnostic?{native_diagnostics:diagnostic}:{}),
        } });
        const component = response.target ? d.approvedComponent(response.target.envelope) : null;
        result = ['CURRENT', 'UPDATED'].includes(response.state) && (!component || component.version === expectedVersion)
          ? { ok: true, version: component?.version || expectedVersion, profile: profiles[0].profile }
          : { ok: false, reason: 'runtime_not_verified', userActionRequired: true };
      } catch(error) {
        // A brand-new Mac cannot be enrolled yet: the extension enrolls this tool's identity only after the person
        // connects it (step 5), so the server answers 401 to everything before that. Until the server has accepted this
        // identity even once, Chrome's own record above (registered from exactly this folder, enabled, developer mode,
        // pinned) plus the folder's exact version is the evidence for step 4; the running build is verified
        // independently after pairing. An identity the server accepted before and now refuses (revoked, clock,
        // signature) is a real failure, never a first install. Windows keeps its existing behaviour.
        const firstInstall = d.platform === 'darwin' && !d.nativeIdentity(home).accepted_at && error?.message === 'NOT_ENROLLED';
        if (firstInstall) {
          const localVer = d.installedVersion(directory);
          result = expectedVersion && localVer === expectedVersion
            ? { ok: true, version: localVer, profile: profiles[0].profile, verification: 'chrome_registration' }
            : { ok: false, reason: 'runtime_version_mismatch', userActionRequired: true };
        } else {
          result = { ok: false, reason: error?.message==='CONTROL_HTTP_429'?'control_rate_limited':'runtime_not_verified', userActionRequired: error?.message!=='CONTROL_HTTP_429' };
        }
      }
      last = { at: d.now(), directory, expectedVersion, scopeKey, result }; return result;
    })().finally(() => { flights.delete(flightKey); });
    flights.set(flightKey,flight);
    return flight;
  };
}
