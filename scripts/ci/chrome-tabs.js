// CI only: what Chrome shows right now - window titles, tab titles, and any button named "Allow" (an approval dialog).
//   osascript -l JavaScript scripts/ci/chrome-tabs.js
function run() {
  const p = Application('System Events').processes.byName('Google Chrome');
  const out = { windows: [], tabs: [], allowButtons: 0 };
  try {
    for (const w of p.windows()) {
      out.windows.push(String(w.name()));
      for (const e of w.entireContents()) {
        try {
          const role = e.role();
          if (role === 'AXRadioButton' || role === 'AXTab') out.tabs.push(String(e.name() || e.title() || e.description() || ''));
          if (role === 'AXButton' && /^allow$/i.test(String(e.name() || e.description() || ''))) out.allowButtons++;
        } catch (_) {}
      }
    }
  } catch (error) { out.error = String(error); }
  return JSON.stringify(out);
}
