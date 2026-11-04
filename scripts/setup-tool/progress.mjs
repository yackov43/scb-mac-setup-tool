// --progress: the macOS Terminal command runs the setup in the foreground of the Terminal the person pasted it into.
// With no setup window there, this is where they see each of the 5 steps and the one or two clicks Chrome asks for,
// in their own language (the same copy as the window, all 30 languages).
export function printProgress(engine, copy, write = text => process.stdout.write(text + '\n'), everyMs = 300) {
  const seen = new Map();
  let lastPhase = '';
  const tip = step => {
    if (step.status === 'error') return String(step.detail || '');
    if (step.id === 'suno' && step.status === 'action') return copy.suno;
    if (step.id === 'chrome' && step.status === 'running' && step.detail === 'restart') return copy.chromeRestart;
    if (step.id !== 'chrome' || step.status !== 'action') return '';
    if (step.detail === 'manual') return copy.chromeManual + ' ' + engine.state.folder;
    return { debugging: copy.macDebugging, approve: copy.macApprove, accessibility: copy.macAccessibility }[step.detail] || '';
  };
  const tick = () => {
    const state = engine.state;
    state.steps.forEach((step, i) => {
      const key = step.status + '|' + step.detail;
      if (step.status === 'pending' || seen.get(step.id) === key) return;
      seen.set(step.id, key);
      if (step.status === 'running' && step.detail === 'verifying') return;
      const mark = { running: '…', done: '✓', action: '!', error: '✕' }[step.status] || ' ';
      write(`[${i + 1}/${state.steps.length}] ${mark} ${copy['step' + (i + 1)]}`);
      const text = tip(step);
      if (text) write('      ' + text);
    });
    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      if (state.phase === 'done') write(copy.allDone);
      if (state.phase === 'failed') write(copy.failed);
    }
  };
  write(copy.title);
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return () => { clearInterval(timer); tick(); };
}
