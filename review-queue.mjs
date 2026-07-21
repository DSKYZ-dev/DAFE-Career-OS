// @ts-check
/**
 * review-queue.mjs — Staged applications waiting for a human's Approve click.
 *
 * Every apply path (auto-apply.mjs, autonomous-loop.mjs, continuous-worker.mjs)
 * fills a form and stops — it never clicks Submit. What it does instead is
 * write one entry here. The dashboard's Review Queue tab is the only place a
 * human ever turns a staged entry into a real submission (via
 * submit-application.mjs, the only script allowed to call
 * applyToJob(..., autoSubmit=true)).
 *
 * One JSON file per entry under data/review-queue/ — not a single array file
 * — so the several detached background processes that can write concurrently
 * never race on a read-modify-write. Only the dashboard process ever mutates
 * an existing entry (approve/reject), so that side has no race either.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = join(ROOT, 'data', 'review-queue');

function ensureDir() {
  mkdirSync(QUEUE_DIR, { recursive: true });
}

/** Same slugging rule used across the apply scripts, in one place. */
export function slugify(company, role) {
  return `${company || ''}-${role || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'entry';
}

function entryPath(id) {
  return join(QUEUE_DIR, `${id}.json`);
}

/**
 * Stage a new application for review. Fills in id/createdAt/updatedAt/status
 * defaults if the caller didn't set them.
 * @param {object} partial - company, role, url, ats, fitScore, reportPath,
 *   cvPath, coverPath, filledCount, totalFields, needsManualSolve, captchaNote, source
 * @returns {object} the written entry
 */
export function writeQueueEntry(partial = {}) {
  ensureDir();
  const slug = partial.slug || slugify(partial.company, partial.role);
  const id = partial.id || `${Date.now()}-${slug}`;
  const now = partial.createdAt || new Date().toISOString();
  const entry = {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'pending_review',
    company: '', role: '', url: '', ats: 'unknown',
    fitScore: null,
    reportPath: null, cvPath: null, coverPath: null,
    filledCount: 0, totalFields: 0,
    needsManualSolve: false, captchaNote: null,
    source: 'auto-apply',
    trackerSlug: slug,
    rejectReason: null, submittedAt: null, error: null,
    ...partial,
    id, slug,
  };
  writeFileSync(entryPath(id), JSON.stringify(entry, null, 2), 'utf-8');
  return entry;
}

/** All queue entries, newest first. */
export function readQueue() {
  ensureDir();
  const entries = [];
  for (const f of readdirSync(QUEUE_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      entries.push(JSON.parse(readFileSync(join(QUEUE_DIR, f), 'utf-8')));
    } catch { /* skip a corrupt entry rather than fail the whole queue */ }
  }
  entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return entries;
}

export function getQueueEntry(id) {
  try {
    return JSON.parse(readFileSync(entryPath(id), 'utf-8'));
  } catch {
    return null;
  }
}

/** Merge `patch` into an existing entry and bump updatedAt. Soft-state only — never unlinks. */
export function updateQueueEntry(id, patch = {}) {
  const current = getQueueEntry(id);
  if (!current) return null;
  const updated = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
  ensureDir();
  writeFileSync(entryPath(id), JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

/** True deletion — only ever used for explicit user cleanup, never by the apply/approve flow. */
export function deleteQueueEntry(id) {
  try {
    unlinkSync(entryPath(id));
    return true;
  } catch {
    return false;
  }
}
