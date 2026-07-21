#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, 'data');
const STATUS_FILE = join(DATA, 'continuous-status.json');
const CONTROL_FILE = join(DATA, 'continuous-control.json');
const SETTINGS_FILE = join(ROOT, 'config', 'profile.yml');
const PIPELINE = join(DATA, 'pipeline.md');

let running = true;
let appsToday = 0;
let lastScanAt = 0;
let totalEval = 0;
let totalStaged = 0;
let totalGhost = 0;
let totalBelow = 0;
let totalErrors = 0;
let startedAt = new Date().toISOString();

function writeJSON(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

function readJSON(path, def) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return def; }
}

function countPending() {
  try {
    const content = readFileSync(PIPELINE, 'utf-8');
    return (content.match(/^- \[ \]/gm) || []).length;
  } catch { return 0; }
}

function log(msg) {
  const line = JSON.stringify({ ts: new Date().toISOString(), msg });
  console.log(line);
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    log(`Spawning: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd: ROOT, shell: true, stdio: 'pipe' });
    let out = '';
    child.stdout.on('data', d => { const s = d.toString(); out += s; process.stdout.write(s); });
    child.stderr.on('data', d => { const s = d.toString(); process.stderr.write(s); });
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`Exit code ${code}`));
    });
    child.on('error', reject);
  });
}

function checkControl() {
  if (!running) return false;
  const control = readJSON(CONTROL_FILE, { action: 'run' });
  if (control.action === 'stop') { running = false; return false; }
  if (control.action === 'pause') return false;
  return true;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function today() { return new Date().toISOString().slice(0, 10); }

async function runGhostCheck() {
  try {
    const out = await runProcess('node', ['ghost-check.mjs', '--apply', '--threshold', '30']);
    const m = out.match(/\{.*\}/);
    if (m) {
      const r = JSON.parse(m[0]);
      totalGhost += (r.stale || 0) + (r.ghost || 0);
      log(`Ghost check: ${r.stale} stale, ${r.ghost} ghost (${r.checked} checked)`);
    }
  } catch (e) {
    log(`Ghost check error (non-fatal): ${e.message}`);
  }
}

function updateStatus() {
  const pending = countPending();
  writeJSON(STATUS_FILE, {
    running: true,
    startedAt,
    date: today(),
    appsToday,
    totalEvaluated: totalEval,
    totalStaged: totalStaged,
    totalGhostSkipped: totalGhost,
    totalBelowThreshold: totalBelow,
    pendingRemaining: pending,
    lastCycleAt: new Date().toISOString(),
    errors: totalErrors
  });
}

async function main() {
  log(`Continuous Worker started — PID ${process.pid}`);

  if (!existsSync(CONTROL_FILE)) writeJSON(CONTROL_FILE, { action: 'run' });
  if (!existsSync(STATUS_FILE)) updateStatus();

  await sleep(2000);

  while (running) {
    if (!checkControl()) { await sleep(5000); continue; }

    const pending = countPending();
    log(`Pending jobs: ${pending}`);

    if (pending === 0) {
      if (Date.now() - lastScanAt > 86400000) {
        try {
          log('No pending jobs — running scan...');
          await runProcess('node', ['career-orchestrator.mjs', '--scan']);
          lastScanAt = Date.now();
        } catch (e) {
          log(`Scan error: ${e.message}`);
        }
        continue;
      }
      log('No pending jobs, sleeping 1h...');
      for (let i = 0; i < 360 && running; i++) {
        if (!checkControl()) break;
        await sleep(10000);
      }
      continue;
    }

    // Reset daily counter
    const status = readJSON(STATUS_FILE, {});
    if (status.date !== today()) appsToday = 0;
    else appsToday = status.appsToday || 0;

    // Ghost-check before evaluating
    log('Running ghost check...');
    await runGhostCheck();
    if (!checkControl()) continue;

    const BATCH = 5;
    const APPLY_MAX = 3;
    const MAX_DAILY = 20;

    if (appsToday >= MAX_DAILY) {
      log(`Daily limit reached (${appsToday}/${MAX_DAILY}), sleeping 1h...`);
      for (let i = 0; i < 360 && running; i++) {
        if (!checkControl()) break;
        await sleep(10000);
      }
      continue;
    }

    // Evaluate batch
    try {
      log(`Evaluating next ${BATCH} jobs...`);
      await runProcess('node', ['auto-pipeline.mjs', '--pdf-only', '--max', String(BATCH)]);
      totalEval += BATCH;
      await runProcess('node', ['merge-tracker.mjs']);
    } catch (e) {
      totalErrors++;
      log(`Evaluation error: ${e.message}`);
      updateStatus();
      await sleep(300000);
      continue;
    }
    if (!checkControl()) continue;

    // Fill + stage high-scorers for review — never submits. Approve staged
    // entries in the dashboard's Review Queue to actually send them.
    const remainingMax = Math.min(APPLY_MAX, MAX_DAILY - appsToday);
    if (remainingMax > 0) {
      try {
        log(`Filling & staging up to ${remainingMax} jobs...`);
        await runProcess('node', ['auto-apply.mjs', '--max', String(remainingMax)]);
        totalStaged += remainingMax;
        appsToday += remainingMax;
        await runProcess('node', ['merge-tracker.mjs']);
      } catch (e) {
        totalErrors++;
        log(`Auto-apply error: ${e.message}`);
      }
    }

    updateStatus();

    // Random delay (2-8 min)
    const delay = 120000 + Math.random() * 360000;
    log(`Cycle complete. Sleeping ${Math.round(delay/1000)}s...`);
    for (let t = 0; t < delay && running; t += 10000) {
      if (!checkControl()) break;
      await sleep(10000);
    }
  }

  writeJSON(STATUS_FILE, { ...readJSON(STATUS_FILE, {}), running: false });
  log('Worker stopped.');
}

process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

main().catch(e => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
