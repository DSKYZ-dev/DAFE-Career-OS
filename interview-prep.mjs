#!/usr/bin/env node
/**
 * interview-prep.mjs — Interview Preparation Generator
 * 
 * Creates comprehensive, printable interview prep materials for a specific role.
 * Includes: company research, STAR stories, technical/behavioral questions, 
 * salary negotiation, questions to ask, and cheat sheets.
 * 
 * Usage:
 *   node interview-prep.mjs --company "Acme Corp" --role "Software Engineer" --url "https://..."
 *   node interview-prep.mjs --file ./reports/042-acme-corp-2026-01-15.md
 *   node interview-prep.mjs --pipeline 5
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { chromium } from 'playwright';
import { callLLM } from './llm-helper.mjs';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(ROOT, 'reports');
const OUTPUT_DIR = join(ROOT, 'output');
const INTERVIEW_DIR = join(OUTPUT_DIR, 'interview-prep');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const CV_PATH = join(ROOT, 'cv.md');
const STORY_BANK = join(ROOT, 'interview-prep', 'story-bank.md');

mkdirSync(INTERVIEW_DIR, { recursive: true });
mkdirSync(dirname(STORY_BANK), { recursive: true });

// Load profile and CV
const profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8'));
const CANDIDATE = profile.candidate || {};
const CV_TEXT = readFileSync(CV_PATH, 'utf-8').slice(0, 8000);

try {
  const { config } = await import('dotenv');
  config();
} catch {}



function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** http(s)-only URL for use in href="..." — anything else (javascript:, data:, etc.) renders as "#". */
function safeUrl(u) {
  try {
    const parsed = new URL(String(u ?? ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '#';
  } catch {
    return '#';
  }
}
function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60); }

async function researchCompany(company, url) {
  console.log(`  🔍 Researching ${company}...`);
  
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const research = { company, website: '', about: '', values: '', news: [], tech: [], size: '', locations: [] };
    
    // Try company website
    const searchUrls = [
      `https://www.google.com/search?q=${encodeURIComponent(company + ' about us')}`,
      `https://www.google.com/search?q=${encodeURIComponent(company + ' mission values')}`,
      `https://www.google.com/search?q=${encodeURIComponent(company + ' technology stack')}`,
      `https://www.google.com/search?q=${encodeURIComponent(company + ' news 2024')}`,
    ];
    
    for (const searchUrl of searchUrls) {
      try {
        await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(1000);
        const text = await page.evaluate(() => document.body.innerText);
        // Extract snippets (simplified)
        if (text.includes('mission') || text.includes('values')) research.values += text.slice(0, 2000) + '\n';
        if (text.includes('stack') || text.includes('technolog')) research.tech += text.slice(0, 2000) + '\n';
        if (text.includes('employee') || text.includes('headcount') || text.includes('team of')) research.size += text.slice(0, 1000) + '\n';
      } catch {}
    }
    
    // If job URL provided, try to get company page
    if (url) {
      try {
        const jobPage = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
        // Try to find company link
        const companyLink = await page.$('a[href*="about"], a[href*="company"], a[href*="careers"]');
        if (companyLink) {
          const href = await companyLink.getAttribute('href');
          if (href) {
            await page.goto(href.startsWith('http') ? href : new URL(href, url).href, { waitUntil: 'networkidle', timeout: 15000 });
            const text = await page.evaluate(() => document.body.innerText);
            research.about = text.slice(0, 5000);
          }
        }
      } catch {}
    }
    
    return research;
  } finally {
    await browser.close();
  }
}

async function generatePrepWithLLM(jobData, research) {
  const prompt = `You are an expert interview coach preparing a candidate for a specific role.

CANDIDATE PROFILE:
${JSON.stringify(CANDIDATE, null, 2)}

CANDIDATE RESUME:
${CV_TEXT}

JOB DETAILS:
Company: ${jobData.company}
Role: ${jobData.role}
Location: ${jobData.location}
URL: ${jobData.url}
Description: ${jobData.description || 'Not provided'}

COMPANY RESEARCH:
${JSON.stringify(research, null, 2)}

Generate a COMPREHENSIVE interview preparation guide in the following JSON format:

{
  "companyOverview": {
    "summary": "2-3 paragraph company overview",
    "mission": "Company mission statement",
    "values": ["value1", "value2", "value3"],
    "recentNews": ["news item 1", "news item 2"],
    "techStack": ["tech1", "tech2", "tech3"],
    "size": "Company size/funding stage",
    "competitors": ["comp1", "comp2"],
    "culture": "Culture description from Glassdoor/reviews"
  },
  "roleAnalysis": {
    "keyResponsibilities": ["resp1", "resp2", "resp3"],
    "requiredSkills": ["skill1", "skill2"],
    "preferredSkills": ["skill1", "skill2"],
    "dayInLife": "What a typical day looks like",
    "challenges": ["challenge1", "challenge2"],
    "successMetrics": "How success is measured in this role"
  },
  "starStories": [
    {
      "situation": "Context",
      "task": "What you needed to do",
      "action": "What you did (specific)",
      "result": "Quantified outcome",
      "relevantTo": ["skill/competency this demonstrates"],
      "tags": ["leadership", "technical", "problem-solving"]
    }
  ],
  "technicalQuestions": [
    {
      "question": "Question text",
      "category": "system-design|coding|domain|tools",
      "difficulty": "easy|medium|hard",
      "keyPoints": ["point1", "point2"],
      "sampleAnswer": "Brief answer outline"
    }
  ],
  "behavioralQuestions": [
    {
      "question": "Question text",
      "competency": "leadership|teamwork|conflict|failure|adaptability",
      "starHint": "Which STAR story to adapt",
      "keyPoints": ["point1", "point2"]
    }
  ],
  "questionsToAsk": [
    {
      "question": "Question to ask interviewer",
      "category": "role|team|company|growth|culture",
      "why": "What this reveals"
    }
  ],
  "salaryNegotiation": {
    "marketRange": "Researched range for role/location",
    "candidateValue": "Your unique value props",
    "talkingPoints": ["point1", "point2"],
    "counterOfferScript": "If they offer X, say Y"
  },
  "cheatSheet": {
    "elevatorPitch": "30-second intro",
    "keyStrengths": ["strength1", "strength2", "strength3"],
    "weaknessAddressed": "How to address your main gap",
    "companySpecificTalkingPoints": ["point1", "point2"],
    "redFlagsToWatch": ["flag1", "flag2"]
  }
}

IMPORTANT: 
- Generate 5-7 STAR stories from the candidate's actual experience
- Technical questions should match the role's seniority and domain
- Behavioral questions should cover all major competencies
- Salary data should be realistic for the location
- All content must be specific to THIS company and role, not generic`;

  return await callLLM(prompt, { taskType: 'reasoning', requireCapabilities: ['reasoning'], maxCost: 'paid' });
}

function parseLLMResponse(text) {
  try {
    // Extract JSON from markdown code block
    const match = text.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonStr = match ? match[1] : text;
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed to parse LLM response:', e.message);
    return null;
  }
}

function buildHTML(prep, jobData) {
  const date = new Date().toISOString().slice(0, 10);
  const fileSlug = `${slugify(jobData.company)}-${slugify(jobData.role)}-${date}`;
  
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><title>Interview Prep: ${esc(jobData.role)} at ${esc(jobData.company)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a2e; padding: 40px; max-width: 900px; margin: 0 auto; background: #fff; }
@media print { body { padding: 20px; } @page { margin: 15mm; } }
h1 { font-size: 2rem; color: #1a1a2e; border-bottom: 3px solid #0066cc; padding-bottom: 10px; margin-bottom: 8px; }
h2 { font-size: 1.4rem; color: #0066cc; margin: 30px 0 12px; border-left: 4px solid #0066cc; padding-left: 12px; }
h3 { font-size: 1.1rem; color: #333; margin: 20px 0 8px; }
h4 { font-size: 1rem; color: #555; margin: 12px 0 6px; }
.meta { color: #666; font-size: .9rem; margin-bottom: 24px; display: flex; gap: 24px; flex-wrap: wrap; }
.meta span { background: #f5f5f5; padding: 4px 12px; border-radius: 16px; }
.section { margin-bottom: 32px; }
.card { background: #fafafa; border: 1px solid #e8e8e8; border-radius: 8px; padding: 20px; margin: 12px 0; }
.card-title { font-weight: 600; color: #0066cc; margin-bottom: 8px; }
.star { background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 16px; margin: 12px 0; }
.star-label { font-size: .75rem; text-transform: uppercase; color: #888; font-weight: 600; margin-right: 8px; }
.star-s { color: #e67e22; } .star-t { color: #3498db; } .star-a { color: #27ae60; } .star-r { color: #8e44ad; }
.badge { display: inline-block; font-size: .7rem; padding: 2px 8px; border-radius: 12px; margin: 2px; background: #e8f4fd; color: #0066cc; }
.badge-hard { background: #fdeaea; color: #c0392b; }
.badge-medium { background: #fef5e7; color: #d68910; }
.badge-easy { background: #e8f8f5; color: #27ae60; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: .9rem; }
th, td { padding: 10px; border: 1px solid #e0e0e0; text-align: left; }
th { background: #f5f5f5; font-weight: 600; }
tr:nth-child(even) { background: #fafafa; }
ul { margin: 8px 0 8px 24px; }
li { margin: 4px 0; }
.print-btn { position: fixed; top: 20px; right: 20px; padding: 12px 24px; background: #0066cc; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; box-shadow: 0 4px 12px rgba(0,102,204,.3); }
@media print { .print-btn { display: none; } }
.footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #e0e0e0; color: #888; font-size: .85rem; text-align: center; }
</style></head><body>
<button class="print-btn" onclick="window.print()">🖨 Print / Save PDF</button>

<h1>Interview Preparation</h1>
<p class="meta">
  <span>${esc(jobData.role)}</span>
  <span>${esc(jobData.company)}</span>
  <span>${esc(jobData.location)}</span>
  <span>${date}</span>
</p>

${jobData.url ? `<p class="meta"><a href="${esc(safeUrl(jobData.url))}" target="_blank" style="color:#0066cc;">🔗 Job Posting</a></p>` : ''}

<!-- COMPANY OVERVIEW -->
<div class="section">
<h2>🏢 Company Overview</h2>
<div class="card"><strong>Summary:</strong> ${esc(prep.companyOverview?.summary || 'Not available')}</div>
<div class="card"><strong>Mission:</strong> ${esc(prep.companyOverview?.mission || 'Not available')}</div>
<div class="card"><strong>Values:</strong> ${(prep.companyOverview?.values || []).map(v => `<span class="badge">${esc(v)}</span>`).join(' ')}</div>
<div class="card"><strong>Culture:</strong> ${esc(prep.companyOverview?.culture || 'Not available')}</div>
<div class="card"><strong>Size/Stage:</strong> ${esc(prep.companyOverview?.size || 'Not available')}</div>
<div class="card"><strong>Tech Stack:</strong> ${(prep.companyOverview?.techStack || []).map(t => `<span class="badge">${esc(t)}</span>`).join(' ')}</div>
<div class="card"><strong>Competitors:</strong> ${(prep.companyOverview?.competitors || []).join(', ') || 'Not available'}</div>
</div>

<!-- ROLE ANALYSIS -->
<div class="section">
<h2>📋 Role Analysis</h2>
<div class="card"><strong>Key Responsibilities:</strong><ul>${(prep.roleAnalysis?.keyResponsibilities || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>
<div class="card"><strong>Required Skills:</strong> ${(prep.roleAnalysis?.requiredSkills || []).map(s => `<span class="badge">${esc(s)}</span>`).join(' ')}</div>
<div class="card"><strong>Preferred Skills:</strong> ${(prep.roleAnalysis?.preferredSkills || []).map(s => `<span class="badge">${esc(s)}</span>`).join(' ')}</div>
<div class="card"><strong>Typical Day:</strong> ${esc(prep.roleAnalysis?.dayInLife || 'Not available')}</div>
<div class="card"><strong>Key Challenges:</strong><ul>${(prep.roleAnalysis?.challenges || []).map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>
<div class="card"><strong>Success Metrics:</strong> ${esc(prep.roleAnalysis?.successMetrics || 'Not available')}</div>
</div>

<!-- STAR STORIES -->
<div class="section">
<h2>⭐ STAR Stories (${(prep.starStories || []).length} prepared)</h2>
${(prep.starStories || []).map((s, i) => `
<div class="star">
  <div><span class="star-label star-s">Situation:</span> ${esc(s.situation)}</div>
  <div style="margin-top:8px"><span class="star-label star-t">Task:</span> ${esc(s.task)}</div>
  <div style="margin-top:8px"><span class="star-label star-a">Action:</span> ${esc(s.action)}</div>
  <div style="margin-top:8px"><span class="star-label star-r">Result:</span> ${esc(s.result)}</div>
  <div style="margin-top:10px"><strong>Relevant to:</strong> ${(s.relevantTo || []).map(r => `<span class="badge">${esc(r)}</span>`).join(' ')}</div>
  <div style="margin-top:4px"><strong>Tags:</strong> ${(s.tags || []).map(t => `<span class="badge">${esc(t)}</span>`).join(' ')}</div>
</div>
`).join('')}
</div>

<!-- TECHNICAL QUESTIONS -->
<div class="section">
<h2>💻 Technical Questions (${(prep.technicalQuestions || []).length})</h2>
<table><thead><tr><th>Question</th><th>Category</th><th>Difficulty</th><th>Key Points</th></tr></thead>
<tbody>${(prep.technicalQuestions || []).map(q => `
<tr>
  <td>${esc(q.question)}</td>
  <td>${esc(q.category)}</td>
  <td><span class="badge badge-${q.difficulty}">${esc(q.difficulty)}</span></td>
  <td>${(q.keyPoints || []).join('; ')}</td>
</tr>
`).join('')}</tbody></table>
</div>

<!-- BEHAVIORAL QUESTIONS -->
<div class="section">
<h2>🗣 Behavioral Questions (${(prep.behavioralQuestions || []).length})</h2>
<table><thead><tr><th>Question</th><th>Competency</th><th>STAR Hint</th><th>Key Points</th></tr></thead>
<tbody>${(prep.behavioralQuestions || []).map(q => `
<tr>
  <td>${esc(q.question)}</td>
  <td>${esc(q.competency)}</td>
  <td>${esc(q.starHint || '')}</td>
  <td>${(q.keyPoints || []).join('; ')}</td>
</tr>
`).join('')}</tbody></table>
</div>

<!-- QUESTIONS TO ASK -->
<div class="section">
<h2>❓ Questions to Ask (${(prep.questionsToAsk || []).length})</h2>
<table><thead><tr><th>Question</th><th>Category</th><th>Why Ask This</th></tr></thead>
<tbody>${(prep.questionsToAsk || []).map(q => `
<tr>
  <td>${esc(q.question)}</td>
  <td>${esc(q.category)}</td>
  <td>${esc(q.why)}</td>
</tr>
`).join('')}</tbody></table>
</div>

<!-- SALARY NEGOTIATION -->
<div class="section">
<h2>💰 Salary Negotiation</h2>
<div class="card"><strong>Market Range:</strong> ${esc(prep.salaryNegotiation?.marketRange || 'Research needed')}</div>
<div class="card"><strong>Your Value Props:</strong><ul>${(prep.salaryNegotiation?.candidateValue || '').split('\n').filter(Boolean).map(v => `<li>${esc(v.trim())}</li>`).join('')}</ul></div>
<div class="card"><strong>Talking Points:</strong><ul>${(prep.salaryNegotiation?.talkingPoints || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>
<div class="card"><strong>Counter-Offer Script:</strong> ${esc(prep.salaryNegotiation?.counterOfferScript || 'Prepare based on offer')}</div>
</div>

<!-- CHEAT SHEET -->
<div class="section">
<h2>📝 Interview Cheat Sheet</h2>
<div class="card"><strong>Elevator Pitch (30s):</strong> ${esc(prep.cheatSheet?.elevatorPitch || 'Prepare your pitch')}</div>
<div class="card"><strong>Top 3 Strengths:</strong><ul>${(prep.cheatSheet?.keyStrengths || []).map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
<div class="card"><strong>Addressing Weakness:</strong> ${esc(prep.cheatSheet?.weaknessAddressed || 'Prepare honest but strategic answer')}</div>
<div class="card"><strong>Company-Specific Talking Points:</strong><ul>${(prep.cheatSheet?.companySpecificTalkingPoints || []).map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>
<div class="card"><strong>Red Flags to Watch:</strong><ul>${(prep.cheatSheet?.redFlagsToWatch || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>
</div>

<div class="footer">
Generated by dafe-career-os interview-prep • ${date} • ${esc(jobData.company)} - ${esc(jobData.role)}
</div>
</body></html>`;
}

async function saveStoryBank(stories) {
  const existing = existsSync(STORY_BANK) ? readFileSync(STORY_BANK, 'utf-8') : '';
  const newEntries = stories.map(s => `
### ${s.tags?.join(', ') || 'General'} — ${new Date().toISOString().slice(0,10)}

**Situation:** ${s.situation}

**Task:** ${s.task}

**Action:** ${s.action}

**Result:** ${s.result}

**Competencies:** ${s.relevantTo?.join(', ') || ''}

---
`).join('\n');
  
  writeFileSync(STORY_BANK, (existing + '\n' + newEntries).trim() + '\n');
  console.log(`  📚 Story bank updated: ${STORY_BANK}`);
}

async function generatePrep(jobData) {
  console.log(`\n📋 Generating interview prep for ${jobData.company} — ${jobData.role}`);
  
  // Research company
  const research = await researchCompany(jobData.company, jobData.url);
  
  // Generate with LLM
  const llmOutput = await generatePrepWithLLM(jobData, research);
  const prep = parseLLMResponse(llmOutput);
  
  if (!prep) {
    throw new Error('Failed to generate prep - LLM response parsing failed');
  }
  
  // Build HTML
  const html = buildHTML(prep, jobData);
  const fileSlug = `${slugify(jobData.company)}-${slugify(jobData.role)}-${new Date().toISOString().slice(0,10)}`;
  const htmlPath = join(INTERVIEW_DIR, `${fileSlug}.html`);
  const jsonPath = join(INTERVIEW_DIR, `${fileSlug}.json`);
  
  writeFileSync(htmlPath, html);
  writeFileSync(jsonPath, JSON.stringify(prep, null, 2));
  
  // Update story bank
  if (prep.starStories?.length) {
    await saveStoryBank(prep.starStories);
  }
  
  console.log(`  ✅ HTML: ${htmlPath}`);
  console.log(`  ✅ JSON: ${jsonPath}`);
  
  // Open in browser
  try {
    const { execSync } = await import('child_process');
    execSync(`start "" "${htmlPath}"`, { shell: true, timeout: 5000 });
  } catch {}
  
  return { htmlPath, jsonPath, prep };
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      company: { type: 'string' },
      role: { type: 'string' },
      url: { type: 'string' },
      location: { type: 'string' },
      file: { type: 'string' },
      pipeline: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  
  if (args.help || (!args.company && !args.file && !args.pipeline)) {
    console.log(`
Usage: node interview-prep.mjs [options]

Options:
  --company "Name"    Company name (required with --role)
  --role "Title"      Role title (required with --company)
  --url "..."         Job posting URL
  --location "..."    Job location
  --file path.md      Generate from existing evaluation report
  --pipeline N        Generate for N-th pending pipeline entry
  --help              Show this help

Examples:
  node interview-prep.mjs --company "Acme Corp" --role "Software Engineer" --url "https://..."
  node interview-prep.mjs --file reports/042-acme-corp-2026-01-15.md
  node interview-prep.mjs --pipeline 1
`);
    process.exit(args.help ? 0 : 1);
  }
  
  let jobData = null;
  
  if (args.file) {
    // Parse from evaluation report
    const content = readFileSync(args.file, 'utf-8');
    const urlMatch = content.match(/\*\*URL:\*\*\s*(.+)/);
    const companyMatch = content.match(/# Evaluation Report\s*\n\n\*\*URL:\*\*\s*.+?\n.*?\*\*Score:\*\*\s*([\d.]+)/s);
    // Simple extraction
    jobData = {
      company: 'Unknown',
      role: 'Unknown',
      url: urlMatch ? urlMatch[1].trim() : '',
      location: 'Remote',
      description: content.slice(0, 3000),
    };
  } else if (args.pipeline) {
    // Get from pipeline
    const lines = readFileSync(join(ROOT, 'data', 'pipeline.md'), 'utf-8').split('\n');
    const pending = lines.filter(l => l.match(/^- \[ \]/)).map(l => {
      const parts = l.replace('- [ ] ', '').split('|').map(s => s.trim());
      return { url: parts[0], company: parts[1], role: parts[2], location: parts[3] };
    });
    const idx = parseInt(args.pipeline, 10) - 1;
    if (pending[idx]) jobData = { ...pending[idx], description: '' };
  } else {
    jobData = {
      company: args.company,
      role: args.role,
      url: args.url || '',
      location: args.location || 'Remote',
      description: '',
    };
  }
  
  if (!jobData) {
    console.error('❌ Could not determine job data');
    process.exit(1);
  }
  
  await generatePrep(jobData);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });