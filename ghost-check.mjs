#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE = join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY = join(ROOT, 'data', 'scan-history.tsv');

function isStale(url, thresholdDays) {
  if (!existsSync(SCAN_HISTORY)) return false;
  const lines = readFileSync(SCAN_HISTORY, 'utf-8').split('\n');
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[1]?.trim() === url?.trim()) {
      const firstSeen = new Date(parts[0]);
      const daysOld = (Date.now() - firstSeen) / 86400000;
      return daysOld > thresholdDays;
    }
  }
  return false;
}

function isGhostHeuristic(url) {
  if (!existsSync(SCAN_HISTORY)) return false;
  const lines = readFileSync(SCAN_HISTORY, 'utf-8').split('\n');
  let count = 0;
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[1]?.trim() === url?.trim()) count++;
  }
  return count >= 3;
}

const args = process.argv.slice(2);
const doApply = args.includes('--apply');
const threshold = parseInt(args[args.indexOf('--threshold') + 1] || '30', 10);

if (!existsSync(PIPELINE)) {
  console.log(JSON.stringify({ checked: 0, stale: 0 }));
  process.exit(0);
}

const lines = readFileSync(PIPELINE, 'utf-8').split('\n');
let checked = 0, stale = 0, ghost = 0;

const updated = lines.map(line => {
  const m = line.match(/^- \[ \]\s*(.+)$/);
  if (m) {
    const url = m[1].trim();
    checked++;
    if (isStale(url, threshold)) {
      stale++;
      return `- [x] ${url} — STALE (ghost check, >${threshold}d old)`;
    }
    if (isGhostHeuristic(url)) {
      ghost++;
      return `- [x] ${url} — GHOST (reposted 3+ times)`;
    }
  }
  return line;
});

if (doApply) writeFileSync(PIPELINE, updated.join('\n'), 'utf-8');

console.log(JSON.stringify({ checked, stale, ghost }));
