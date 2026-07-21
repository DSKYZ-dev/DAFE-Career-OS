#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { parseArgs } from 'util';
import { getActiveProfile, coverCandidate } from './profile-helper.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const APP_TRACKER = join(ROOT, 'data', 'applications.md');
const OUTPUT_DIR = join(ROOT, 'output');
const REPORT_DIR = join(ROOT, 'reports');

function readLines(p) {
  try { return readFileSync(p, 'utf-8').split('\n'); } catch { return []; }
}
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function deriveSlug(company, role) {
  const s = (company + '-' + role).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';
  return s.slice(0, 60);
}

async function generateApplyHtml(jobs) {
  const items = jobs.map((j, i) => {
    const slug = deriveSlug(j.company, j.role);
    const cvPath = join('output', `${slug}-cv.pdf`);
    const clPath = join('output', `${slug}-cover.pdf`);
    const hasCv = existsSync(join(ROOT, cvPath));
    const hasCl = existsSync(join(ROOT, clPath));
    return `<div class="job-card" data-index="${i}">
      <div class="job-header">
        <h3>${esc(j.company || 'Unknown')} — ${esc(j.role || 'Unknown')}</h3>
        <span class="status-badge pending">Pending</span>
      </div>
      <p class="job-location">${esc(j.location || 'Remote')}</p>
      <p class="job-url"><a href="${esc(j.url)}" target="_blank">${esc(j.url)}</a></p>
      <div class="job-actions">
        <button onclick="window.open('${esc(j.url)}','_blank')" class="btn btn-apply">Open & Apply</button>
        <button onclick="markDone(${i})" class="btn btn-done">Mark Applied</button>
        <button onclick="markSkip(${i})" class="btn btn-skip">Skip</button>
      </div>
      <div class="job-files">
        ${hasCv ? `<span class="file-badge">CV ✓</span>` : `<span class="file-badge missing">CV</span>`}
        ${hasCl ? `<span class="file-badge">Cover ✓</span>` : `<span class="file-badge missing">Cover</span>`}
      </div>
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><title>Apply Assist — Job Applications</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
h1 { font-size: 1.5rem; margin-bottom: 8px; }
.subtitle { color: #666; margin-bottom: 20px; }
.stats { display: flex; gap: 16px; margin-bottom: 20px; }
.stat { background: white; padding: 12px 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
.stat-num { font-size: 1.8rem; font-weight: 700; }
.stat-label { font-size: .8rem; color: #666; }
.job-card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
.job-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.job-header h3 { font-size: 1rem; }
.status-badge { font-size: .75rem; padding: 2px 8px; border-radius: 12px; }
.status-badge.pending { background: #fff3cd; color: #856404; }
.status-badge.done { background: #d4edda; color: #155724; }
.status-badge.skipped { background: #f8d7da; color: #721c24; }
.job-location { color: #666; font-size: .85rem; margin-bottom: 4px; }
.job-url { font-size: .8rem; margin-bottom: 10px; word-break: break-all; }
.job-url a { color: #0066cc; }
.job-actions { display: flex; gap: 8px; margin-bottom: 8px; }
.btn { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: .85rem; font-weight: 500; }
.btn-apply { background: #0066cc; color: white; }
.btn-apply:hover { background: #0052a3; }
.btn-done { background: #28a745; color: white; }
.btn-done:hover { background: #218838; }
.btn-skip { background: #6c757d; color: white; }
.btn-skip:hover { background: #5a6268; }
.job-files { display: flex; gap: 8px; }
.file-badge { font-size: .75rem; padding: 2px 8px; border-radius: 4px; background: #e8f5e9; color: #2e7d32; }
.file-badge.missing { background: #fff3e0; color: #e65100; }
</style></head><body>
<h1>Apply Assist</h1>
<p class="subtitle">Jobs found this session — click Open & Apply to apply, then Mark Applied when done</p>
<div class="stats">
  <div class="stat"><div class="stat-num" id="total-num">${jobs.length}</div><div class="stat-label">Total</div></div>
  <div class="stat"><div class="stat-num" id="done-num">0</div><div class="stat-label">Applied</div></div>
  <div class="stat"><div class="stat-num" id="skip-num">0</div><div class="stat-label">Skipped</div></div>
</div>
<div id="job-list">${items}</div>
<script>
const state = new Array(${jobs.length}).fill('pending');
function updateStats() {
  const done = state.filter(s => s === 'done').length;
  const skipped = state.filter(s => s === 'skipped').length;
  document.getElementById('done-num').textContent = done;
  document.getElementById('skip-num').textContent = skipped;
}
function markDone(i) {
  if (state[i] === 'done') return;
  state[i] = 'done';
  const card = document.querySelectorAll('.job-card')[i];
  card.querySelector('.status-badge').textContent = 'Applied';
  card.querySelector('.status-badge').className = 'status-badge done';
  updateStats();
  fetch('/mark?i=' + i + '&s=applied').catch(()=>{});
}
function markSkip(i) {
  if (state[i] === 'skipped') return;
  state[i] = 'skipped';
  const card = document.querySelectorAll('.job-card')[i];
  card.querySelector('.status-badge').textContent = 'Skipped';
  card.querySelector('.status-badge').className = 'status-badge skipped';
  updateStats();
  fetch('/mark?i=' + i + '&s=skipped').catch(()=>{});
}
</script></body></html>`;
}

async function main() {
  const now = new Date().toISOString().slice(0, 10);

  const lines = readLines(PIPELINE_PATH);
  const jobs = [];
  for (const line of lines) {
    const m = line.match(/^- \[([ x])\] (.+)$/);
    if (m) {
      const parts = m[2].split('|').map(s => s.trim());
      const url = parts[0] || '';
      const company = parts[1] || '';
      const role = parts[2] || '';
      const location = parts[3] || '';
      if (url) jobs.push({ url, company, role, location, status: m[1] === 'x' ? 'done' : 'pending', raw: line });
    }
  }

  const pending = jobs.filter(j => j.status === 'pending');
  console.log(`\nFound ${jobs.length} total pipeline entries, ${pending.length} pending.\n`);

  if (pending.length === 0) {
    console.log('No pending jobs to apply to. Run auto-pipeline first to find jobs.');
    return;
  }

  // Generate CV and cover letter PDFs for pending jobs
  console.log('Generating tailored materials...\n');
  const genCvCmd = join(ROOT, 'generate-cv.mjs');
  const genClCmd = join(ROOT, 'generate-cover-letter.mjs');

  for (let i = 0; i < pending.length; i++) {
    const j = pending[i];
    const slug = deriveSlug(j.company, j.role);
    const cvOut = join(OUTPUT_DIR, `${slug}-cv.pdf`);
    const clOut = join(OUTPUT_DIR, `${slug}-cover.pdf`);

    mkdirSync(OUTPUT_DIR, { recursive: true });

    if (!existsSync(cvOut)) {
      try {
        const { execFileSync } = await import('child_process');
        execFileSync('node', [genCvCmd, '--profile', getActiveProfile(), '--company', j.company, '--role', j.role, '--out', cvOut], { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
        console.log(`  CV: ${j.company} → ${slug}-cv.pdf`);
      } catch (e) {
        const msg = e.stderr ? e.stderr.toString().trim().slice(0, 200) : e.message;
        console.log(`  CV: ${j.company} → skipped (${msg})`);
      }
    } else {
      console.log(`  CV: ${j.company} → already exists`);
    }

    if (!existsSync(clOut)) {
      try {
        const { execFileSync } = await import('child_process');
        const payload = {
          candidate: coverCandidate(),
          letter: {
            role_title: j.role, company: j.company, city: 'Remote', date: now,
            greeting: `Dear Hiring Manager,`,
            opening: `I am writing to apply for the ${j.role} position at ${j.company}.`,
            profile_intro: `With a track record of adapting quickly and delivering results, I am confident I can contribute effectively to your team.`,
            achievements: [{ lead: `Proven ability`, impact: `to adapt quickly and deliver results in remote environments` }],
            closing: `Thank you for your consideration.`,
            footnotes: [`References available upon request.`]
          },
          output_path: clOut
        };
        writeFileSync(join(ROOT, 'output', `${slug}-payload.json`), JSON.stringify(payload, null, 2));
        execFileSync('node', [genClCmd, '--payload', join(ROOT, 'output', `${slug}-payload.json`)], { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
        console.log(`  CL: ${j.company} → ${slug}-cover.pdf`);
      } catch (e) {
        const msg = e.stderr ? e.stderr.toString().trim().slice(0, 200) : e.message;
        console.log(`  CL: ${j.company} → cover skipped (${msg})`);
      }
    } else {
      console.log(`  CL: ${j.company} → already exists`);
    }
  }

  // Generate the HTML dashboard and serve it
  const html = await generateApplyHtml(pending);
  const htmlPath = join(OUTPUT_DIR, `apply-assist-${now}.html`);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(htmlPath, html);

  console.log(`\nApply dashboard: ${htmlPath}`);
  console.log('Open in browser to see all jobs with Apply buttons.');
  console.log('\n💡 TIP: Use dafe-career-os or open http://localhost:3456 for the visual dashboard with one-click pipeline.');

  // Try to open in default browser
  try {
    const { execSync } = await import('child_process');
    execSync(`start "" "${htmlPath}"`, { shell: true, timeout: 5000 });
  } catch {}

  // Also start a tiny HTTP server for the mark endpoint
  const http = await import('http');
  const results = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/mark') {
      const idx = parseInt(u.searchParams.get('i') || '-1');
      const s = u.searchParams.get('s') || 'pending';
      if (idx >= 0 && idx < pending.length) {
        results.push({ idx, status: s, ...pending[idx], timestamp: new Date().toISOString() });
        console.log(`  Marked: ${pending[idx].company} — ${s}`);
      }
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end('ok');
    } else if (u.pathname === '/results') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results, null, 2));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      res.end(html);
    }
  });
  server.listen(3457, () => {
    console.log(`Dashboard server: http://localhost:3457`);
    console.log('\nOpen the dashboard, click Open & Apply for each job, then Mark Applied when done.');
    console.log('Press Ctrl+C to finish and save results.');
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n\nSaving application results...');
    if (results.length > 0) {
      const appLines = [`# Applications — ${now}\n`, `| # | Company | Role | URL | Status | Time |`, `|---|---------|------|-----|--------|------|`];
      results.forEach((r, i) => {
        appLines.push(`| ${i+1} | ${r.company} | ${r.role} | [Link](${r.url}) | ${r.status} | ${r.timestamp} |`);
      });
      const appPath = join(OUTPUT_DIR, `apply-results-${now}.md`);
      writeFileSync(appPath, appLines.join('\n') + '\n');
      console.log(`Results saved: ${appPath}`);
    }
    server.close();
    process.exit(0);
  });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
