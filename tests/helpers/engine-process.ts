import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENTRY = path.join(ROOT, 'tests/helpers/engine-child.ts');
const PS1 = path.join(ROOT, 'tests/helpers/win-engine.ps1');
export const IS_WINDOWS = process.platform === 'win32';
export const API_KEY = 'shutdown-test-api-key-0123456789abcdef';

export type ShutdownKind = 'sigint' | 'sigterm' | 'sigbreak';
export interface LogLine {
  event?: string;
  level?: number;
  time?: string;
  [k: string]: unknown;
}

export async function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export const portIsOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

export interface EngineProcess {
  pid: number;
  port: number;
  api(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** parsed JSON log lines written so far */
  log(): LogLine[];
  stderr(): string;
  isAlive(): boolean;
  /** deliver a real OS signal (Windows: Ctrl+C / Ctrl+Break in the engine's own console) and wait for the exit */
  shutdown(kind: ShutdownKind, timeoutSec?: number): Promise<{ exitCode: number | null; exited: boolean; ms: number }>;
  kill(): void;
  cleanup(): void;
}

/** Runs the PowerShell helper with stdout sent to a file: a pipe could be inherited by the hidden engine and block us. */
function runPs(args: string[], env?: NodeJS.ProcessEnv): string {
  const f = path.join(os.tmpdir(), `nms-ps-${process.pid}-${Math.random().toString(36).slice(2)}.out`);
  const fd = fs.openSync(f, 'w');
  try {
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args], { stdio: ['ignore', fd, 'ignore'], windowsHide: true, env });
  } finally {
    fs.closeSync(fd);
  }
  const out = fs.readFileSync(f, 'utf8');
  fs.rmSync(f, { force: true });
  return out;
}

export async function startEngineProcess(env: Record<string, string> = {}, entry: string = ENTRY): Promise<EngineProcess> {
  const port = await freeTcpPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-engine-'));
  const outFile = path.join(dir, 'stdout.log');
  const errFile = path.join(dir, 'stderr.log');
  const childEnv = { ...process.env, PORT: String(port), ENGINE_API_KEYS: API_KEY, ...env };

  let pid: number;
  let child: ChildProcess | null = null;
  let exitInfo: { code: number | null } | null = null;

  if (IS_WINDOWS) {
    const out = runPs(['start', '-Entry', entry, '-Out', outFile, '-Err', errFile, '-WorkDir', ROOT], childEnv);
    pid = Number(out.trim().split(/\s+/).pop());
    if (!Number.isInteger(pid)) throw new Error(`could not start engine: ${out}`);
  } else {
    const out = fs.openSync(outFile, 'w');
    const err = fs.openSync(errFile, 'w');
    child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: ROOT, env: childEnv, stdio: ['ignore', out, err] });
    child.on('exit', (code) => (exitInfo = { code }));
    pid = child.pid!;
  }

  const readLog = (): LogLine[] =>
    (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LogLine;
        } catch {
          return { event: 'non_json_line', raw: l } as LogLine;
        }
      });

  const alive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // wait for readiness
  const deadline = Date.now() + 60_000;
  while (!readLog().some((l) => l.event === 'engine_started')) {
    if (Date.now() > deadline || !alive()) throw new Error(`engine did not start. stderr: ${fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : ''}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const proc: EngineProcess = {
    pid,
    port,
    async api(method, urlPath, body) {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: { authorization: `Bearer ${API_KEY}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    log: readLog,
    stderr: () => (fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : ''),
    isAlive: alive,
    async shutdown(kind, timeoutSec = 20) {
      const t0 = Date.now();
      if (IS_WINDOWS) {
        if (kind === 'sigterm') throw new Error('SIGTERM cannot be delivered to a Windows process (a kill is TerminateProcess)');
        const out = runPs(['shutdown', '-TargetPid', String(pid), '-Event', kind === 'sigint' ? '0' : '1', '-TimeoutSec', String(timeoutSec)]);
        const parsed = JSON.parse(out.trim().split('\n').pop()!);
        return { exitCode: parsed.exitCode as number | null, exited: !!parsed.exited, ms: Date.now() - t0 };
      }
      child!.kill(kind === 'sigint' ? 'SIGINT' : kind === 'sigterm' ? 'SIGTERM' : 'SIGHUP');
      const end = Date.now() + timeoutSec * 1000;
      while (!exitInfo && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      if (!exitInfo) child!.kill('SIGKILL');
      return { exitCode: exitInfo ? (exitInfo as { code: number | null }).code : null, exited: !!exitInfo, ms: Date.now() - t0 };
    },
    kill() {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    },
    cleanup() {
      proc.kill();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
  return proc;
}

/** `ping` processes whose command line contains `needle` (used to prove no orphaned ping children remain). */
export function processesMatching(needle: string): string[] {
  if (IS_WINDOWS) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.Name -match '^ping' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`], { encoding: 'utf8', windowsHide: true });
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const r = spawnSync('pgrep', ['-af', needle], { encoding: 'utf8' });
  return r.stdout.split('\n').map((s) => s.trim()).filter((l) => l && !l.includes('pgrep'));
}
