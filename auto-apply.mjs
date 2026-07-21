#!/usr/bin/env node
/**
 * auto-apply.mjs — Automated Job Application Filler
 * 
 * Supports: Greenhouse, Lever, Workday, Ashby, and generic ATS
 * Fills form fields with candidate data, uploads CV + cover letter
 * 
 * This script only ever FILLS forms and stages them in the Review Queue
 * (review-queue.mjs) — it never clicks Submit. Approving a staged entry in
 * the dashboard is the only way an application actually gets submitted (see
 * submit-application.mjs). --auto-submit is accepted for backwards
 * compatibility but ignored.
 *
 * Usage:
 *   node auto-apply.mjs --max 10              # Process pipeline, fill + stage
 *   node auto-apply.mjs --url "..."            # Single URL, fill + stage
 *   node auto-apply.mjs --provider greenhouse --max 5  # Filter by ATS
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { chromium } from 'playwright';
import { writeQueueEntry } from './review-queue.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const OUTPUT_DIR = join(ROOT, 'output');
const LOG_DIR = join(ROOT, 'logs');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

// Load candidate profile
import yaml from 'js-yaml';
const profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8'));
const CANDIDATE = profile.candidate || {};
// Overlay dashboard Settings (data/settings.json) so contact details
// entered in the UI actually reach generated applications.
try {
  const s = JSON.parse(readFileSync(join(ROOT, 'data', 'settings.json'), 'utf-8'));
  for (const k of ['email', 'phone', 'linkedin', 'portfolio', 'scoreThreshold']) {
    if (s[k] !== undefined && s[k] !== '') CANDIDATE[k] = s[k];
  }
} catch {}

// Build a company -> score map from data/applications.md for fit-ranking.
function loadApplicationScores() {
  const map = new Map();
  try {
    const lines = readFileSync(join(ROOT, 'data', 'applications.md'), 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\|\s*\d+\s*\|.*?\|(.*?)\|(.*?)\|\s*([\d.]+)\/5\s*\|/);
      if (m) {
        const company = m[1].trim().toLowerCase();
        const score = parseFloat(m[3]);
        if (!map.has(company) || score > map.get(company)) map.set(company, score);
      }
    }
  } catch {}
  return map;
}

// ATS Detection
/** True if `hostname` IS `domain` or a real subdomain of it — not a substring
 * match, so "evil-greenhouse.io" or "greenhouse.io.evil.com" don't match. */
function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith('.' + domain);
}

function detectATS(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (hostMatches(hostname, 'greenhouse.io') || hostMatches(hostname, 'grnh.se')) return 'greenhouse';
  if (hostMatches(hostname, 'lever.co')) return 'lever';
  if (hostMatches(hostname, 'myworkdayjobs.com') || hostMatches(hostname, 'workday.com')) return 'workday';
  if (hostMatches(hostname, 'ashbyhq.com')) return 'ashby';
  if (hostMatches(hostname, 'smartrecruiters.com')) return 'smartrecruiters';
  if (hostMatches(hostname, 'icims.com')) return 'icims';
  if (hostMatches(hostname, 'taleo.net')) return 'taleo';
  if (hostMatches(hostname, 'bamboohr.com')) return 'bamboohr';
  return 'unknown';
}

// ATS-specific field selectors
const FIELD_SELECTORS = {
  greenhouse: {
    firstName: ['#first_name', 'input[name="first_name"]', '[data-field="first_name"] input'],
    lastName: ['#last_name', 'input[name="last_name"]', '[data-field="last_name"] input'],
    email: ['#email', 'input[name="email"]', '[data-field="email"] input'],
    phone: ['#phone', 'input[name="phone"]', '[data-field="phone"] input'],
    resume: ['#resume', 'input[type="file"][name="resume"]', '[data-field="resume"] input[type="file"]'],
    coverLetter: ['#cover_letter', 'input[type="file"][name="cover_letter"]', '[data-field="cover_letter"] input[type="file"]'],
    linkedin: ['#linkedin', 'input[name="linkedin"]', '[data-field="linkedin"] input'],
    portfolio: ['#portfolio', 'input[name="portfolio"]', '[data-field="portfolio"] input'],
    submit: ['button[type="submit"]', 'input[type="submit"]', '.submit-button', 'button:has-text("Submit Application")'],
  },
  lever: {
    firstName: ['input[name="name"]', 'input[placeholder*="Name" i]'],
    email: ['input[name="email"]', 'input[placeholder*="Email" i]'],
    phone: ['input[name="phone"]', 'input[placeholder*="Phone" i]'],
    resume: ['input[type="file"][name="resume"]', 'input[type="file"][accept*="pdf"]'],
    coverLetter: ['textarea[name="coverLetter"]', 'textarea[placeholder*="Cover" i]'],
    linkedin: ['input[name="urls[LinkedIn]"]', 'input[placeholder*="LinkedIn" i]'],
    portfolio: ['input[name="urls[Portfolio]"]', 'input[placeholder*="Portfolio" i]'],
    submit: ['button[type="submit"]', '.postings-btn-primary', 'button:has-text("Submit Application")'],
  },
  workday: {
    firstName: ['input[name*="firstName"]', 'input[id*="firstName"]'],
    lastName: ['input[name*="lastName"]', 'input[id*="lastName"]'],
    email: ['input[name*="email"]', 'input[id*="email"]'],
    phone: ['input[name*="phone"]', 'input[id*="phone"]'],
    resume: ['input[type="file"][name*="resume"]', 'input[type="file"][id*="resume"]'],
    coverLetter: ['textarea[name*="coverLetter"]', 'textarea[id*="coverLetter"]'],
    linkedin: ['input[name*="linkedin"]', 'input[id*="linkedin"]'],
    submit: ['button[type="submit"]', 'button[data-automation-id="submitButton"]', 'button:has-text("Submit")'],
  },
  ashby: {
    firstName: ['input[name="firstName"]', 'input[placeholder*="First" i]'],
    lastName: ['input[name="lastName"]', 'input[placeholder*="Last" i]'],
    email: ['input[name="email"]', 'input[placeholder*="Email" i]'],
    phone: ['input[name="phone"]', 'input[placeholder*="Phone" i]'],
    resume: ['input[type="file"][name="resume"]', 'input[type="file"]'],
    coverLetter: ['textarea[name="coverLetter"]', 'textarea[placeholder*="Cover" i]'],
    linkedin: ['input[name="linkedin"]', 'input[placeholder*="LinkedIn" i]'],
    portfolio: ['input[name="portfolio"]', 'input[placeholder*="Portfolio" i]'],
    submit: ['button[type="submit"]', 'button:has-text("Submit Application")', 'button:has-text("Apply")'],
  },
  unknown: {
    firstName: ['input[name*="first" i]', 'input[placeholder*="First" i]', 'input[id*="first" i]'],
    lastName: ['input[name*="last" i]', 'input[placeholder*="Last" i]', 'input[id*="last" i]'],
    email: ['input[name*="email" i]', 'input[type="email"]', 'input[placeholder*="Email" i]'],
    phone: ['input[name*="phone" i]', 'input[placeholder*="Phone" i]', 'input[type="tel"]'],
    resume: ['input[type="file"][name*="resume" i]', 'input[type="file"][accept*="pdf"]', 'input[type="file"]'],
    coverLetter: ['textarea[name*="cover" i]', 'textarea[placeholder*="Cover" i]'],
    linkedin: ['input[name*="linkedin" i]', 'input[placeholder*="LinkedIn" i]'],
    portfolio: ['input[name*="portfolio" i]', 'input[placeholder*="Portfolio" i]'],
    submit: ['button[type="submit"]', 'input[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Apply")'],
  },
};

// Keyword hints per field, used to discover inputs via their <label> text
// (the existing selectors only match by name/placeholder/id, which misses
// most real forms — that's why it filled 0/8 fields).
const LABEL_KEYWORDS = {
  firstName: ['first name', 'firstname', 'given name', 'forename'],
  lastName: ['last name', 'lastname', 'family name', 'surname'],
  email: ['email', 'e-mail', 'mail'],
  phone: ['phone', 'mobile', 'telephone', 'tel'],
  resume: ['resume', 'cv', 'résumé'],
  coverLetter: ['cover letter', 'cover', 'motivation'],
  linkedin: ['linkedin'],
  portfolio: ['portfolio', 'portfolio url', 'website', 'personal site'],
};

// Find an input/textarea whose associated <label> text matches the keywords.
// Returns a CSS selector string (or null) so Playwright can act on it.
// Runs inside a given context (page or frame).
function labelSelectorIn(ctx, keywords) {
  return ctx.evaluate((kws) => {
    const kwsL = kws.map(k => k.toLowerCase());
    const labels = Array.from(document.querySelectorAll('label'));
    for (const lab of labels) {
      const t = (lab.textContent || '').toLowerCase();
      if (!kwsL.some(k => t.includes(k))) continue;
      let el = lab.htmlFor ? document.getElementById(lab.htmlFor) : null;
      if (!el) el = lab.querySelector('input, textarea, select');
      if (!el && lab.parentElement) el = lab.parentElement.querySelector('input, textarea, select');
      if (!el) {
        let s = lab.nextElementSibling;
        while (s && !el) { el = s.querySelector('input, textarea, select'); s = s.nextElementSibling; }
      }
      if (el) {
        if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
        if (el.name) return `[name="${el.name}"]`;
        if (el.placeholder) return `[placeholder="${el.placeholder}"]`;
      }
    }
    return null;
  }, keywords);
}

// Ashby (and some others) embed the apply form inside an <iframe>.
// Try the main page first, then every frame, until something matches.
async function runInContexts(page, fn) {
  const main = await fn(page).catch(() => null);
  if (main) return main;
  for (const frame of page.frames()) {
    const r = await fn(frame).catch(() => null);
    if (r) return r;
  }
  return null;
}

async function labelSelector(page, keywords) {
  return runInContexts(page, (ctx) => labelSelectorIn(ctx, keywords));
}

// Resolve an element handle across the main page and any iframes.
async function findInContexts(page, selector) {
  const main = await page.$(selector).catch(() => null);
  if (main) return main;
  for (const frame of page.frames()) {
    const el = await frame.$(selector).catch(() => null);
    if (el) return el;
  }
  return null;
}

async function fillField(page, fieldKey, selectors, value, fieldName) {
  const all = (selectors || []).slice();
  const ls = await labelSelector(page, LABEL_KEYWORDS[fieldKey] || [fieldName.toLowerCase()]);
  if (ls) all.push(ls);
  for (const selector of all) {
    try {
      const element = await findInContexts(page, selector);
      if (element) {
        const tagName = await element.evaluate(el => el.tagName.toLowerCase());
        const type = await element.getAttribute('type');
        
        if (type === 'file' && value) {
          await element.setInputFiles(value);
          console.log(`    ✓ ${fieldName}: uploaded`);
          return true;
        } else if (tagName === 'textarea' || tagName === 'input') {
          await element.fill(value);
          console.log(`    ✓ ${fieldName}: filled`);
          return true;
        }
      }
    } catch (e) {
      // Try next selector
    }
  }
  console.log(`    ⚠ ${fieldName}: no matching field found`);
  return false;
}

// Try to reach a real ATS apply form: many boards (remotive, jobicy, ...)
// only show an "Apply" button/link that redirects to Greenhouse/Lever/Ashby/Workday.
const ATS_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'workday.com', 'taleo.net', 'smartrecruiters.com', 'icims.com', 'boards.greenhouse.io'];
async function findAtsHref(page) {
  try {
    return await page.evaluate((hosts) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const isAts = (href) => { try { return hosts.some(d => new URL(href).hostname.toLowerCase().includes(d)); } catch { return false; } };
      // 1) direct ATS-host links
      for (const a of anchors) { if (isAts(a.href)) return a.href; }
      // 2) links whose text is an apply CTA (only if it points at an ATS host)
      for (const a of anchors) {
        const t = (a.textContent || '').toLowerCase().trim();
        const h = (a.href || '').toLowerCase();
        if (h.startsWith('http') && !h.includes('logout') && isAts(h) && (t === 'apply' || t.includes('apply now') || t.includes('apply for this'))) return a.href;
      }
      return null;
    }, ATS_HOSTS);
  } catch { return null; }
}
async function tryRedirectToAts(page) {
  try {
    const href = await findAtsHref(page);
    if (href && !href.includes('logout')) {
      const before = page.url();
      await page.goto(href, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2500);
      return page.url() !== before;
    }
    // Fallback: click a visible Apply CTA
    const applyLink = page.locator('a:has-text("Apply"), button:has-text("Apply"), a.apply, .apply-button');
    if (await applyLink.first().isVisible({ timeout: 2500 }).catch(() => false)) {
      const before = page.url();
      await applyLink.first().click();
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      return page.url() !== before;
    }
  } catch {}
  return false;
}

function splitName(candidate) {
  const parts = (candidate?.full_name || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

// CAPTCHA/bot-challenge DETECTION only — this never attempts to solve or
// bypass anything. If one is found, the caller stops before the submit
// click and the job gets flagged for the human to solve themselves.
const CHALLENGE_SELECTORS = [
  'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]', 'iframe[title*="challenge" i]',
  '.g-recaptcha', '#g-recaptcha-response', '[data-sitekey]',
  '.h-captcha', '[class*="cf-turnstile"]',
];
const CHALLENGE_TEXT_RE = /verify you are human|i.?m not a robot|security check|prove you.?re human/i;

async function detectChallenge(page) {
  const checkCtx = async (ctx) => {
    for (const sel of CHALLENGE_SELECTORS) {
      try { if (await ctx.$(sel)) return true; } catch {}
    }
    try {
      const text = await ctx.evaluate(() => document.body?.innerText || '');
      if (CHALLENGE_TEXT_RE.test(text)) return true;
    } catch {}
    return false;
  };
  if (await checkCtx(page)) return { detected: true, note: 'Challenge detected on the main page' };
  for (const frame of page.frames()) {
    if (await checkCtx(frame)) return { detected: true, note: 'Challenge detected in an embedded frame' };
  }
  return { detected: false, note: null };
}

async function applyToJob(page, url, candidate, cvPath, coverPath, autoSubmit = false) {
  // Defense in depth: the ONLY caller ever allowed to pass autoSubmit=true is
  // submit-application.mjs, which sets this env var on itself right before
  // calling in — and only after a human clicked Approve in the dashboard. Any
  // other caller hitting this (a future bug re-hardcoding `true` somewhere,
  // the exact class of bug that made every apply path here blind-submit
  // before this fix) crashes loudly instead of silently clicking Submit.
  if (autoSubmit && process.env.DAFE_SUBMIT_APPROVED !== '1') {
    throw new Error('applyToJob(autoSubmit=true) called outside the approved submit-application.mjs flow — refusing to click Submit.');
  }
  const ats = detectATS(url);
  console.log(`  [ATS: ${ats}] ${url}`);
  
  const fields = FIELD_SELECTORS[ats] || FIELD_SELECTORS.unknown;
  const name = splitName(candidate);
  
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Ashby/Greenhouse are SPAs — wait for form fields to actually render.
  await page.waitForSelector('input, textarea, iframe', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3500);
  
  // Handle cookie banners
  try {
    await page.click('button:has-text("Accept"), button:has-text("Allow"), button:has-text("OK"), [id*="cookie"] button', { timeout: 3000 });
  } catch {}
  
  // Fill form fields (with label-text discovery)
  const results = {
    firstName: await fillField(page, 'firstName', fields.firstName, name.first, 'First Name'),
    lastName: await fillField(page, 'lastName', fields.lastName, name.last, 'Last Name'),
    email: await fillField(page, 'email', fields.email, candidate.email || '', 'Email'),
    phone: await fillField(page, 'phone', fields.phone, candidate.phone || '', 'Phone'),
    resume: await fillField(page, 'resume', fields.resume, cvPath || '', 'Resume'),
    coverLetter: await fillField(page, 'coverLetter', fields.coverLetter, coverPath || '', 'Cover Letter'),
    linkedin: await fillField(page, 'linkedin', fields.linkedin, candidate.linkedin || '', 'LinkedIn'),
    portfolio: await fillField(page, 'portfolio', fields.portfolio, candidate.portfolio || '', 'Portfolio'),
  };
  
  let filledCount = Object.values(results).filter(Boolean).length;
  const totalFields = Object.keys(results).length;
  
  // If the page had no form, try clicking "Apply" to reach the real ATS form.
  if (filledCount < 3) {
    const redirected = await tryRedirectToAts(page);
    if (redirected) {
      console.log(`    ↳ Redirected to ATS form: ${page.url()}`);
       results.firstName = await fillField(page, 'firstName', fields.firstName, name.first, 'First Name');
       results.lastName = await fillField(page, 'lastName', fields.lastName, name.last, 'Last Name');
      results.email = await fillField(page, 'email', fields.email, candidate.email || '', 'Email');
      results.phone = await fillField(page, 'phone', fields.phone, candidate.phone || '', 'Phone');
      results.resume = await fillField(page, 'resume', fields.resume, cvPath || '', 'Resume');
      results.coverLetter = await fillField(page, 'coverLetter', fields.coverLetter, coverPath || '', 'Cover Letter');
      results.linkedin = await fillField(page, 'linkedin', fields.linkedin, candidate.linkedin || '', 'LinkedIn');
      results.portfolio = await fillField(page, 'portfolio', fields.portfolio, candidate.portfolio || '', 'Portfolio');
      filledCount = Object.values(results).filter(Boolean).length;
    }
  }
  
  console.log(`  Filled ${filledCount}/${totalFields} fields`);
  
  if (filledCount < 3) {
    return { success: false, reason: 'Too few fields filled - form may need manual handling', ats, filled: filledCount };
  }

  const challenge = await detectChallenge(page);
  if (challenge.detected) {
    console.log(`  ⚠ CAPTCHA/challenge detected — not solving it, not submitting. ${challenge.note}`);
    return { success: false, reason: 'CAPTCHA/challenge detected', ats, filled: filledCount, ready: true, needsManualSolve: true, captchaNote: challenge.note };
  }

  if (!autoSubmit) {
    console.log(`  ⏸ Form filled and staged. Approve it in the dashboard's Review Queue to submit.`);
    return { success: false, reason: 'Staged for review', ats, filled: filledCount, ready: true };
  }

  // Re-check immediately before the irreversible click — approval can land
  // well after staging, and a challenge can appear (or still be unsolved)
  // between fill time and click time.
  const preSubmitChallenge = await detectChallenge(page);
  if (preSubmitChallenge.detected) {
    console.log(`  ⚠ CAPTCHA/challenge present at submit time — not clicking Submit. ${preSubmitChallenge.note}`);
    return { success: false, reason: 'CAPTCHA/challenge detected', ats, filled: filledCount, ready: true, needsManualSolve: true, captchaNote: preSubmitChallenge.note };
  }

  // Auto-submit — only reached with autoSubmit=true, which the guard at the
  // top of this function already confirmed came from an approved click.
  for (const selector of fields.submit) {
    try {
      const btn = await findInContexts(page, selector);
      if (btn) {
        const isVisible = await btn.isVisible();
        const isEnabled = await btn.isEnabled();
        if (isVisible && isEnabled) {
          await btn.click();
          await page.waitForTimeout(3000);
          console.log(`  ✓ Submitted application`);
          return { success: true, reason: 'Application submitted', ats, filled: filledCount };
        }
      }
    } catch (e) {
      // Try next selector
    }
  }

  return { success: false, reason: 'Submit button not found', ats, filled: filledCount };
}

async function processPipeline(maxJobs = 10, filterATS = null) {
  const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
  const pending = [];
  
  for (const line of lines) {
    const m = line.match(/^- \[ \] (.+)$/);
    if (m) {
      const parts = m[1].split('|').map(s => s.trim());
      pending.push({ url: parts[0], company: parts[1], role: parts[2], location: parts[3], raw: line });
    }
  }
  
  // Fit-ranking: prefer higher-scored jobs first. Scores come from the
  // applications tracker (populated by the evaluate step). Unknowns sort last.
  const scoreMap = loadApplicationScores();
  pending.sort((a, b) => (scoreMap.get(b.company) || 0) - (scoreMap.get(a.company) || 0));

  // Skip off-fit jobs so we never waste submissions on roles that scored
  // below the user's threshold (quality over quantity).
  const threshold = (CANDIDATE.scoreThreshold) || 4.0;
  const filtered = pending.filter(j => {
    const s = scoreMap.get((j.company || '').toLowerCase());
    if (s === undefined) return true;       // un-evaluated: let it through to be scored
    return s >= threshold;
  });
  const belowThreshold = pending.length - filtered.length;

  const toProcess = filtered.slice(0, maxJobs);
  console.log(`\n🚀 Auto-Apply: Processing ${toProcess.length}/${pending.length} pending jobs (fit-ranked; ${belowThreshold} below ${threshold} skipped)\n`);
  
  const browser = await chromium.launch({ headless: true }); // Unattended / continuous-friendly
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const results = [];
  
  for (let i = 0; i < toProcess.length; i++) {
    const job = toProcess[i];
    const slug = (job.company + '-' + job.role).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    const cvPath = join(OUTPUT_DIR, `${slug}-cv.pdf`);
    const coverPath = join(OUTPUT_DIR, `${slug}-cover.pdf`);
    
    console.log(`\n[${i+1}/${toProcess.length}] ${job.company} — ${job.role}`);
    
    if (!existsSync(cvPath)) console.log(`  ⚠ CV not found: ${cvPath}`);
    if (!existsSync(coverPath)) console.log(`  ⚠ Cover letter not found: ${coverPath}`);
    
    const ats = detectATS(job.url);
    if (filterATS && ats !== filterATS) {
      console.log(`  ⏭ Skipping (ATS: ${ats}, filter: ${filterATS})`);
      results.push({ ...job, status: 'skipped', reason: `ATS filter: ${ats}` });
      continue;
    }
    
    try {
      const result = await applyToJob(page, job.url, CANDIDATE,
        existsSync(cvPath) ? cvPath : null,
        existsSync(coverPath) ? coverPath : null,
        false // this script only ever fills + stages; see submit-application.mjs
      );

      // Stage a successfully-filled form for human review — nothing here
      // ever submits. Applied status only ever gets set by submit-application.mjs.
      if (result.ready) {
        writeQueueEntry({
          company: job.company, role: job.role, url: job.url, ats: result.ats,
          fitScore: scoreMap.get((job.company || '').toLowerCase()) ?? null,
          cvPath: existsSync(cvPath) ? cvPath : null,
          coverPath: existsSync(coverPath) ? coverPath : null,
          filledCount: result.filled, totalFields: 8,
          needsManualSolve: !!result.needsManualSolve, captchaNote: result.captchaNote || null,
          source: 'auto-apply',
        });
      }

      results.push({ ...job, ...result, timestamp: new Date().toISOString() });
      
      // Log to file
      const logFile = join(LOG_DIR, `apply-${new Date().toISOString().slice(0,10)}.jsonl`);
      writeFileSync(logFile, JSON.stringify(results[results.length-1]) + '\n', { flag: 'a' });
      
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
      results.push({ ...job, status: 'error', reason: err.message, timestamp: new Date().toISOString() });
    }
    
    await page.waitForTimeout(3000);
  }
  
  await browser.close();
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('AUTO-APPLY SUMMARY');
  console.log('='.repeat(60));
  const ready = results.filter(r => r.ready && !r.needsManualSolve).length;
  const needsSolve = results.filter(r => r.needsManualSolve).length;
  const errors = results.filter(r => r.status === 'error').length;
  const skipped = results.filter(r => r.status === 'skipped').length;

  console.log(`  Staged for review: ${ready}`);
  console.log(`  Needs manual CAPTCHA solve: ${needsSolve}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  → Open the dashboard's Review Queue to approve and actually submit.`);
  
  return results;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      max: { type: 'string', short: 'm' },
      autoSubmit: { type: 'boolean' },
      url: { type: 'string' },
      provider: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  
  if (args.help) {
    console.log(`
Usage: node auto-apply.mjs [options]

Fills forms and stages them in the Review Queue. Never submits — approve a
staged entry in the dashboard to actually submit (see submit-application.mjs).

Options:
  --max N           Max jobs to process (default: 10)
  --url "..."       Apply to single URL instead of pipeline
  --provider ATS    Filter by ATS: greenhouse, lever, workday, ashby, etc.
  --help            Show this help

Examples:
  node auto-apply.mjs --max 20
  node auto-apply.mjs --url "https://company.greenhouse.io/jobs/123"
  node auto-apply.mjs --provider greenhouse --max 10
`);
    process.exit(0);
  }

  if (args.autoSubmit) {
    console.log('⚠ --auto-submit is ignored — applications are staged in the Review Queue and submitted only from the dashboard, after you approve them.\n');
  }

  const maxJobs = args.max ? parseInt(args.max, 10) : 10;

  if (args.url) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const result = await applyToJob(page, args.url, CANDIDATE, null, null, false);
    console.log('\nResult:', result);
    if (result.ready) {
      const job = { company: '(single URL)', role: '', url: args.url };
      writeQueueEntry({
        company: job.company, role: job.role, url: job.url, ats: result.ats,
        filledCount: result.filled, totalFields: 8,
        needsManualSolve: !!result.needsManualSolve, captchaNote: result.captchaNote || null,
        source: 'auto-apply-single-url',
      });
      console.log('Staged for review — open the dashboard Review Queue to approve.');
    }
    await browser.close();
  } else {
    await processPipeline(maxJobs, args.provider);
  }
}

// Only run the CLI when this file is executed directly — other scripts
// (autonomous-loop.mjs, submit-application.mjs) import applyToJob without
// wanting a full pipeline run to fire as a side effect of the import.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}

export { applyToJob };