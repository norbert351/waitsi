#!/usr/bin/env node
// WAITSI CLI — attach the waiting layer to any slow command.
//
// Wrap a slow command (build, test, deploy, agent run) and get PAID to wait:
// a live commons surface opens for the duration, every waited second banks
// XP + sponsor discovery revenue, and when the command exits the wait is
// settled and the earned balance is claimed as a WV-… voucher.
//
// Usage:
//   waitsi -- <command...>                    # defaults below
//   waitsi --handle zubbycrypt -- npm run build
//   waitsi --base http://localhost:3120 -- node slow.js
//   waitsi --no-browser -- npm test           # headless (CI-safe)
//   waitsi --no-claim -- cmd                  # settle, leave balance claimable
//
// Env overrides: WAITSI_HANDLE, WAITSI_BASE.
import { spawn } from 'node:child_process';

const DEFAULT_BASE = process.env.WAITSI_BASE || 'https://waitsi-j9qk.onrender.com';
const DEFAULT_HANDLE = process.env.WAITSI_HANDLE || 'zubbycrypt';

function parseArgs(argv) {
  const opts = { base: DEFAULT_BASE, handle: null, agent: 'cli', browser: true, claim: true };
  const cmd = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { cmd.push(...argv.slice(i + 1)); break; }
    if (a === '-h' || a === '--help') { opts.help = true; i += 1; continue; }
    if (a === '--no-browser') { opts.browser = false; i += 1; continue; }
    if (a === '--no-claim') { opts.claim = false; i += 1; continue; }
    const eq = a.match(/^--(base|handle|agent)=(.*)$/);
    if (eq) { opts[eq[1]] = eq[2]; i += 1; continue; }
    if (a === '--base' || a === '--handle' || a === '--agent') {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
      i += 2;
      continue;
    }
    if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    cmd.push(...argv.slice(i)); // first bare arg starts the command
    break;
  }
  if (!opts.handle) opts.handle = DEFAULT_HANDLE;
  if (!opts.agent) opts.agent = 'cli';
  if (!cmd.length) throw new Error('no command given — append `-- <command…>` after any options');
  return { ...opts, cmd };
}

async function http(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((j && j.error) || `HTTP ${res.status} ${text.slice(0, 120)}`);
  return j;
}

function openBrowser(url) {
  const bin = { linux: 'xdg-open', darwin: 'open', win32: 'cmd' }[process.platform];
  if (!bin) return false;
  try {
    const p = process.platform === 'win32'
      ? spawn(bin, ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      : spawn(bin, [url], { detached: true, stdio: 'ignore' });
    p.unref();
    return true;
  } catch { return false; }
}

const HELP = `WAITSI — the waiting layer for AI. Wrap any slow command and get paid to wait.

Usage:
  waitsi [options] -- <command…>

Options:
  --handle <name>   builder handle (env WAITSI_HANDLE, default zubbycrypt)
  --agent <key>     agent/tool label shown on the surface (default cli)
  --base <url>      WAITSI service URL (env WAITSI_BASE, default https://waitsi-j9qk.onrender.com)
  --no-browser      headless: don't try to open the live surface
  --no-claim        settle the wait but leave the balance claimable on the board
  -h, --help        this help

Examples:
  waitsi -- npm run build
  waitsi --handle zubbycrypt --base http://localhost:3120 -- npx tsc --noEmit
  WAITSI_BASE=http://localhost:3120 waitsi --no-browser -- pytest -q
`;

// ---- run -------------------------------------------------------------------
let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`waitsi: ${e.message}`);
  process.exit(2);
}
if (opts.help) { console.log(HELP); process.exit(0); }

const { base, handle, agent, cmd } = opts;

console.log(`\n  ⏳ WAITSI — the waiting layer for AI`);
console.log(`  builder @${handle} · agent "${agent}" · ${base}`);

// 1) Open the wait session — this allocates the sponsor surface + world.
let session;
try {
  const started = await http(base, 'POST', '/waits/start', { handle, agentKey: agent });
  session = started.session;
  const d = started.discovery || {};
  const q = new URLSearchParams({ handle, agent, session: session.id, token: session.token });
  if (d.sponsor) q.set('sponsor', d.sponsor);
  if (d.title) q.set('title', d.title);
  if (d.surface) q.set('surface', d.surface);
  const url = `${base}/?${q}`;
  console.log(`  ● session #${session.id} — live surface: ${url}`);
  if (opts.browser) {
    console.log(openBrowser(url)
      ? '    (opened in your browser — the CLI settles when the command exits)'
      : '    (could not auto-open a browser — paste the surface URL above)');
  }
} catch (e) {
  console.error(`waitsi: could not start the wait session: ${e.message}`);
  process.exit(1);
}

// 2) Run the wrapped command. Every second it runs is a paid wait second.
const t0 = Date.now();
const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: process.env });
let settled = false;

async function settle() {
  if (settled) return;
  settled = true;
  const secs = Math.max(0, Math.floor((Date.now() - t0) / 1000));
  let banked = false;
  try {
    const done = await http(base, 'POST', `/waits/${session.id}/complete`, {
      handle, token: session.token, attendedTicks: secs, agentKey: agent,
    });
    banked = true;
    const disco = done.discovery
      ? ` (+${done.discovery.builderCoinsStr} $CMNS from ${done.discovery.sponsor})` : '';
    console.log(`\n  ✓ banked ${done.session.seconds}s of wait → +${done.session.xpEarned} XP, +${done.session.coinsEarned} coins${disco}`);
  } catch (e) {
    if (/already completed/i.test(e.message)) {
      console.log('\n  ℹ session was already banked from the live surface');
    } else {
      console.error(`waitsi: could not bank the wait: ${e.message}`);
    }
  }
  if (opts.claim && banked) {
    try {
      const c = await http(base, 'POST', '/payouts', { handle, token: session.token });
      console.log(`  💰 claimed ${c.payout.amountStr} $CMNS — voucher ${c.payout.voucher}`);
    } catch (e) {
      if (/nothing to claim/i.test(e.message)) {
        console.log('  ℹ balance already settled — nothing new to claim');
      } else {
        console.error(`waitsi: claim failed: ${e.message}`);
      }
    }
  }
  // final board line
  try {
    const board = await http(base, 'GET', `/board/${encodeURIComponent(handle)}`);
    console.log(`  @${handle} — LVL ${board.world.level} · ${board.totalStr} $CMNS lifetime · ${board.claimableStr} claimable`);
  } catch { /* board is best-effort */ }
}

child.on('error', (e) => {
  // Command never ran — nothing was waited, so abandon honestly.
  console.error(`waitsi: cannot run "${cmd.join(' ')}": ${e.message}`);
  http(base, 'POST', `/waits/${session.id}/abandon`, { handle, token: session.token })
    .catch(() => {})
    .finally(() => process.exit(1));
});

child.on('exit', (code, signal) => {
  settle().finally(() => {
    process.exitCode = code !== null ? code : (signal === 'SIGINT' ? 130 : 143);
  });
});

// Forward interrupts to the child, then settle the partial wait on its exit.
let sigCount = 0;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    sigCount += 1;
    if (sigCount > 1) process.exit(130); // second ctrl-c: leave now
    if (!child.killed) child.kill(sig);
  });
}
