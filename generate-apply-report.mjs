#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { getActiveProfile } from './profile-helper.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(ROOT, 'output');
const DATA_DIR = join(ROOT, 'data');
const REPORTS_DIR = join(ROOT, 'reports');

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function collectSessionInfo() {
  const info = {
    date: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    profile: getActiveProfile(),
    pipelineJobs: [],
    appliedCount: 0,
    reports: [],
    outputPdfs: []
  };

  // Read pipeline
  try {
    const pipe = readFileSync(join(DATA_DIR, 'pipeline.md'), 'utf-8');
    for (const line of pipe.split('\n')) {
      const m = line.match(/^- \[([ x])\] (.+)$/);
      if (m) {
        const parts = m[1].trim() === 'x' ? 'Applied' : 'Pending';
        const data = m[2].split('|').map(s => s.trim());
        info.pipelineJobs.push({ url: data[0] || '', company: data[1] || '', role: data[2] || '', location: data[3] || '', status: parts });
        if (parts === 'Applied') info.appliedCount++;
      }
    }
  } catch {}

  // Collect reports
  try {
    if (existsSync(REPORTS_DIR)) {
      for (const f of readdirSync(REPORTS_DIR).sort()) {
        if (f.endsWith('.md')) {
          const content = readFileSync(join(REPORTS_DIR, f), 'utf-8');
          const scoreM = content.match(/\*\*Score:\*\*\s*([\d.]+)\/5/);
          const tlDrM = content.match(/\*\*TL;DR:\*\*\s*(.+)/);
          info.reports.push({
            file: f,
            score: scoreM ? parseFloat(scoreM[1]) : null,
            tldr: tlDrM ? tlDrM[1].trim() : ''
          });
        }
      }
    }
  } catch {}

  // Collect PDFs
  try {
    if (existsSync(OUTPUT_DIR)) {
      for (const f of readdirSync(OUTPUT_DIR)) {
        if (f.endsWith('.pdf')) info.outputPdfs.push(f);
      }
    }
  } catch {}

  return info;
}

function buildHtml(info) {
  const avgScore = info.reports.length > 0
    ? (info.reports.reduce((s, r) => s + (r.score || 0), 0) / info.reports.length).toFixed(1)
    : 'N/A';

  const reportRows = info.reports.map(r => {
    const rec = r.score >= 4 ? '✅ Strong Apply' : r.score >= 3 ? '👍 Apply' : r.score >= 2 ? '🤔 Consider' : '❌ Skip';
    return `<tr><td>${esc(r.file)}</td><td>${r.score != null ? r.score.toFixed(1) + '/5' : 'N/A'}</td><td>${rec}</td><td>${esc(r.tldr)}</td></tr>`;
  }).join('\n');

  const pipelineRows = info.pipelineJobs.map(j => {
    const cls = j.status === 'Applied' ? 'status-applied' : 'status-pending';
    return `<tr class="${cls}"><td>${esc(j.company)}</td><td>${esc(j.role)}</td><td>${esc(j.location)}</td><td class="${cls}">${j.status}</td><td><a href="${esc(j.url)}" target="_blank">Link</a></td></tr>`;
  }).join('\n');

  const pdfSection = info.outputPdfs.length > 0
    ? `<h2>Generated PDFs (${info.outputPdfs.length})</h2><ul>${info.outputPdfs.map(f => `<li>${esc(f)}</li>`).join('\n')}</ul>`
    : '';

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><title>Job Search Report — ${info.date}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', -apple-system, sans-serif; color: #222; padding: 30px; max-width: 1100px; margin: 0 auto; }
@media print { body { padding: 15px; } @page { margin: 15mm; } }
h1 { font-size: 1.6rem; margin-bottom: 4px; }
.subtitle { color: #666; font-size: .9rem; margin-bottom: 20px; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
.summary-card { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 14px; text-align: center; }
.summary-num { font-size: 1.8rem; font-weight: 700; color: #0066cc; }
.summary-label { font-size: .75rem; color: #666; text-transform: uppercase; letter-spacing: .5px; }
h2 { font-size: 1.1rem; margin: 20px 0 10px; border-bottom: 2px solid #eee; padding-bottom: 4px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: .85rem; }
th { text-align: left; background: #f1f1f1; padding: 8px 10px; font-weight: 600; }
td { padding: 7px 10px; border-bottom: 1px solid #eee; }
tr:hover td { background: #f9f9f9; }
.status-applied td:last-child { color: #28a745; font-weight: 600; }
.status-pending td:last-child { color: #856404; }
.print-btn { position: fixed; top: 10px; right: 10px; padding: 10px 20px; background: #0066cc; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: .9rem; }
@media print { .print-btn { display: none; } }
ul { margin-left: 20px; margin-bottom: 16px; }
li { margin-bottom: 3px; font-size: .85rem; }
</style></head><body>
<button onclick="window.print()" class="print-btn">Print / Save PDF</button>
<h1>Job Search Report</h1>
<p class="subtitle">${info.date} — Profile: ${info.profile} | Generated: ${info.generatedAt.slice(0, 19).replace('T', ' ')}</p>

<div class="summary-grid">
  <div class="summary-card"><div class="summary-num">${info.pipelineJobs.length}</div><div class="summary-label">Jobs Found</div></div>
  <div class="summary-card"><div class="summary-num">${info.appliedCount}</div><div class="summary-label">Applied</div></div>
  <div class="summary-card"><div class="summary-num">${info.reports.length}</div><div class="summary-label">Evaluated</div></div>
  <div class="summary-card"><div class="summary-num">${info.outputPdfs.length}</div><div class="summary-label">PDFs Generated</div></div>
  <div class="summary-card"><div class="summary-num">${avgScore}</div><div class="summary-label">Avg Score</div></div>
</div>

<h2>Pipeline Status</h2>
<table><thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Status</th><th>URL</th></tr></thead>
<tbody>${pipelineRows}</tbody></table>

<h2>Evaluation Reports</h2>
<table><thead><tr><th>Report</th><th>Score</th><th>Recommendation</th><th>Summary</th></tr></thead>
<tbody>${reportRows || '<tr><td colspan="4">No reports yet</td></tr>'}</tbody></table>

${pdfSection}
</body></html>`;
}

async function main() {
  const { values: args } = parseArgs({
    options: { out: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' } },
    strict: false
  });

  if (args.help) {
    console.log('Usage: node generate-apply-report.mjs [--out path/to/report.html]');
    process.exit(0);
  }

  const info = collectSessionInfo();
  const html = buildHtml(info);
  const outPath = args.out || join(OUTPUT_DIR, `job-report-${info.date}.html`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  console.log(`\nReport generated: ${outPath}`);
  console.log(`  Jobs found: ${info.pipelineJobs.length}`);
  console.log(`  Applied: ${info.appliedCount}`);
  console.log(`  Evaluated: ${info.reports.length}`);
  console.log(`  PDFs: ${info.outputPdfs.length}`);
  console.log(`\nOpen the HTML file and use Print (Ctrl+P) to save as PDF.`);

  try {
    const { execSync } = await import('child_process');
    execSync(`start "" "${outPath}"`, { shell: true, timeout: 5000 });
  } catch {}
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
