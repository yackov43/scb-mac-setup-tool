// JavaScript for Automation, executed by osascript. Uses native Accessibility; no Chrome AppleEvents.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function scbWindowIsOffscreen(position, size, screens) {
  const rect = [position && position[0], position && position[1], size && size[0], size && size[1]].map(Number);
  if (!rect.every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0 || !screens || !screens.length) return false;
  const [x, y, width, height] = rect, sliver = 64;
  // macOS never lets a window leave the displays entirely: moved far off, it is clamped so a strip stays on screen.
  // Measured on macOS 14.8 (1920x1080): (-32000,-32000) becomes (-960,25), a 40px strip at the left edge below the
  // menu bar; (5000,300) becomes (1880,300). Hidden therefore means: on EVERY display, at most a sliver shows.
  return screens.every(screen => {
    if (!Array.isArray(screen) || screen.length !== 4 || !screen.every(Number.isFinite) || screen[2] <= 0 || screen[3] <= 0) return false;
    const visibleWidth = Math.min(x + width, screen[0] + screen[2]) - Math.max(x, screen[0]);
    const visibleHeight = Math.min(y + height, screen[1] + screen[3]) - Math.max(y, screen[1]);
    return visibleWidth <= sliver || visibleHeight <= sliver;
  });
}
function run(argv) {
  const read = file => ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null));
  const request = JSON.parse(read(argv[0]));
  const write = value => $(JSON.stringify(value)).writeToFileAtomicallyEncodingError(argv[1], true, $.NSUTF8StringEncoding, null);
  const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const system = Application('System Events');
  const host = Application.currentApplication(); host.includeStandardAdditions = true;
  let owned = null, previous = null, process = null, address = null, currentUrl = null, geometry = null, step = 'accessibility', axApp = null;
  const checkpoint = name => { step = name; write({ ok: false, reason: 'native_step_incomplete', step, at: new Date().toISOString() }); };
  const wait = (fn, seconds = 12) => {
    const until = Date.now() + seconds * 1000;
    do { try { const result = fn(); if (result) return result; } catch (error) { if (error.message === 'native_pin_control_ambiguous') throw error; } delay(0.1); } while (Date.now() < until);
    throw Error('native_control_unavailable');
  };
  const attr = (element, name) => { try { return element.attributes.byName(name).value(); } catch (_) { return null; } };
  function byId(root, id) {
    const queue = [root]; let budget = 1800;
    while (queue.length && budget-- > 0) {
      const item = queue.shift();
      if (attr(item, 'AXIdentifier') === id || attr(item, 'AXDOMIdentifier') === id) return item;
      try { queue.push(...item.uiElements()); } catch (_) {}
    }
    return null;
  }
  const press = element => element.actions.byName('AXPress').perform();
  const label = value => String(value || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  function pinToggle(root) {
    const wanted = (request.pinLabels || []).map(label), queue = [root], matches = []; let budget = 1800;
    while (queue.length && budget-- > 0) {
      const item = queue.shift();
      if ((attr(item, 'AXIdentifier') === 'crToggle' || attr(item, 'AXDOMIdentifier') === 'crToggle') &&
          wanted.includes(label(attr(item, 'AXTitle') || attr(item, 'AXDescription')))) matches.push(item);
      try { queue.push(...item.uiElements()); } catch (_) {}
    }
    if (matches.length > 1) throw Error('native_pin_control_ambiguous');
    return matches[0] || null;
  }
  const sameAddress = (actual, expected) => {
    const a = String(actual || '').replace(/^(https?:\/\/)?/i, '').replace(/\/$/, '');
    const b = String(expected || '').replace(/^(https?:\/\/)?/i, '').replace(/\/$/, '');
    if (a === b || actual === expected) return true;
    // Chrome's Extensions page rewrites its own address and drops parameters it does not know (scb_setup=...), so the
    // owned window shows chrome://extensions[/?id=...] once there (measured, macOS 14.8 + 26). The window itself was
    // already proven by the nonce page; here it only has to be on the Extensions page.
    const page = v => String(v || '').split(/[?#]/)[0].replace(/\/$/, '').toLowerCase();
    return /^chrome:\/\/extensions/i.test(String(expected)) && page(actual) === page(expected);
  };
  function addressAt(root, expected) {
    const queue = [root]; let budget = 600;
    while (queue.length && budget-- > 0) {
      const item = queue.shift(), role = attr(item, 'AXRole');
      if (['AXTextField', 'AXComboBox', 'AXSearchField'].includes(role) && sameAddress(String(attr(item, 'AXValue') || ''), expected)) return item;
      try { queue.push(...item.uiElements()); } catch (_) {}
    }
    return null;
  }
  function hidden() {
    const native = $.NSScreen.screens, screens = [];
    if (Number(native.count) > 0) {
      const primary = native.objectAtIndex(0).frame;
      for (let i = 0; i < Number(native.count); i++) {
        const frame = native.objectAtIndex(i).frame;
        // AX positions start at the primary display's top left; AppKit screen frames start at its bottom left.
        screens.push([Number(frame.origin.x) - Number(primary.origin.x),
          Number(primary.origin.y) + Number(primary.size.height) - Number(frame.origin.y) - Number(frame.size.height),
          Number(frame.size.width), Number(frame.size.height)]);
      }
    }
    geometry = { position: owned.position(), size: owned.size(), screens };
    if (!scbWindowIsOffscreen(geometry.position, geometry.size, screens)) throw Error('background_window_guard_failed');
  }
  function ownedFocus() {
    if (!process.frontmost()) throw Error('native_focus_changed');
    hidden();
    let element = attr(process, 'AXFocusedWindow');
    for (let i = 0; element && i < 10; i++, element = attr(element, 'AXParent'))
      if (addressAt(element, currentUrl)) return;
    throw Error('native_focus_changed');
  }
  function focus() {
    owned.actions.byName('AXRaise').perform(); process.frontmost = true; ownedFocus();
  }
  function navigate(url) {
    try {
      focus();
      address.attributes.byName('AXFocused').value = true;
      address.value = url; currentUrl = url;
      ownedFocus(); system.keyCode(36);
      address = wait(() => addressAt(owned, url), 5);
    } finally { if (previous) previous.frontmost = true; }
  }
  function on(element) {
    if (Number(attr(element, 'AXValue')) !== 1) press(element);
    wait(() => Number(attr(element, 'AXValue')) === 1, 3);
  }
  try {
    checkpoint('accessibility');
    if (!system.uiElementsEnabled()) throw Error('mac_accessibility_permission_required');
    checkpoint('previous_application');
    previous = system.applicationProcesses.whose({ frontmost: true })()[0];
    const launch = /^http:\/\/127\.0\.0\.1:([0-9]+)\/native-setup\/([a-z0-9-]+)$/.exec(request.launchUrl || '');
    if (!launch || launch[2] !== request.nonce || Number(launch[1]) < 1 || Number(launch[1]) > 65535)
      throw Error('invalid_launch_proof');
    const url = 'chrome://extensions/?' + (request.installRequired ? '' : 'id=' + request.extensionId + '&') + 'scb_setup=' + request.nonce;
    const args = ['--user-data-dir=' + request.userData, '--profile-directory=' + request.profile, '--new-window',
      '--window-position=-32000,-32000', '--window-size=1000,760', '--force-renderer-accessibility',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check', request.launchUrl];
    checkpoint('launch');
    host.doShellScript(shellQuote(request.chrome) + ' ' + args.map(shellQuote).join(' ') + ' >/dev/null 2>&1 &');
    // System Events can inspect the nonce window without a Chrome scripting authorization or name-only auto-launch.
    // Several "Google Chrome" processes may run at once (this setup's own window is one), so the owner is the process
    // whose window shows the nonce page, never the first one with that name.
    checkpoint('owned_window');
    owned = wait(() => {
      checkpoint('owned_window_poll');
      for (const candidate of system.applicationProcesses.whose({ name: 'Google Chrome' })()) {
        let found = null;
        try {
          found = candidate.windows().find(window => {
            const field = addressAt(window, request.launchUrl);
            if (field) address = field;
            return !!field;
          });
        } catch (_) {}
        if (found) { process = candidate; checkpoint('owned_window_poll_done'); return found; }
      }
      checkpoint('owned_window_poll_done'); return null;
    }, 20);
    currentUrl = request.launchUrl;
    checkpoint('background_window');
    owned.position = [-32000, -32000]; owned.size = [1000, 760]; hidden();
    checkpoint('extensions_navigation');
    navigate(url);
    checkpoint('native_window');
    // A Chrome that was already running ignores --force-renderer-accessibility and shows Accessibility no page content,
    // so the Extensions page's switches are never found (native_control_unavailable, macOS 26 CI, 2026-11-04). Measured
    // on macOS 14.8 / Chrome 156: AXManualAccessibility is unsupported (-25205); AXEnhancedUserInterface turns the page
    // tree on (38 -> 665 elements). It is switched on only AFTER the navigation (measured: switched on before it, typing into the address bar no longer navigates), and back off when this step ends.
    checkpoint('page_accessibility');
    try { axApp = $.AXUIElementCreateApplication(process.unixId()); $.AXUIElementSetAttributeValue(axApp, $('AXEnhancedUserInterface'), $.NSNumber.numberWithBool(true)); } catch (_) { axApp = null; }
    const ax = owned;
    checkpoint('developer_mode');
    const dev = wait(() => byId(ax, 'devMode'), 30); // the page tree takes seconds to build once switched on
    if (request.developerModeRequired) on(dev);
    if (request.installRequired) {
    let load = byId(ax, 'loadUnpacked');
    if (!load) { on(dev); load = wait(() => byId(ax, 'loadUnpacked')); }
    checkpoint('folder_picker');
    press(load);
    const sheet = wait(() => ax.sheets()[0]);
    // The OS folder chooser uses the current process for its Go to Folder shortcut.
    // Focus is restored to its previous application as soon as the owned sheet is answered.
    try {
      focus();
      system.keystroke('g', { using: ['command down', 'shift down'] });
      const field = wait(() => {
        const sheets = sheet.sheets();
        if (sheets.length) return sheets[0].textFields()[0] || sheets[0].comboBoxes()[0];
        return sheet.textFields()[0] || sheet.comboBoxes()[0];
      });
      field.value = request.directory;
      ownedFocus(); system.keyCode(36); delay(0.2); ownedFocus(); system.keyCode(36);
    } finally { if (previous) previous.frontmost = true; }
    wait(() => ax.sheets().length === 0);
    checkpoint('details');
    navigate('chrome://extensions/?id=' + request.extensionId + '&scb_setup=' + request.nonce);
    }
    checkpoint('enable');
    if (request.enableRequired) on(wait(() => byId(ax, 'enableToggle')));
    checkpoint('pin');
    if (request.pinRequired) {
      on(wait(() => pinToggle(ax)));
    }
    // The engine separately requires independent signed runtime verification of the running build.
    write({ ok: true, extensionId: request.extensionId, version: request.version, profile: request.profile, pinned: true });
  } catch (error) {
    const message = String(error.message || error);
    const reason = /^[a-z_]+$/.test(message) ? message : /not authorized|-1743|assistive|accessibility/i.test(message)
      ? 'mac_accessibility_permission_required' : 'native_install_failed';
    write({ ok: false, reason, step, message, errorNumber: error.errorNumber || null, geometry });
  } finally {
    try { if (axApp) $.AXUIElementSetAttributeValue(axApp, $('AXEnhancedUserInterface'), $.NSNumber.numberWithBool(false)); } catch (_) {}
    try { if (previous) previous.frontmost = true; } catch (_) {}
    try {
      // A window may acquire additional user tabs during setup. Never close an entire browser window.
      if (owned && addressAt(owned, currentUrl)) {
        try {
          hidden();
          navigate('chrome://newtab/');
        } finally {
          if (addressAt(owned, currentUrl)) owned.attributes.byName('AXMinimized').value = true;
        }
      }
    } catch (_) {}
  }
}
