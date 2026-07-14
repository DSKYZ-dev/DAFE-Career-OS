#!/usr/bin/env node
/**
 * cloud-eval.mjs — Cloud-based Job Offer Evaluator for dafe-career-os
 * Supports: OpenRouter, OpenAI, Anthropic, Gemini
 * 
 * Usage:
 *   node cloud-eval.mjs --file ./jds/job.txt
 *   node cloud-eval.mjs --provider openrouter --model meta-llama/llama-3.1-8b-instruct:free "JD text"
 * 
 * Set API keys in .env:
 *   OPENROUTER_API_KEY=sk-or-...
 *   OPENAI_API_KEY=sk-...
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   GEMINI_API_KEY=...
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

try {
  const { config } = await import('dotenv');
  config();
} catch {}

const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  shared:  join(ROOT, 'modes', '_shared.md'),
  oferta:  join(ROOT, 'modes', 'oferta.md'),
  cv:      join(ROOT, 'cv.md'),
  reports: join(ROOT, 'reports'),
};

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║         dafe-career-os — Cloud Evaluator (OpenRouter/OpenAI/etc)   ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using cloud LLMs.

  USAGE
    node cloud-eval.mjs "<JD text>"
    node cloud-eval.mjs --file ./jds/my-job.txt
    node cloud-eval.mjs --provider openrouter --model meta-llama/llama-3.1-8b-instruct:free "JD text"

  OPTIONS
    --file <path>     Read JD from file
    --provider <name> Provider: openrouter | openai | anthropic | gemini (default: openrouter)
    --model <name>    Model name (provider-specific)
    --no-save         Do not save report

  PROVIDER SETUP (add to .env)
    OPENROUTER_API_KEY=sk-or-...   # openrouter.ai — many free models
    OPENAI_API_KEY=sk-...          # platform.openai.com
    ANTHROPIC_API_KEY=sk-ant-...   # console.anthropic.com
    GEMINI_API_KEY=...             # aistudio.google.com

  RECOMMENDED FREE MODELS (OpenRouter):
    meta-llama/llama-3.1-8b-instruct:free
    google/gemma-2-9b-it:free
    microsoft/phi-3-mini-128k-instruct:free
    mistralai/mistral-7b-instruct:free

  EXAMPLES
    node cloud-eval.mjs "We are looking for a Senior AI Engineer..."
    node cloud-eval.mjs --file ./jds/openai-swe.txt
    OPENROUTER_API_KEY=xxx node cloud-eval.mjs --model openai/gpt-4o-mini --file ./jds/job.txt
`);
  process.exit(0);
}

// Parse flags
let jdText    = '';
let provider  = process.env.CLOUD_PROVIDER || 'openrouter';
let modelName = process.env.CLOUD_MODEL;
let saveReport = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) { console.error(`❌  File not found: ${filePath}`); process.exit(1); }
    jdText = readFileSync(filePath, 'utf-8').trim();
  } else if (args[i] === '--provider' && args[i + 1]) {
    provider = args[++i].toLowerCase();
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) { console.error('❌  No Job Description provided.'); process.exit(1); }

// Default models per provider
const DEFAULT_MODELS = {
  openrouter: 'meta-llama/llama-3.1-8b-instruct:free',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
  gemini: 'gemini-1.5-flash',
};

// Premium models (require payment)
// openrouter: 'nvidia/nemotron-3-ultra'  // 550B params, ~$5-10/1M tokens
// openrouter: 'openai/gpt-4o'           // ~$5/1M input, $15/1M output
// openrouter: 'anthropic/claude-3.5-sonnet'  // ~$3/1M input, $15/1M output
modelName = modelName || DEFAULT_MODELS[provider];

// API Keys
const API_KEYS = {
  openrouter: process.env.OPENROUTER_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
};

const apiKey = API_KEYS[provider];
if (!apiKey) {
  console.error(`❌  No API key for ${provider}. Set ${provider.toUpperCase()}_API_KEY in .env`);
  process.exit(1);
}

// Load context files
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found: ${path}`);
    return `[${label} not found]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

const sharedMd  = readFile(PATHS.shared, 'modes/_shared.md');
const ofertaMd  = readFile(PATHS.oferta, 'modes/oferta.md');
const cvMd      = readFile(PATHS.cv, 'cv.md');
const profileYml = readFile(join(ROOT, 'config', 'profile.yml'), 'config/profile.yml');

const systemPrompt = `${sharedMd}\n\n${ofertaMd}`;

const userPrompt = `CANDIDATE PROFILE:
${profileYml}

CANDIDATE RESUME:
${cvMd}

JOB DESCRIPTION:
${jdText}

Evaluate using the A-G framework. Output JSON FIRST exactly like this (use numbers, not strings for score):

\`\`\`json
{
  "score": 3.5,
  "scores": {
    "role": 7,
    "compensation": 5,
    "growth": 6,
    "company": 8,
    "location": 7,
    "fit": 6,
    "legitimacy": 8
  },
  "recommendation": "Apply",
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "weaknesses": ["weakness 1", "weakness 2"],
  "tldr": "One line summary of the evaluation"
}
\`\`\`

Then after the JSON, write the full markdown report with sections A-G.`;

async function callProvider() {
  const basePrompts = { system: systemPrompt, user: userPrompt };
  
  switch (provider) {
    case 'openrouter': {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/santifer/DAFE Career OS',
          'X-Title': 'dafe-career-os',
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: basePrompts.system },
            { role: 'user', content: basePrompts.user },
          ],
          temperature: 0.3,
        }),
      });
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices[0].message.content;
    }
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: basePrompts.system },
            { role: 'user', content: basePrompts.user },
          ],
          temperature: 0.3,
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices[0].message.content;
    }
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: 8000,
          system: basePrompts.system,
          messages: [{ role: 'user', content: basePrompts.user }],
          temperature: 0.3,
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.content[0].text;
    }
    case 'gemini': {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(`${basePrompts.system}\n\n${basePrompts.user}`);
      return result.response.text();
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function main() {
  console.log(`☁️  Evaluating with ${provider} (${modelName})...`);
  
  let report;
  try {
    report = await callProvider();
  } catch (err) {
    console.error(`❌  Evaluation failed: ${err.message}`);
    process.exit(1);
  }

  // Save report
  if (saveReport) {
    mkdirSync(PATHS.reports, { recursive: true });
    const files = readdirSync(PATHS.reports).filter(f => f.match(/^\d+-/));
    const nums = files.map(f => parseInt(f.match(/^(\d+)-/)?.[1] || '0')).filter(n => !isNaN(n));
    const nextNum = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${nextNum}-cloud-${date}.md`;
    writeFileSync(join(PATHS.reports, filename), report, 'utf-8');
    console.log(`✅  Report saved: reports/${filename}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(report);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });