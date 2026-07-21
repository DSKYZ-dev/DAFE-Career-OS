#!/usr/bin/env node
/**
 * autonomous-loop.mjs — Autonomous Entry-Level / Low-Barrier Job Application Loop
 * 
 * Finds and applies to entry-level, minimal-requirement, "any-background" positions
 * regardless of the user's primary focus tracks. Designed for when the user just
 * needs a position — any position — and wants maximum volume with quality.
 * 
 * Features:
 * - Scans all portals for entry-level/junior/graduate/trainee/intern roles
 * - Gates on keyword match + a liveness/legitimacy check — NOT a fit-score
 *   threshold (an entry-level rubric would score against the user's real
 *   target roles and reject almost everything; see #5 in the redesign plan)
 * - Generates FULLY TAILORED CV + cover letter per job via LLM
 * - Fills and stages every application for human review — NEVER submits.
 *   Approve a staged entry in the dashboard's Review Queue to actually send
 *   it (see submit-application.mjs). --auto-submit is accepted for
 *   backwards compatibility but ignored.
 * - Respects daily/hourly rate limits, retries with backoff
 * - Logs everything for audit trail
 *
 * Usage:
 *   node autonomous-loop.mjs --max 20              # Fill + stage, up to 20 jobs
 *   node autonomous-loop.mjs --max 50 --hours 4     # Run for 4 hours max
 *   node autonomous-loop.mjs --force --max 30       # Skip the liveness check too
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { chromium } from 'playwright';
import yaml from 'js-yaml';
import { execFileSync } from 'child_process';
import { writeQueueEntry } from './review-queue.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const OUTPUT_DIR = join(ROOT, 'output');
const LOG_DIR = join(ROOT, 'logs');
const TRACKER_DIR = join(ROOT, 'batch', 'tracker-additions');
const REPORTS_DIR = join(ROOT, 'reports');
const SETTINGS_PATH = join(ROOT, 'data', 'settings.json');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(TRACKER_DIR, { recursive: true });

// ── Load Config ──────────────────────────────────────────────────────
// No scoreThreshold here on purpose — this loop never gates on a fit score
// (see the docstring above for why). maxDaily/min/maxDelay still apply to
// rate-limiting how fast jobs get filled.
let SETTINGS = { maxDailyApplications: 30, minDelayMs: 8000, maxDelayMs: 20000 };
try { const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')); SETTINGS = { ...SETTINGS, ...s }; } catch {}

const PROFILE = yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {};
const CANDIDATE = PROFILE.candidate || {};

// Overlay settings from dashboard
try {
  const s = JSON.parse(readFileSync(join(ROOT, 'data', 'settings.json'), 'utf-8'));
  for (const k of ['email', 'phone', 'linkedin', 'portfolio']) {
    if (s[k] !== undefined && s[k] !== '') CANDIDATE[k] = s[k];
  }
} catch {}

// ── Entry-Level Detection Keywords ───────────────────────────────────
const ENTRY_LEVEL_KEYWORDS = [
  // Explicit level indicators
  'entry level', 'entry-level', 'junior', 'graduate', 'grad', 'trainee',
  'intern', 'internship', 'apprentice', 'apprenticeship', 'co-op', 'coop',
  'associate', 'analyst i', 'analyst 1', 'engineer i', 'engineer 1',
  'developer i', 'developer 1', 'software engineer i', 'software engineer 1',
  'new grad', 'new graduate', 'recent grad', 'recent graduate',
  '0-1 year', '0-2 years', '0-3 years', '1 year', '1+ year',
  'no experience', 'minimal experience', 'little experience',
  'willing to train', 'will train', 'training provided', 'on the job training',
  'career starter', 'early career', 'launch', 'fellowship', 'rotation program',
  'leadership development', 'rotational program', 'management trainee'
];

const SENIOR_EXCLUSION_KEYWORDS = [
  'senior', 'lead', 'principal', 'staff', 'architect', 'manager', 'director',
  'vp', 'vice president', 'head of', 'chief', 'expert', '5+ years', '7+ years',
  '10+ years', 'extensive experience', 'deep expertise', 'proven track record',
  'staff engineer', 'principal engineer', 'tech lead', 'team lead'
];

// ── Helpers ──────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function logFile(msg) { appendFileSync(join(LOG_DIR, `autonomous-${new Date().toISOString().slice(0,10)}.log`), msg + '\n'); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function isEntryLevel(title, description = '') {
  const text = (title + ' ' + description).toLowerCase();
  
  // Must have at least one entry-level indicator
  const hasEntrySignal = ENTRY_LEVEL_KEYWORDS.some(kw => text.includes(kw));
  if (!hasEntrySignal) return false;
  
  // Must NOT have senior indicators (unless explicitly entry-level + senior = contradiction)
  const hasSeniorSignal = SENIOR_EXCLUSION_KEYWORDS.some(kw => text.includes(kw));
  if (hasSeniorSignal) {
    // Allow if it says "senior" but also "entry level" — likely a data error, skip
    return false;
  }
  
  return true;
}

function getNextReportNum() {
  let max = 0;
  for (const dir of [REPORTS_DIR, TRACKER_DIR]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = f.match(/^(\d+)-/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max + 1;
}

// `num` is passed in (from the SAME getNextReportNum() call the caller used
// to name the report file) rather than recomputed here — recomputing it
// separately meant the tracker's report link and the report file's actual
// name could disagree (the report gets written first, so a second
// getNextReportNum() call here would see it and return num+1).
function writeTrackerEntry(job, slug, num, pdfExists) {
  const date = new Date().toISOString().slice(0, 10);
  const tsvFile = `${String(num).padStart(3, '0')}-${slug}.tsv`;
  const tsv = `${num}\t${date}\t${job.company}\t${job.role}\tEvaluated\t/5\t${pdfExists ? '✅' : '❌'}\t[${num}](reports/${String(num).padStart(3, '0')}-${slug}-${date}.md)\t[entry-level] Staged — approve in dashboard Review Queue to submit`;
  writeFileSync(join(TRACKER_DIR, tsvFile), tsv + '\n', 'utf-8');
  log(`    ✓ Tracker: ${tsvFile}`);
}

// ── Tailored CV Generation via LLM ───────────────────────────────────
async function generateTailoredCV(job, cvText, jdText) {
  const prompt = `You are an expert resume writer. Rewrite the candidate's CV to be perfectly tailored for this specific job.

CANDIDATE'S BASE CV:
${cvText}

JOB DESCRIPTION:
${jdText}

COMPANY: ${job.company}
ROLE: ${job.role}

INSTRUCTIONS:
1. Keep ALL factual claims from the base CV - NEVER invent metrics, technologies, or experiences
2. Reorder/rephrase to highlight the 3-5 most relevant experiences for THIS role
3. Mirror the JD's terminology (e.g., if JD says "TypeScript", use "TypeScript" not "JS/TS")
4. Prioritize skills/keywords from the JD in the summary and skills sections
5. Select the 4 most relevant bullet points per role that match JD requirements
6. Output clean markdown with standard sections: Summary, Experience, Projects, Education, Skills
7. Max 2 pages when rendered. Be creative to PDF.

Return ONLY the tailored CV markdown. No commentary.`;

  const jdPath = join(ROOT, 'jds', `tailor-${Date.now()}.txt`);
  mkdirSync(dirname(jdPath), { recursive: true });
  writeFileSync(jdPath, prompt, 'utf-8');
  
  try {
    const result = execFileSync('node', ['cloud-eval.mjs', '--file', jdPath], { 
      cwd: ROOT, 
      timeout: 120000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });
    return result.trim();
  } catch (e) {
    log(`    ⚠ LLM tailoring failed: ${e.message}, using base CV`);
    return cvText;
  } finally {
    try { unlinkSync(jdPath); } catch {}
  }
}

// ── Tailored Cover Letter Generation via LLM ─────────────────────────
async function generateTailoredCoverLetter(job, cvText, jdText) {
  const prompt = `Write a compelling, tailored cover letter for this specific job.

CANDIDATE CV (for reference - use real facts only):
${cvText}

JOB DESCRIPTION:
${jdText}

COMPANY: ${job.company}
ROLE: ${job.role}
CANDIDATE NAME: ${CANDIDATE.full_name || CANDIDATE.name || 'Candidate'}
CANDIDATE CURRENT ROLE: ${CANDIDATE.current_role || 'Current Role'}
YEARS EXPERIENCE: ${CANDIDATE.years_experience || CANDIDATE.experience || 'Several'}

INSTRUCTIONS:
1. 3-4 paragraphs, professional but human tone
2. Opening: Specific hook referencing company mission/product + role
3. Body paragraph 1: 2-3 concrete achievements from CV that map to JD's top requirements
4. Body paragraph 2: Demonstrate company knowledge (mission, values, recent news) + culture fit
5. Closing: Clear call to action, availability
6. NEVER invent facts. Only use what's in the CV or public company info.
7. Match the JD's language for key technologies/competencies
8. ~250-350 words total

Return JSON:
{
  "greeting": "Dear Hiring Manager,",
  "opening": "...",
  "profile_intro": "...",
  "achievements": [{"lead": "...", "impact": "..."}, {"lead": "...", "impact": "..."}],
  "closing": "...",
  "footnotes": ["References available upon request."]
}`;

  const jdPath = join(ROOT, 'jds', `cover-${Date.now()}.txt`);
  mkdirSync(dirname(jdPath), { recursive: true });
  writeFileSync(jdPath, prompt, 'utf-8');
  
  try {
    const result = execFileSync('node', ['cloud-eval.mjs', '--file', jdPath], { 
      cwd: ROOT, 
      timeout: 120000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });
    // Extract JSON from response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('No JSON in response');
  } catch (e) {
    log(`    ⚠ LLM cover letter failed: ${e.message}, using template`);
    return null;
  } finally {
    try { unlinkSync(jdPath); } catch {}
  }
}

// ── PDF Generation ───────────────────────────────────────────────────
async function generatePDFs(job, tailoredCV, coverPayload) {
  const slug = (job.company + '-' + job.role).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  const cvOut = join(OUTPUT_DIR, `${slug}-cv.pdf`);
  const clOut = join(OUTPUT_DIR, `${slug}-cover.pdf`);
  
   // Write tailored CV to temp file for generate-cv.mjs
  const cvPath = join(OUTPUT_DIR, `${slug}-tailored.md`);
  writeFileSync(cvPath, tailoredCV, 'utf-8');
  
  // Generate CV PDF (render the LLM-tailored markdown via --cv)
  try {
    execFileSync('node', ['generate-cv.mjs', '--profile', 'default', '--cv', cvPath, '--company', job.company, '--role', job.role, '--out', cvOut], { 
      cwd: ROOT, stdio: 'pipe', timeout: 60000 
    });
    log(`    ✓ CV: ${cvOut}`);
  } catch (e) {
    log(`    ⚠ CV generation failed: ${e.message}`);
  }
  
  // Generate Cover Letter PDF
  if (coverPayload) {
    const payloadPath = join(OUTPUT_DIR, `${slug}-payload.json`);
    writeFileSync(payloadPath, JSON.stringify({
      candidate: {
        name: CANDIDATE.full_name || CANDIDATE.name || 'Candidate',
        email: CANDIDATE.email,
        phone: CANDIDATE.phone,
        linkedin: CANDIDATE.linkedin,
        github: CANDIDATE.github,
        location: CANDIDATE.location,
        credentials: CANDIDATE.credentials || []
      },
      letter: coverPayload,
      output_path: clOut
    }, null, 2), 'utf-8');
    
    try {
      execFileSync('node', ['generate-cover-letter.mjs', '--payload', payloadPath], { 
        cwd: ROOT, stdio: 'pipe', timeout: 30000 
      });
      log(`    ✓ Cover Letter: ${clOut}`);
    } catch (e) {
      log(`    ⚠ Cover letter failed: ${e.message}`);
    }
  }
  
  return { cvOut, clOut, slug };
}

// ── Liveness / legitimacy check (replaces fit-score evaluation) ───────
// Entry-level jobs are gated by isEntryLevel() (keyword match), NOT a fit
// score — scoring "is this a legitimate low-barrier job" against the same
// rubric used for the user's real target roles is the wrong tool (a
// "warehouse trainee, will train" listing scores near 0 on an AI/automation
// fit rubric and would never survive). This just confirms the posting still
// looks live, reusing check-liveness.mjs's own tested detection rather than
// re-implementing expiry heuristics here. Fails OPEN — matches this repo's
// stated principle that a false "expired" is worse than a slow check.
function checkLiveness(url) {
  try {
    const out = execFileSync('node', ['check-liveness.mjs', url], {
      cwd: ROOT, timeout: 45000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024,
    });
    return out.includes('❌ expired') ? 'expired' : 'active';
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    return out.includes('❌ expired') ? 'expired' : 'uncertain';
  }
}

// Escape a value for a double-quoted YAML scalar. Backslashes must be
// escaped FIRST — escaping the quote before the backslash lets a value
// ending in "\" corrupt the escaping and break out of the quoted string.
function yamlEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// Deterministic report — no LLM call, no fit score. Being explicit that this
// mode doesn't score fit is the point: it stops a confusing senior-rubric
// "reasoning" paragraph from showing up under a trainee-role posting.
function buildEntryLevelReport(job, liveness) {
  const date = new Date().toISOString().slice(0, 10);
  return `# ${job.role} — ${job.company}

**Date:** ${date}
**URL:** ${job.url}
**Mode:** Entry-level / low-barrier ("I Need A Job Now")
**Liveness:** ${liveness}

This report was produced by the entry-level autonomous loop, which does not
score fit against your primary target roles — it only checks entry-level/
low-barrier keyword signals and that the listing still looks live. Read the
actual job description before approving submission in the Review Queue.

## Machine Summary
\`\`\`yaml
company: "${yamlEscape(job.company)}"
role: "${yamlEscape(job.role)}"
url: "${yamlEscape(job.url)}"
mode: entry-level
liveness: ${liveness}
score: null
\`\`\`
`;
}

// ── Main Autonomous Loop ─────────────────────────────────────────────
async function main() {
  const { values: args } = parseArgs({
    options: {
      max: { type: 'string', short: 'm' },
      autoSubmit: { type: 'boolean' },
      hours: { type: 'string' },
      dryRun: { type: 'boolean' },
      verbose: { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });

  if (args.help) {
    console.log(`
Autonomous Entry-Level Job Application Loop

Usage:
  node autonomous-loop.mjs [options]

Options:
  --max N              Max jobs to process (default: 20)
  --hours N            Max hours to run (default: unlimited)
  --force              Skip the liveness check too — pure keyword gate
  --verbose            Verbose logging
  --help               Show this help

This always fills and stages — it never submits. Approve staged entries in
the dashboard's Review Queue to actually send them.

Examples:
  node autonomous-loop.mjs --max 20
  node autonomous-loop.mjs --max 50 --hours 4
  node autonomous-loop.mjs --force --max 30
`);
    process.exit(0);
  }

  const maxJobs = args.max ? parseInt(args.max, 10) : 20;
  if (args.autoSubmit) {
    log('⚠ --auto-submit is ignored — applications are staged in the Review Queue and submitted only from the dashboard, after you approve them.');
  }
  const maxHours = args.hours ? parseFloat(args.hours) : null;
  const force = args.force === true;
  const verbose = args.verbose || false;
  const startTime = Date.now();
  const maxMs = maxHours ? maxHours * 60 * 60 * 1000 : Infinity;

  log(`🚀 AUTONOMOUS LOOP STARTED`);
  log(`   Max jobs: ${maxJobs} | Max hours: ${maxHours || '∞'} | Mode: fill + stage for review`);
  logFile(`START max=${maxJobs} hours=${maxHours} force=${force}`);

  // Step 1: Run scan to populate pipeline (entry-level wide-net mode)
  log('\n📡 Scanning portals for new jobs (entry-level wide-net)...');
  try {
    execFileSync('node', ['scan.mjs', '--entry-level'], { cwd: ROOT, stdio: 'inherit', timeout: 300000 });
  } catch (e) {
    log(`⚠ Scan failed: ${e.message}`);
  }

  // Step 2: Read pipeline
  const lines = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8').split('\n') : [];
  const pending = [];
  
  for (const line of lines) {
    const m = line.match(/^- \[ \] (.+)$/);
    if (m) {
      const parts = m[1].split('|').map(s => s.trim());
      pending.push({ 
        url: parts[0], 
        company: parts[1] || 'Unknown', 
        role: parts[2] || 'Unknown Role', 
        location: parts[3] || 'Unknown',
        raw: line 
      });
    }
  }

  log(`\n📋 Found ${pending.length} pending jobs in pipeline`);

  // Step 3: Filter for entry-level
  const entryJobs = [];
  for (const job of pending) {
    // We need to fetch the job page to check description
    // For now, filter by title keywords
    if (isEntryLevel(job.role)) {
      entryJobs.push(job);
    }
  }

  log(`🎯 ${entryJobs.length} entry-level jobs detected by title`);

  if (entryJobs.length === 0) {
    log('No entry-level jobs found. Exiting.');
    return;
  }

  // Step 4: Process each job
  const cvText = readFileSync(join(ROOT, 'cv.md'), 'utf-8');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let processed = 0;
  let staged = 0;
  let errors = 0;

  for (let i = 0; i < entryJobs.length && processed < maxJobs; i++) {
    if (Date.now() - startTime > maxMs) {
      log(`\n⏰ Time limit reached (${maxHours}h)`);
      break;
    }

    const job = entryJobs[i];
    processed++;
    log(`\n[${processed}/${Math.min(maxJobs, entryJobs.length)}] ${job.company} — ${job.role}`);
    log(`   ${job.url}`);

    // Fetch job description
    let jdText = '';
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      jdText = await page.evaluate(() => document.body.innerText.slice(0, 15000));
      job.description = jdText;
      
      // Re-check entry-level with full description
      if (!isEntryLevel(job.role, jdText)) {
        log(`   ⏭ Not entry-level based on description`);
        continue;
      }
    } catch (e) {
      log(`   ⚠ Failed to fetch JD: ${e.message}`);
    }

    // Liveness/legitimacy check instead of a fit score (see comment above
    // checkLiveness — an entry-level posting shouldn't be scored against the
    // user's real target-role rubric).
    let liveness = 'uncertain';
    if (!force) {
      liveness = checkLiveness(job.url);
      log(`   Liveness: ${liveness}`);
      if (liveness === 'expired') {
        log(`   ⏭ Posting appears expired — skipping`);
        continue;
      }
    } else {
      log(`   🔥 FORCE mode — skipping liveness check`);
    }
    const report = buildEntryLevelReport(job, liveness);

    // Generate tailored CV
    log(`   ✍️  Generating tailored CV...`);
    const tailoredCV = await generateTailoredCV(job, cvText, jdText);

    // Generate tailored cover letter
    log(`   ✍️  Generating tailored cover letter...`);
    const coverPayload = await generateTailoredCoverLetter(job, cvText, jdText);

    // Generate PDFs
    log(`   📄 Generating PDFs...`);
    const { cvOut, clOut, slug } = await generatePDFs(job, tailoredCV, coverPayload);

    // Fill and stage for review — this never submits. Approve it in the
    // dashboard's Review Queue to actually send it (see submit-application.mjs).
    log(`   📝 Filling application...`);
    try {
      const { applyToJob } = await import('./auto-apply.mjs');
      const result = await applyToJob(page, job.url, CANDIDATE, cvOut, clOut, false);

      if (result.ready) {
        staged++;
        const reportNum = getNextReportNum();
        const reportPath = join(REPORTS_DIR, `${String(reportNum).padStart(3, '0')}-${slug}-${new Date().toISOString().slice(0,10)}.md`);
        writeFileSync(reportPath, report, 'utf-8');
        writeTrackerEntry(job, slug, reportNum, existsSync(cvOut));
        writeQueueEntry({
          company: job.company, role: job.role, url: job.url, ats: result.ats,
          fitScore: null,
          reportPath: `reports/${String(reportNum).padStart(3, '0')}-${slug}-${new Date().toISOString().slice(0, 10)}.md`,
          cvPath: existsSync(cvOut) ? cvOut : null,
          coverPath: existsSync(clOut) ? clOut : null,
          filledCount: result.filled, totalFields: 8,
          needsManualSolve: !!result.needsManualSolve, captchaNote: result.captchaNote || null,
          source: 'autonomous-loop',
        });
        log(`   ✅ Staged for review (Report #${reportNum})${result.needsManualSolve ? ' — needs manual CAPTCHA solve' : ''}`);
      } else {
        log(`   ❌ Failed: ${result.reason}`);
        errors++;
      }
    } catch (e) {
      log(`   ❌ Error: ${e.message}`);
      errors++;
    }

    // Rate limiting delay
    if (i < entryJobs.length - 1) {
      const d = Math.floor(Math.random() * (SETTINGS.maxDelayMs - SETTINGS.minDelayMs) + SETTINGS.minDelayMs);
      log(`   ⏳ Waiting ${(d/1000).toFixed(1)}s...`);
      await delay(d);
    }
  }

  await browser.close();

  // Summary
  log('\n' + '='.repeat(50));
  log('AUTONOMOUS LOOP COMPLETE');
  log('='.repeat(50));
  log(`Processed: ${processed}`);
  log(`Staged for review: ${staged}`);
  log(`Errors:    ${errors}`);
  log(`→ Open the dashboard's Review Queue to approve and actually submit.`);
  logFile(`END processed=${processed} staged=${staged} errors=${errors}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });