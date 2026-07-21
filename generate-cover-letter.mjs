#!/usr/bin/env node
/**
 * generate-cover-letter.mjs — Renders a cover letter payload to PDF.
 *
 * Usage:
 *   node generate-cover-letter.mjs --payload payload.json
 *   node generate-cover-letter.mjs --payload payload.json --out output/slug-cover.pdf
 *   node generate-cover-letter.mjs --tailor --company "Acme" --role "SWE" --jd-file jd.txt --cv-file cv.md --out out.pdf
 *
 * Fills templates/cover-letter-template.html with the payload, then renders
 * it to PDF via the same Playwright pipeline used for CVs (generate-pdf.mjs).
 *
 * `buildHtml` is exported as a pure function so the template can be tested
 * without loading Playwright (renderHtmlToPdf is imported lazily inside main).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve, basename, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { parseArgs } from "util";
import { execFileSync } from "child_process";

const OUTPUT_ROOT = resolve("output");
const ROOT = dirname(fileURLToPath(import.meta.url));

function safeOutputPath(raw) {
  const filename = basename(raw).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, "-");
  return join(OUTPUT_ROOT, filename);
}

function _require(obj, keys, context) {
  for (const key of keys) {
    if (!obj || typeof obj !== "object" || !(key in obj)) {
      throw new Error(`Missing required field: ${context}.${key}`);
    }
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asUrl(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function buildContactLine(candidate) {
  const parts = [];
  if (candidate.location) parts.push(escapeHtml(candidate.location));
  if (candidate.email) {
    const email = escapeHtml(candidate.email);
    parts.push(`<a href="mailto:${email}">${email}</a>`);
  }
  if (candidate.phone) parts.push(escapeHtml(candidate.phone));
  if (candidate.linkedin) {
    parts.push(`<a href="${escapeHtml(asUrl(candidate.linkedin))}">LinkedIn</a>`);
  }
  if (candidate.github) {
    const display = candidate.github.replace(/^https?:\/\//, "");
    parts.push(`<a href="${escapeHtml(asUrl(candidate.github))}">${escapeHtml(display)}</a>`);
  }
  return parts.join(" &nbsp;|&nbsp; ");
}

function buildCredentialsBlock(candidate) {
  const credentials = candidate.credentials || [];
  if (!credentials.length) return "";
  return `<div class="credentials">${credentials.map(escapeHtml).join(" &nbsp;|&nbsp; ")}</div>`;
}

function buildDateline(letter) {
  const parts = [letter.company, letter.city, letter.date].filter(Boolean).map(escapeHtml);
  return parts.join(" &nbsp;&nbsp; ");
}

function buildAchievementsBlock(achievements) {
  if (!achievements || !achievements.length) return "";
  const items = achievements.map(ach => {
    const lead = escapeHtml(ach.lead || "");
    const impact = escapeHtml(ach.impact || "");
    return `    <li><b>${lead},</b> ${impact}</li>`;
  }).join("\n");
  return `<ul class="achievements">\n${items}\n  </ul>`;
}

function buildFootnotesBlock(footnotes) {
  if (!footnotes || !footnotes.length) return "";
  const lines = footnotes.map(fn => {
    if (typeof fn === "object" && fn !== null) {
      const marker = escapeHtml(fn.marker || "");
      const text = escapeHtml(fn.text || "");
      const url = fn.url
        ? ` <a href="${escapeHtml(fn.url)}">${escapeHtml(fn.url)}</a>`
        : "";
      return `    <p>${marker} ${text}${url}</p>`;
    }
    return `    <p>${escapeHtml(fn)}</p>`;
  }).join("\n");
  return `<div class="footnotes">\n${lines}\n  </div>`;
}

export function buildHtml(payload) {
  _require(payload, ["candidate", "letter"], "payload");
  const candidate = payload.candidate;
  const letter = payload.letter;
  _require(candidate, ["name"], "candidate");
  _require(letter, ["role_title", "opening", "profile_intro"], "letter");

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(scriptDir, "templates", "cover-letter-template.html");
  let html = readFileSync(templatePath, "utf-8");

  const greetingBlock = letter.greeting ? `<p class="greeting">${escapeHtml(letter.greeting)}</p>` : "";
  const closingBlock = letter.closing ? `<p>${escapeHtml(letter.closing)}</p>` : "";
  const languageClosingBlock = letter.language_closing
    ? `<p class="language-closing">${escapeHtml(letter.language_closing)}</p>`
    : "";
  const problemsBlock = letter.problems_section ? `<p>${escapeHtml(letter.problems_section)}</p>` : "";

  const replacements = {
    "{{NAME}}": escapeHtml(candidate.name),
    "{{CONTACT_LINE}}": buildContactLine(candidate),
    "{{CREDENTIALS_BLOCK}}": buildCredentialsBlock(candidate),
    "{{ROLE_TITLE}}": escapeHtml(letter.role_title),
    "{{DATELINE}}": buildDateline(letter),
    "{{GREETING_BLOCK}}": greetingBlock,
    "{{OPENING}}": escapeHtml(letter.opening),
    "{{PROFILE_INTRO}}": escapeHtml(letter.profile_intro),
    "{{ACHIEVEMENTS_BLOCK}}": buildAchievementsBlock(letter.achievements),
    "{{PROBLEMS_BLOCK}}": problemsBlock,
    "{{CLOSING_BLOCK}}": closingBlock,
    "{{LANGUAGE_CLOSING_BLOCK}}": languageClosingBlock,
    "{{FOOTNOTES_BLOCK}}": buildFootnotesBlock(letter.footnotes),
  };

  return html.replace(/\{\{[A-Z_]+\}\}/g, (token) => replacements[token] ?? token);
}

// ── LLM-based Tailored Cover Letter Generation ─────────────────────────
async function generateTailoredCoverLetter(job, cvText, jdText) {
  const profilePath = join(ROOT, 'config', 'profile.yml');
  let profile = {};
  try { profile = require('js-yaml').load(readFileSync(profilePath, 'utf-8')); } catch {}
  const CANDIDATE = profile.candidate || {};

  const prompt = `Write a compelling, tailored cover letter for this specific job.

CANDIDATE PROFILE:
- Name: ${CANDIDATE.full_name || CANDIDATE.name || 'Candidate'}
- Current Role: ${CANDIDATE.current_role || CANDIDATE.title || 'Current Role'}
- Years Experience: ${CANDIDATE.years_experience || CANDIDATE.experience || 'Several'}
- Location: ${CANDIDATE.location || 'Remote'}
- Email: ${CANDIDATE.email || ''}
- LinkedIn: ${CANDIDATE.linkedin || ''}
- Portfolio: ${CANDIDATE.portfolio || ''}

CANDIDATE CV (source of truth - NEVER invent facts):
${cvText}

JOB DESCRIPTION:
${jdText}

COMPANY: ${job.company}
ROLE: ${job.role}

INSTRUCTIONS:
1. 3-4 paragraphs, professional but human tone, ~250-350 words total
2. Opening (1 paragraph): Specific hook referencing company mission/product + role title. Show genuine interest.
3. Body Paragraph 1 (1 paragraph): 2-3 concrete achievements from CV that DIRECTLY map to JD's top 3 requirements. Use exact metrics/tech from CV.
4. Body Paragraph 2 (1 paragraph): Demonstrate company knowledge (mission, values, recent news, tech stack) + culture fit. Connect candidate's working style to company.
5. Closing (1 paragraph): Clear call to action, availability, enthusiasm.
6. NEVER invent facts, metrics, technologies, or experiences not in CV.
7. Mirror JD's terminology for key skills/technologies.
8. If candidate has obvious gaps (domain, language, visa), briefly acknowledge + mitigation.

Return ONLY valid JSON (no markdown fences):
{
  "greeting": "Dear Hiring Manager,",
  "opening": "string",
  "profile_intro": "string",
  "achievements": [{"lead": "string", "impact": "string"}, {"lead": "string", "impact": "string"}],
  "closing": "string",
  "footnotes": ["References available upon request."]
}`;

  const jdPath = join(ROOT, 'jds', `cover-gen-${Date.now()}.txt`);
  mkdirSync(dirname(jdPath), { recursive: true });
  writeFileSync(jdPath, prompt, 'utf-8');
  
  try {
    const result = execFileSync('node', ['cloud-eval.mjs', '--file', jdPath], { 
      cwd: ROOT, 
      timeout: 120000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('No JSON in LLM response');
  } catch (e) {
    console.error(`Cover letter LLM generation failed: ${e.message}`);
    return null;
  } finally {
    try { require('fs').unlinkSync(jdPath); } catch {}
  }
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const { values: args } = parseArgs({
    options: {
      payload: { type: "string" },
      out:     { type: "string" },
      help:    { type: "boolean", short: "h" },
      // Tailored generation options
      tailor:       { type: "boolean" },
      company:      { type: "string" },
      role:         { type: "string" },
      "jd-file":    { type: "string" },
      "cv-file":    { type: "string" },
      url:          { type: "string" },
    },
    strict: false,
  });

  // Tailored generation mode
  if (args.tailor) {
    if (!args.company || !args.role || (!args["jd-file"] && !args.url)) {
      console.error(`
Usage (tailored):
  node generate-cover-letter.mjs --tailor --company "Acme" --role "SWE" --jd-file jd.txt --cv-file cv.md --out out.pdf
  node generate-cover-letter.mjs --tailor --company "Acme" --role "SWE" --url "https://..." --cv-file cv.md --out out.pdf

Required: --tailor, --company, --role, (--jd-file OR --url), --cv-file
Optional: --out
`);
      process.exit(1);
    }

    let jdText = '';
    if (args["jd-file"]) {
      if (!existsSync(args["jd-file"])) { console.error(`JD file not found: ${args["jd-file"]}`); process.exit(1); }
      jdText = readFileSync(args["jd-file"], 'utf-8');
    } else if (args.url) {
      // Fetch JD from URL using Playwright
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      try {
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        jdText = await page.evaluate(() => document.body.innerText.slice(0, 15000));
      } finally {
        await browser.close();
      }
    }

    if (!args["cv-file"] || !existsSync(args["cv-file"])) {
      console.error(`CV file not found: ${args["cv-file"]}`);
      process.exit(1);
    }
    const cvText = readFileSync(args["cv-file"], 'utf-8');

    const job = { company: args.company, role: args.role, url: args.url || '' };
    const coverPayload = await generateTailoredCoverLetter(job, cvText, jdText);
    
    if (!coverPayload) {
      console.error('Failed to generate tailored cover letter');
      process.exit(1);
    }

    // Build payload
    let profile = {};
    try { profile = require('js-yaml').load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8')); } catch {}
    const CANDIDATE = profile.candidate || {};

    const payload = {
      candidate: {
        name: CANDIDATE.full_name || CANDIDATE.name || 'Candidate',
        email: CANDIDATE.email,
        phone: CANDIDATE.phone,
        linkedin: CANDIDATE.linkedin,
        github: CANDIDATE.github,
        location: CANDIDATE.location,
        credentials: CANDIDATE.credentials || []
      },
      letter: {
        role_title: args.role,
        company: args.company,
        city: 'Remote',
        date: new Date().toISOString().slice(0, 10),
        ...coverPayload
      },
      output_path: args.out ? resolve(args.out) : safeOutputPath(`${args.company}-${args.role}-cover.pdf`)
    };

    if (!existsSync(OUTPUT_ROOT)) mkdirSync(OUTPUT_ROOT, { recursive: true });
    const { renderHtmlToPdf } = await import("./generate-pdf.mjs");
    const html = buildHtml(payload);
    await renderHtmlToPdf(html, resolve(payload.output_path), { format: "a4" });
    console.log(`\nTailored cover letter PDF: ${payload.output_path}`);
    process.exit(0);
  }

  // Standard payload mode
  if (args.help || !args.payload) {
    console.log(`
Usage:
  node generate-cover-letter.mjs --payload payload.json [--out output/path.pdf]

  --payload   Path to the JSON payload file (required)
  --out       Override output path from payload (optional)

Tailored Generation (NEW):
  node generate-cover-letter.mjs --tailor --company "Acme" --role "SWE" --jd-file jd.txt --cv-file cv.md [--out out.pdf]
  node generate-cover-letter.mjs --tailor --company "Acme" --role "SWE" --url "https://..." --cv-file cv.md [--out out.pdf]

  --tailor        Enable LLM-based tailored generation
  --company       Company name
  --role          Role title
  --jd-file       Path to job description text file
  --url           OR job URL (will fetch JD via Playwright)
  --cv-file       Path to candidate CV markdown
  --out           Output PDF path
`);
    process.exit(args.help ? 0 : 1);
  }

  const payloadPath = resolve(args.payload);
  if (!existsSync(payloadPath)) {
    console.error(`ERROR: payload file not found: ${payloadPath}`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(payloadPath, "utf-8"));

  if (args.out) {
    payload.output_path = args.out;
  }

  if (!payload.output_path) {
    const company = (payload.letter?.company || "company").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const role    = (payload.letter?.role_title || "role").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
    payload.output_path = join(OUTPUT_ROOT, `${company}-${role}-cover.pdf`);
  } else {
    payload.output_path = safeOutputPath(payload.output_path);
  }

  if (!existsSync(OUTPUT_ROOT)) mkdirSync(OUTPUT_ROOT, { recursive: true });

  const { renderHtmlToPdf } = await import("./generate-pdf.mjs");

  try {
    const html = buildHtml(payload);
    const outputPath = resolve(payload.output_path);
    await renderHtmlToPdf(html, outputPath, { format: "a4" });
    console.log(`\nCover letter PDF: ${payload.output_path}`);
  } catch (err) {
    console.error("ERROR generating cover letter PDF:");
    console.error(err.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();