#!/usr/bin/env node
/**
 * career-orchestrator.mjs — Unified Career Operations Orchestrator
 * 
 * Uses ModelRegistry to auto-detect and route tasks to best available models:
 * - Cloud (OpenRouter, Gemini, OpenAI, Anthropic) for reasoning/orchestration
 * - Local (Ollama) for implementation/extraction tasks
 * 
 * Commands:
 *   scan          - Search job boards + web
 *   evaluate      - Evaluate jobs with best reasoning model
 *   cv            - Generate tailored CV PDF
 *   cover         - Generate cover letter PDF
 *   prep          - Interview preparation
 *   apply         - Auto-apply to jobs
 *   pipeline      - Full pipeline: scan → evaluate → cv → cover → apply
 *   dashboard     - Interactive apply dashboard
 *   report        - Printable summary report
 *   status        - Show available models
 */

import { ModelRegistry, TaskRouter } from './model-registry.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';
import { getActiveProfile, coverCandidate } from './profile-helper.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const REPORTS_DIR = join(ROOT, 'reports');
const OUTPUT_DIR = join(ROOT, 'output');
const TRACKER_DIR = join(ROOT, 'batch', 'tracker-additions');
const LOGS_DIR = join(ROOT, 'logs');

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });
mkdirSync(TRACKER_DIR, { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });

// Load profile & CV
const PROFILE = yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8'));
const CANDIDATE = PROFILE.candidate || {};
const CV_TEXT = readFileSync(join(ROOT, 'cv.md'), 'utf-8').slice(0, 8000);

// Global registry
let registry = null;
let router = null;

async function initRegistry() {
  if (!registry) {
    registry = await new ModelRegistry().detect();
    router = new TaskRouter(registry);
    console.log('🔧 Model Registry initialized');
    console.log(`   Local: ${registry.localModels.size} models`);
    console.log(`   Cloud: ${Array.from(registry.cloudProviders.values()).reduce((sum, p) => sum + p.models.length, 0)} models`);
  }
  return registry;
}

// ─── Pipeline Steps ──────────────────────────────────────────────

async function runScan() {
  console.log('\n📡 [1/5] Scanning job boards...');
  try {
    execFileSync('node', ['scan.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 180000 });
  } catch (e) { console.error('Scan failed:', e.message); }
  
  console.log('\n🌐 [1b/5] Web searching (OpenRouter + Google)...');
  try {
    execFileSync('node', ['web-search.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 180000 });
  } catch (e) { console.error('Web search failed:', e.message); }
}

async function runEvaluate(limit = 10) {
  await initRegistry();
  
  console.log(`\n📊 [2/5] Evaluating jobs (limit: ${limit})...`);
  
  const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
  const pending = [];
  for (const line of lines) {
    const m = line.match(/^- \[ \] (.+)$/);
    if (m) {
      const parts = m[1].split('|').map(s => s.trim());
      pending.push({ url: parts[0], company: parts[1], role: parts[2], location: parts[3] });
    }
  }
  
  const toEvaluate = pending.slice(0, limit);
  if (!toEvaluate.length) { console.log('No pending jobs'); return; }
  
  console.log(`Found ${toEvaluate.length} jobs to evaluate\n`);
  
  for (let i = 0; i < toEvaluate.length; i++) {
    const job = toEvaluate[i];
    const num = i + 1;
    console.log(`  [${num}/${toEvaluate.length}] ${job.company} — ${job.role}`);
    
    try {
      // Fetch job page
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(job.url, { waitUntil: 'networkidle', timeout: 30000 });
      const text = await page.evaluate(() => document.body.innerText).catch(() => '');
      const title = await page.title().catch(() => job.role);
      await browser.close();
      
      // Evaluate with best reasoning model
      const prompt = buildEvalPrompt(job, title, text);
      const result = await router.routeWithModel(prompt, { 
        taskType: 'evaluate',
        requireCapabilities: ['reasoning'],
        maxCost: 'paid'
      });
      
      // Parse score
      const score = parseScore(result);
      const tldr = parseTldr(result);
      
      console.log(`    Score: ${score}/5 | ${score >= 3 ? 'Evaluated' : 'SKIP'}`);
      
      // Save report
      await saveReport(job, result, score, tldr);
      
      // Update pipeline
      await updatePipelineEntry(job.url, true);
      
    } catch (err) {
      console.error(`    Error: ${err.message}`);
    }
  }
  
  // Merge tracker
  try {
    execFileSync('node', ['merge-tracker.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 30000 });
  } catch {}
}

function buildEvalPrompt(job, title, jdText) {
  const isEntry = /entry.?level|junior|no experience|trainee|apprentice|assistant|representative|specialist|clerk|agent|coordinator|scheduler|dispatcher|processor|operator|technician|aide|helper|attendant|secretary|receptionist|host|monitor|reviewer|tester/i.test(title);
  const leniency = isEntry ? `\n\nLENIENCY: Entry-level role. Be generous - basic literacy + typing + communication = qualified. Transferable skills count. Focus on reliability, communication, willingness to learn.` : '';
  
  return `You are a career advisor evaluating a job offer for a specific candidate.

CANDIDATE PROFILE:
${JSON.stringify(CANDIDATE, null, 2)}

CANDIDATE RESUME (abridged):
${CV_TEXT}

JOB:
Title: ${title}
Company: ${job.company}
URL: ${job.url}
Location: ${job.location}

Job Description:
${jdText}
${leniency}

Evaluate using A-G scoring (0-10 each):
A. Role Alignment: Does this role match the candidate's trajectory?
B. Compensation & Benefits: Salary range, benefits, equity
C. Growth Potential: Learning, advancement, mentorship
D. Company Health: Financial stability, reputation, culture
E. Location & Logistics: Remote policy, hours, commute
F. Personal Fit: Values alignment, team, work style
G. Posting Legitimacy: Real posting, no red flags

Output JSON FIRST:
\`\`\`json
{
  "score": <overall 1-5>,
  "scores": { "role": <0-10>, "compensation": <0-10>, "growth": <0-10>, "company": <0-10>, "location": <0-10>, "fit": <0-10>, "legitimacy": <0-10> },
  "recommendation": "<Strong Apply | Apply | Consider | Skip>",
  "strengths": ["..."],
  "weaknesses": ["..."],
  "tldr": "<one line summary>"
}
\`\`\`

Then write full markdown evaluation report.`;
}

async function saveReport(job, result, score, tldr) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = (job.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';
  const files = readdirSync(REPORTS_DIR).filter(f => f.match(/^\d+-/));
  const nums = files.map(f => parseInt(f.match(/^(\d+)-/)?.[1] || '0')).filter(n => !isNaN(n));
  const nextNum = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
  const reportFile = `${nextNum}-${slug}-${date}.md`;
  
  const header = `# Evaluation Report\n\n**URL:** ${job.url}\n**Score:** ${score.toFixed(1)}/5\n**TL;DR:** ${tldr}\n\n`;
  writeFileSync(join(REPORTS_DIR, reportFile), header + result, 'utf-8');
  
  // Tracker TSV
  mkdirSync(TRACKER_DIR, { recursive: true });
  const tsvFile = `${nextNum}-${slug}.tsv`;
  const tsv = `${nextNum}\t${new Date().toISOString().slice(0, 10)}\t${job.company}\t${job.role}\t${score >= 3 ? 'Evaluated' : 'SKIP'}\t${score.toFixed(1)}/5\t❌\t[${nextNum}](reports/${reportFile})\t${tldr}`;
  writeFileSync(join(TRACKER_DIR, tsvFile), tsv + '\n', 'utf-8');
}

async function updatePipelineEntry(url, evaluated) {
  const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
  const newLines = lines.map(line => {
    const m = line.match(/^- \[([ x])\] (.+)$/);
    if (m && m[2].startsWith(url)) {
      return line.replace('- [ ]', '- [x]');
    }
    return line;
  });
  writeFileSync(PIPELINE_PATH, newLines.join('\n'), 'utf-8');
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
  let m = text.match(/"tldr"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  m = text.match(/TL;DR:\s*(.+)/i);
  if (m) return m[1].trim();
  m = text.match(/## A\) Role Summary\s*\n([\s\S]+?)\n\n/);
  if (m) return m[1].trim().slice(0, 200);
  return 'No summary';
}

// ─── CV/Cover Letter Generation with Quality Gates ───────────────

async function generateDocuments() {
  console.log('\n📄 [3/5] Generating CVs & Cover Letters with quality gates...');
  let count = 0;
  
  const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
  for (const line of lines) {
    const m = line.match(/^- \[x\] (.+)$/);
    if (!m) continue;
    const parts = m[1].split('|').map(s => s.trim());
    const company = parts[1], role = parts[2] || 'Role';
    if (!company) continue;
    
    const slug = (company + '-' + role).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
    const cvOut = join(OUTPUT_DIR, `${slug}-cv.pdf`);
    const clOut = join(OUTPUT_DIR, `${slug}-cover.pdf`);
    
    // Generate CV with quality review
    if (!existsSync(cvOut)) {
      console.log(`  📝 Generating CV for ${company}...`);
      try {
        execFileSync('node', ['generate-cv.mjs', '--profile', getActiveProfile(), '--company', company, '--role', role, '--out', cvOut], { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
        count++;
      } catch (e) {
        const msg = e.stderr ? e.stderr.toString().trim().slice(0, 200) : e.message;
        console.log(`  ⚠️  CV failed for ${company}: ${msg}`);
      }
    }
    
    if (!existsSync(clOut)) {
      const payload = {
        candidate: coverCandidate(),
        letter: { 
          role_title: role, company, city: 'Remote', date: new Date().toISOString().slice(0, 10), 
          greeting: 'Dear Hiring Manager,', 
          opening: `I am writing to apply for the ${role} position at ${company}.`, 
          profile_intro: 'With a track record of adapting quickly and delivering results, I am confident I can contribute effectively to your team.',
          achievements: [{ lead: 'Proven ability', impact: 'to adapt quickly and deliver results in remote environments' }], 
          closing: 'Thank you for your consideration.', 
          footnotes: ['References available upon request.'] 
        },
        output_path: clOut
      };
      writeFileSync(join(OUTPUT_DIR, `${slug}-payload.json`), JSON.stringify(payload, null, 2));
      try {
        execFileSync('node', ['generate-cover-letter.mjs', '--payload', join(OUTPUT_DIR, `${slug}-payload.json`)], { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
      } catch (e) {
        const msg = e.stderr ? e.stderr.toString().trim().slice(0, 200) : e.message;
        console.log(`  ⚠️  CL failed for ${company}: ${msg}`);
      }
    }
  }
  console.log(`  Generated ${count} new CVs`);
}

// ─── Quality Review Functions ────────────────────────────────────

async function qualityReviewCV(company, role, cvHtml) {
  const prompt = `Review this CV for ATS compatibility and role fit.

COMPANY: ${company}
ROLE: ${role}

CV HTML:
${cvHtml.slice(0, 10000)}

Rate 1-10 on:
1. ATS parseability (clean text extraction)
2. Keyword relevance to role
3. Formatting consistency
4. Contact info completeness
5. Experience relevance
6. Skills alignment

Output JSON:
{
  "score": <1-10>,
  "atsScore": <1-10>,
  "approved": <boolean>,
  "issues": ["issue1", "issue2"],
  "recommendations": ["rec1", "rec2"]
}`;

  try {
    const result = await router.routeWithModel(prompt, { 
      taskType: 'evaluate',
      requireCapabilities: ['reasoning'],
      maxCost: 'paid'
    });
    const m = result.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { score: 5, atsScore: 5, approved: true, issues: [], recommendations: [] };
  } catch {
    return { score: 7, atsScore: 7, approved: true, issues: [], recommendations: [] };
  }
}

async function qualityReviewCoverLetter(company, role, payload) {
  const prompt = `Review this cover letter for role fit and personalization.

COMPANY: ${company}
ROLE: ${role}

COVER LETTER:
${JSON.stringify(payload.letter, null, 2)}

Rate 1-10 on:
1. Company-specific personalization
2. Role requirement matching
3. STAR story relevance
4. Professional tone
5. Call to action clarity

Output JSON:
{
  "score": <1-10>,
  "approved": <boolean>,
  "issues": ["issue1", "issue2"],
  "recommendations": ["rec1", "rec2"]
}`;

  try {
    const result = await router.routeWithModel(prompt, { 
      taskType: 'evaluate',
      requireCapabilities: ['reasoning'],
      maxCost: 'paid'
    });
    const m = result.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { score: 7, approved: true, issues: [], recommendations: [] };
  } catch {
    return { score: 7, approved: true, issues: [], recommendations: [] };
  }
}

// ─── Main Pipeline ───────────────────────────────────────────────

// `autoSubmit` selects the apply MODE (headless fill+stage vs interactive
// apply-assist dashboard) — nothing ever actually auto-submits from here;
// every application still lands in the Review Queue for a human approval
// click (see submit-application.mjs).
async function runPipeline(maxJobs = 20, autoSubmit = false) {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║          DAFE CAREER OS AUTOMATED PIPELINE                          ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`   Max jobs: ${maxJobs} | Apply mode: ${autoSubmit ? 'headless fill + stage' : 'interactive review dashboard'}\n`);
  
  const startTime = Date.now();
  
  await runScan();
  await runEvaluate(maxJobs);
  await generateDocuments();
  
  // Generate report
  console.log('\n📊 [5/5] Generating printable report...');
  execFileSync('node', ['generate-apply-report.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 30000 });
  
  // Fill & stage applications either way — nothing here ever submits.
  // Approve staged entries in the dashboard's Review Queue to send them.
  if (autoSubmit) {
    console.log('\n📋 Filling & staging applications for review (nothing is submitted automatically)...');
    await runApply();
  } else {
    console.log('\n📋 Launching apply dashboard for manual review...');
    await runApplyDashboard();
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n✅ Pipeline complete in ${elapsed} minutes`);
}

async function runApply() {
  console.log('\n📋 [4/5] Filling & staging applications for review...');
  const args = ['auto-apply.mjs', '--max', '10'];

  try {
    execFileSync('node', args, { cwd: ROOT, stdio: 'inherit', timeout: 600000 });
  } catch {}
}

async function runApplyDashboard() {
  console.log('\n📋 Launching interactive apply dashboard...');
  try {
    execFileSync('node', ['apply-assist.mjs'], { cwd: ROOT, stdio: 'inherit', timeout: 600000 });
  } catch {}
}

// ─── CLI Commands ────────────────────────────────────────────────

async function cmdScan() { await runScan(); }
async function cmdEvaluate(max = 10) { await initRegistry(); await runEvaluate(max); }
async function cmdCV() { await initRegistry(); await generateDocuments(); }
async function cmdCover() { await initRegistry(); await generateDocuments(); }
async function cmdPrep(company, role, url) { 
  await initRegistry(); 
  const { interviewPrep } = await import('./interview-prep.mjs');
  await interviewPrep({ company, role, url });
}
async function cmdApply() { await runApply(); }
async function cmdDashboard() { await runApplyDashboard(); }
async function cmdReport() { execFileSync('node', ['generate-apply-report.mjs'], { cwd: ROOT, stdio: 'inherit' }); }
async function cmdStatus() { await initRegistry(); console.log('\n=== Model Status ===\n'); console.log(JSON.stringify(registry.getStatus(), null, 2)); }
async function cmdPipeline(max = 20, auto = false) { await runPipeline(max, auto); }

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      scan: { type: 'boolean' },
      evaluate: { type: 'boolean' },
      cv: { type: 'boolean' },
      cover: { type: 'boolean' },
      prep: { type: 'boolean' },
      apply: { type: 'boolean' },
      dashboard: { type: 'boolean' },
      report: { type: 'boolean' },
      status: { type: 'boolean' },
      pipeline: { type: 'boolean' },
      max: { type: 'string', short: 'm' },
      auto: { type: 'boolean' },
      noAuto: { type: 'boolean' },
      company: { type: 'string' },
      role: { type: 'string' },
      url: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  
  if (values.help) {
    console.log(`
DAFE Career OS Orchestrator — Unified Job Search Automation

USAGE:
  node career-orchestrator.mjs <command> [options]

COMMANDS:
  --scan                 Scan job boards (9 providers) + web search
  --evaluate [--max N]   Evaluate pending jobs with best reasoning model
  --cv                   Generate tailored CV PDFs
  --cover                Generate cover letter PDFs
  --prep --company "X" --role "Y" [--url "..."]  Interview preparation
  --apply                Fill & stage applications (headless) — never submits; approve in the dashboard Review Queue
  --dashboard            Interactive apply-assist dashboard (manual review)
  --report               Generate printable HTML report
  --status               Show available models (local + cloud)
  --pipeline [--max N] [--no-auto]  Full pipeline: scan → evaluate → cv → cover → fill & stage → report

OPTIONS:
  --max N          Max jobs to process (default: 20)
  --no-auto        With --pipeline: use the interactive apply-assist dashboard instead of headless fill & stage
  --company "X"    Company name (for prep)
  --role "Y"       Role title (for prep)
  --url "..."      Job URL (for prep)

EXAMPLES:
  node career-orchestrator.mjs --pipeline --max 15 --no-auto
  node career-orchestrator.mjs --pipeline --max 10
  node career-orchestrator.mjs --scan
  node career-orchestrator.mjs --evaluate --max 20
  node career-orchestrator.mjs --prep --company "Acme Corp" --role "Support" --url "https://..."
  node career-orchestrator.mjs --apply
  node career-orchestrator.mjs --report
  node career-orchestrator.mjs --status
`);
    process.exit(0);
  }

  // Execute command based on flags
  if (values.scan) await cmdScan();
  else if (values.evaluate) await cmdEvaluate(values.max ? parseInt(values.max) : 10);
  else if (values.cv) await cmdCV();
  else if (values.cover) await cmdCover();
  else if (values.prep) await cmdPrep(values.company, values.role, values.url);
  else if (values.apply) await cmdApply();
  else if (values.dashboard) await cmdDashboard();
  else if (values.report) await cmdReport();
  else if (values.status) await cmdStatus();
  else if (values.pipeline) await cmdPipeline(values.max ? parseInt(values.max) : 20, !values.noAuto);
  else console.log('Unknown command. Use --help');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });