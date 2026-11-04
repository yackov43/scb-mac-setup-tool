// Retire only SunoCoverBot's old approval workers, identified by their exact executable paths.
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export function legacyWorkerCommand(home, temp = os.tmpdir()) {
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const allowed = [path.join(home, 'auto-allow.exe'), path.join(temp, 'scb-runtime', 'auto-allow.exe')];
  const script = `$allowed = @(${allowed.map(literal).join(',')})
Get-CimInstance Win32_Process -Filter "Name = 'auto-allow.exe'" | Where-Object {
  $_.ExecutablePath -in $allowed -and $_.CommandLine -match '(?:^|\\s)--continuous(?:\\s|$)'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }`;
  return Buffer.from(script, 'utf16le').toString('base64');
}
export async function retireLegacyDebugWorkers(home, { platform = process.platform, run = execFile } = {}) {
  if (platform !== 'win32') return;
  await new Promise((resolve, reject) => run(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', legacyWorkerCommand(home)],
    { windowsHide: true, timeout: 10_000 }, error => error ? reject(Error('legacy_worker_retirement_failed')) : resolve()));
}
