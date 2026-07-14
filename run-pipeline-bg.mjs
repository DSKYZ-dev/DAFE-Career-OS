#!/usr/bin/env node
// Detached background pipeline runner.
// Runs the heavy pipeline steps as its own process so it SURVIVES
// server crashes, browser disconnects, or the terminal being closed.
// Writes a JSON-lines event stream to data/pipeline-events.log and a
// status snapshot to data/pipeline-status.json that the dashboard reads.
//
// Usage: node run-pipeline-bg.mjs <pipeline|rescore>

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const STATUS_FILE = join(DATA_DIR, 'pipeline-status.json');
const EVENTS = join(DATA_DIR, 'pipeline-events.log');

const STEPS = {
  pipeline: [
    { name: 'Scanning job boards', cmd: 'node', args: ['career-orchestrator.mjs', '--scan'] },
    { name: 'Evaluating jobs', cmd: 'node', args: ['auto-pipeline.mjs', '--pdf-only', '--max', '10'] },
    { name: 'Generating CVs & Cover Letters', cmd: 'node', args: ['career-orchestrator.mjs', '--cv'] },
    { name: 'Auto-applying to jobs', cmd: 'node', args: ['auto-apply.mjs', '--max', '5'] },
    { name: 'Merging tracker', cmd: 'node', args: ['merge-tracker.mjs'] },
  ],
  rescore: [
    { name: 'Scoring unscored jobs', cmd: 'node', args: ['auto-pipeline.mjs', '--pdf-only', '--max', '50'] },
    { name: 'Merging tracker', cmd: 'node', args: ['merge-tracker.mjs'] },
  ],
};

const mode = process.argv[2] || 'pipeline';
const steps = STEPS[mode];
if (!steps) { console.error('Unknown mode:', mode); process.exit(2); }

const label = mode === 'rescore' ? 'Re-Score' : 'Pipeline';

// A single step (e.g. the Playwright web-search or an LLM evaluation) must
// never hang the whole pipeline forever. If a step's child exceeds this, we
// kill it and move on. 30 min is far more than any step should need.
const STEP_TIMEOUT_MS = 30 * 60 * 1000;

// If we crash unexpectedly, still emit 'done' so the dashboard's UI unlocks
// (otherwise it would be stuck "Running" with every button disabled).
function fatal(msg) {
  try { logLine('  ✗ Fatal: ' + msg); } catch {}
  try { emit({ type: 'done', success: false }); } catch {}
  try { setStatus({ running: false, stepName: 'Crashed', finishedAt: Date.now() }); } catch {}
}
process.on('uncaughtException', (e) => { fatal(e && e.stack || e); process.exit(1); });
process.on('unhandledRejection', (e) => { fatal(e && e.stack || e); process.exit(1); });

function setStatus(obj) {
  let prev = {};
  try { if (existsSync(STATUS_FILE)) prev = JSON.parse(readFileSync(STATUS_FILE, 'utf-8')); } catch {}
  try { writeFileSync(STATUS_FILE, JSON.stringify(Object.assign(prev, obj, { updatedAt: Date.now() }), null, 2)); } catch {}
}
function emit(obj) { appendFileSync(EVENTS, JSON.stringify(obj) + '\n'); }
function logLine(line) { appendFileSync(EVENTS, JSON.stringify({ type: 'log', text: String(line) }) + '\n'); }

// Fresh event stream for this run (so a reconnect replays only this job).
writeFileSync(EVENTS, '', 'utf-8');
setStatus({ running: true, mode, label, current: 0, total: steps.length, stepName: '', startedAt: Date.now() });

emit({ type: 'start', totalSteps: steps.length, label });
logLine(`\n=== Starting ${label} at ${new Date().toISOString()} ===`);

let idx = 0;
function runStep() {
  if (idx >= steps.length) {
    logLine(`\n=== ${label} Complete ===`);
    setStatus({ running: false, current: steps.length, stepName: 'Complete', finishedAt: Date.now() });
    emit({ type: 'done', success: true });
    process.exit(0);
  }
  const step = steps[idx];
  setStatus({ current: idx + 1, total: steps.length, stepName: step.name });
  emit({ type: 'step', current: idx + 1, total: steps.length, name: step.name });
  logLine(`\n[${idx + 1}/${steps.length}] ${step.name}...`);

  const child = spawn(step.cmd, step.args, { cwd: ROOT, shell: true });
  let killed = false;
  const stepTimer = setTimeout(() => {
    killed = true;
    logLine(`  ⚠ Step timed out after ${Math.round(STEP_TIMEOUT_MS / 60000)} min — killing and continuing.`);
    try { child.kill('SIGKILL'); } catch {}
  }, STEP_TIMEOUT_MS);
  child.stdout.on('data', d => { for (const l of d.toString().split('\n').filter(Boolean)) logLine('  ' + l.trimEnd()); });
  child.stderr.on('data', d => { for (const l of d.toString().split('\n').filter(Boolean)) logLine('  ! ' + l.trimEnd()); });
  const next = () => { clearTimeout(stepTimer); idx++; setTimeout(runStep, 300); };
  child.on('close', code => { clearTimeout(stepTimer); logLine(killed ? '  ⚠ Skipped (timed out)' : code === 0 ? '  ✓ Done' : `  ⚠ Exit code ${code}`); next(); });
  child.on('error', err => { clearTimeout(stepTimer); logLine('  ✗ Error: ' + err.message); next(); });
}
runStep();
