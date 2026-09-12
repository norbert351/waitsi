// Shared test harness — ONE place that knows how to boot a WAITSI server for a
// test file. Before this existed, each test file spawned the server its own way
// and silently inherited whatever was in the shell env; when the DB URL wasn't
// exported, all six files failed identically with an opaque `fetch failed` and
// 56 red tests that looked like 56 bugs instead of one missing variable.
//
// Everything a spawned server needs is resolved HERE, and a preflight check
// fails loudly and specifically if the DB is unreachable.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const DB_URL_FILE = '/tmp/wdb_url.txt';

// Port reservation ledger — see bootServer. Each test FILE runs in its own
// process, so this guards against duplicates WITHIN a file; the real fix is
// giving every file a distinct PORT constant.
const claimedPorts = new Set();

// Resolve the DB URL from (in order): an explicit env var, the on-disk file the
// dev environment uses, or fail with an actionable message.
export function resolveDbUrl() {
  const fromEnv = process.env.WAITSI_DATABASE_URL || process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  if (existsSync(DB_URL_FILE)) {
    const fromFile = readFileSync(DB_URL_FILE, 'utf8').trim();
    if (fromFile) return fromFile;
  }
  throw new Error(
    'No database for the test run. Set WAITSI_DATABASE_URL (or DATABASE_URL), '
    + `or write the connection string to ${DB_URL_FILE}.`,
  );
}

export function serverEnv(overrides = {}) {
  return {
    ...process.env,
    WAITSI_DATABASE_URL: resolveDbUrl(),
    // This VM resolves IPv6 first but has no working IPv6 route, so every
    // connection to Neon hangs for ~10s before falling back. Forcing IPv4
    // first is the difference between a 2-minute suite and a 20-minute one.
    NODE_OPTIONS: '--dns-result-order=ipv4first',
    ...overrides,
  };
}

// Boot a server on `port` with a fresh isolated schema, wait for /health, seed
// it, and return the child process. Throws (with the child's captured stderr)
// if it never comes up — never returns a process that isn't actually serving.
export async function bootServer({ port, schema, extraEnv = {}, seed = true }) {
  const base = `http://127.0.0.1:${port}`;

  // Refuse to run two servers on one port. `node --test` executes test FILES IN
  // PARALLEL, so a duplicate port means one server silently never wins the bind
  // and requests are answered by the WRONG service — which shows up as a random
  // `undefined` in an unrelated assertion. (payouts.test.js and
  // multiagent.test.js both used port 3197 and produced exactly that.) Failing
  // loudly here is the difference between a 10-second diagnosis and an evening.
  if (claimedPorts.has(port)) {
    throw new Error(
      `port ${port} is already claimed by another test file — give this file its own PORT. `
      + 'Two servers on one port means requests land on the wrong service.',
    );
  }
  claimedPorts.add(port);
  const env = serverEnv({
    PORT: String(port),
    WAITSI_DB_SCHEMA: schema,
    ...extraEnv,
  });

  // Capture output instead of discarding it: `stdio: 'ignore'` is what turned a
  // clear boot error into an opaque "fetch failed" across 56 tests.
  let log = '';
  const proc = spawn(process.execPath, ['src/index.js'], {
    cwd: process.cwd(),
    env,
  });
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  let healthy = false;
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited before becoming healthy (code ${proc.exitCode}):\n${log}`);
    }
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) { healthy = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) {
    proc.kill();
    throw new Error(`server never became healthy on ${base} after 30s:\n${log}`);
  }

  if (seed) {
    await new Promise((resolve, reject) => {
      const s = spawn(process.execPath, ['src/seed.js'], { cwd: process.cwd(), env });
      let out = '';
      s.stdout.on('data', (d) => { out += d; });
      s.stderr.on('data', (d) => { out += d; });
      s.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed failed (${code}):\n${out}`))));
    });
  }

  return { proc, base, env, log: () => log };
}
