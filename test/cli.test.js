// Integration tests for the WAITSI CLI (bin/waitsi.mjs): wrapping a slow
// command opens a session, banks the waited seconds on exit, and (by default)
// claims the earned balance as a WV-… voucher. Run: npm run smoke
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bootServer } from './harness.js';

const PORT = 3201;
// Fresh schema per run so parallel test files never collide on the shared DB.
const SCHEMA = 'cli_' + Date.now();
let proc;
const base = `http://127.0.0.1:${PORT}`;

// The CLI banks waited seconds on a heartbeat; for short jobs the heartbeat may
// not fire even once before the command exits. A 500ms cadence keeps the tests
// fast while still exercising the real loop.
const CLI_ENV = { WAITSI_HEARTBEAT_MS: '500', NODE_OPTIONS: '--dns-result-order=ipv4first' };

function runCli(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['bin/waitsi.mjs', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...CLI_ENV },
    });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

before(async () => {
  const booted = await bootServer({ port: PORT, schema: SCHEMA });
  proc = booted.proc;
});

after(() => {
  if (proc) proc.kill();
});

test('CLI wraps a slow command: session starts, wait banks, WV- voucher claims', async () => {
  const job = 'setTimeout(()=>console.log("JOB_DONE"), 2600)';
  const r = await runCli([
    '--base', base, '--handle', 'cli_tester', '--no-browser',
    '--', 'node', '-e', job,
  ]);
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  assert.match(r.out, /JOB_DONE/);               // the wrapped command ran
  assert.match(r.out, /live surface: .*session=/); // attachable deep link printed
  assert.match(r.out, /banked \d+s of wait/);    // wait settled with real seconds
  assert.match(r.out, /WV-/);                    // payout voucher issued
  assert.match(r.out, /claimable/);              // board line printed
});

test('--no-claim settles but leaves the balance claimable on the board', async () => {
  const r = await runCli([
    '--base', base, '--handle', 'cli_tester', '--no-browser', '--no-claim',
    '--', 'node', '-e', 'setTimeout(()=>{}, 1800)',
  ]);
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  assert.doesNotMatch(r.out, /WV-/); // no claim in no-claim mode
  const board = await fetch(`${base}/board/cli_tester`).then((q) => q.json());
  assert.ok(board.claimableMicro > 0, 'earned balance should remain claimable');
});

test('CLI banks a failed command too (builder still waited), exit code preserved', async () => {
  const r = await runCli([
    '--base', base, '--handle', 'cli_tester', '--no-browser',
    '--', 'node', '-e', 'console.error("BOOM"); process.exit(7)',
  ]);
  assert.equal(r.code, 7, `exit code must propagate (stderr: ${r.err})`);
  assert.match(r.out, /banked \d+s of wait/); // the wait was still banked
  assert.match(r.err, /BOOM/);                // child stderr passed through
});
