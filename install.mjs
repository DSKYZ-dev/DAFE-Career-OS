#!/usr/bin/env node
/**
 * install.mjs — DAFE Career OS Interactive Installer & Setup Wizard
 * 
 * Installs dependencies, configures profile, sets up LLM providers,
 * creates desktop shortcuts, and validates the environment.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { parseArgs } from 'util';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(process.env.USERPROFILE || '', 'Desktop');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const ENV_PATH = join(ROOT, '.env');
const ENV_EXAMPLE = join(ROOT, '.env.example');

const BANNER = `
╔══════════════════════════════════════════════════════════════════╗
║                  DAFE CAREER OS INSTALLER                           ║
║         Automated Job Search & Application Platform             ║
╚══════════════════════════════════════════════════════════════════╝
`; 

let nonInteractive = false;

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function err(msg) { console.log(`  ❌ ${msg}`); }
function step(msg) { console.log(`\n🔧 ${msg}`); }

async function run(cmd, args = [], opts = {}) {
  try {
    const result = spawnSync(cmd, args, { cwd: ROOT, shell: true, encoding: 'utf-8', ...opts });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } catch (e) {
    return { code: 1, stdout: '', stderr: e.message };
  }
}

async function checkNode() {
  step('Checking Node.js...');
  const { code, stdout } = await run('node', ['--version']);
  if (code === 0) { ok(`Node.js ${stdout.trim()}`); return true; }
  err('Node.js not found. Please install from nodejs.org');
  return false;
}

async function checkPlaywright() {
  step('Checking Playwright...');
  try {
    const { chromium } = await import('playwright');
    ok('Playwright installed');
    // Install browsers if needed
    const browsers = ['chromium'];
    for (const b of browsers) {
      try { await import(`playwright/${b}`); } catch { 
        log(`Installing ${b} browser...`);
        await run('npx', ['playwright', 'install', b]);
      }
    }
    return true;
  } catch {
    warn('Playwright not installed, will install with npm');
    return false;
  }
}

async function installDeps() {
  step('Installing npm dependencies...');
  const { code } = await run('npm', ['install', '--prefer-offline']);
  if (code === 0) { ok('Dependencies installed'); return true; }
  err('npm install failed');
  return false;
}

async function setupEnv(nonInteractive = false) {
  step('Setting up environment configuration...');
  
  let envContent = '';
  if (existsSync(ENV_PATH)) {
    envContent = readFileSync(ENV_PATH, 'utf-8');
    ok('.env exists');
  } else if (existsSync(ENV_EXAMPLE)) {
    envContent = readFileSync(ENV_EXAMPLE, 'utf-8');
    log('Created from .env.example');
  } else {
    envContent = `# DAFE Career OS Environment Variables\nGEMINI_API_KEY=\nOPENROUTER_API_KEY=\nOPENAI_API_KEY=\nANTHROPIC_API_KEY=\n`;
  }
  
  if (nonInteractive) {
    log('Non-interactive mode: skipping API key prompts');
    // Ensure required vars exist
    if (!envContent.includes('CLOUD_PROVIDER=')) envContent += `\nCLOUD_PROVIDER=gemini\n`;
    if (!envContent.includes('CLOUD_MODEL=')) envContent += `CLOUD_MODEL=gemini-1.5-flash\n`;
    if (!envContent.includes('OLLAMA_MODEL=')) envContent += `OLLAMA_MODEL=llama3:8b\n`;
    if (!envContent.includes('OLLAMA_BASE_URL=')) envContent += `OLLAMA_BASE_URL=http://127.0.0.1:11434\n`;
    writeFileSync(ENV_PATH, envContent.trim() + '\n');
    ok('.env configured (non-interactive)');
    return true;
  }
  
  // Interactive API key setup
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const ask = (q) => new Promise(r => rl.question(`  ${q}: `, r));
  
  console.log('\n  📋 API Key Configuration (press Enter to skip):');
  
  const keys = [
    { key: 'GEMINI_API_KEY', label: 'Gemini API Key (free at aistudio.google.com)', env: 'GEMINI_API_KEY=' },
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API Key (free at openrouter.ai)', env: 'OPENROUTER_API_KEY=' },
    { key: 'OPENAI_API_KEY', label: 'OpenAI API Key', env: 'OPENAI_API_KEY=' },
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API Key', env: 'ANTHROPIC_API_KEY=' },
  ];
  
  for (const k of keys) {
    const current = new RegExp(`${k.env}(.*)`).exec(envContent)?.[1]?.trim();
    if (current) { log(`${k.key}: already set`); continue; }
    const val = await ask(`${k.label}`);
    if (val) envContent = envContent.replace(k.env, `${k.env}${val}`);
  }
  
  rl.close();
  
  // LLM Provider selection
  console.log('\n  🤖 Default LLM Provider:');
  console.log('    1) Gemini (Google) - Free tier, fast');
  console.log('    2) OpenRouter - Many free models');
  console.log('    3) OpenAI - Paid, high quality');
  console.log('    4) Anthropic - Paid, high quality');
  console.log('    5) Local Ollama - Free, private');
  
  const choice = await new Promise(r => rl.question('  Select (1-5) [1]: ', r));
  const providers = { '1': 'gemini', '2': 'openrouter', '3': 'openai', '4': 'anthropic', '5': 'ollama' };
  const provider = providers[choice.trim()] || 'gemini';
  
  if (!envContent.includes('CLOUD_PROVIDER=')) {
    envContent += `\nCLOUD_PROVIDER=${provider}\n`;
  } else {
    envContent = envContent.replace(/CLOUD_PROVIDER=.*/, `CLOUD_PROVIDER=${provider}`);
  }
  
  // Model selection
  const models = {
    gemini: 'gemini-1.5-flash',
    openrouter: 'meta-llama/llama-3.1-8b-instruct:free',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-haiku-20240307',
    ollama: 'llama3:8b',
  };
  if (!envContent.includes('CLOUD_MODEL=')) {
    envContent += `CLOUD_MODEL=${models[provider]}\n`;
  } else {
    envContent = envContent.replace(/CLOUD_MODEL=.*/, `CLOUD_MODEL=${models[provider]}`);
  }
  
  writeFileSync(ENV_PATH, envContent.trim() + '\n');
  ok('.env configured');
  return true;
}

async function setupProfile() {
  step('Setting up candidate profile...');
  
  if (existsSync(PROFILE_PATH)) {
    ok('Profile exists, skipping');
    return true;
  }
  
  const example = join(ROOT, 'config', 'profile.example.yml');
  if (existsSync(example)) {
    copyFileSync(example, PROFILE_PATH);
    ok('Created from example');
  } else {
    // Create basic profile
    const profile = `candidate:
  full_name: "Your Name"
  email: "you@example.com"
  location: "Your City"
  timezone: "America/Chicago"
  target_roles:
    - "Customer Service"
    - "Data Entry"
    - "Administrative Assistant"
  salary_target:
    min: 35000
    max: 0
    currency: USD
  skills:
    - "Python"
    - "JavaScript"
    - "Customer Service"
    - "Data Processing"
  uniqueness: "Your unique value proposition here"
`;
    mkdirSync(dirname(PROFILE_PATH), { recursive: true });
    writeFileSync(PROFILE_PATH, profile);
    ok('Basic profile created');
  }
  
  // Interactive profile editing
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(`  ${q}: `, r));
  
  console.log('\n  👤 Quick Profile Setup (press Enter to keep current):');
  const profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8'));
  
  profile.candidate.full_name = await ask(`Full name [${profile.candidate.full_name}]`) || profile.candidate.full_name;
  profile.candidate.email = await ask(`Email [${profile.candidate.email}]`) || profile.candidate.email;
  profile.candidate.location = await ask(`Location [${profile.candidate.location}]`) || profile.candidate.location;
  profile.candidate.timezone = await ask(`Timezone [${profile.candidate.timezone}]`) || profile.candidate.timezone;
  
  const roles = await ask(`Target roles (comma-separated) [${profile.candidate.target_roles.join(', ')}]`);
  if (roles) profile.candidate.target_roles = roles.split(',').map(r => r.trim());
  
  const salary = await ask(`Min salary (annual USD) [${profile.candidate.salary_target.min}]`);
  if (salary) profile.candidate.salary_target.min = parseInt(salary, 10);
  
  const skills = await ask(`Skills (comma-separated) [${profile.candidate.skills.join(', ')}]`);
  if (skills) profile.candidate.skills = skills.split(',').map(s => s.trim());
  
  const unique = await ask(`Uniqueness/value prop [${profile.candidate.uniqueness}]`);
  if (unique) profile.candidate.uniqueness = unique;
  
  writeFileSync(PROFILE_PATH, yaml.dump(profile));
  rl.close();
  ok('Profile saved');
  return true;
}

async function setupOllama() {
  step('Checking Ollama (local LLM)...');
  const { code } = await run('ollama', ['--version']);
  if (code === 0) {
    ok('Ollama installed');
    // Check for models
    const { stdout } = await run('ollama', ['list']);
    if (!stdout.includes('llama3')) {
      log('Pulling llama3:8b model...');
      await run('ollama', ['pull', 'llama3:8b']);
    }
    return true;
  }
  warn('Ollama not installed (optional for local eval)');
  return false;
}

async function createDesktopShortcut() {
  step('Creating desktop shortcut...');
  
  if (!existsSync(DESKTOP)) {
    warn('Desktop folder not found');
    return;
  }
  
  const shortcutPath = join(DESKTOP, 'DAFE Career OS.lnk');
  const psScript = `
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut("${shortcutPath.replace(/\\/g, '\\\\')}")
    $Shortcut.TargetPath = "node.exe"
    $Shortcut.Arguments = "${join(ROOT, 'dafe-career-os-launcher.mjs').replace(/\\/g, '\\\\')}"
    $Shortcut.WorkingDirectory = "${ROOT.replace(/\\/g, '\\\\')}"
    $Shortcut.IconLocation = "${join(ROOT, 'favicon.ico').replace(/\\/g, '\\\\')}"
    $Shortcut.Description = "DAFE Career OS Job Search Automation"
    $Shortcut.Save()
  `;
  
  try {
    await run('powershell', ['-Command', psScript]);
    ok('Desktop shortcut created');
  } catch {
    warn('Could not create shortcut (run as admin if needed)');
  }
}

async function cleanDesktopBats() {
  step('Cleaning up .bat files on Desktop...');
  
  if (!existsSync(DESKTOP)) return;
  
  const files = readdirSync(DESKTOP).filter(f => f.endsWith('.bat'));
  const keep = ['DAFE-Career-OS.bat', 'dafe-career-os.bat'];
  
  for (const f of files) {
    if (!keep.includes(f)) {
      try {
        // Move to dafe-career-os folder instead of deleting
        const dest = join(ROOT, 'archive', 'desktop-bats', f);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(DESKTOP, f), dest);
        // Actually delete
        // require('fs').unlinkSync(join(DESKTOP, f));
        log(`Archived: ${f} → archive/desktop-bats/`);
      } catch (e) {
        warn(`Could not archive ${f}: ${e.message}`);
      }
    }
  }
  ok('Desktop cleanup done');
}

async function runDoctor() {
  step('Running system health check...');
  await run('node', ['doctor.mjs', '--json']);
}

async function main() {
  const { values } = parseArgs({
    options: {
      quick: { type: 'boolean', short: 'q' },
      profile: { type: 'boolean' },
      llm: { type: 'boolean' },
      shortcut: { type: 'boolean' },
      doctor: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  
  if (values.help) {
    console.log(`
DAFE Career OS Installer & Setup Wizard

Usage: node install.mjs [options]

Options:
  --quick, -q     Quick install (deps only, no interactive setup)
  --profile       Only run profile configuration
  --llm           Only run LLM provider setup
  --shortcut      Only create desktop shortcut
  --doctor        Only run health check
  --yes, -y       Non-interactive mode (use existing config, skip prompts)
  --help          Show this help

Run without options for full interactive setup.
`); 
    process.exit(0);
  }
  
  const nonInteractive = values.yes || values.quick;
  console.log(BANNER);
  
  if (values.quick) {
    // Quick non-interactive install
    await checkNode();
    await installDependencies();
    await checkPlaywright();
    await setupDirectories();
    return;
  }
  
  if (values.profile) { await setupProfile(); return; }
  if (values.llm) { await setupLLM(); return; }
  if (values.shortcut) { await createDesktopShortcut(); return; }
  if (values.doctor) { await runDoctor(); return; }
  
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(`\n${q} (Y/n): `, r));
  
  const checks = [
    { name: 'Node.js', fn: checkNode, required: true },
    { name: 'Dependencies', fn: installDeps, required: true },
    { name: 'Playwright', fn: checkPlaywright, required: true },
    { name: 'Environment', fn: () => setupEnv(nonInteractive), required: true },
    { name: 'Profile', fn: setupProfile, required: true },
    { name: 'Ollama (optional)', fn: setupOllama, required: false },
    { name: 'Desktop Shortcut', fn: createDesktopShortcut, required: false },
    { name: 'Cleanup .bat files', fn: cleanDesktopBats, required: false },
    { name: 'Health Check', fn: runDoctor, required: false },
  ];
  
  for (const check of checks) {
    const shouldRun = check.required || nonInteractive || await ask(`Run ${check.name}?`);
    if (shouldRun) {
      try {
        await check.fn();
      } catch (e) {
        if (check.required) throw e;
        warn(`${check.name} failed: ${e.message}`);
      }
    }
  }
  
  rl.close();
  
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    INSTALLATION COMPLETE                        ║
╚══════════════════════════════════════════════════════════════════╝

🚀 DAFE Career OS is ready!

Quick start:
  • Double-click "DAFE Career OS" on your Desktop
  • Or run: node dafe-career-os-launcher.mjs
  • Or run pipeline directly: node auto-pipeline.mjs --max 20

Key commands:
  node auto-pipeline.mjs --max 20      # Full automated pipeline
  node interview-prep.mjs --company "X" --role "Y"  # Interview prep
  node auto-apply.mjs --max 10         # Auto-apply to jobs
  node apply-assist.mjs                # Manual apply dashboard
  node dafe-career-os-launcher.mjs         # Interactive menu

Files created:
  • config/profile.yml — Your candidate profile
  • .env — API keys and LLM settings
  • Desktop/DAFE Career OS.lnk — Launcher shortcut

Logs & outputs:
  • reports/ — Evaluation reports
  • output/ — CVs, cover letters, HTML reports
  • logs/ — Application logs
  • interview-prep/ — Interview preparation materials
`);
}

main().catch(e => { console.error('\n❌ Installation failed:', e); process.exit(1); });