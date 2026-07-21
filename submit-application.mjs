#!/usr/bin/env node
/**
 * submit-application.mjs — The ONLY script in this codebase allowed to
 * actually submit an application (call applyToJob with autoSubmit=true).
 *
 * It only ever runs in response to a human clicking Approve on a staged
 * Review Queue entry in the dashboard — never on its own, never as part of
 * a scan/evaluate/fill pass. Every other apply path (auto-apply.mjs,
 * autonomous-loop.mjs, continuous-worker.mjs) fills a form and stops there.
 *
 * Mirrors run-pipeline-bg.mjs's status/event/PID-file plumbing so it plugs
 * into the dashboard's existing SSE log stream and "is a job running" lock.
 *
 * Usage: node submit-application.mjs --ids id1,id2,id3
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { chromium } from 'playwright';
import yaml from 'js-yaml';
import { getQueueEntry, updateQueueEntry } from './review-queue.mjs';
// Authorizes applyToJob's internal guard to click Submit. Must be set before
// applyToJob is ever CALLED (checked live at call time, so it's fine that
// this assignment runs after the (hoisted) import above).
process.env.DAFE_SUBMIT_APPROVED = '1';
import { applyToJob } from './auto-apply.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
const STATUS_FILE = join(DATA_DIR, 'pipeline-status.json');
const EVENTS = join(DATA_DIR, 'pipeline-events.log');
const APP_TRACKER = join(DATA_DIR, 'applications.md');

function setStatus(obj) {
  let prev = {};
  try { if (existsSync(STATUS_FILE)) prev = JSON.parse(readFileSync(STATUS_FILE, 'utf-8')); } catch {}
  try { writeFileSync(STATUS_FILE, JSON.stringify(Object.assign(prev, obj, { updatedAt: Date.now() }), null, 2)); } catch {}
}
function emit(obj) { appendFileSync(EVENTS, JSON.stringify(obj) + '\n'); }
function logLine(line) { appendFileSync(EVENTS, JSON.stringify({ type: 'log', text: String(line) }) + '\n'); }

function fatal(msg) {
  try { logLine('  ✗ Fatal: ' + msg); } catch {}
  try { emit({ type: 'done', success: false }); } catch {}
  try { setStatus({ running: false, stepName: 'Crashed', finishedAt: Date.now() }); } catch {}
}
process.on('uncaughtException', (e) => { fatal((e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { fatal((e && e.stack) || e); process.exit(1); });

// Flip a tracker row Evaluated -> Applied. The ONLY place allowed to write
// "Applied" — mirrors "only this script may auto-submit": that status should
// mean a real submission happened, not merely a filled form.
function markApplied(company) {
  try {
    const lines = readFileSync(APP_TRACKER, 'utf-8').split('\n');
    const updated = lines.map((line) => {
      const parts = line.split('|').map((s) => s.trim());
      if (parts.length >= 7 && parts[3].toLowerCase() === String(company || '').toLowerCase()) {
        parts[6] = 'Applied';
        return '| ' + parts.slice(1).join(' | ') + ' |';
      }
      return line;
    });
    writeFileSync(APP_TRACKER, updated.join('\n'), 'utf-8');
  } catch { /* tracker row is best-effort — the queue entry is the source of truth */ }
}

function loadCandidate() {
  const profile = yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8')) || {};
  const candidate = profile.candidate || {};
  try {
    const s = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf-8'));
    for (const k of ['email', 'phone', 'linkedin', 'portfolio']) {
      if (s[k] !== undefined && s[k] !== '') candidate[k] = s[k];
    }
  } catch { /* settings.json is optional */ }
  return candidate;
}

async function main() {
  const { values: args } = parseArgs({ options: { ids: { type: 'string' } }, strict: false });
  const ids = (args.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    console.error('Usage: node submit-application.mjs --ids id1,id2,...');
    process.exit(2);
  }

  const label = 'Submitting Applications';
  writeFileSync(EVENTS, '', 'utf-8');
  setStatus({ running: true, mode: 'submit', label, current: 0, total: ids.length, stepName: '', startedAt: Date.now() });
  emit({ type: 'start', totalSteps: ids.length, label });
  logLine(`\n=== Submitting ${ids.length} approved application(s) at ${new Date().toISOString()} ===`);

  const CANDIDATE = loadCandidate();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let submitted = 0, needsSolve = 0, failed = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    setStatus({ current: i + 1, total: ids.length, stepName: `Submitting ${i + 1}/${ids.length}` });
    emit({ type: 'step', current: i + 1, total: ids.length, name: `Submitting ${id}` });

    const entry = getQueueEntry(id);
    if (!entry) { logLine(`  ✗ ${id}: not found in queue`); failed++; continue; }
    if (!['pending_review', 'failed'].includes(entry.status)) {
      logLine(`  ⏭ ${id}: status is '${entry.status}' — not re-submitting`);
      continue;
    }

    logLine(`\n[${i + 1}/${ids.length}] ${entry.company} — ${entry.role}`);
    updateQueueEntry(id, { status: 'submitting' });

    try {
      // Re-fill immediately before the click, right here, rather than
      // resuming an old session — a form filled hours/days ago at staging
      // time could be stale, and this doubles as a last-second liveness
      // check on the posting itself.
      const result = await applyToJob(page, entry.url, CANDIDATE, entry.cvPath, entry.coverPath, true);
      if (result.success) {
        updateQueueEntry(id, { status: 'submitted', submittedAt: new Date().toISOString(), error: null });
        markApplied(entry.company);
        logLine(`  ✓ Submitted`);
        submitted++;
      } else if (result.needsManualSolve) {
        updateQueueEntry(id, { status: 'pending_review', needsManualSolve: true, captchaNote: result.captchaNote || null });
        logLine(`  ⚠ Still needs a manual CAPTCHA/challenge solve: ${result.captchaNote || ''}`);
        needsSolve++;
      } else {
        updateQueueEntry(id, { status: 'failed', error: result.reason || 'Unknown failure' });
        logLine(`  ✗ Failed: ${result.reason || 'unknown'}`);
        failed++;
      }
    } catch (e) {
      updateQueueEntry(id, { status: 'failed', error: e.message });
      logLine(`  ✗ Error: ${e.message}`);
      failed++;
    }

    if (i < ids.length - 1) await page.waitForTimeout(3000);
  }

  await browser.close();
  logLine(`\n=== Submit complete: ${submitted} submitted, ${needsSolve} need manual solve, ${failed} failed ===`);
  setStatus({ running: false, current: ids.length, stepName: 'Complete', finishedAt: Date.now() });
  emit({ type: 'done', success: true });
}

main().catch((err) => { fatal((err && err.stack) || err); process.exit(1); });
