#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import http from 'http';
import yaml from 'js-yaml';
import { readQueue, getQueueEntry, updateQueueEntry } from './review-queue.mjs';
import { loadCatalog, resolveActiveFocuses } from './focus-catalog.mjs';
import { getProfile } from './profile-helper.mjs';
import { PDFParse } from 'pdf-parse';

// Crash-proof: never let a single bad request or async rejection take the
// server down (which is what dropped the user's connection).
process.on('uncaughtException', (e) => { try { appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data', 'server-errors.log'), `[${new Date().toISOString()}] uncaught: ${e && e.stack || e}\n`); } catch {} });
process.on('unhandledRejection', (e) => { try { appendFileSync(join(dirname(fileURLToPath(import.meta.url)), 'data', 'server-errors.log'), `[${new Date().toISOString()}] unhandledRejection: ${e && e.stack || e}\n`); } catch {} });

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const APP_TRACKER = join(ROOT, 'data', 'applications.md');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const OUTPUT_DIR = join(ROOT, 'output');
const REPORTS_DIR = join(ROOT, 'reports');
const CV_PATH = join(ROOT, 'cv.md');

let pipelineRunning = false;
let sseClients = [];

const EVENTS_FILE = join(ROOT, 'data', 'pipeline-events.log');
const STATUS_FILE = join(ROOT, 'data', 'pipeline-status.json');
const PID_FILE = join(ROOT, 'data', 'pipeline.pid');

function sendSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { /* client disconnected */ }
  }
}

// Append to the persistent event log AND broadcast live to connected clients.
function sendLog(line) {
  const obj = { type: 'log', text: String(line).trimEnd() };
  try { appendFileSync(EVENTS_FILE, JSON.stringify(obj) + '\n'); } catch {}
  sendSSE(obj);
}
function emitEvent(obj) {
  try { appendFileSync(EVENTS_FILE, JSON.stringify(obj) + '\n'); } catch {}
  sendSSE(obj);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Authoritative "is a pipeline actually running" check. We do NOT trust the
// status file alone: if the background process was killed (window closed, crash,
// killed mid-step) it never writes running:false, which permanently locks the
// dashboard in a "Running" state. Here we verify the PID is still alive and
// auto-reset stale state if it is not.
function isPipelineRunning() {
  let status;
  try { status = JSON.parse(readFileSync(STATUS_FILE, 'utf-8')); } catch { return false; }
  if (status.running !== true) return false;
  let pid = null;
  try { pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10); } catch {}
  if (pid && isProcessAlive(pid)) return true;
  // Stale: status says running but the process is gone — clear it so the
  // dashboard (and new runs) can recover.
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(Object.assign(status, { running: false, stepName: 'Interrupted', finishedAt: Date.now() }), null, 2));
  } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  return false;
}

// Launch the heavy pipeline as a fully DETACHED background process so it
// survives server crashes, browser disconnects, and terminal closure.
function startBackgroundJob(mode) {
  if (isPipelineRunning()) return false;
  const child = spawn('node', ['run-pipeline-bg.mjs', mode], { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
  child.unref();
  try { writeFileSync(PID_FILE, String(child.pid)); } catch {}
  return true;
}

// Submitting is its own kind of background job — reuses the SAME lock as
// scan/rescore/need-a-job-now (only one Playwright-driven job runs at a
// time) but launches submit-application.mjs, the only script allowed to
// actually click Submit.
function startSubmitJob(ids) {
  if (isPipelineRunning()) return false;
  const child = spawn('node', ['submit-application.mjs', '--ids', ids.join(',')], { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
  child.unref();
  try { writeFileSync(PID_FILE, String(child.pid)); } catch {}
  return true;
}

function parseTracker() {
  const lines = readFileSync(APP_TRACKER, 'utf-8').split('\n').filter(Boolean);
  const apps = [];
  let inHeader = true;
  for (const line of lines) {
    if (inHeader) {
      if (line.startsWith('|---')) inHeader = false;
      continue;
    }
    const m = line.match(/^\|\s*(\d+)\s*\|\s*([\d-]+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*\[(\d+)\]\((.*?)\)\s*\|\s*(.*?)\s*\|/);
    if (m) {
      const rawNotes = m[10]?.trim() || '';
      const trackMatch = rawNotes.match(/^\[(\w+)\]\s*/);
      const app = {
        num: parseInt(m[1]), date: m[2], company: m[3], role: m[4],
        score: m[5]?.trim(), status: m[6]?.trim(), pdf: m[7]?.trim(),
        reportNum: parseInt(m[8]), reportPath: m[9], notes: rawNotes.replace(/^\[\w+\]\s*/, ''),
        track: trackMatch ? trackMatch[1] : '',
        url: ''
      };
      const repFile = join(ROOT, m[9]);
      if (existsSync(repFile)) {
        const rep = readFileSync(repFile, 'utf-8');
        const u = rep.match(/\*\*URL:\*\*\s*(.+)/);
        if (u) app.url = u[1].trim();
      }
      apps.push(app);
    }
  }
  return apps;
}

function scoreToNum(s) {
  const v = parseFloat(String(s ?? '').replace('/5', ''));
  return Number.isFinite(v) ? v : -1;
}

function countPipelinePending() {
  try {
    const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
    let pending = 0, processed = 0;
    for (const line of lines) {
      if (line.match(/^- \[ \]/)) pending++;
      if (line.match(/^- \[x\]/)) processed++;
    }
    return { pending, processed };
  } catch { return { pending: 0, processed: 0 }; }
}

function countOutputPDFs() {
  try {
    return readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.pdf')).length;
  } catch { return 0; }
}

function parsePipeline() {
  try {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    const jobs = [];
    const re = /^- \[( |x)\] (.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\s*$/;
    for (const line of text.split('\n')) {
      const m = line.match(re);
      if (!m) continue;
      const [, , company, title, location, extra] = m;
      const urlMatch = line.match(/(https?:\/\/[^\s|)]+)/);
      const url = urlMatch ? urlMatch[1] : '';
      jobs.push({
        company: company.trim(),
        title: title.trim(),
        location: (location || '').trim(),
        url,
        applied: m[1] === 'x',
      });
    }
    return jobs;
  } catch { return []; }
}

// Remove applications that scored 0.0/5 (declutter the tracker).
function removeApplicationZeros() {
  const lines = readFileSync(APP_TRACKER, 'utf-8').split('\n');
  let removed = 0;
  const kept = [];
  for (const line of lines) {
    const m = line.match(/^\|\s*\d+\s*\|.*?\|(.*?)\|\s*([\d.]+)\/5\s*\|/);
    if (m && parseFloat(m[2]) === 0) { removed++; continue; }
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  writeFileSync(APP_TRACKER, kept.join('\n') + '\n', 'utf-8');
  return removed;
}

function updateAppStatus(company, newStatus) {
  const lines = readFileSync(APP_TRACKER, 'utf-8').split('\n');
  const updated = lines.map(line => {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length >= 7 && parts[3].toLowerCase().includes(company.toLowerCase())) {
      parts[6] = newStatus;
      return '| ' + parts.slice(1).join(' | ') + ' |';
    }
    return line;
  });
  writeFileSync(APP_TRACKER, updated.join('\n'), 'utf-8');
}

function readReport(file) {
  // file is a relative link like ../reports/028-foo.md or reports/028-foo.md
  const name = basename(file || '');
  const candidates = [
    join(REPORTS_DIR, name),
    join(ROOT, file || ''),
    join(ROOT, 'data', file || ''),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return readFileSync(c, 'utf-8');
    } catch {}
  }
  return null;
}

// --- War Room & Continuous Mode Helpers ---
const DATA_DIR = join(ROOT, 'data');
let continuousChild = null;

function writeJSON(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}
function readJSON(path, def) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return def; }
}

function getSettings() {
  const f = join(DATA_DIR, 'settings.json');
  try { return JSON.parse(readFileSync(f, 'utf-8')); } catch {
    const d = { email: '', phone: '', linkedin: '', portfolio: '', followupDays: [3, 7, 14], continuousBatch: 5, continuousMaxDaily: 20, scoreThreshold: 4.0, filterAggressiveness: 'conservative', llmProvider: 'gemini' };
    writeJSON(f, d); return d;
  }
}
function saveSettings(data) {
  const cur = getSettings();
  for (const k of ['email','phone','linkedin','portfolio','followupDays','continuousBatch','continuousMaxDaily','scoreThreshold','filterAggressiveness']) {
    if (data[k] !== undefined) cur[k] = data[k];
  }
  writeJSON(join(DATA_DIR, 'settings.json'), cur);
  return cur;
}

function getFunnelData() {
  const apps = parseTracker();
  const count = s => s === 'responded' ? apps.filter(a => ['Responded','Interview','Offer'].includes(a.status)).length : apps.filter(a => a.status === s).length;
  const funnel = { total: apps.length, evaluated: count('Evaluated'), applied: count('Applied'), responded: count('responded'), interview: count('Interview'), offer: count('Offer') };
  const perTrack = {};
  for (const t of ['ai','support','untagged']) {
    const ta = apps.filter(a => (a.track||'untagged') === t);
    if (ta.length) perTrack[t] = { total: ta.length, evaluated: ta.filter(a=>a.status==='Evaluated').length, applied: ta.filter(a=>a.status==='Applied').length, responded: ta.filter(a=>['Responded','Interview','Offer'].includes(a.status)).length, interview: ta.filter(a=>a.status==='Interview').length, offer: ta.filter(a=>a.status==='Offer').length };
  }
  return { funnel, perTrack };
}

function getDailyQueue() {
  const apps = parseTracker();
  const top = apps.filter(a => a.status === 'Evaluated' && scoreToNum(a.score) >= 4.0).sort((a,b) => scoreToNum(b.score)-scoreToNum(a.score)).slice(0, 3);
  const settings = getSettings();
  const fd = settings.followupDays || [3,7,14];
  const now = Date.now();
  const due = apps.filter(a => a.status === 'Applied' && fd.some(d => { const age = (now - new Date(a.date).getTime())/86400000; return age >= d && age < d+2; })).slice(0, 5);
  return { topJobs: top, followupsDue: due };
}

function getPatterns() {
  const apps = parseTracker();
  const byTrack = {};
  for (const a of apps) {
    const t = a.track||'untagged';
    if (!byTrack[t]) byTrack[t] = { total:0, evaluated:0, applied:0, responded:0, interviewed:0, offered:0, rejected:0 };
    byTrack[t].total++;
    if (a.status === 'Evaluated') byTrack[t].evaluated++;
    else if (a.status === 'Applied') byTrack[t].applied++;
    else if (['Responded','Interview','Offer'].includes(a.status)) byTrack[t].responded++;
    if (a.status === 'Interview') byTrack[t].interviewed++;
    if (a.status === 'Offer') byTrack[t].offered++;
    if (a.status === 'Rejected') byTrack[t].rejected++;
  }
  const scores = apps.map(a => scoreToNum(a.score)).filter(s => s >= 0);
  const avgScore = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length*10)/10 : 0;
  const interviewed = apps.filter(a => ['Interview','Offer'].includes(a.status)).length;
  return { total: apps.length, evaluated: apps.filter(a => a.status === 'Evaluated').length, applied: apps.filter(a => a.status === 'Applied').length, interviewed, offers: apps.filter(a => a.status === 'Offer').length, rejected: apps.filter(a => a.status === 'Rejected').length, avgScore, conversionRate: apps.length ? Math.round(interviewed/apps.length*100) : 0, byTrack };
}

// Fills the application and stages it in the Review Queue — never submits.
// Approving it in the dashboard is what actually sends it (submit-application.mjs).
async function applyToUrl(jobUrl) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [join(ROOT, 'auto-apply.mjs'), '--url', jobUrl], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    cp.stdout.on('data', c => stdout += c);
    cp.stderr.on('data', c => stderr += c);
    cp.on('close', code => {
      if (code === 0) {
        resolve({ staged: stdout.includes('Staged for review'), message: (stdout.trim() || 'auto-apply completed') });
      } else {
        reject(new Error(stderr.trim() || `auto-apply exited with code ${code}`));
      }
    });
    cp.on('error', reject);
  });
}

function getCompanyIntel(company) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const cacheDir = join(DATA_DIR, 'company-intel');
  const cacheFile = join(cacheDir, slug+'.json');
  if (existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile,'utf-8'));
    if (Date.now() - c.fetchedAt < 604800000) return c;
  }
  const r = { company, fetchedAt: Date.now(), summary: `${company} — company intel available after web search integration.` };
  mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(r,null,2),'utf-8');
  return r;
}

function handleContinuousStart(req, res) {
  const existing = readJSON(join(DATA_DIR, 'continuous-status.json'), { running: false });
  if (existing.running) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({error:'Already running'})); return; }
  writeJSON(join(DATA_DIR,'continuous-control.json'), { action: 'run' });
  continuousChild = spawn('node', ['continuous-worker.mjs'], { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
  continuousChild.unref();
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({started:true}));
}

function handleContinuousStop(req, res) {
  writeJSON(join(DATA_DIR,'continuous-control.json'), { action: 'stop' });
  if (continuousChild) { try { continuousChild.kill(); } catch {} continuousChild = null; }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({stopped:true}));
}
// --- End War Room Helpers ---

function server() {
  const requestHandler = (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (path === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      sseClients.push(res);

      // Replay the recent tail immediately so a client that connects mid-run
      // sees current progress instead of a blank panel.
      let lastLen = 0;
      try {
        if (existsSync(EVENTS_FILE)) {
          const text = readFileSync(EVENTS_FILE, 'utf-8');
          lastLen = text.length;
          for (const line of text.trim().split('\n').slice(-300)) {
            if (line.trim()) res.write(`data: ${line}\n\n`);
          }
        }
      } catch {}

      // Live tail: run-pipeline-bg.mjs is a SEPARATE process and cannot push
      // to our SSE clients directly, so we poll the event log file and forward
      // any new (complete) lines. Without this, the dashboard froze on a
      // "Running" state with a stuck progress bar and never reloaded data.
      const pushNew = () => {
        try {
          if (!existsSync(EVENTS_FILE)) return;
          const text = readFileSync(EVENTS_FILE, 'utf-8');
          if (text.length < lastLen) lastLen = 0; // file truncated (new run) — resend from start
          if (text.length > lastLen) {
            const chunk = text.slice(lastLen);
            const nl = chunk.lastIndexOf('\n');
            if (nl !== -1) {
              lastLen += nl + 1;
              for (const line of chunk.slice(0, nl).split('\n')) {
                if (line.trim()) res.write(`data: ${line}\n\n`);
              }
            }
          }
        } catch {}
      };
      const tailTimer = setInterval(pushNew, 400);

      const cleanup = () => {
        clearInterval(tailTimer);
        sseClients = sseClients.filter(r => r !== res);
      };
      req.on('close', cleanup);
      return;
    }

    if (path === '/api/run-pipeline' && req.method === 'POST') {
      if (isPipelineRunning()) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Pipeline already running' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ started: true }));
      startBackgroundJob('pipeline');
      return;
    }

    if (path === '/api/rescore' && req.method === 'POST') {
      if (isPipelineRunning()) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Pipeline already running' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ started: true }));
      startBackgroundJob('rescore');
      return;
    }

    if (path === '/api/need-a-job-now' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const opts = body ? JSON.parse(body) : {};
          const max = Number(opts.max) || 20;
          if (isPipelineRunning()) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'A job is already running. Wait for it to finish.' }));
            return;
          }
          const child = spawn(process.execPath, ['need-a-job-now.mjs', '--max', String(max)], { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
          child.unref();
          try { writeFileSync(PID_FILE, String(child.pid)); } catch {}
          sendLog(`🔥 I NEED A JOB NOW started (entry-level, max ${max}) — filling and staging for review, nothing will be submitted automatically`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ started: true, max }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (path === '/api/remove-zeros' && req.method === 'POST') {
      try {
        const removed = removeApplicationZeros();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ removed }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (path === '/api/pipeline-status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: isPipelineRunning() }));
      return;
    }

    if (path === '/api/applications') {
      const apps = parseTracker();
      const stats = { ...countPipelinePending(), pdfs: countOutputPDFs() };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ applications: apps, stats }));
      return;
    }

    // /api/status — onboarding check (used by web dashboard)
    if (path === '/api/status') {
      const hasCV = existsSync(join(ROOT, 'cv.md'));
      const hasProfile = existsSync(join(ROOT, 'config', 'profile.yml'));
      const hasPortals = existsSync(join(ROOT, 'portals.yml'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ready: hasCV && hasProfile && hasPortals,
        hasCV,
        hasProfile,
        hasPortals,
      }));
      return;
    }

    // /api/jobs — return jobs parsed from pipeline.md (used by web dashboard)
    if (path === '/api/jobs') {
      const jobs = parsePipeline();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobs, count: jobs.length }));
      return;
    }

    if (path === '/api/report' && req.method === 'GET') {
      const file = url.searchParams.get('file') || '';
      const md = readReport(file);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ markdown: md || '_Report not found._' }));
      return;
    }

    if (path === '/api/application/status' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { company, status } = JSON.parse(body);
          if (!company || !status) throw new Error('Missing company or status');
          updateAppStatus(company, status);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (path === '/api/apply' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { num, url, company, role } = JSON.parse(body);
          if (!url) throw new Error('Missing URL');
          const result = await applyToUrl(url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ staged: result.staged, message: result.message }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // --- Review Queue: staged applications, nothing here ever submits ---
    if (path === '/api/review-queue' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: readQueue() }));
      return;
    }

    if (path === '/api/review-queue/approve' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          if (!id) throw new Error('Missing id');
          if (isPipelineRunning()) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'A job is already running. Wait for it to finish.' })); return; }
          startSubmitJob([id]);
          sendLog(`✅ Approved — submitting 1 application...`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ started: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (path === '/api/review-queue/approve-batch' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { ids } = JSON.parse(body);
          if (!Array.isArray(ids) || !ids.length) throw new Error('Missing ids');
          if (isPipelineRunning()) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'A job is already running. Wait for it to finish.' })); return; }
          startSubmitJob(ids);
          sendLog(`✅ Approved — submitting ${ids.length} application(s)...`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ started: true, count: ids.length }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (path === '/api/review-queue/reject' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id, reason } = JSON.parse(body);
          const updated = updateQueueEntry(id, { status: 'rejected', rejectReason: reason || null });
          if (!updated) throw new Error('Entry not found');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ rejected: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (path === '/api/review-queue/reject-batch' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { ids, reason } = JSON.parse(body);
          if (!Array.isArray(ids) || !ids.length) throw new Error('Missing ids');
          let count = 0;
          for (const id of ids) { if (updateQueueEntry(id, { status: 'rejected', rejectReason: reason || null })) count++; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ rejected: count }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Serve a generated CV/cover-letter PDF referenced by a Review Queue card.
    // Sandboxed to OUTPUT_DIR via basename() — never resolves outside it.
    if (path === '/api/output-file' && req.method === 'GET') {
      const name = basename(url.searchParams.get('name') || '');
      const filePath = join(OUTPUT_DIR, name);
      if (!name || !existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"` });
      res.end(readFileSync(filePath));
      return;
    }

    // --- Resume / CV: upload a PDF (or paste text) instead of relying on
    // LinkedIn — cv.md is the single source of truth every evaluation and
    // tailored application is built from. ---
    if (path === '/api/cv' && req.method === 'GET') {
      let content = '';
      try { content = readFileSync(CV_PATH, 'utf-8'); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content }));
      return;
    }

    if (path === '/api/cv/extract' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { dataBase64 } = JSON.parse(body);
          if (!dataBase64) throw new Error('Missing file data');
          const buf = Buffer.from(dataBase64, 'base64');
          const parser = new PDFParse({ data: buf });
          let result;
          try { result = await parser.getText(); } finally { await parser.destroy(); }
          if (!result.text || !result.text.trim()) {
            throw new Error('No extractable text found in this PDF — it may be a scanned image. Try pasting the text directly instead.');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: result.text }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (path === '/api/cv/save' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { content } = JSON.parse(body);
          if (typeof content !== 'string' || !content.trim()) throw new Error('CV content is empty');
          // Back up whatever was there before overwriting — cv.md isn't
          // version-controlled (it's gitignored, user-layer data).
          if (existsSync(CV_PATH)) writeFileSync(CV_PATH + '.bak', readFileSync(CV_PATH, 'utf-8'), 'utf-8');
          writeFileSync(CV_PATH, content, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ saved: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // --- Job focus catalog: system starter categories + the user's selection ---
    if (path === '/api/focus-catalog' && req.method === 'GET') {
      const profile = getProfile();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ catalog: loadCatalog(), active: resolveActiveFocuses(profile) }));
      return;
    }

    if (path === '/api/profile/focuses' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { selectedIds, custom } = JSON.parse(body);
          const profile = getProfile();
          const fromCatalog = (Array.isArray(selectedIds) ? selectedIds : []).map(id => ({ id }));
          const fromCustom = (Array.isArray(custom) ? custom : [])
            .filter(c => c && (c.label || (Array.isArray(c.keywords) && c.keywords.length)))
            .map(c => ({ id: 'custom', label: c.label || '', keywords: Array.isArray(c.keywords) ? c.keywords : [] }));
          profile.active_focuses = [...fromCatalog, ...fromCustom];
          writeFileSync(join(ROOT, 'config', 'profile.yml'), yaml.dump(profile), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ saved: true, active_focuses: profile.active_focuses }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Static font files for the dashboard's own type (Space Grotesk / DM
    // Sans) — no build step, just a sandboxed direct serve from fonts/.
    if (path.startsWith('/fonts/')) {
      const name = basename(path);
      const filePath = join(ROOT, 'fonts', name);
      if (!name.endsWith('.woff2') || !existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(readFileSync(filePath));
      return;
    }

    if (path === '/api/continuous/start' && req.method === 'POST') { handleContinuousStart(req, res); return; }
    if (path === '/api/continuous/stop' && req.method === 'POST') { handleContinuousStop(req, res); return; }
    if (path === '/api/continuous/status') {
      const s = readJSON(join(DATA_DIR, 'continuous-status.json'), { running: false, pendingRemaining: 0 });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s)); return;
    }
    if (path === '/api/funnel') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getFunnelData())); return;
    }
    if (path === '/api/daily-queue') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getDailyQueue())); return;
    }
    if (path === '/api/settings' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getSettings())); return;
    }
    if (path === '/api/settings' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { const s = saveSettings(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s)); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({error:e.message})); } });
      return;
    }
    if (path === '/api/company-intel') {
      const company = url.searchParams.get('company') || '';
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getCompanyIntel(company))); return;
    }
    if (path === '/api/patterns') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getPatterns())); return;
    }

    // Provider -> its .env API key variable name. cloud-eval.mjs and
    // model-registry.mjs (the scripts that actually make LLM calls) read
    // these exact names — this map is the single source of truth so the
    // dashboard can never again save a key under the wrong provider's var.
    const LLM_KEY_VAR = { gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', ollama: 'OLLAMA_API_KEY' };

    if (path === '/api/llm-config') {
      if (req.method === 'GET') {
        const envPath = join(ROOT, '.env');
        // CLOUD_PROVIDER/CLOUD_MODEL — NOT LLM_PROVIDER/LLM_MODEL — because
        // cloud-eval.mjs (what the pipeline actually runs) reads those names.
        let provider = 'gemini', model = '', hasKey = false;
        if (existsSync(envPath)) {
          const text = readFileSync(envPath, 'utf-8');
          const mProv = text.match(/^CLOUD_PROVIDER=(.+)$/m);
          if (mProv) provider = mProv[1].trim();
          const mModel = text.match(/^CLOUD_MODEL=(.+)$/m);
          if (mModel) model = mModel[1].trim();
          const keyVar = LLM_KEY_VAR[provider] || 'GEMINI_API_KEY';
          const keyRe = new RegExp(`^${keyVar}=(.+)$`, 'm');
          const mKey = text.match(keyRe);
          if (mKey && mKey[1].trim() && !mKey[1].trim().startsWith('your_')) hasKey = true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ provider, model, hasKey, keyPreview: hasKey ? '••••••••' : '' }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const { provider, apiKey, model } = JSON.parse(body);
            const chosenProvider = provider || 'gemini';
            const envPath = join(ROOT, '.env');
            let lines = [];
            if (existsSync(envPath)) lines = readFileSync(envPath, 'utf-8').split('\n');
            const setLine = (prefix, val) => {
              const i = lines.findIndex(l => l.startsWith(prefix));
              if (i >= 0) lines[i] = prefix + '=' + val;
              else lines.push(prefix + '=' + val);
            };
            setLine('CLOUD_PROVIDER', chosenProvider);
            // Ollama is the one provider that's valid with no key at all
            // (local `ollama serve`) — every other provider needs one, and an
            // empty submission there just means "keep whatever was saved".
            if (apiKey) setLine(LLM_KEY_VAR[chosenProvider] || 'GEMINI_API_KEY', apiKey);
            if (model) setLine('CLOUD_MODEL', model);
            writeFileSync(envPath, lines.join('\n'), 'utf-8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ saved: true }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(html);
  };

  // Two listeners sharing ONE handler: IPv4 (0.0.0.0) AND IPv6 (::1).
  // Windows keeps these as separate stacks, and browsers may resolve
  // "localhost" to either — so we must accept both or a cached tab
  // loaded under the other family can never reach the server.
  const srv = http.createServer(requestHandler);
  const srv6 = http.createServer(requestHandler);

  srv.listen(PORT, '0.0.0.0', () => {
    try { writeFileSync(join(ROOT, 'data', 'server.pid'), String(process.pid)); } catch {}
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║     DAFE Career OS Control Dashboard        ║`);
    console.log(`  ╚══════════════════════════════════════════╝`);
    console.log(`\n  → Open http://127.0.0.1:${PORT} in your browser`);
    console.log(`  → Press Ctrl+C to stop the server\n`);
    try { execFileSync('start', [`http://127.0.0.1:${PORT}`], { shell: true, timeout: 3000 }); } catch {}
    if (!existsSync(join(ROOT, '.env'))) {
      console.log(`  ⚠  WARNING: No .env file found — LLM providers are NOT configured.`);
      console.log(`  ⚠  Buttons that evaluate/apply jobs will fail silently.`);
      console.log(`  ⚠  Copy .env.example to .env and add at least one API key.`);
      console.log(`  ⚠  Free options: Gemini (aistudio.google.com) or OpenRouter.\n`);
    }
  });

  // IPv6 listener (if the OS supports it) so a browser that resolves
  // "localhost" to ::1 can still reach the dashboard.
  try { srv6.listen(PORT, '::1', () => { console.log(`  → Also reachable on http://[::1]:${PORT}`); }); } catch (e) {}
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DAFE Career OS Dashboard</title>
<style>
@font-face { font-family: 'Space Grotesk'; src: url('/fonts/space-grotesk-latin.woff2') format('woff2'); font-weight: 400 700; font-display: swap; }
@font-face { font-family: 'DM Sans'; src: url('/fonts/dm-sans-latin.woff2') format('woff2'); font-weight: 400 700; font-display: swap; }
:root {
  --bg: #0B0E14;
  --bg-elevated: #0D1117;
  --panel: #12161F;
  --panel-hover: #1A1F2C;
  --border: #232838;
  --text: #E6E8EC;
  --text-dim: #8B93A7;
  --text-mute: #5B6478;
  --accent-green: #2EA44F;
  --accent-green-bright: #4ADE80;
  --accent-cyan: #22D3EE;
  --accent-violet: #8B5CF6;
  --accent-amber: #FFB020;
  --accent-red: #FF4B4B;
  --accent-red-dark: #3D1414;
  --accent-red-border: #7A2020;
  --accent-magenta: #E94BE0;
  --font-display: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-body: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'Cascadia Code', 'Fira Code', monospace;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--font-body); background: var(--bg); color: var(--text); min-height: 100vh; }
.header { background: linear-gradient(135deg, var(--panel), var(--bg)); padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.header h1 { font-family: var(--font-display); font-size: 1.4rem; font-weight: 700; color: var(--accent-green-bright); letter-spacing: .01em; }
.header .subtitle { color: var(--text-dim); font-size: .85rem; }
.container { max-width: 1280px; margin: 0 auto; padding: 20px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px; text-align: center; }
.stat-card .num { font-family: var(--font-display); font-size: 1.8rem; font-weight: 700; color: var(--accent-green-bright); }
.stat-card .label { font-size: .7rem; color: var(--text-dim); margin-top: 4px; text-transform: uppercase; letter-spacing: .05em; }
.main-btn-wrap { text-align: center; margin-bottom: 18px; }
.btn-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-bottom: 16px; }
.tool-btn { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 10px 18px; font-size: .85rem; font-weight: 600; cursor: pointer; transition: background .15s; }
.tool-btn:hover { background: var(--panel-hover); }
.tool-btn.primary { background: linear-gradient(135deg, var(--accent-green), #22c55e); border: none; color: white; }
.tool-btn.danger { background: var(--accent-red-dark); border-color: var(--accent-red-border); color: var(--text); }
.tool-btn:disabled { opacity: .5; cursor: not-allowed; }
.main-btn { font-family: var(--font-display); background: linear-gradient(135deg, var(--accent-green), #22c55e); color: white; border: none; border-radius: 16px; padding: 18px 50px; font-size: 1.2rem; font-weight: 700; cursor: pointer; transition: transform .15s, box-shadow .15s; box-shadow: 0 4px 20px rgba(46,164,79,.35); }
.main-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 30px rgba(46,164,79,.45); }
.main-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.main-btn .small { display: block; font-size: .7rem; font-weight: 400; opacity: .8; margin-top: 4px; font-family: var(--font-body); }
.log-panel { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; padding: 14px; font-family: var(--font-mono); font-size: .78rem; line-height: 1.5; max-height: 240px; overflow-y: auto; margin-bottom: 18px; white-space: pre-wrap; color: var(--text-dim); }
.progress-bar { height: 4px; background: var(--border); border-radius: 2px; margin-bottom: 12px; overflow: hidden; }
.progress-bar .fill { height: 100%; background: linear-gradient(90deg, var(--accent-green), #22c55e); width: 0; transition: width .3s; border-radius: 2px; }
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.toolbar input[type=text] { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; color: var(--text); font-size: .85rem; min-width: 200px; }
.filter-panel { display: none; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 14px; gap: 18px; flex-wrap: wrap; }
.filter-panel.open { display: flex; }
.filter-group { display: flex; flex-direction: column; gap: 6px; }
.filter-group label { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); }
.filter-group select, .filter-group input { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; color: var(--text); font-size: .8rem; }
.chk { display: flex; align-items: center; gap: 4px; font-size: .8rem; }
.tabs { display: flex; gap: 4px; margin-bottom: 14px; flex-wrap: wrap; }
.tab { padding: 8px 20px; border: 1px solid var(--border); border-radius: 8px 8px 0 0; background: var(--panel); color: var(--text-dim); cursor: pointer; font-size: .85rem; }
.tab.active { background: var(--border); color: var(--text); border-bottom-color: var(--border); }
.tab-content { display: none; }
.tab-content.active { display: block; }
.table-wrap { overflow-x: auto; background: var(--panel); border-radius: 8px; border: 1px solid var(--border); }
table { width: 100%; border-collapse: collapse; }
th { background: var(--border); padding: 10px 12px; text-align: left; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim); cursor: pointer; user-select: none; white-space: nowrap; font-family: var(--font-display); }
th.no-sort { cursor: default; }
th:hover:not(.no-sort) { color: var(--text); }
th .arrow { opacity: .4; margin-left: 4px; }
th.sorted .arrow { opacity: 1; color: var(--accent-green-bright); }
td { padding: 10px 12px; border-top: 1px solid var(--border); font-size: .82rem; }
tr:hover { background: var(--panel-hover); cursor: pointer; }
.status-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: .72rem; font-weight: 600; }
.status-Evaluated { background: rgba(34,211,238,.15); color: var(--accent-cyan); }
.status-Applied { background: rgba(46,164,79,.18); color: var(--accent-green-bright); }
.status-Interview { background: rgba(255,176,32,.16); color: var(--accent-amber); }
.status-Offer { background: rgba(139,92,246,.18); color: var(--accent-violet); }
.status-Rejected { background: rgba(255,75,75,.16); color: var(--accent-red); }
.status-SKIP { background: var(--border); color: var(--text-mute); }
.status-btn { padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text-dim); cursor: pointer; font-size: .68rem; margin: 1px; }
.status-btn:hover { background: var(--border); color: var(--text); }
.status-btn.active { background: var(--border); color: var(--accent-green-bright); border-color: var(--accent-green); }
.apply-btn { padding: 4px 10px; border: 1px solid var(--accent-cyan); border-radius: 6px; background: var(--bg); color: var(--accent-cyan); cursor: pointer; font-size: .68rem; font-weight: 600; }
.apply-btn:hover { background: rgba(34,211,238,.15); }
.apply-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.muted { color: var(--text-mute); font-size: .68rem; }
.score-cell { font-weight: 700; }
.track-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: .68rem; font-weight: 600; background: rgba(139,92,246,.15); color: var(--accent-violet); }
.notes-cell { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: none; align-items: flex-start; justify-content: center; padding: 40px 20px; overflow-y: auto; z-index: 50; }
.modal-overlay.open { display: flex; }
.modal { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; max-width: 860px; width: 100%; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.modal h2 { font-family: var(--font-display); color: var(--accent-green-bright); font-size: 1.3rem; margin-bottom: 4px; }
.modal .sub { color: var(--text-dim); font-size: .85rem; margin-bottom: 14px; }
.modal .meta { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.modal .close { float: right; background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: .85rem; }
.modal .report { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; padding: 18px; font-size: .85rem; line-height: 1.6; max-height: 60vh; overflow-y: auto; }
.modal .report h1, .modal .report h2, .modal .report h3 { color: var(--accent-green-bright); margin: 14px 0 6px; font-family: var(--font-display); }
.modal .report h1 { font-size: 1.2rem; } .modal .report h2 { font-size: 1.05rem; } .modal .report h3 { font-size: .95rem; }
.modal .report strong { color: var(--text); }
.modal .report ul { margin: 6px 0 6px 20px; }
.modal .report code { background: var(--panel); padding: 1px 5px; border-radius: 4px; }
.modal .report a { color: var(--accent-cyan); }

/* === War Room === */
.war-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.war-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.war-card h3 { font-family: var(--font-display); font-size: .85rem; color: var(--accent-green-bright); margin-bottom: 10px; text-transform: uppercase; letter-spacing: .05em; }
.funnel-step { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.funnel-bar-wrap { flex: 1; background: var(--bg); height: 22px; border-radius: 11px; overflow: hidden; position: relative; }
.funnel-fill { height: 100%; background: linear-gradient(90deg, var(--accent-green), #22c55e); border-radius: 11px; transition: width .5s; }
.funnel-label { font-size: .72rem; color: var(--text-dim); width: 80px; text-align: right; flex-shrink: 0; }
.funnel-count { font-size: .85rem; font-weight: 700; color: var(--text); width: 36px; text-align: right; flex-shrink: 0; }
.funnel-pct { font-size: .72rem; color: var(--text-mute); width: 42px; text-align: right; flex-shrink: 0; }
.queue-item { padding: 8px 0; border-bottom: 1px solid var(--panel); font-size: .82rem; display: flex; justify-content: space-between; align-items: center; }
.queue-item:last-child { border-bottom: none; }
.queue-item .q-score { font-weight: 700; color: var(--accent-green-bright); margin-left: 8px; }
.queue-item .q-company { color: var(--text); }
.queue-item .q-role { color: var(--text-dim); font-size: .78rem; }
.cont-status { display: flex; gap: 16px; flex-wrap: wrap; margin: 10px 0; }
.cont-stat { text-align: center; background: var(--bg); border-radius: 8px; padding: 10px 14px; }
.cont-stat .num { font-family: var(--font-display); font-size: 1.3rem; font-weight: 700; color: var(--accent-green-bright); }
.cont-stat .label { font-size: .65rem; color: var(--text-mute); text-transform: uppercase; }
.pattern-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap: 8px; margin: 10px 0; }
.pat-box { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; text-align: center; }
.pat-box .num { font-size: 1.1rem; font-weight: 700; }
.pat-box .label { font-size: .65rem; color: var(--text-mute); }
.track-table { width: 100%; font-size: .78rem; margin-top: 8px; }
.track-table th { background: var(--bg); padding: 6px 8px; font-size: .68rem; }
.track-table td { padding: 6px 8px; border-top: 1px solid var(--panel); text-align: center; }
/* === Settings === */
.settings-form { max-width: 560px; }
.settings-form label { display: block; font-size: .72rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .05em; margin: 14px 0 4px; }
.settings-form input { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font-size: .9rem; }
.settings-form textarea { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font-size: .82rem; font-family: var(--font-mono); resize: vertical; line-height: 1.5; }
.settings-form input[type=file] { border: 1px dashed var(--border); padding: 10px 12px; cursor: pointer; }
.settings-form .hint { font-size: .7rem; color: var(--text-mute); margin-top: 2px; }
.settings-form .save-btn { margin-top: 20px; padding: 10px 30px; background: linear-gradient(135deg, var(--accent-green), #22c55e); color: #fff; border: none; border-radius: 10px; font-size: .9rem; font-weight: 600; cursor: pointer; }
.settings-form .save-btn:hover { opacity: .9; }

/* === Job Focus catalog (Settings) === */
.focus-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin: 10px 0 16px; }
.focus-chk { display: flex; align-items: center; gap: 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: .82rem; cursor: pointer; }
.focus-chk:hover { border-color: var(--accent-green); }
.focus-chk input { accent-color: var(--accent-green); }
.focus-custom-form { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.focus-custom-form input { flex: 1; min-width: 160px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; color: var(--text); font-size: .85rem; }
.focus-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.focus-chip { display: inline-flex; align-items: center; gap: 6px; background: rgba(233,75,224,.12); color: var(--accent-magenta); border: 1px solid rgba(233,75,224,.35); border-radius: 999px; padding: 4px 10px; font-size: .76rem; }
.focus-chip button { background: none; border: none; color: inherit; cursor: pointer; font-size: .9rem; line-height: 1; padding: 0; }

/* === Review Queue === */
.review-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.review-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.review-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.review-card.needs-solve { border-color: var(--accent-amber); }
.review-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.review-card-company { font-family: var(--font-display); font-weight: 700; color: var(--text); font-size: .95rem; }
.review-card-role { color: var(--text-dim); font-size: .82rem; }
.review-card-badges { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0; }
.review-badge { font-size: .68rem; font-weight: 600; padding: 2px 8px; border-radius: 10px; }
.review-badge.score { background: rgba(46,164,79,.18); color: var(--accent-green-bright); }
.review-badge.score.unscored { background: var(--border); color: var(--text-mute); }
.review-badge.ats { background: rgba(34,211,238,.15); color: var(--accent-cyan); }
.review-badge.fields { background: var(--border); color: var(--text-dim); }
.review-captcha-banner { background: rgba(255,176,32,.14); border: 1px solid var(--accent-amber); color: var(--accent-amber); border-radius: 8px; padding: 8px 10px; font-size: .76rem; }
.review-card-links { display: flex; gap: 10px; font-size: .78rem; }
.review-card-links a { color: var(--accent-cyan); text-decoration: none; }
.review-card-links a:hover { text-decoration: underline; }
.review-card-actions { display: flex; gap: 8px; margin-top: auto; padding-top: 8px; }
.review-approve-btn { flex: 1; background: linear-gradient(135deg, var(--accent-green), #22c55e); color: #fff; border: none; border-radius: 8px; padding: 8px 12px; font-size: .82rem; font-weight: 600; cursor: pointer; }
.review-approve-btn:disabled { opacity: .5; cursor: not-allowed; }
.review-reject-btn { background: var(--accent-red-dark); color: var(--text); border: 1px solid var(--accent-red-border); border-radius: 8px; padding: 8px 12px; font-size: .82rem; cursor: pointer; }
.review-status-pill { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-mute); }
@media (max-width:700px) { .war-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>DAFE Career OS</h1>
    <div class="subtitle">Automated Job Search Pipeline</div>
  </div>
  <div style="display:flex;align-items:center;gap:14px;font-size:.75rem;color:var(--text-dim)">
    <span id="status-indicator">● Ready</span>
    <span id="conn-dot" title="Server connection status" style="width:10px;height:10px;border-radius:50%;background:var(--accent-red);display:inline-block"></span>
  </div>
</div>
<div id="banner" style="display:none;position:fixed;top:0;left:0;right:0;z-index:9999;background:var(--accent-red);color:#fff;font-size:.85rem;font-weight:600;padding:10px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>

<div class="container">
  <div class="stats" id="stats"></div>

  <div class="main-btn-wrap">
    <button class="main-btn" id="runBtn" onclick="runPipeline()">
      Scan &amp; Fill
      <span class="small">Finds jobs → Evaluates → Generates PDFs → Stages for your review</span>
    </button>
  </div>

  <div class="main-btn-wrap" style="margin-top:14px">
    <button class="main-btn" id="needJobNowBtn" onclick="needAJobNow()" style="background:linear-gradient(135deg,var(--accent-amber),var(--accent-red));box-shadow:0 4px 20px rgba(255,75,75,.35)">
      🔥 I NEED A JOB NOW!
      <span class="small">Entry-level blaster — scans junior/grad/trainee roles and stages them for review</span>
    </button>
  </div>

  <div class="btn-row">
    <button class="tool-btn primary" id="rescoreBtn" onclick="rescore()">↻ Force Re-Score</button>
    <button class="tool-btn danger" id="removeZerosBtn" onclick="removeZeros()">🗑 Remove 0-Score</button>
    <button class="tool-btn" onclick="toggleFilter()">⚲ Filter</button>
    <button class="tool-btn" onclick="loadData()">⟳ Refresh</button>
  </div>

  <div class="progress-bar" id="progressBar"><div class="fill" id="progressFill"></div></div>
  <div class="log-panel" id="logPanel">Ready. Click "Scan &amp; Auto-Apply" to run the full pipeline, or use the tools above to organize results.</div>

  <div class="filter-panel" id="filterPanel">
    <div class="filter-group">
      <label>Track</label>
      <select id="fTrack">
        <option value="">All focuses</option>
      </select>
    </div>
    <div class="filter-group">
      <label>Min Score</label>
      <select id="fMinScore">
        <option value="0">Any</option>
        <option value="1">≥ 1.0</option>
        <option value="2">≥ 2.0</option>
        <option value="3">≥ 3.0</option>
        <option value="4">≥ 4.0</option>
      </select>
    </div>
    <div class="filter-group">
      <label>Status</label>
      <div id="fStatus" style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="chk"><input type="checkbox" value="Evaluated" checked> Evaluated</label>
        <label class="chk"><input type="checkbox" value="Applied" checked> Applied</label>
        <label class="chk"><input type="checkbox" value="Interview" checked> Interview</label>
        <label class="chk"><input type="checkbox" value="Offer" checked> Offer</label>
        <label class="chk"><input type="checkbox" value="Rejected" checked> Rejected</label>
        <label class="chk"><input type="checkbox" value="SKIP" checked> SKIP</label>
      </div>
    </div>
    <div class="filter-group">
      <label>Search</label>
      <input type="text" id="fSearch" placeholder="company, role, notes..." oninput="renderTable()">
    </div>
    <div class="filter-group" style="justify-content:flex-end">
      <button class="tool-btn" onclick="clearFilters()">Clear</button>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('applications')">Applications</div>
    <div class="tab" onclick="switchTab('reviewqueue')">Review Queue <span id="reviewQueueCount"></span></div>
    <div class="tab" onclick="switchTab('pipeline')">Pipeline</div>
    <div class="tab" onclick="switchTab('warroom')">War Room</div>
    <div class="tab" onclick="switchTab('settings')">Settings</div>
  </div>

  <div class="tab-content active" id="tab-applications">
    <div class="toolbar">
      <input type="text" id="quickSearch" placeholder="Quick search..." oninput="renderTable()">
      <span style="font-size:.72rem;color:var(--text-mute)">Click a column header to sort • click a row for details</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr id="appHead"></tr></thead>
        <tbody id="appTable"></tbody>
      </table>
    </div>
  </div>

  <div class="tab-content" id="tab-reviewqueue">
    <div class="review-toolbar">
      <span style="font-size:.72rem;color:var(--text-mute)">Every application waits here for your approval — nothing is ever submitted automatically.</span>
      <button class="tool-btn" id="reviewSelectAllBtn" onclick="toggleSelectAllQueue()">☑ Select all</button>
      <button class="tool-btn primary" id="reviewApproveSelectedBtn" onclick="approveSelectedQueue()" disabled>✅ Approve selected</button>
      <button class="tool-btn danger" id="reviewRejectSelectedBtn" onclick="rejectSelectedQueue()" disabled>✕ Reject selected</button>
      <button class="tool-btn" onclick="loadReviewQueue()">⟳ Refresh</button>
    </div>
    <div class="review-grid" id="reviewGrid"></div>
  </div>

  <div class="tab-content" id="tab-pipeline">
    <div class="table-wrap">
      <table>
        <thead><tr><th class="no-sort">Status</th><th class="no-sort">Company</th><th class="no-sort">Role</th><th class="no-sort">Location</th></tr></thead>
        <tbody id="pipelineTable"></tbody>
      </table>
    </div>
  </div>

  <div class="tab-content" id="tab-warroom">
    <div class="war-grid">
      <div class="war-card">
        <h3>Funnel</h3>
        <div id="funnelViz"></div>
      </div>
      <div class="war-card">
        <h3>Continuous Mode</h3>
        <div id="contPanel">
          <button class="main-btn" style="padding:14px 30px;font-size:1rem" id="contBtn" onclick="toggleContinuous()">
            Start Continuous Processing
            <span class="small">Auto-evaluates &amp; stages applications for review until pipeline is empty</span>
          </button>
          <div class="cont-status" id="contStatus" style="display:none"></div>
        </div>
      </div>
      <div class="war-card">
        <h3>Top 3 Jobs Today</h3>
        <div id="dailyQueue"></div>
      </div>
      <div class="war-card">
        <h3>Follow-ups Due</h3>
        <div id="followupsList"></div>
      </div>
      <div class="war-card">
        <h3>Track Performance</h3>
        <div id="patternsBox"></div>
      </div>
      <div class="war-card">
        <h3>Pattern Summary</h3>
        <div id="patternSummary"></div>
      </div>
    </div>
  </div>

  <div class="tab-content" id="tab-settings">
    <div class="settings-form">
      <label>Email</label>
      <input type="email" id="sEmail" placeholder="you@example.com">
      <div class="hint">Used for follow-up drafts and application forms.</div>

      <label>Phone</label>
      <input type="text" id="sPhone" placeholder="(555) 000-0000">

      <label>LinkedIn</label>
      <input type="url" id="sLinkedin" placeholder="https://linkedin.com/in/yourprofile">

      <label>Portfolio / GitHub</label>
      <input type="url" id="sPortfolio" placeholder="https://github.com/yourname">
      <div class="hint">Shown on your CV + used to fill the Portfolio field on apply forms.</div>

      <hr style="border-color:var(--border);margin:24px 0">
      <h3 style="color:var(--text);font-size:.9rem;margin:0 0 4px;font-family:var(--font-display)">Resume / CV</h3>
      <div class="hint" style="margin-bottom:12px">This — not LinkedIn — is what every evaluation and tailored application is actually built from. Upload a PDF (text is extracted automatically) or a .txt/.md file, or just edit it directly below.</div>
      <input type="file" id="cvFileInput" accept=".pdf,.txt,.md" onchange="handleCvFileUpload(event)">
      <div class="hint" id="cvUploadStatus" style="margin:6px 0"></div>
      <textarea id="cvTextarea" rows="14" placeholder="Loading..."></textarea>
      <div class="hint" style="margin-top:4px">Extracted PDF text often needs a cleanup pass — fix line breaks, add markdown headers (## Summary, ## Experience, etc.) before saving, or ask your AI agent to tidy it up afterward.</div>
      <button class="save-btn" onclick="saveCv()" style="margin-top:10px">💾 Save as My CV</button>
      <span id="cvSaveStatus" style="margin-left:12px;font-size:.82rem;color:var(--accent-green-bright)"></span>

      <label>Follow-up Days</label>
      <input type="text" id="sFollowupDays" value="3, 7, 14" placeholder="3, 7, 14">
      <div class="hint">Comma-separated: days after applying to send follow-ups.</div>

      <label>Fill & Stage Threshold</label>
      <input type="number" id="sThreshold" value="4.0" min="0" max="5" step="0.1">
      <div class="hint">Minimum fit score for a job to get filled and staged in the Review Queue (0-5). Nothing is ever submitted without your approval regardless of score.</div>

      <label>Daily Staging Limit</label>
      <input type="number" id="sMaxDaily" value="20" min="1" max="50">
      <div class="hint">Maximum applications filled & staged per day (Continuous Mode).</div>

      <hr style="border-color:var(--border);margin:24px 0">
      <h3 style="color:var(--text);font-size:.9rem;margin:0 0 4px;font-family:var(--font-display)">Job Focus</h3>
      <div class="hint" style="margin-bottom:12px">What kinds of roles should the scanner look for? Pick as many as you want — select from the starter catalog and/or add your own.</div>
      <div class="focus-grid" id="focusGrid"></div>
      <div class="focus-custom-form">
        <input type="text" id="focusCustomLabel" placeholder="Custom focus name (e.g. Trading Systems Developer)">
        <input type="text" id="focusCustomKeywords" placeholder="Keywords, comma-separated (e.g. Pine Script, MQL5)">
        <button class="tool-btn" onclick="addCustomFocus()">+ Add</button>
      </div>
      <div class="focus-chips" id="focusChips"></div>

      <label>Job Title Filter Aggressiveness</label>
      <select id="sAggressiveness">
        <option value="conservative">Conservative — keep almost everything (broadest)</option>
        <option value="balanced">Balanced — require a role or skill match (recommended)</option>
        <option value="aggressive">Aggressive — require a target-role match (narrowest)</option>
      </select>
      <div class="hint">How strictly incoming jobs are filtered to your selected focuses above. Adjust if too many or too few jobs show up.</div>

      <hr style="border-color:var(--border);margin:24px 0">
      <h3 style="color:var(--text);font-size:.9rem;margin:0 0 4px;font-family:var(--font-display)">LLM Provider</h3>
      <div class="hint" style="margin-bottom:12px">AI provider used for job evaluation and application generation.</div>

      <label>Provider</label>
      <select id="sLlmProvider" onchange="onLlmProviderChange()">
        <option value="gemini">Gemini (free tier — gemini-3.5-flash)</option>
        <option value="openrouter">OpenRouter (free tier — auto-rotation)</option>
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic Claude</option>
        <option value="ollama">Ollama (local free, or Ollama Cloud with a key)</option>
      </select>

      <label>API Key</label>
      <input type="password" id="sApiKey" placeholder="Paste your API key here">
      <div class="hint" id="sApiKeyHint">Stored in .env file. Get a free Gemini key at aistudio.google.com</div>

      <label>Model (optional)</label>
      <input type="text" id="sModel" placeholder="gemini-3.5-flash (default)">
      <div class="hint">Leave blank for provider default.</div>

      <button class="save-btn" onclick="saveSettings()">Save Settings</button>
      <span id="settingsStatus" style="margin-left:12px;font-size:.82rem;color:var(--accent-green-bright)"></span>
    </div>
  </div>
</div>

<div class="modal-overlay" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <button class="close" onclick="closeModal()">✕ Close</button>
    <h2 id="mTitle"></h2>
    <div class="sub" id="mSub"></div>
    <div class="meta" id="mMeta"></div>
    <div class="report" id="mReport">Loading...</div>
  </div>
</div>

<script>
const statuses = ['Evaluated', 'Applied', 'Interview', 'Offer', 'Rejected', 'SKIP'];
const COLS = [
  { key: 'num', label: '#' },
  { key: 'date', label: 'Date' },
  { key: 'track', label: 'Track' },
  { key: 'company', label: 'Company' },
  { key: 'role', label: 'Role' },
  { key: 'score', label: 'Score', numeric: true },
  { key: 'status', label: 'Status' },
  { key: 'apply', label: 'Apply', noSort: true },
  { key: 'actions', label: 'Actions', noSort: true },
  { key: 'notes', label: 'Notes' },
];
let allApps = [];
let sortState = { key: 'score', dir: 'desc' };
let eventSource = null;

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function scoreNum(s) { const v = parseFloat(String(s ?? '').replace('/5','')); return Number.isFinite(v) ? v : -1; }

function setConn(ok) {
  const el = document.getElementById('conn-dot');
  if (el) el.style.background = ok ? 'var(--accent-green-bright)' : 'var(--accent-red)';
}
let _bannerTimer = null;
function showBanner(msg) {
  const b = document.getElementById('banner');
  if (!b) return;
  b.textContent = msg;
  b.style.display = 'block';
  clearTimeout(_bannerTimer);
  _bannerTimer = setTimeout(() => { b.style.display = 'none'; }, 7000);
}
async function getJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    setConn(true);
    return await r.json();
  } catch (e) {
    setConn(false);
    showBanner('⚠ Cannot reach server (' + e.message + '). Make sure DAFE-Career-OS.bat is running.');
    return { error: e.message };
  }
}
async function postJSON(url, opts) {
  try {
    const r = await fetch(url, Object.assign({ method: 'POST' }, opts));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    setConn(true);
    return await r.json();
  } catch (e) {
    setConn(false);
    showBanner('⚠ Cannot reach server (' + e.message + '). Make sure DAFE-Career-OS.bat is running.');
    return { error: e.message };
  }
}

function connectSSE() {
  eventSource = new EventSource('/api/stream');
  eventSource.onopen = () => { setConn(true); const b = document.getElementById('banner'); if (b) b.style.display = 'none'; };
  eventSource.onerror = () => setConn(false);
  eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'log') {
      const panel = document.getElementById('logPanel');
      const line = document.createElement('div');
      line.textContent = data.text;
      panel.appendChild(line);
      panel.scrollTop = panel.scrollHeight;
    } else if (data.type === 'start') {
      document.getElementById('logPanel').innerHTML = '';
      document.getElementById('runBtn').disabled = true;
      document.getElementById('rescoreBtn').disabled = true;
      document.getElementById('removeZerosBtn').disabled = true;
      document.getElementById('status-indicator').textContent = '● Running: ' + (data.label || 'Pipeline');
      document.getElementById('progressFill').style.width = '0%';
      // A replayed/in-flight 'start' must be confirmed against the server's
      // authoritative state — a killed pipeline leaves a stale 'start' in the
      // log, and we must NOT lock the UI on it.
      fetchStatus().then(s => { if (!s.running) forceReady(); });
    } else if (data.type === 'step') {
      document.getElementById('progressFill').style.width = (data.current / data.total * 100) + '%';
    } else if (data.type === 'done') {
      document.getElementById('runBtn').disabled = false;
      document.getElementById('rescoreBtn').disabled = false;
      document.getElementById('removeZerosBtn').disabled = false;
      document.getElementById('status-indicator').textContent = '● Ready';
      document.getElementById('progressFill').style.width = '100%';
      loadData();
      loadReviewQueueBadge();
      if (document.getElementById('tab-reviewqueue').classList.contains('active')) loadReviewQueue();
    }
  };
}

async function fetchStatus() {
  try { const r = await fetch('/api/pipeline-status'); if (!r.ok) return { running: false }; return await r.json(); }
  catch { return { running: false }; }
}

// Force the UI back to a usable "Ready" state (re-enable all buttons, clear
// the Running indicator) when a run died without a 'done' event.
function forceReady() {
  const ind = document.getElementById('status-indicator');
  if (ind) ind.textContent = '● Ready';
  const pf = document.getElementById('progressFill');
  if (pf) pf.style.width = '100%';
  const rb = document.getElementById('runBtn'); if (rb) rb.disabled = false;
  const rs = document.getElementById('rescoreBtn'); if (rs) rs.disabled = false;
  const rz = document.getElementById('removeZerosBtn'); if (rz) rz.disabled = false;
}

// Reconcile the UI with the server's authoritative running state. Called on
// load and by the watchdog, so a stale "Running" never permanently locks it.
async function reconcileStatus() {
  const s = await fetchStatus();
  if (!s.running) forceReady();
}

// Watchdog: if the UI shows "Running" but the server says nothing is
// actually alive (the PID died), recover. Relies on the authoritative
// /api/pipeline-status (which verifies the live PID) so a genuinely slow but
// alive pipeline is never false-reset.
setInterval(async () => {
  const ind = document.getElementById('status-indicator');
  if (ind && /Running/.test(ind.textContent)) {
    const s = await fetchStatus();
    if (!s.running) forceReady();
  }
}, 15000);

async function runPipeline() {
  const d = await postJSON('/api/run-pipeline');
  if (d.error) alert(d.error);
}
async function needAJobNow() {
  const d = await postJSON('/api/need-a-job-now', { body: JSON.stringify({ max: 20 }) });
  if (d.error) { alert(d.error); return; }
  showBanner('🔥 I NEED A JOB NOW is running! Applications are being filled and staged — check the Review Queue to approve and submit.');
  loadData();
}
async function rescore() {
  const d = await postJSON('/api/rescore');
  if (d.error) alert(d.error);
}
async function removeZeros() {
  if (!confirm('Remove all applications that scored 0.0/5? This declutters the tracker.')) return;
  const d = await postJSON('/api/remove-zeros');
  if (d.removed !== undefined) { alert('Removed ' + d.removed + ' zero-score entr' + (d.removed === 1 ? 'y' : 'ies') + '.'); loadData(); }
  else if (d.error) alert(d.error);
}

function toggleFilter() { document.getElementById('filterPanel').classList.toggle('open'); }
function clearFilters() {
  document.getElementById('fTrack').value = '';
  document.getElementById('fMinScore').value = '0';
  document.querySelectorAll('#fStatus input').forEach(c => c.checked = true);
  document.getElementById('fSearch').value = '';
  renderTable();
}

async function loadData() {
  const data = await getJSON('/api/applications');
  if (data.error) return;
  allApps = data.applications;

  const trackCounts = {};
  for (const a of allApps) { const t = a.track || 'untagged'; trackCounts[t] = (trackCounts[t] || 0) + 1; }
  const trackStats = Object.keys(trackCounts).map(t => ({ num: trackCounts[t], label: 'Track: ' + t }));
  document.getElementById('stats').innerHTML = [
    { num: data.stats.pending, label: 'Pending Jobs' },
    { num: data.stats.processed, label: 'Processed' },
    { num: data.stats.pdfs, label: 'PDFs' },
    { num: allApps.filter(a => a.status === 'Applied').length, label: 'Applied' },
    { num: allApps.filter(a => a.status === 'Interview').length, label: 'Interviews' },
    { num: allApps.filter(a => a.status === 'Offer').length, label: 'Offers' },
    ...trackStats,
  ].map(s => '<div class="stat-card"><div class="num">' + s.num + '</div><div class="label">' + s.label + '</div></div>').join('');

  renderHead();
  renderTable();
}

function renderHead() {
  document.getElementById('appHead').innerHTML = COLS.map(c =>
    '<th' + (c.noSort ? ' class="no-sort"' : '') + ' data-key="' + c.key + '" onclick="' + (c.noSort ? '' : 'sortBy(' + String.fromCharCode(39) + c.key + String.fromCharCode(39) + ')') + '">' +
    c.label + (c.noSort ? '' : ' <span class="arrow">' + (sortState.key === c.key ? (sortState.dir === 'asc' ? '▲' : '▼') : '↕') + '</span>') +
    '</th>'
  ).join('');
  document.querySelectorAll('#appHead th').forEach(th => {
    if (th.dataset.key === sortState.key) th.classList.add('sorted');
  });
}

function sortBy(key) {
  if (sortState.key === key) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  else { sortState.key = key; sortState.dir = (key === 'score' || key === 'num' || key === 'date') ? 'desc' : 'asc'; }
  renderHead();
  renderTable();
}

function renderTable() {
  const fTrack = document.getElementById('fTrack').value;
  const fMin = parseFloat(document.getElementById('fMinScore').value) || 0;
  const fStatus = Array.from(document.querySelectorAll('#fStatus input:checked')).map(c => c.value);
  const fSearch = (document.getElementById('fSearch').value || document.getElementById('quickSearch').value || '').toLowerCase();

  let rows = allApps.filter(a => {
    if (fTrack && a.track !== fTrack) return false;
    if (scoreNum(a.score) < fMin) return false;
    if (!fStatus.includes(a.status)) return false;
    if (fSearch) {
      const hay = (a.company + ' ' + a.role + ' ' + a.notes + ' ' + (a.track || '')).toLowerCase();
      if (!hay.includes(fSearch)) return false;
    }
    return true;
  });

  const dir = sortState.dir === 'asc' ? 1 : -1;
  const key = sortState.key;
  rows.sort((a, b) => {
    let va, vb;
    if (key === 'score' || key === 'num') { va = (key === 'score' ? scoreNum(a.score) : a.num); vb = (key === 'score' ? scoreNum(b.score) : b.num); }
    else { va = String(a[key] ?? '').toLowerCase(); vb = String(b[key] ?? '').toLowerCase(); }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });

  document.getElementById('appTable').innerHTML = rows.map(a => {
    const statusClass = 'status-' + a.status.replace(/[^a-zA-Z]/g, '');
    const trackBadge = a.track ? '<span class="track-badge">' + esc(a.track) + '</span>' : '';
    const actions = statuses.map(s =>
      '<button class="status-btn' + (s === a.status ? ' active' : '') + '" onclick="event.stopPropagation();updateStatus(' + String.fromCharCode(39) + a.company.replace(/'/g, "\\'") + String.fromCharCode(39) + ',' + String.fromCharCode(39) + s + String.fromCharCode(39) + ')">' + s + '</button>'
    ).join('');
    const applyBtn = a.url ? '<button class="apply-btn" id="apply-' + a.num + '" onclick="event.stopPropagation();applyToJob(' + a.num + ')">Apply</button>' : '<span class="muted">—</span>';
    const sc = scoreNum(a.score);
    const scoreColor = sc >= 4 ? 'var(--accent-green-bright)' : sc >= 3 ? 'var(--accent-cyan)' : sc > 0 ? 'var(--accent-amber)' : 'var(--text-mute)';
    return '<tr onclick="openDetail(' + a.num + ')">' +
      '<td>' + a.num + '</td>' +
      '<td>' + a.date + '</td>' +
      '<td>' + trackBadge + '</td>' +
      '<td>' + esc(a.company) + '</td>' +
      '<td>' + esc(a.role) + '</td>' +
      '<td class="score-cell" style="color:' + scoreColor + '">' + a.score + '</td>' +
      '<td><span class="status-badge ' + statusClass + '">' + a.status + '</span></td>' +
      '<td class="app-actions">' + applyBtn + '</td>' +
      '<td class="app-actions">' + actions + '</td>' +
      '<td class="notes-cell" title="' + esc(a.notes) + '">' + esc(a.notes).slice(0, 60) + '</td>' +
    '</tr>';
  }).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--text-mute);padding:24px">No applications match the current filters.</td></tr>';
}

async function updateStatus(company, status) {
  try {
    const r = await fetch('/api/application/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company, status }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    setConn(true);
  } catch (e) {
    setConn(false);
    showBanner('⚠ Cannot reach server (' + e.message + '). Make sure DAFE-Career-OS.bat is running.');
  }
  loadData();
}

async function applyToJob(num) {
  const a = allApps.find(x => x.num === num);
  if (!a || !a.url) { alert('No URL for this job'); return; }
  const btn = document.getElementById('apply-' + num);
  if (!btn) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Filling…';
  try {
    const r = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num: a.num, url: a.url, company: a.company, role: a.role })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data.staged) {
      showBanner('📋 Filled and staged for review — approve it in the Review Queue to submit.');
    } else {
      showBanner('⚠ ' + (data.error || data.message || 'Apply failed'));
    }
    setConn(true);
  } catch (e) {
    setConn(false);
    showBanner('⚠ Cannot reach server (' + e.message + '). Make sure DAFE-Career-OS.bat is running.');
  }
  btn.disabled = false;
  btn.textContent = origText;
  loadData();
}

async function openDetail(num) {
  const a = allApps.find(x => x.num === num);
  if (!a) return;
  document.getElementById('mTitle').textContent = a.role + ' — ' + a.company;
  document.getElementById('mSub').textContent = 'Report #' + a.num + (a.reportPath ? '' : '');
  document.getElementById('mMeta').innerHTML =
    '<span class="track-badge">' + esc(a.track || 'untagged') + '</span>' +
    '<span class="status-badge status-' + a.status.replace(/[^a-zA-Z]/g, '') + '">' + a.status + '</span>' +
    '<span style="color:var(--accent-green-bright);font-weight:700">' + a.score + '</span>' +
    '<span style="color:var(--text-dim)">' + a.date + '</span>';
  const file = a.reportPath ? a.reportPath.split('/').pop() : '';
  document.getElementById('mReport').textContent = 'Loading report...';
  document.getElementById('modal').classList.add('open');
  if (file) {
    const d = await getJSON('/api/report?file=' + encodeURIComponent(file));
    if (d.error) { document.getElementById('mReport').innerHTML = '<span style="color:var(--accent-red)">⚠ Could not load report (' + esc(d.error) + ').<br>Check DAFE-Career-OS.bat is running.</span>'; }
    else { document.getElementById('mReport').innerHTML = renderMd(d.markdown || '_No report._'); }
  } else {
    document.getElementById('mReport').textContent = a.notes || 'No report available.';
  }
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }

function renderMd(md) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(md)
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>[\\s\\S]*?<\\/li>)/g, '<ul>$1</ul>')
    .replace(/\\n{2,}/g, '<br><br>')
    .replace(/\\n/g, '<br>');
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
  var tabEl = document.querySelector('.tab[onclick*="' + name + '"]');
  if (tabEl) tabEl.classList.add('active');
  var contentEl = document.getElementById('tab-' + name);
  if (contentEl) contentEl.classList.add('active');
  if (name === 'pipeline') loadPipeline();
  if (name === 'warroom') { loadWarRoom(); loadContinuous(); }
  if (name === 'settings') { loadSettings(); loadFocusCatalog(); loadCv(); }
  if (name === 'reviewqueue') loadReviewQueue();
}

async function loadPipeline() {
  const data = await getJSON('/api/applications');
  if (data.error) { document.getElementById('pipelineTable').innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--accent-red);padding:24px">⚠ Cannot reach server. Is DAFE-Career-OS.bat running?</td></tr>'; return; }
  document.getElementById('pipelineTable').innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-mute);padding:24px">Run a scan to populate the pipeline. Pending jobs appear here after scanning.</td></tr>';
}

// === Review Queue Client — nothing here ever submits by itself. Approve
// spawns submit-application.mjs, which is the only script allowed to click
// a real Submit button, and only after this explicit click. ===
let reviewQueueEntries = [];
const selectedQueueIds = new Set();

function fileName(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}

async function loadReviewQueueBadge() {
  const d = await getJSON('/api/review-queue');
  if (d.error) return;
  const pending = (d.entries || []).filter(e => e.status === 'pending_review' || e.status === 'failed').length;
  const el = document.getElementById('reviewQueueCount');
  if (el) el.textContent = pending ? '(' + pending + ')' : '';
}

async function loadReviewQueue() {
  const d = await getJSON('/api/review-queue');
  if (d.error) return;
  reviewQueueEntries = d.entries || [];
  for (const id of [...selectedQueueIds]) { if (!reviewQueueEntries.some(e => e.id === id)) selectedQueueIds.delete(id); }
  renderReviewQueue();
  loadReviewQueueBadge();
}

function renderReviewQueue() {
  const grid = document.getElementById('reviewGrid');
  if (!reviewQueueEntries.length) {
    grid.innerHTML = '<div style="color:var(--text-mute);font-size:.85rem;grid-column:1/-1">Nothing staged yet. Run "Scan &amp; Fill" or "I NEED A JOB NOW" to fill and stage applications here for your review.</div>';
    updateReviewBulkButtons();
    return;
  }
  grid.innerHTML = reviewQueueEntries.map(e => {
    const actionable = e.status === 'pending_review' || e.status === 'failed';
    const scoreBadge = e.fitScore == null
      ? '<span class="review-badge score unscored">Unscored</span>'
      : '<span class="review-badge score">' + Number(e.fitScore).toFixed(1) + '/5</span>';
    const links = [];
    if (e.cvPath) links.push('<a href="/api/output-file?name=' + encodeURIComponent(fileName(e.cvPath)) + '" target="_blank">CV</a>');
    if (e.coverPath) links.push('<a href="/api/output-file?name=' + encodeURIComponent(fileName(e.coverPath)) + '" target="_blank">Cover Letter</a>');
    if (e.reportPath) links.push('<a href="#" onclick="event.preventDefault();openReviewReport(' + String.fromCharCode(39) + e.reportPath + String.fromCharCode(39) + ')">Report</a>');
    links.push('<a href="' + esc(e.url) + '" target="_blank">Listing ↗</a>');
    const captchaBanner = e.needsManualSolve
      ? '<div class="review-captcha-banner">⚠ CAPTCHA/challenge detected — open the listing, solve it yourself, then Approve.' + (e.captchaNote ? ' (' + esc(e.captchaNote) + ')' : '') + '</div>'
      : '';
    const statusPill = {
      pending_review: 'Awaiting review',
      submitting: 'Submitting…',
      submitted: '✅ Submitted',
      failed: '⚠ Failed: ' + esc(e.error || 'unknown'),
      rejected: 'Rejected' + (e.rejectReason ? ': ' + esc(e.rejectReason) : ''),
    }[e.status] || e.status;
    const checkbox = actionable
      ? '<input type="checkbox" ' + (selectedQueueIds.has(e.id) ? 'checked' : '') + ' onchange="toggleQueueSelect(' + String.fromCharCode(39) + e.id + String.fromCharCode(39) + ', this.checked)">'
      : '';
    return '<div class="review-card' + (e.needsManualSolve ? ' needs-solve' : '') + '">' +
      '<div class="review-card-top">' +
        '<div>' +
          '<div class="review-card-company">' + checkbox + ' ' + esc(e.company) + '</div>' +
          '<div class="review-card-role">' + esc(e.role) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="review-card-badges">' +
        scoreBadge +
        '<span class="review-badge ats">' + esc(e.ats || 'unknown') + '</span>' +
        '<span class="review-badge fields">' + (e.filledCount ?? '?') + '/' + (e.totalFields ?? '?') + ' fields</span>' +
      '</div>' +
      captchaBanner +
      '<div class="review-card-links">' + links.join(' · ') + '</div>' +
      '<div class="review-card-actions">' +
        (actionable
          ? '<button class="review-approve-btn" onclick="approveOneQueue(' + String.fromCharCode(39) + e.id + String.fromCharCode(39) + ')">✅ Approve &amp; Submit</button>' +
            '<button class="review-reject-btn" onclick="rejectOneQueue(' + String.fromCharCode(39) + e.id + String.fromCharCode(39) + ')">✕ Reject</button>'
          : '<span class="review-status-pill">' + statusPill + '</span>') +
      '</div>' +
    '</div>';
  }).join('');
  updateReviewBulkButtons();
}

function openReviewReport(reportPath) {
  if (!reportPath) return;
  const file = reportPath.split('/').pop();
  document.getElementById('mTitle').textContent = 'Report';
  document.getElementById('mSub').textContent = '';
  document.getElementById('mMeta').innerHTML = '';
  document.getElementById('mReport').textContent = 'Loading report...';
  document.getElementById('modal').classList.add('open');
  getJSON('/api/report?file=' + encodeURIComponent(file)).then(d => {
    document.getElementById('mReport').innerHTML = d.error
      ? '<span style="color:var(--accent-red)">⚠ Could not load report.</span>'
      : renderMd(d.markdown || '_No report._');
  });
}

function toggleQueueSelect(id, checked) {
  if (checked) selectedQueueIds.add(id); else selectedQueueIds.delete(id);
  updateReviewBulkButtons();
}

function toggleSelectAllQueue() {
  const actionableIds = reviewQueueEntries.filter(e => e.status === 'pending_review' || e.status === 'failed').map(e => e.id);
  const allSelected = actionableIds.length > 0 && actionableIds.every(id => selectedQueueIds.has(id));
  if (allSelected) actionableIds.forEach(id => selectedQueueIds.delete(id));
  else actionableIds.forEach(id => selectedQueueIds.add(id));
  renderReviewQueue();
}

function updateReviewBulkButtons() {
  const n = selectedQueueIds.size;
  const approveBtn = document.getElementById('reviewApproveSelectedBtn');
  const rejectBtn = document.getElementById('reviewRejectSelectedBtn');
  if (approveBtn) { approveBtn.disabled = n === 0; approveBtn.textContent = n ? '✅ Approve selected (' + n + ')' : '✅ Approve selected'; }
  if (rejectBtn) { rejectBtn.disabled = n === 0; rejectBtn.textContent = n ? '✕ Reject selected (' + n + ')' : '✕ Reject selected'; }
}

async function approveOneQueue(id) {
  const d = await postJSON('/api/review-queue/approve', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  if (d.error) { alert(d.error); return; }
  showBanner('✅ Submitting — watch the log panel for progress.');
  selectedQueueIds.delete(id);
  setTimeout(loadReviewQueue, 1500);
}

async function rejectOneQueue(id) {
  const d = await postJSON('/api/review-queue/reject', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  if (d.error) { alert(d.error); return; }
  selectedQueueIds.delete(id);
  loadReviewQueue();
}

async function approveSelectedQueue() {
  const ids = [...selectedQueueIds];
  if (!ids.length) return;
  if (!confirm('Submit ' + ids.length + ' application(s)? Each one will actually be sent.')) return;
  const d = await postJSON('/api/review-queue/approve-batch', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  if (d.error) { alert(d.error); return; }
  showBanner('✅ Submitting ' + ids.length + ' application(s) — watch the log panel for progress.');
  selectedQueueIds.clear();
  setTimeout(loadReviewQueue, 1500);
}

async function rejectSelectedQueue() {
  const ids = [...selectedQueueIds];
  if (!ids.length) return;
  const d = await postJSON('/api/review-queue/reject-batch', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  if (d.error) { alert(d.error); return; }
  selectedQueueIds.clear();
  loadReviewQueue();
}

// === Job Focus Catalog Client (Settings) ===
// === Resume / CV Client (Settings) ===
async function loadCv() {
  const d = await getJSON('/api/cv');
  const el = document.getElementById('cvTextarea');
  if (d.error) { el.placeholder = 'Could not load cv.md'; return; }
  el.value = d.content || '';
  el.placeholder = '';
}

function handleCvFileUpload(event) {
  const file = event.target.files[0];
  event.target.value = ''; // always clear so re-selecting the same file fires change again
  if (!file) return;
  const statusEl = document.getElementById('cvUploadStatus');
  const name = file.name.toLowerCase();

  if (name.endsWith('.txt') || name.endsWith('.md')) {
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById('cvTextarea').value = reader.result;
      statusEl.textContent = 'Loaded ' + file.name + ' — review below, then Save.';
    };
    reader.onerror = () => { statusEl.textContent = '⚠ Could not read ' + file.name; };
    reader.readAsText(file);
    return;
  }

  if (name.endsWith('.pdf')) {
    statusEl.textContent = 'Extracting text from ' + file.name + '...';
    const reader = new FileReader();
    reader.onload = async () => {
      var base64 = String(reader.result).split(',')[1] || '';
      var d = await postJSON('/api/cv/extract', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataBase64: base64 }) });
      if (d.error) { statusEl.textContent = '⚠ ' + d.error; return; }
      document.getElementById('cvTextarea').value = d.text;
      statusEl.textContent = 'Extracted from ' + file.name + ' — review below (PDF formatting may need cleanup), then Save.';
    };
    reader.onerror = () => { statusEl.textContent = '⚠ Could not read ' + file.name; };
    reader.readAsDataURL(file);
    return;
  }

  statusEl.textContent = '⚠ Unsupported file type — use .pdf, .txt, or .md.';
}

async function saveCv() {
  var content = document.getElementById('cvTextarea').value;
  if (!content.trim()) { alert('CV content is empty — nothing to save.'); return; }
  var d = await postJSON('/api/cv/save', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
  if (d.error) { alert(d.error); return; }
  document.getElementById('cvSaveStatus').textContent = 'Saved ✓';
  setTimeout(function() { document.getElementById('cvSaveStatus').textContent = ''; }, 2500);
}

let focusCatalogData = { catalog: [], active: [] };
let customFocuses = [];

async function loadFocusCatalog() {
  const d = await getJSON('/api/focus-catalog');
  if (d.error) return;
  focusCatalogData = d;
  customFocuses = (d.active || []).filter(f => f.id === 'custom');
  renderFocusGrid();
}

function renderFocusGrid() {
  const activeIds = new Set((focusCatalogData.active || []).filter(f => f.id !== 'custom').map(f => f.id));
  document.getElementById('focusGrid').innerHTML = (focusCatalogData.catalog || []).map(f =>
    '<label class="focus-chk"><input type="checkbox" value="' + esc(f.id) + '" ' + (activeIds.has(f.id) ? 'checked' : '') + '> ' + esc(f.label) + '</label>'
  ).join('');
  renderFocusChips();
}

function renderFocusChips() {
  document.getElementById('focusChips').innerHTML = customFocuses.map((f, i) =>
    '<span class="focus-chip">' + esc(f.label) + '<button onclick="removeCustomFocus(' + i + ')" title="Remove">✕</button></span>'
  ).join('');
}

function addCustomFocus() {
  const labelEl = document.getElementById('focusCustomLabel');
  const kwEl = document.getElementById('focusCustomKeywords');
  const label = labelEl.value.trim();
  const keywords = kwEl.value.split(',').map(s => s.trim()).filter(Boolean);
  if (!label && !keywords.length) return;
  customFocuses.push({ id: 'custom', label: label || keywords[0], keywords: keywords.length ? keywords : [label] });
  labelEl.value = ''; kwEl.value = '';
  renderFocusChips();
}

function removeCustomFocus(i) {
  customFocuses.splice(i, 1);
  renderFocusChips();
}

function selectedFocusIds() {
  return Array.from(document.querySelectorAll('#focusGrid input:checked')).map(el => el.value);
}

// Populates the Applications-tab Track filter from whatever focuses are
// actually active, instead of a hardcoded pair.
async function populateTrackFilter() {
  const d = await getJSON('/api/focus-catalog');
  if (d.error) return;
  const sel = document.getElementById('fTrack');
  const current = sel.value;
  const seen = new Set();
  let opts = '<option value="">All focuses</option>';
  for (const f of (d.active || [])) {
    const id = f.id === 'custom' ? 'custom:' + f.label : f.id;
    if (seen.has(id)) continue;
    seen.add(id);
    opts += '<option value="' + esc(id) + '">' + esc(f.label) + '</option>';
  }
  sel.innerHTML = opts;
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
}

document.getElementById('fTrack').addEventListener('change', renderTable);
document.getElementById('fMinScore').addEventListener('change', renderTable);
document.querySelectorAll('#fStatus input').forEach(c => c.addEventListener('change', renderTable));

connectSSE();
reconcileStatus();
loadData();
loadReviewQueueBadge();
populateTrackFilter();
setInterval(loadData, 8000);
setInterval(() => { getJSON('/api/applications'); }, 15000);
setInterval(loadReviewQueueBadge, 10000);

// === War Room Client ===
async function loadWarRoom() {
  const resp = await Promise.all([
    getJSON('/api/funnel'),
    getJSON('/api/daily-queue'),
    getJSON('/api/patterns'),
  ]);
  if (resp[0].error || resp[1].error || resp[2].error) return;
  var funnel = resp[0].funnel;
  var queue = resp[1];
  var patterns = resp[2];
  renderFunnel(funnel);
  renderQueue(queue);
  renderFollowups(queue.followupsDue);
  renderPatterns(patterns);
}

function renderFunnel(f) {
  var max = Math.max(f.evaluated, 1);
  var stages = [
    { key: 'evaluated', label: 'Evaluated' },
    { key: 'applied', label: 'Applied' },
    { key: 'responded', label: 'Responded' },
    { key: 'interview', label: 'Interview' },
    { key: 'offer', label: 'Offer' },
  ];
  var html = '';
  for (var i = 0; i < stages.length; i++) {
    var s = stages[i];
    var val = f[s.key] || 0;
    var pct = Math.round(val / max * 100);
    var conv = s.key === 'evaluated' ? '' : ' (' + (f[s.key] && f.evaluated ? Math.round(f[s.key] / f.evaluated * 100) : 0) + '%)';
    html += '<div class="funnel-step">' +
      '<span class="funnel-label">' + s.label + '</span>' +
      '<div class="funnel-bar-wrap"><div class="funnel-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="funnel-count">' + val + '</span>' +
      '<span class="funnel-pct">' + conv + '</span>' +
    '</div>';
  }
  document.getElementById('funnelViz').innerHTML = html;
}

function renderQueue(q) {
  var html = '';
  if (!q.topJobs || q.topJobs.length === 0) {
    html = '<div style="color:var(--text-mute);font-size:.8rem">No high-score jobs waiting. Run a scan to find more.</div>';
  } else {
    for (var i = 0; i < q.topJobs.length; i++) {
      var j = q.topJobs[i];
      html += '<div class="queue-item">' +
        '<div><span class="q-company">' + esc(j.company) + '</span> <span class="q-role">' + esc(j.role) + '</span></div>' +
        '<span class="q-score">' + j.score + '</span>' +
      '</div>';
    }
  }
  document.getElementById('dailyQueue').innerHTML = html;
}

function renderFollowups(list) {
  var html = '';
  if (!list || list.length === 0) {
    html = '<div style="color:var(--text-mute);font-size:.8rem">No follow-ups due right now.</div>';
  } else {
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var days = Math.floor((Date.now() - new Date(f.date).getTime()) / 86400000);
      html += '<div class="queue-item">' +
        '<div><span class="q-company">' + esc(f.company) + '</span> <span class="q-role">' + esc(f.role) + '</span></div>' +
        '<span style="color:var(--accent-amber);font-size:.78rem">' + days + 'd ago</span>' +
      '</div>';
    }
  }
  document.getElementById('followupsList').innerHTML = html;
}

function renderPatterns(p) {
  document.getElementById('patternSummary').innerHTML =
    '<div class="pattern-grid">' +
      '<div class="pat-box"><div class="num" style="color:var(--accent-cyan)">' + p.total + '</div><div class="label">Total Apps</div></div>' +
      '<div class="pat-box"><div class="num" style="color:var(--accent-green-bright)">' + p.applied + '</div><div class="label">Applied</div></div>' +
      '<div class="pat-box"><div class="num" style="color:var(--accent-amber)">' + p.interviewed + '</div><div class="label">Interviews</div></div>' +
      '<div class="pat-box"><div class="num" style="color:var(--accent-violet)">' + p.offers + '</div><div class="label">Offers</div></div>' +
      '<div class="pat-box"><div class="num" style="color:var(--accent-red)">' + p.rejected + '</div><div class="label">Rejected</div></div>' +
      '<div class="pat-box"><div class="num" style="color:var(--accent-green-bright)">' + p.avgScore + '</div><div class="label">Avg Score</div></div>' +
    '</div>';
  var th = '<table class="track-table"><tr><th>Track</th><th>Total</th><th>Applied</th><th>Resp.</th><th>Int.</th><th>Offer</th><th>Rej.</th></tr>';
  for (var t in p.byTrack) {
    if (p.byTrack.hasOwnProperty(t)) {
      var b = p.byTrack[t];
      th += '<tr><td style="font-weight:600">' + t + '</td><td>' + b.total + '</td><td>' + b.applied + '</td><td>' + b.responded + '</td><td>' + b.interviewed + '</td><td>' + b.offered + '</td><td>' + b.rejected + '</td></tr>';
    }
  }
  th += '</table>';
  document.getElementById('patternsBox').innerHTML = th;
}

// === Continuous Mode Client ===
async function loadContinuous() {
  var s = await getJSON('/api/continuous/status');
  var btn = document.getElementById('contBtn');
  var panel = document.getElementById('contStatus');
  if (s.error) {
    btn.innerHTML = 'Start Continuous Processing<span class="small">⚠ Server offline — restart DAFE-Career-OS.bat</span>';
    btn.onclick = startContinuous;
    panel.style.display = 'none';
    return;
  }
  if (s.running) {
    btn.innerHTML = 'Stop Continuous Processing<span class="small">Worker is running</span>';
    btn.onclick = stopContinuous;
    panel.style.display = 'flex';
    panel.innerHTML =
      '<div class="cont-stat"><div class="num">' + (s.totalEvaluated || 0) + '</div><div class="label">Evaluated</div></div>' +
      '<div class="cont-stat"><div class="num">' + (s.totalStaged || 0) + '</div><div class="label">Staged</div></div>' +
      '<div class="cont-stat"><div class="num">' + (s.pendingRemaining || 0) + '</div><div class="label">Remaining</div></div>' +
      '<div class="cont-stat"><div class="num">' + (s.totalGhostSkipped || 0) + '</div><div class="label">Ghosts Skipped</div></div>';
  } else {
    btn.innerHTML = 'Start Continuous Processing<span class="small">Auto-evaluates &amp; stages applications for review until pipeline is empty</span>';
    btn.onclick = startContinuous;
    panel.style.display = 'none';
  }
}

async function startContinuous() {
  var d = await postJSON('/api/continuous/start');
  if (d.error) { alert(d.error); return; }
  loadContinuous();
}

async function stopContinuous() {
  await postJSON('/api/continuous/stop');
  loadContinuous();
}

async function toggleContinuous() {
  var s = await getJSON('/api/continuous/status');
  if (s.error) return;
  if (s.running) { await stopContinuous(); }
  else { await startContinuous(); }
}

// === Settings Client ===
async function loadSettings() {
  var [s, llm] = await Promise.all([
    getJSON('/api/settings'),
    getJSON('/api/llm-config'),
  ]);
  if (s.error) return;
  document.getElementById('sEmail').value = s.email || '';
  document.getElementById('sPhone').value = s.phone || '';
  document.getElementById('sLinkedin').value = s.linkedin || '';
  document.getElementById('sPortfolio').value = s.portfolio || '';
  document.getElementById('sFollowupDays').value = (s.followupDays || [3,7,14]).join(', ');
  document.getElementById('sThreshold').value = s.scoreThreshold || 4.0;
  document.getElementById('sMaxDaily').value = s.continuousMaxDaily || 20;
  document.getElementById('sAggressiveness').value = s.filterAggressiveness || 'conservative';
  if (!llm.error) {
    document.getElementById('sLlmProvider').value = llm.provider || 'gemini';
    document.getElementById('sApiKey').placeholder = llm.hasKey ? '•••••••• (key set)' : 'Paste your API key here';
    document.getElementById('sModel').value = llm.model || '';
  }
  onLlmProviderChange();
}

function onLlmProviderChange() {
  var provider = document.getElementById('sLlmProvider').value;
  var hint = document.getElementById('sApiKeyHint');
  if (provider === 'ollama') {
    hint.textContent = 'Optional. Leave blank to use a local Ollama (ollama serve on this machine, free). Paste an Ollama Cloud API key (ollama.com) to use cloud models instead.';
  } else {
    hint.textContent = 'Stored in .env file. Get a free Gemini key at aistudio.google.com';
  }
}

async function saveSettings() {
  var body = {
    email: document.getElementById('sEmail').value,
    phone: document.getElementById('sPhone').value,
    linkedin: document.getElementById('sLinkedin').value,
    portfolio: document.getElementById('sPortfolio').value,
    followupDays: document.getElementById('sFollowupDays').value.split(',').map(function(s) { return parseInt(s.trim()); }).filter(function(n) { return !isNaN(n); }),
    scoreThreshold: parseFloat(document.getElementById('sThreshold').value) || 4.0,
    continuousMaxDaily: parseInt(document.getElementById('sMaxDaily').value) || 20,
    filterAggressiveness: document.getElementById('sAggressiveness').value,
  };
  var d = await postJSON('/api/settings', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (d.error) { alert(d.error); return; }

  var focusBody = { selectedIds: selectedFocusIds(), custom: customFocuses };
  var focusResult = await postJSON('/api/profile/focuses', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(focusBody) });
  if (focusResult.error) { alert('Job focus save error: ' + focusResult.error); return; }
  populateTrackFilter();

  // Always save provider + model, not just when an API key is typed — Ollama's
  // local mode has no key at all, and switching provider/model shouldn't
  // silently no-op just because the key field was left blank.
  var apiKey = document.getElementById('sApiKey').value;
  var llmBody = {
    provider: document.getElementById('sLlmProvider').value,
    apiKey: apiKey,
    model: document.getElementById('sModel').value,
  };
  var llm = await postJSON('/api/llm-config', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(llmBody) });
  if (llm.error) { alert('LLM config error: ' + llm.error); return; }
  if (apiKey) {
    document.getElementById('sApiKey').value = '';
    document.getElementById('sApiKey').placeholder = '•••••••• (key set)';
  }
  document.getElementById('settingsStatus').textContent = 'Saved \u2713';
  setTimeout(function() { document.getElementById('settingsStatus').textContent = ''; }, 2000);
}

// Patch stats to refresh on pipeline completion
var _origUpdate = updateStatus;
updateStatus = async function(company, status) {
  await _origUpdate(company, status);
  if (document.getElementById('tab-warroom').classList.contains('active')) {
    loadWarRoom();
    loadContinuous();
  }
};
</script>
</body>
</html>`;

server();
