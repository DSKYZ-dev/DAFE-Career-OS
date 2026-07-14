#!/usr/bin/env node
/**
 * dafe-career-os-launcher.mjs — Unified Desktop Launcher
 * 
 * Interactive menu to run all dafe-career-os operations from one place.
 */

import { execFileSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import yaml from 'js-yaml';
import { getActiveProfile } from './profile-helper.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const MENU = `
╔══════════════════════════════════════════════════════════════════╗
║                    DAFE CAREER OS LAUNCHER                          ║
║              Automated Job Search & Application                 ║
╠══════════════════════════════════════════════════════════════════╣
║  SCAN & DISCOVER                                                ║
║  1) Full Pipeline  — Scan → Evaluate → PDFs → Apply            ║
║  2) Quick Scan      — Job boards + web search only             ║
║  3) Web Search Only — Indeed/LinkedIn via Gemini               ║
║                                                                 ║
║  EVALUATE & PREPARE                                             ║
║  4) Evaluate Job    — Analyze single JD (cloud LLM)            ║
║  5) Interview Prep  — Generate prep materials for role         ║
║  6) Local Eval      — Ollama local evaluation                  ║
║                                                                 ║
║  DOCUMENTS & APPLY                                              ║
║  7) Generate CV     — Tailored CV PDF                          ║
║  8) Cover Letter    — Tailored cover letter PDF                ║
║  9) Auto Apply      — Fill & submit applications (Playwright)  ║
║  10) Apply Assist   — Dashboard to review & apply manually     ║
║                                                                 ║
║  REPORTS & TRACKING                                             ║
║  11) Pipeline Report — Printable HTML summary                  ║
║  12) Apply Report    — Applications summary                    ║
║  13) View Tracker    — Open applications.md                    ║
║                                                                 ║
║  SETUP                                                          ║
║  14) Configure       — Run interactive setup wizard            ║
║  15) Doctor          — Check system health                     ║
║                                                                 ║
║  0) Exit                                                         ║
╚══════════════════════════════════════════════════════════════════╝
`;

async function runScript(script, args = [], options = {}) {
  console.log(`\n▶ Running: node ${script} ${args.join(' ')}\n`);
  try {
    const child = spawn('node', [script, ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
      ...options,
    });
    return new Promise((resolve) => child.on('close', resolve));
  } catch (e) {
    console.error(`Error running ${script}:`, e.message);
  }
}

async function fullPipeline() {
  const { values } = parseArgs({
    options: { max: { type: 'string', short: 'm' }, autoSubmit: { type: 'boolean' } },
    strict: false,
  });
  const max = values.max ? parseInt(values.max, 10) : 20;
  const auto = values.autoSubmit ? '--auto-submit' : '';
  await runScript('auto-pipeline.mjs', ['--max', String(max)]);
  if (auto) await runScript('auto-apply.mjs', ['--max', String(max), '--auto-submit']);
}

async function quickScan() {
  await runScript('scan.mjs');
}

async function webSearch() {
  await runScript('web-search.mjs');
}

async function evaluateJob() {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const jd = await new Promise(r => rl.question('\nPaste job description or URL: ', r));
  rl.close();
  if (jd.startsWith('http')) {
    await runScript('cloud-eval.mjs', ['--url', jd]);
  } else {
    await runScript('cloud-eval.mjs', [jd]);
  }
}

async function interviewPrep() {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const company = await new Promise(r => rl.question('\nCompany name: ', r));
  const role = await new Promise(r => rl.question('Role title: ', r));
  const url = await new Promise(r => rl.question('Job URL (optional): ', r));
  const location = await new Promise(r => rl.question('Location (optional): ', r));
  rl.close();
  
  await runScript('interview-prep.mjs', ['--company', company, '--role', role, '--url', url, '--location', location]);
}

async function localEval() {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const jd = await new Promise(r => rl.question('\nPaste job description: ', r));
  rl.close();
  await runScript('ollama-eval.mjs', [jd]);
}

async function generateCV() {
  await runScript('generate-cv.mjs', ['--profile', getActiveProfile()]);
}

async function coverLetter() {
  await runScript('generate-cover-letter.mjs', ['--help']);
}

async function autoApply() {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const max = await new Promise(r => rl.question('\nMax applications (default 10): ', r));
  const auto = await new Promise(r => rl.question('Auto-submit? (y/N): ', r));
  rl.close();
  await runScript('auto-apply.mjs', ['--max', max || '10', auto.toLowerCase() === 'y' ? '--auto-submit' : '']);
}

async function applyAssist() {
  await runScript('apply-assist.mjs');
}

async function pipelineReport() {
  await runScript('generate-apply-report.mjs');
}

async function applyReport() {
  await runScript('generate-apply-report.mjs');
}

async function viewTracker() {
  const { execSync } = await import('child_process');
  try { execSync(`start "" "${join(ROOT, 'data', 'applications.md')}"`, { shell: true }); } catch {}
}

async function configure() {
  await runScript('install.mjs');
}

async function doctor() {
  await runScript('doctor.mjs', ['--json']);
}

async function main() {
  const { values } = parseArgs({
    options: { cmd: { type: 'string' }, max: { type: 'string' }, auto: { type: 'boolean' } },
    strict: false,
  });

  // Direct command mode
  if (values.cmd) {
    const commands = {
      'pipeline': () => fullPipeline(),
      'scan': () => quickScan(),
      'web': () => webSearch(),
      'eval': () => evaluateJob(),
      'prep': () => interviewPrep(),
      'local-eval': () => localEval(),
      'cv': () => generateCV(),
      'cover': () => coverLetter(),
      'apply': () => autoApply(),
      'assist': () => applyAssist(),
      'report': () => pipelineReport(),
      'tracker': () => viewTracker(),
      'config': () => configure(),
      'doctor': () => doctor(),
    };
    if (commands[values.cmd]) return commands[values.cmd]();
    console.error(`Unknown command: ${values.cmd}`);
    process.exit(1);
  }

  // Interactive menu
  console.log(MENU);
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const choice = await new Promise(r => rl.question('Select option: ', r));
  rl.close();

  const actions = {
    '1': fullPipeline,
    '2': quickScan,
    '3': webSearch,
    '4': evaluateJob,
    '5': interviewPrep,
    '6': localEval,
    '7': generateCV,
    '8': coverLetter,
    '9': autoApply,
    '10': applyAssist,
    '11': pipelineReport,
    '12': applyReport,
    '13': viewTracker,
    '14': configure,
    '15': doctor,
    '0': () => process.exit(0),
  };

  if (actions[choice]) await actions[choice]();
  else console.log('Invalid option');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });