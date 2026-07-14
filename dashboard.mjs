#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import http from 'http';

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

let pipelineRunning = false;
let sseClients = [];

const EVENTS_FILE = join(ROOT, 'data', 'pipeline-events.log');
const STATUS_FILE = join(ROOT, 'data', 'pipeline-status.json');

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

function isPipelineRunning() {
  try { return JSON.parse(readFileSync(STATUS_FILE, 'utf-8')).running === true; } catch { return false; }
}

// Launch the heavy pipeline as a fully DETACHED background process so it
// survives server crashes, browser disconnects, and terminal closure.
function startBackgroundJob(mode) {
  if (isPipelineRunning()) return false;
  const child = spawn('node', ['run-pipeline-bg.mjs', mode], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  pipelineRunning = true;
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
      apps.push({
        num: parseInt(m[1]), date: m[2], company: m[3], role: m[4],
        score: m[5]?.trim(), status: m[6]?.trim(), pdf: m[7]?.trim(),
        reportNum: parseInt(m[8]), reportPath: m[9], notes: rawNotes.replace(/^\[\w+\]\s*/, ''),
        track: trackMatch ? trackMatch[1] : ''
      });
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
    const d = { email: '', phone: '', linkedin: '', portfolio: '', followupDays: [3, 7, 14], continuousBatch: 5, continuousMaxDaily: 20, scoreThreshold: 4.0, filterAggressiveness: 'conservative' };
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
  if (existing.running) { res.writeHead(409); res.end(JSON.stringify({error:'Already running'})); return; }
  writeJSON(join(DATA_DIR,'continuous-control.json'), { action: 'run' });
  // Detached so it survives server restart / browser disconnect.
  continuousChild = spawn('node', ['continuous-worker.mjs'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  continuousChild.unref();
  res.writeHead(200); res.end(JSON.stringify({started:true}));
}

function handleContinuousStop(req, res) {
  writeJSON(join(DATA_DIR,'continuous-control.json'), { action: 'stop' });
  if (continuousChild) { try { continuousChild.kill(); } catch {} continuousChild = null; }
  res.writeHead(200); res.end(JSON.stringify({stopped:true}));
}
// --- End War Room Helpers ---

function server() {
  const srv = http.createServer((req, res) => {
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
      if (pipelineRunning || isPipelineRunning()) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Pipeline already running' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ started: true }));
      startBackgroundJob('pipeline');
      return;
    }

    if (path === '/api/rescore' && req.method === 'POST') {
      if (pipelineRunning || isPipelineRunning()) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Pipeline already running' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ started: true }));
      startBackgroundJob('rescore');
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

    if (path === '/api/continuous/start' && req.method === 'POST') { handleContinuousStart(req, res); return; }
    if (path === '/api/continuous/stop' && req.method === 'POST') { handleContinuousStop(req, res); return; }
    if (path === '/api/continuous/status') {
      const s = readJSON(join(DATA_DIR, 'continuous-status.json'), { running: false, pendingRemaining: 0 });
      res.writeHead(200); res.end(JSON.stringify(s)); return;
    }
    if (path === '/api/funnel') {
      res.writeHead(200); res.end(JSON.stringify(getFunnelData())); return;
    }
    if (path === '/api/daily-queue') {
      res.writeHead(200); res.end(JSON.stringify(getDailyQueue())); return;
    }
    if (path === '/api/settings' && req.method === 'GET') {
      res.writeHead(200); res.end(JSON.stringify(getSettings())); return;
    }
    if (path === '/api/settings' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { const s = saveSettings(JSON.parse(body)); res.writeHead(200); res.end(JSON.stringify(s)); } catch (e) { res.writeHead(400); res.end(JSON.stringify({error:e.message})); } });
      return;
    }
    if (path === '/api/company-intel') {
      const company = url.searchParams.get('company') || '';
      res.writeHead(200); res.end(JSON.stringify(getCompanyIntel(company))); return;
    }
    if (path === '/api/patterns') {
      res.writeHead(200); res.end(JSON.stringify(getPatterns())); return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });

  srv.listen(PORT, '0.0.0.0', () => {
    try { writeFileSync(join(ROOT, 'data', 'server.pid'), String(process.pid)); } catch {}
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║     DAFE Career OS Control Dashboard        ║`);
    console.log(`  ╚══════════════════════════════════════════╝`);
    console.log(`\n  → Open http://127.0.0.1:${PORT} in your browser`);
    console.log(`  → Press Ctrl+C to stop the server\n`);
    try { execFileSync('start', [`http://localhost:${PORT}`], { shell: true, timeout: 3000 }); } catch {}
  });
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DAFE Career OS Dashboard</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
.header { background: linear-gradient(135deg, #1e293b, #0f172a); padding: 20px 24px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between; }
.header h1 { font-size: 1.4rem; font-weight: 700; color: #38bdf8; }
.header .subtitle { color: #94a3b8; font-size: .85rem; }
.container { max-width: 1280px; margin: 0 auto; padding: 20px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 14px; text-align: center; }
.stat-card .num { font-size: 1.8rem; font-weight: 700; color: #38bdf8; }
.stat-card .label { font-size: .7rem; color: #94a3b8; margin-top: 4px; text-transform: uppercase; letter-spacing: .05em; }
.main-btn-wrap { text-align: center; margin-bottom: 18px; }
.btn-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-bottom: 16px; }
.tool-btn { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 10px; padding: 10px 18px; font-size: .85rem; font-weight: 600; cursor: pointer; transition: background .15s; }
.tool-btn:hover { background: #334155; }
.tool-btn.primary { background: linear-gradient(135deg, #38bdf8, #818cf8); border: none; color: white; }
.tool-btn.danger { background: #7f1d1d; border-color: #b91c1c; }
.tool-btn:disabled { opacity: .5; cursor: not-allowed; }
.main-btn { background: linear-gradient(135deg, #38bdf8, #818cf8); color: white; border: none; border-radius: 16px; padding: 18px 50px; font-size: 1.2rem; font-weight: 700; cursor: pointer; transition: transform .15s, box-shadow .15s; box-shadow: 0 4px 20px rgba(56,189,248,.3); }
.main-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 30px rgba(56,189,248,.4); }
.main-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.main-btn .small { display: block; font-size: .7rem; font-weight: 400; opacity: .8; margin-top: 4px; }
.log-panel { background: #0d1117; border: 1px solid #334155; border-radius: 8px; padding: 14px; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: .78rem; line-height: 1.5; max-height: 240px; overflow-y: auto; margin-bottom: 18px; white-space: pre-wrap; color: #8b949e; }
.progress-bar { height: 4px; background: #334155; border-radius: 2px; margin-bottom: 12px; overflow: hidden; }
.progress-bar .fill { height: 100%; background: linear-gradient(90deg, #38bdf8, #818cf8); width: 0; transition: width .3s; border-radius: 2px; }
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.toolbar input[type=text] { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 8px 12px; color: #e2e8f0; font-size: .85rem; min-width: 200px; }
.filter-panel { display: none; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px; margin-bottom: 14px; gap: 18px; flex-wrap: wrap; }
.filter-panel.open { display: flex; }
.filter-group { display: flex; flex-direction: column; gap: 6px; }
.filter-group label { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; }
.filter-group select, .filter-group input { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 6px 8px; color: #e2e8f0; font-size: .8rem; }
.chk { display: flex; align-items: center; gap: 4px; font-size: .8rem; }
.tabs { display: flex; gap: 4px; margin-bottom: 14px; }
.tab { padding: 8px 20px; border: 1px solid #334155; border-radius: 8px 8px 0 0; background: #1e293b; color: #94a3b8; cursor: pointer; font-size: .85rem; }
.tab.active { background: #334155; color: #e2e8f0; border-bottom-color: #334155; }
.tab-content { display: none; }
.tab-content.active { display: block; }
.table-wrap { overflow-x: auto; background: #1e293b; border-radius: 8px; border: 1px solid #334155; }
table { width: 100%; border-collapse: collapse; }
th { background: #334155; padding: 10px 12px; text-align: left; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: #94a3b8; cursor: pointer; user-select: none; white-space: nowrap; }
th.no-sort { cursor: default; }
th:hover:not(.no-sort) { color: #e2e8f0; }
th .arrow { opacity: .4; margin-left: 4px; }
th.sorted .arrow { opacity: 1; color: #38bdf8; }
td { padding: 10px 12px; border-top: 1px solid #334155; font-size: .82rem; }
tr:hover { background: #263548; cursor: pointer; }
.status-badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: .72rem; font-weight: 600; }
.status-Evaluated { background: #1e3a5f; color: #60a5fa; }
.status-Applied { background: #14532d; color: #4ade80; }
.status-Interview { background: #713f12; color: #fbbf24; }
.status-Offer { background: #4c1d95; color: #a78bfa; }
.status-Rejected { background: #450a0a; color: #f87171; }
.status-SKIP { background: #1f2937; color: #6b7280; }
.status-btn { padding: 4px 8px; border: 1px solid #334155; border-radius: 6px; background: #0f172a; color: #94a3b8; cursor: pointer; font-size: .68rem; margin: 1px; }
.status-btn:hover { background: #334155; color: #e2e8f0; }
.status-btn.active { background: #334155; color: #38bdf8; border-color: #38bdf8; }
.score-cell { font-weight: 700; }
.track-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: .68rem; font-weight: 600; background: #1e3a5f; color: #93c5fd; }
.notes-cell { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.7); display: none; align-items: flex-start; justify-content: center; padding: 40px 20px; overflow-y: auto; z-index: 50; }
.modal-overlay.open { display: flex; }
.modal { background: #0f172a; border: 1px solid #334155; border-radius: 12px; max-width: 860px; width: 100%; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.modal h2 { color: #38bdf8; font-size: 1.3rem; margin-bottom: 4px; }
.modal .sub { color: #94a3b8; font-size: .85rem; margin-bottom: 14px; }
.modal .meta { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.modal .close { float: right; background: #1e293b; border: 1px solid #334155; color: #e2e8f0; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: .85rem; }
.modal .report { background: #0d1117; border: 1px solid #334155; border-radius: 8px; padding: 18px; font-size: .85rem; line-height: 1.6; max-height: 60vh; overflow-y: auto; }
.modal .report h1, .modal .report h2, .modal .report h3 { color: #38bdf8; margin: 14px 0 6px; }
.modal .report h1 { font-size: 1.2rem; } .modal .report h2 { font-size: 1.05rem; } .modal .report h3 { font-size: .95rem; }
.modal .report strong { color: #e2e8f0; }
.modal .report ul { margin: 6px 0 6px 20px; }
.modal .report code { background: #1e293b; padding: 1px 5px; border-radius: 4px; }
.modal .report a { color: #60a5fa; }

/* === War Room === */
.war-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.war-card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 16px; }
.war-card h3 { font-size: .85rem; color: #38bdf8; margin-bottom: 10px; text-transform: uppercase; letter-spacing: .05em; }
.funnel-step { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.funnel-bar-wrap { flex: 1; background: #0f172a; height: 22px; border-radius: 11px; overflow: hidden; position: relative; }
.funnel-fill { height: 100%; background: linear-gradient(90deg, #38bdf8, #818cf8); border-radius: 11px; transition: width .5s; }
.funnel-label { font-size: .72rem; color: #94a3b8; width: 80px; text-align: right; flex-shrink: 0; }
.funnel-count { font-size: .85rem; font-weight: 700; color: #e2e8f0; width: 36px; text-align: right; flex-shrink: 0; }
.funnel-pct { font-size: .72rem; color: #64748b; width: 42px; text-align: right; flex-shrink: 0; }
.queue-item { padding: 8px 0; border-bottom: 1px solid #1e293b; font-size: .82rem; display: flex; justify-content: space-between; align-items: center; }
.queue-item:last-child { border-bottom: none; }
.queue-item .q-score { font-weight: 700; color: #4ade80; margin-left: 8px; }
.queue-item .q-company { color: #e2e8f0; }
.queue-item .q-role { color: #94a3b8; font-size: .78rem; }
.cont-status { display: flex; gap: 16px; flex-wrap: wrap; margin: 10px 0; }
.cont-stat { text-align: center; background: #0f172a; border-radius: 8px; padding: 10px 14px; }
.cont-stat .num { font-size: 1.3rem; font-weight: 700; color: #38bdf8; }
.cont-stat .label { font-size: .65rem; color: #64748b; text-transform: uppercase; }
.pattern-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap: 8px; margin: 10px 0; }
.pat-box { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px; text-align: center; }
.pat-box .num { font-size: 1.1rem; font-weight: 700; }
.pat-box .label { font-size: .65rem; color: #64748b; }
.track-table { width: 100%; font-size: .78rem; margin-top: 8px; }
.track-table th { background: #0f172a; padding: 6px 8px; font-size: .68rem; }
.track-table td { padding: 6px 8px; border-top: 1px solid #1e293b; text-align: center; }
/* === Settings === */
.settings-form { max-width: 500px; }
.settings-form label { display: block; font-size: .72rem; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; margin: 14px 0 4px; }
.settings-form input { width: 100%; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; color: #e2e8f0; font-size: .9rem; }
.settings-form .hint { font-size: .7rem; color: #64748b; margin-top: 2px; }
.settings-form .save-btn { margin-top: 20px; padding: 10px 30px; background: linear-gradient(135deg,#38bdf8,#818cf8); color: #fff; border: none; border-radius: 10px; font-size: .9rem; font-weight: 600; cursor: pointer; }
.settings-form .save-btn:hover { opacity: .9; }
@media (max-width:700px) { .war-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>DAFE Career OS</h1>
    <div class="subtitle">Automated Job Search Pipeline</div>
  </div>
  <div style="display:flex;align-items:center;gap:14px;font-size:.75rem;color:#94a3b8">
    <span id="status-indicator">● Ready</span>
    <span id="conn-dot" title="Server connection status" style="width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block"></span>
  </div>
</div>
<div id="banner" style="display:none;position:fixed;top:0;left:0;right:0;z-index:9999;background:#ef4444;color:#fff;font-size:.85rem;font-weight:600;padding:10px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>

<div class="container">
  <div class="stats" id="stats"></div>

  <div class="main-btn-wrap">
    <button class="main-btn" id="runBtn" onclick="runPipeline()">
      Scan &amp; Auto-Apply
      <span class="small">Finds jobs → Evaluates → Generates PDFs → Submits applications</span>
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
        <option value="">All tracks</option>
        <option value="ai">AI / LLM</option>
        <option value="support">Support / Ops</option>
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
    <div class="tab" onclick="switchTab('pipeline')">Pipeline</div>
    <div class="tab" onclick="switchTab('warroom')">War Room</div>
    <div class="tab" onclick="switchTab('settings')">Settings</div>
  </div>

  <div class="tab-content active" id="tab-applications">
    <div class="toolbar">
      <input type="text" id="quickSearch" placeholder="Quick search..." oninput="renderTable()">
      <span style="font-size:.72rem;color:#64748b">Click a column header to sort • click a row for details</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr id="appHead"></tr></thead>
        <tbody id="appTable"></tbody>
      </table>
    </div>
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
            <span class="small">Auto-evaluates &amp; applies to jobs until pipeline is empty</span>
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

      <label>Follow-up Days</label>
      <input type="text" id="sFollowupDays" value="3, 7, 14" placeholder="3, 7, 14">
      <div class="hint">Comma-separated: days after applying to send follow-ups.</div>

      <label>Auto-Apply Threshold</label>
      <input type="number" id="sThreshold" value="4.0" min="0" max="5" step="0.1">
      <div class="hint">Minimum score for automatic application (0-5).</div>

      <label>Daily Apply Limit</label>
      <input type="number" id="sMaxDaily" value="20" min="1" max="50">
      <div class="hint">Maximum auto-applications per day.</div>

      <label>Job Title Filter Aggressiveness</label>
      <select id="sAggressiveness">
        <option value="conservative">Conservative — keep almost everything (broadest)</option>
        <option value="balanced">Balanced — require a role or skill match (recommended)</option>
        <option value="aggressive">Aggressive — require a target-role match (narrowest)</option>
      </select>
      <div class="hint">How strictly incoming jobs are filtered to your profile. Adjust if too many or too few jobs show up.</div>

      <button class="save-btn" onclick="saveSettings()">Save Settings</button>
      <span id="settingsStatus" style="margin-left:12px;font-size:.82rem;color:#4ade80"></span>
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
  if (el) el.style.background = ok ? '#22c55e' : '#ef4444';
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
    } else if (data.type === 'step') {
      document.getElementById('progressFill').style.width = (data.current / data.total * 100) + '%';
    } else if (data.type === 'done') {
      document.getElementById('runBtn').disabled = false;
      document.getElementById('rescoreBtn').disabled = false;
      document.getElementById('removeZerosBtn').disabled = false;
      document.getElementById('status-indicator').textContent = '● Ready';
      document.getElementById('progressFill').style.width = '100%';
      loadData();
    }
  };
}

async function runPipeline() {
  const d = await postJSON('/api/run-pipeline');
  if (d.error) alert(d.error);
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
    '<th' + (c.noSort ? ' class="no-sort"' : '') + ' data-key="' + c.key + '" onclick="' + (c.noSort ? '' : 'sortBy(\\'' + c.key + '\\')') + '">' +
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
      '<button class="status-btn' + (s === a.status ? ' active' : '') + '" onclick="event.stopPropagation();updateStatus(\\'' + a.company.replace(/'/g, "\\'") + '\\',\\'' + s + '\\')">' + s + '</button>'
    ).join('');
    const sc = scoreNum(a.score);
    const scoreColor = sc >= 4 ? '#4ade80' : sc >= 3 ? '#60a5fa' : sc > 0 ? '#fbbf24' : '#64748b';
    return '<tr onclick="openDetail(' + a.num + ')">' +
      '<td>' + a.num + '</td>' +
      '<td>' + a.date + '</td>' +
      '<td>' + trackBadge + '</td>' +
      '<td>' + esc(a.company) + '</td>' +
      '<td>' + esc(a.role) + '</td>' +
      '<td class="score-cell" style="color:' + scoreColor + '">' + a.score + '</td>' +
      '<td><span class="status-badge ' + statusClass + '">' + a.status + '</span></td>' +
      '<td class="app-actions">' + actions + '</td>' +
      '<td class="notes-cell" title="' + esc(a.notes) + '">' + esc(a.notes).slice(0, 60) + '</td>' +
    '</tr>';
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:#64748b;padding:24px">No applications match the current filters.</td></tr>';
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

async function openDetail(num) {
  const a = allApps.find(x => x.num === num);
  if (!a) return;
  document.getElementById('mTitle').textContent = a.role + ' — ' + a.company;
  document.getElementById('mSub').textContent = 'Report #' + a.num + (a.reportPath ? '' : '');
  document.getElementById('mMeta').innerHTML =
    '<span class="track-badge">' + esc(a.track || 'untagged') + '</span>' +
    '<span class="status-badge status-' + a.status.replace(/[^a-zA-Z]/g, '') + '">' + a.status + '</span>' +
    '<span style="color:#38bdf8;font-weight:700">' + a.score + '</span>' +
    '<span style="color:#94a3b8">' + a.date + '</span>';
  const file = a.reportPath ? a.reportPath.split('/').pop() : '';
  document.getElementById('mReport').textContent = 'Loading report...';
  document.getElementById('modal').classList.add('open');
  if (file) {
    const d = await getJSON('/api/report?file=' + encodeURIComponent(file));
    if (d.error) { document.getElementById('mReport').innerHTML = '<span style="color:#f87171">⚠ Could not load report (' + esc(d.error) + ').<br>Check DAFE-Career-OS.bat is running.</span>'; }
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
  if (name === 'settings') loadSettings();
}

async function loadPipeline() {
  const data = await getJSON('/api/applications');
  if (data.error) { document.getElementById('pipelineTable').innerHTML = '<tr><td colspan="4" style="text-align:center;color:#f87171;padding:24px">⚠ Cannot reach server. Is DAFE-Career-OS.bat running?</td></tr>'; return; }
  document.getElementById('pipelineTable').innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:24px">Run a scan to populate the pipeline. Pending jobs appear here after scanning.</td></tr>';
}

document.getElementById('fTrack').addEventListener('change', renderTable);
document.getElementById('fMinScore').addEventListener('change', renderTable);
document.querySelectorAll('#fStatus input').forEach(c => c.addEventListener('change', renderTable));

connectSSE();
loadData();
setInterval(loadData, 8000);
setInterval(() => { getJSON('/api/applications'); }, 15000);

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
    html = '<div style="color:#64748b;font-size:.8rem">No high-score jobs waiting. Run a scan to find more.</div>';
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
    html = '<div style="color:#64748b;font-size:.8rem">No follow-ups due right now.</div>';
  } else {
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var days = Math.floor((Date.now() - new Date(f.date).getTime()) / 86400000);
      html += '<div class="queue-item">' +
        '<div><span class="q-company">' + esc(f.company) + '</span> <span class="q-role">' + esc(f.role) + '</span></div>' +
        '<span style="color:#fbbf24;font-size:.78rem">' + days + 'd ago</span>' +
      '</div>';
    }
  }
  document.getElementById('followupsList').innerHTML = html;
}

function renderPatterns(p) {
  document.getElementById('patternSummary').innerHTML =
    '<div class="pattern-grid">' +
      '<div class="pat-box"><div class="num" style="color:#60a5fa">' + p.total + '</div><div class="label">Total Apps</div></div>' +
      '<div class="pat-box"><div class="num" style="color:#4ade80">' + p.applied + '</div><div class="label">Applied</div></div>' +
      '<div class="pat-box"><div class="num" style="color:#fbbf24">' + p.interviewed + '</div><div class="label">Interviews</div></div>' +
      '<div class="pat-box"><div class="num" style="color:#a78bfa">' + p.offers + '</div><div class="label">Offers</div></div>' +
      '<div class="pat-box"><div class="num" style="color:#f87171">' + p.rejected + '</div><div class="label">Rejected</div></div>' +
      '<div class="pat-box"><div class="num" style="color:#38bdf8">' + p.avgScore + '</div><div class="label">Avg Score</div></div>' +
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
      '<div class="cont-stat"><div class="num">' + (s.totalApplied || 0) + '</div><div class="label">Applied</div></div>' +
      '<div class="cont-stat"><div class="num">' + (s.pendingRemaining || 0) + '</div><div class="label">Remaining</div></div>' +
      '<div class="cont-stat"><div class="num">' + (s.totalGhostSkipped || 0) + '</div><div class="label">Ghosts Skipped</div></div>';
  } else {
    btn.innerHTML = 'Start Continuous Processing<span class="small">Auto-evaluates &amp; applies to jobs until pipeline is empty</span>';
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
  var s = await getJSON('/api/settings');
  if (s.error) return;
  document.getElementById('sEmail').value = s.email || '';
  document.getElementById('sPhone').value = s.phone || '';
  document.getElementById('sLinkedin').value = s.linkedin || '';
  document.getElementById('sPortfolio').value = s.portfolio || '';
  document.getElementById('sFollowupDays').value = (s.followupDays || [3,7,14]).join(', ');
  document.getElementById('sThreshold').value = s.scoreThreshold || 4.0;
  document.getElementById('sMaxDaily').value = s.continuousMaxDaily || 20;
  document.getElementById('sAggressiveness').value = s.filterAggressiveness || 'conservative';
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
