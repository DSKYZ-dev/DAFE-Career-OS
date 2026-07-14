#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { chromium } from 'playwright';
import { getActiveProfile, coverCandidate } from './profile-helper.mjs';
import { parseArgs } from 'util';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const REPORTS_DIR = join(ROOT, 'reports');
const TRACKER_DIR = join(ROOT, 'batch', 'tracker-additions');
const OUTPUT_DIR = join(ROOT, 'output');

// Load user profile once
const CV_TEXT = readFileSync(join(ROOT, 'cv.md'), 'utf-8').slice(0, 8000);
const PROFILE_TEXT = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8');
const PROFILE = yaml.load(PROFILE_TEXT) || {};
const CANDIDATE = PROFILE.candidate || {};
const TRACKS = CANDIDATE.tracks || [];

try {
  const { config } = await import('dotenv');
  config();
} catch {}


function readLines(p) {
  try { return readFileSync(p, 'utf-8').split('\n'); } catch { return []; }
}
function writeLines(p, lines) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join('\n'), 'utf-8');
}
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeTsv(v) {
  const s = String(v ?? '');
  return s.includes('\t') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

// Map a job title to its best-fit track based on the profile's track role lists.
function deriveTrack(role) {
  const r = (role || '').toLowerCase();
  let best = null, bestHits = 0;
  for (const t of TRACKS) {
    const roles = (t.target_roles || []).map(x => x.toLowerCase());
    let hits = 0;
    for (const kw of roles) {
      if (kw.includes(' ') ? r.includes(kw) : r.split(/[\s/,-]+/).includes(kw)) hits++;
    }
    if (hits > bestHits) { bestHits = hits; best = t.name; }
  }
  return best;
}

function getNextReportNum() {
  if (!existsSync(REPORTS_DIR)) return 1;
  const files = readdirSafe(REPORTS_DIR);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^(\d+)-/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function readdirSafe(p) {
  try { return readFileSync(p, 'utf-8').split('\n').filter(Boolean); } catch { return []; }
}

async function fetchJobPage(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText);
    const title = await page.title();
    return { title, text: text.slice(0, 15000) };
  } finally {
    await browser.close();
  }
}

async function evaluateJob(title, company, url, jdText) {
  // Use cloud-eval.mjs for fast cloud evaluation (OpenRouter/OpenAI/Anthropic/Gemini)
  const jdPath = join(ROOT, 'jds', `temp-${Date.now()}.txt`);
  mkdirSync(dirname(jdPath), { recursive: true });
  writeFileSync(jdPath, jdText, 'utf-8');
  
  try {
    const { execFileSync } = await import('child_process');
    const result = execFileSync('node', ['cloud-eval.mjs', '--file', jdPath], { 
      cwd: ROOT, 
      timeout: 180000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 10
    });
    return result;
  } catch (err) {
    return `# Evaluation Error\n\n**URL:** ${url}\n**Error:** ${err.message}\n\nCould not evaluate this job posting.`;
  } finally {
    try { require('fs').unlinkSync(jdPath); } catch {}
  }
}

function parseScore(text) {
  // Try to parse JSON code block
  let jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (typeof parsed.score === 'number') return parsed.score;
      if (typeof parsed.global === 'number') return parsed.global;
    } catch {}
  }
  // Try JSON key patterns with optional quotes on value
  let m = text.match(/"global"\s*:\s*"?([\d.]+)"?/);
  if (m) return parseFloat(m[1]);
  m = text.match(/"score"\s*:\s*"?([\d.]+)"?/);
  if (m) return parseFloat(m[1]);
  // Try **Score:** X.X/5 or **Score:** X.X (without /5)
  m = text.match(/\*\*Score:\*\*\s*([\d.]+)(?:\/5)?/);
  if (m) return parseFloat(m[1]);
  m = text.match(/Score:\s*([\d.]+)(?:\/5)?/);
  if (m) return parseFloat(m[1]);
  return null;
}

function parseTldr(text) {
  // Try JSON format first
  let m = text.match(/"tldr"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  // Try to extract a summary from the report
  m = text.match(/TL;DR:\s*(.+)/i);
  if (m) return m[1].trim();
  // Try to get first meaningful line after role summary
  m = text.match(/## A\) Role Summary\s*\n([\s\S]+?)\n\n/);
  if (m) return m[1].trim().slice(0, 200);
  return 'No summary';
}

async function generatePdfs(entries) {
  console.log('\n[5/6] Generating CV and cover letter PDFs...');
  let count = 0;
  for (const entry of entries) {
    if (!entry.url || !entry.company) continue;
    const slug = (entry.company + '-' + (entry.role || 'role')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'unknown';
    const cvOut = join(OUTPUT_DIR, `${slug}-cv.pdf`);
    const clOut = join(OUTPUT_DIR, `${slug}-cover.pdf`);
    mkdirSync(OUTPUT_DIR, { recursive: true });

    if (!existsSync(cvOut)) {
      try {
        execFileSync('node', ['generate-cv.mjs', '--profile', getActiveProfile(), '--company', entry.company, '--role', entry.role || 'Role', '--out', cvOut], { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
        count++;
      } catch (e) {
        const msg = e.stderr ? e.stderr.toString().trim().slice(0, 200) : e.message;
        console.log(`  CV failed for ${entry.company}: ${msg}`);
      }
    }
    if (!existsSync(clOut)) {
      const payload = {
        candidate: coverCandidate(),
        letter: {
          role_title: entry.role || 'Role', company: entry.company, city: 'Remote', date: entry.date || new Date().toISOString().slice(0, 10),
          greeting: `Dear Hiring Manager,`,
          opening: `I am writing to apply for the ${entry.role || 'open'} position at ${entry.company}.`,
          profile_intro: `With a track record of adapting quickly and delivering results, I am confident I can contribute effectively to your team.`,
          achievements: [{ lead: `Proven ability`, impact: `to adapt quickly and deliver results in remote environments` }],
          closing: `Thank you for your consideration.`,
          footnotes: [`References available upon request.`]
        },
        output_path: clOut
      };
      writeFileSync(join(OUTPUT_DIR, `${slug}-payload.json`), JSON.stringify(payload, null, 2));
      try {
        execFileSync('node', ['generate-cover-letter.mjs', '--payload', join(OUTPUT_DIR, `${slug}-payload.json`)], { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
        count++;
      } catch (e) {
        const msg = e.stderr ? e.stderr.toString().trim().slice(0, 200) : e.message;
        console.log(`  CL failed for ${entry.company}: ${msg}`);
      }
    }
  }
  console.log(`  Generated ${count} new PDFs`);
}

function generateReportHtml(entries, reports) {
  const avgScore = reports.length > 0 ? (reports.reduce((s, r) => s + r.score, 0) / reports.length).toFixed(1) : 'N/A';
  const applied = entries.filter(e => e.status === 'applied').length;
  const pending = entries.filter(e => e.status === 'pending').length;

  const evalRows = reports.map(r => {
    const rec = r.score >= 4 ? 'Strong Apply' : r.score >= 3 ? 'Apply' : r.score >= 2 ? 'Consider' : 'Skip';
    return `<tr><td>${esc(r.company)}</td><td>${esc(r.role)}</td><td>${r.score.toFixed(1)}/5</td><td>${rec}</td><td>${esc(r.tldr)}</td></tr>`;
  }).join('\n');

  const pipeRows = entries.map(e => {
    const cls = e.status === 'applied' ? 'status-applied' : 'status-pending';
    return `<tr class="${cls}"><td>${esc(e.company)}</td><td>${esc(e.role)}</td><td>${esc(e.location)}</td><td class="${cls}">${e.status}</td></tr>`;
  }).join('\n');

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>Auto Pipeline Report</title>
<style>
body { font-family: -apple-system, sans-serif; padding: 20px; max-width: 900px; margin: 0 auto; }
@media print { body { padding: 10px; } @page { margin: 12mm; } }
.summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 20px; }
.summary-card { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 12px; text-align: center; }
.summary-num { font-size: 1.6rem; font-weight: 700; color: #0066cc; }
.summary-label { font-size: .7rem; color: #666; text-transform: uppercase; }
h2 { font-size: 1.1rem; margin: 16px 0 8px; border-bottom: 2px solid #eee; }
table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: .85rem; }
th { text-align: left; background: #f1f1f1; padding: 6px 8px; }
td { padding: 5px 8px; border-bottom: 1px solid #eee; }
</style></head><body>
<h1>Auto Pipeline Report</h1>
<p>Generated: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}</p>
<div class="summary-grid">
  <div class="summary-card"><div class="summary-num">${entries.length}</div><div class="summary-label">Jobs</div></div>
  <div class="summary-card"><div class="summary-num">${applied}</div><div class="summary-label">Applied</div></div>
  <div class="summary-card"><div class="summary-num">${pending}</div><div class="summary-label">Pending</div></div>
  <div class="summary-card"><div class="summary-num">${reports.length}</div><div class="summary-label">Evaluated</div></div>
  <div class="summary-card"><div class="summary-num">${avgScore}</div><div class="summary-label">Avg Score</div></div>
</div>
<h2>Evaluations</h2>
<table><thead><tr><th>Company</th><th>Role</th><th>Score</th><th>Rec</th><th>Summary</th></tr></thead>
<tbody>${evalRows || '<tr><td colspan="5">No evaluations yet</td></tr>'}</tbody></table>
<h2>Pipeline</h2>
<table><thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Status</th></tr></thead>
<tbody>${pipeRows || '<tr><td colspan="4">No pipeline entries</td></tr>'}</tbody></table>
</body></html>`;
}

async function main() {
  const { values: args } = parseArgs({
    options: { skipScan: { type: 'boolean' }, pdfOnly: { type: 'boolean' }, max: { type: 'string', short: 'm' }, auto: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    strict: false
  });

  if (args.help) {
    console.log(`Usage: node auto-pipeline.mjs [--skip-scan] [--pdf-only] [--max N] [--auto]

Steps:
  1. Web search for entry-level jobs (Gemini + Google Search)
  2. Run provider scan (Greenhouse, Ashby, Lever, etc.)
  3. Read pending pipeline entries
  4. Fetch + evaluate each job (via Playwright + Gemini)
  5. Generate tailored CV + cover letter PDFs
  6. Generate printable HTML report
  7. Auto-apply (if --auto) or launch apply assistant (default -- manual)`);
    process.exit(0);
  }

  const maxJobs = args.max ? parseInt(args.max, 10) : 50;

  console.log('=== Auto Pipeline ===\n');

  // Step 1: Web search
  if (!args.pdfOnly) {
    console.log('[1/6] Web searching for entry-level jobs...');
    try {
      execFileSync('node', ['web-search.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 180000 });
    } catch (e) {
      console.error('Web search failed:', e.message);
    }

    // Step 2: Provider scan
    console.log('\n[2/6] Running provider scan...');
    try {
      execFileSync('node', ['scan.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 120000 });
    } catch (e) {
      console.error('Scan failed:', e.message);
    }
  }

  // Step 3: Read pipeline
  console.log('\n[3/6] Reading pipeline...');
  const lines = readLines(PIPELINE_PATH);
  const pending = [];
  const other = [];
  for (const line of lines) {
    const m = line.match(/^- \[ \] (.+)$/);
    if (m) {
      const parts = m[1].split('|').map(s => s.trim());
      pending.push({ raw: line, url: parts[0] || '', company: parts[1] || '', role: parts[2] || '', location: parts[3] || '', track: parts[4] || '' });
    } else {
      other.push(line);
    }
  }

  if (pending.length === 0) {
    console.log('No pending pipeline entries. Run scan mode first.');
    if (args.pdfOnly) console.log('Try without --pdf-only to run web search + provider scan.');
    return;
  }
  const toEvaluate = pending.slice(0, maxJobs);
  console.log(`Found ${pending.length} pending entries. Evaluating ${toEvaluate.length} (limit: ${maxJobs}).\n`);

  // Step 4: Evaluate
  console.log('[4/6] Evaluating jobs...\n');
  const processed = [];
  const trackerEntries = [];
  const evaluations = [];
  let nextNum = getNextReportNum();

  for (let i = 0; i < toEvaluate.length; i++) {
    const entry = toEvaluate[i];
    const num = nextNum + i;
    const date = new Date().toISOString().slice(0, 10);
    const slug = (entry.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';
    const reportFile = `${String(num).padStart(3, '0')}-${slug}-${date}.md`;

    console.log(`  [${i + 1}/${pending.length}] ${entry.company} — ${entry.role}`);

    let report;
    try {
      const page = await fetchJobPage(entry.url);
      report = await evaluateJob(page.title || entry.role, entry.company, entry.url, page.text);
    } catch (err) {
      report = `# Evaluation Error\n\n**URL:** ${entry.url}\n**Error:** ${err.message}\n\nCould not fetch or evaluate this job posting.`;
    }

    const score = parseScore(report) || 0;
    const tldr = parseTldr(report) || 'No summary';
    const track = entry.track || deriveTrack(entry.role) || 'unknown';

    mkdirSync(REPORTS_DIR, { recursive: true });
    const header = `# Evaluation Report\n\n**URL:** ${entry.url}\n**Track:** ${track}\n**Score:** ${score.toFixed(1)}/5\n**TL;DR:** ${tldr}\n\n`;
    writeFileSync(join(REPORTS_DIR, reportFile), header + report, 'utf-8');

    mkdirSync(TRACKER_DIR, { recursive: true });
    const tsvFile = `${String(num).padStart(3, '0')}-${slug}.tsv`;
    const pdfEmoji = '❌';
    const reportLink = `[${num}](reports/${reportFile})`;
    const status = score >= 3 ? 'Evaluated' : 'SKIP';
    const note = `[${track}] ${tldr}`;
    const tsv = `${num}\t${date}\t${escapeTsv(entry.company)}\t${escapeTsv(entry.role || 'Unknown')}\t${status}\t${score.toFixed(1)}/5\t${pdfEmoji}\t${reportLink}\t${escapeTsv(note)}`;
    writeFileSync(join(TRACKER_DIR, tsvFile), tsv + '\n', 'utf-8');

    processed.push(entry.raw.replace('- [ ]', '- [x]'));
    entry.score = score; entry.track = track;
    evaluations.push({ company: entry.company, role: entry.role, score, track, tldr, reportFile });
    console.log(`    Score: ${score.toFixed(1)}/5 | Track: ${track} | ${status}`);
  }

  // Update pipeline - only mark evaluated ones as done
  const newLines = [];
  let pi = 0;
  const evaluatedUrls = new Set(toEvaluate.map(e => e.url));
  for (const line of lines) {
    const m = line.match(/^- \[ \] (.+)$/);
    if (m) {
      const parts = m[1].split('|').map(s => s.trim());
      const url = parts[0] || '';
      if (evaluatedUrls.has(url)) {
        newLines.push(processed[pi] || line);
        pi++;
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }
  writeLines(PIPELINE_PATH, newLines);

  // Merge tracker
  console.log('\nMerging tracker...');
  try {
    execFileSync('node', ['merge-tracker.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 30000 });
  } catch {}

  // Step 5: Generate PDFs
  await generatePdfs(toEvaluate);

  // Step 6: Generate report
  console.log('\n[6/6] Generating printable report...');
  const reportHtml = generateReportHtml(
    toEvaluate.map(e => ({ ...e, status: 'pending' })),
    evaluations
  );
  const reportDate = new Date().toISOString().slice(0, 10);
  const reportPath = join(OUTPUT_DIR, `pipeline-report-${reportDate}.html`);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(reportPath, reportHtml);
  console.log(`  Report: ${reportPath}`);

  // Summary
  console.log(`\n=== Pipeline Complete ===`);
  console.log(`  Jobs processed: ${pending.length}`);
  console.log(`  Evaluations: ${evaluations.length}`);
  console.log(`  Reports: reports/ directory`);
  console.log(`  PDFs: output/ directory`);
  console.log(`  HTML report: ${reportPath}`);

  try {
    execFileSync('node', ['generate-apply-report.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 30000 });
  } catch {}

  if (args.auto) {
    // Auto-submit applications
    console.log('\n🚀 Auto-submit enabled — launching auto-apply...');
    try {
      execFileSync('node', ['auto-apply.mjs', '--max', '10', '--auto-submit'], { cwd: ROOT, stdio: 'inherit', timeout: 600000 });
      // Merge tracker after auto-apply
      try {
        execFileSync('node', ['merge-tracker.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 30000 });
      } catch {}
    } catch (e) {
      if (e.signal !== 'SIGINT') console.error('Auto-apply error:', e.message);
    }
  } else {
    // Launch apply assist (manual)
    console.log(`\nNext: run "node apply-assist.mjs" to review and apply to jobs interactively.`);
    console.log('\nLaunching apply assistant...');
    try {
      execFileSync('node', ['apply-assist.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 600000 });
    } catch (e) {
      if (e.signal !== 'SIGINT') console.error('Apply assist closed:', e.message);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
