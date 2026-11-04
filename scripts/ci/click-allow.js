// CI only: stands in for the PERSON clicking "Allow" in Chrome's "Allow remote debugging?" dialog. The runner has
// Accessibility for this; the product itself never needs it.   osascript -l JavaScript scripts/ci/click-allow.js <seconds>
function run(argv) {
  const secs = Number(argv[0] || 60);
  const p = Application('System Events').processes.byName('Google Chrome');
  for (let t = 0; t < secs * 2; t++) {
    try {
      for (const w of p.windows()) for (const e of w.entireContents()) {
        try { if (e.role() === 'AXButton' && /^allow$/i.test(String(e.name() || e.description() || ''))) { e.click(); return 'CLICKED Allow after ' + (t / 2) + ' s'; } } catch (_) {}
      }
    } catch (_) {}
    delay(0.5);
  }
  return 'no Allow button within ' + secs + ' s';
}
