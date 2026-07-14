const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const yaml = require('js-yaml');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = 3456;
const PROJECT_DIR = path.resolve(__dirname, '..');
const NPM_DIR = path.join(process.env.USERPROFILE || process.env.HOME, 'AppData', 'Roaming', 'npm');
const PATH_ENV = `${NPM_DIR};${process.env.PATH}`;
const MODEL_PREF_FILE = path.join(__dirname, 'model-preference.json');

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';");
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter for API endpoints
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < 60000);
  if (timestamps.length > 60) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  next();
}
app.use('/api/', rateLimit);

// Input validation helper
function validatePath(baseDir, userPath) {
  const resolved = path.resolve(baseDir, userPath);
  if (!resolved.startsWith(baseDir)) return null;
  return resolved;
}

// ── Helpers ──────────────────────────────────────────────────────────

function runNode(script, args = [], timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script, ...args], {
      cwd: PROJECT_DIR,
      env: { ...process.env, PATH: PATH_ENV, NODE_OPTIONS: '' },
      shell: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, timeout);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', reject);
  });
}

function getModelPref() {
  try { return JSON.parse(fs.readFileSync(MODEL_PREF_FILE, 'utf8')).model || ''; } catch { return ''; }
}

function runOpenCode(prompt, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const model = getModelPref();
    const args = model ? ['run', '--model', model, prompt] : ['run', prompt];
    const child = spawn('opencode', args, {
      cwd: PROJECT_DIR,
      env: { ...process.env, PATH: PATH_ENV },
      shell: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, timeout);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', reject);
  });
}

function safeRead(file) {
  try {
    return fs.readFileSync(path.join(PROJECT_DIR, file), 'utf8');
  } catch { return ''; }
}

function safeReadYaml(file) {
  try {
    return yaml.load(safeRead(file));
  } catch { return null; }
}

// ── API Routes ───────────────────────────────────────────────────────

// Health / status
app.get('/api/status', async (req, res) => {
  const result = await runNode('doctor.mjs', ['--json']);
  try {
    const status = JSON.parse(result.stdout);
    res.json(status);
  } catch {
    res.json({ error: 'Failed to parse doctor output', raw: result.stdout });
  }
});

// Dashboard stats (cached for 30s to avoid filesystem thrashing)
let statsCache = null;
let statsCacheTime = 0;
app.get('/api/stats', (req, res) => {
  const now = Date.now();
  if (statsCache && now - statsCacheTime < 30000) return res.json(statsCache);

  const tracker = safeRead('data/applications.md');
  const pipeline = safeRead('data/pipeline.md');
  let reports = 0, outputs = 0;
  try {
    reports = fs.readdirSync(path.join(PROJECT_DIR, 'reports')).filter(f => f.endsWith('.md')).length;
  } catch {}
  try {
    outputs = fs.readdirSync(path.join(PROJECT_DIR, 'output')).filter(f => f.endsWith('.pdf')).length;
  } catch {}
  const stories = safeRead('interview-prep/story-bank.md');

  const trackerLines = tracker.split('\n').filter(l => l.includes('|') && !l.includes('---') && !l.includes('#') && !l.includes('| # |'));
  const statuses = { Evaluated: 0, Applied: 0, Interview: 0, Offer: 0, Rejected: 0, Discarded: 0, SKIP: 0, Responded: 0 };
  trackerLines.forEach(l => {
    const cols = l.split('|').map(c => c.trim());
    const status = cols[5] || '';
    if (statuses[status] !== undefined) statuses[status]++;
  });

  const profile = safeReadYaml('config/profile.yml');
  const cvExists = fs.existsSync(path.join(PROJECT_DIR, 'cv.md'));
  const portals = safeReadYaml('portals.yml');

  statsCache = {
    evaluations: reports,
    pdfs: outputs,
    applications: trackerLines.length,
    statusDistribution: statuses,
    pipelineEntries: pipeline.split('\n').filter(l => l.includes('|') && !l.includes('---') && !l.includes('#')).length,
    storyBank: stories.length > 0,
    cvExists,
    profileReady: !!(profile && profile.candidate && profile.candidate.full_name),
    portalsConfigured: !!(portals && ((portals.tracked_companies && portals.tracked_companies.length > 0) || (portals.companies && portals.companies.length > 0))),
    companyCount: (portals?.tracked_companies?.length || portals?.companies?.length || 0),
  };
  statsCacheTime = now;
  res.json(statsCache);
});

// Profile
app.get('/api/profile', (req, res) => {
  const raw = safeRead('config/profile.yml');
  let profile = null;
  try { profile = parseYaml(raw); } catch {}
  const cv = safeRead('cv.md');
  res.json({ profile, raw, cv: cv.substring(0, 5000) });
});

app.post('/api/profile', (req, res) => {
  try {
    fs.writeFileSync(path.join(PROJECT_DIR, 'config', 'profile.yml'), req.body.yaml, 'utf8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cv', (req, res) => {
  try {
    fs.writeFileSync(path.join(PROJECT_DIR, 'cv.md'), req.body.cv, 'utf8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Profile Management ───────────────────────────────────────────
const PROFILES_DIR = path.join(PROJECT_DIR, 'profiles');
const ACTIVE_FILE = path.join(PROFILES_DIR, 'active.txt');
const FOCUSES_FILE = path.join(PROFILES_DIR, '_focuses.json');

function getActiveProfile() {
  try { return fs.readFileSync(ACTIVE_FILE, 'utf8').trim(); } catch { return 'Default'; }
}

function listProfiles() {
  const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
  const active = getActiveProfile();
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('_'))
    .map(e => ({
      name: e.name,
      active: e.name === active,
      hasCv: fs.existsSync(path.join(PROFILES_DIR, e.name, 'cv.md')),
    }));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// Load available focus definitions
function getFocusDefinitions() {
  return readJson(FOCUSES_FILE) || [];
}

// Get selected focus IDs for a profile
function getProfileFoci(profileName) {
  const file = path.join(PROFILES_DIR, profileName, 'foci.json');
  return readJson(file) || [];
}

// Regenerate portals.yml from a profile's foci + shared config
function rebuildPortalsYml(profileName) {
  const shared = readJson(path.join(PROFILES_DIR, profileName, 'shared.json'));
  if (!shared) throw new Error(`No shared config for profile "${profileName}"`);
  
  const focusIds = getProfileFoci(profileName);
  const allFocuses = getFocusDefinitions();
  const selected = allFocuses.filter(f => focusIds.includes(f.id));
  
  // Combine title filter positives from selected focuses
  const positive = [...new Set(selected.flatMap(f => f.titleFilter.positive))];
  const negative = shared.titleFilter?.negative || [];
  const seniorityBoost = shared.titleFilter?.seniority_boost || [];
  
  const titleFilter = { positive, negative };
  if (seniorityBoost.length) titleFilter.seniority_boost = seniorityBoost;
  
  // Combine search queries from selected focuses
  const searchQueries = selected.flatMap(f => f.searchQueries || []);
  
  // Build portals config
  const portals = {
    location: { ...(shared.location || { zipcode: '75254', radius: 50 }), remote_only: shared.remote_only === true },
    title_filter: titleFilter,
    location_filter: shared.location_filter || {},
    salary_filter: shared.salary_filter || { min: 35000, max: 0, currency: 'USD' },
    search_queries: searchQueries,
    tracked_companies: shared.tracked_companies || [],
    job_boards: shared.job_boards || [],
  };
  
  const yamlStr = yaml.dump(portals, { indent: 2, lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false });
  fs.writeFileSync(path.join(PROJECT_DIR, 'portals.yml'), yamlStr, 'utf8');
  return { focusIds, focusLabels: selected.map(f => f.label) };
}

// Copy profile's personal files to root
function activateProfileFiles(profileName) {
  const src = p => path.join(PROFILES_DIR, profileName, p);
  const dst = p => path.join(PROJECT_DIR, p);
  const pairs = [
    ['cv.md', 'cv.md'],
    ['profile.yml', 'config/profile.yml'],
    ['_profile.md', 'modes/_profile.md'],
  ];
  for (const [srcRel, dstRel] of pairs) {
    const s = src(srcRel);
    if (fs.existsSync(s)) {
      fs.mkdirSync(path.dirname(dst(dstRel)), { recursive: true });
      fs.copyFileSync(s, dst(dstRel));
    }
  }
}

// ── API: Profiles ──

// List profiles
app.get('/api/profiles', (req, res) => {
  try {
    const profiles = listProfiles();
    const active = getActiveProfile();
    res.json({ profiles, active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create profile
app.post('/api/profiles', (req, res) => {
  try {
    const { name, copyFrom } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Profile name required' });
    const safeName = name.trim();
    const profileDir = path.join(PROFILES_DIR, safeName);
    if (fs.existsSync(profileDir)) return res.status(409).json({ error: `Profile "${safeName}" already exists` });

    fs.mkdirSync(profileDir, { recursive: true });
    
    // Copy from existing profile or create empty
    const source = copyFrom || getActiveProfile();
    const srcDir = path.join(PROFILES_DIR, source);
    if (fs.existsSync(srcDir)) {
      for (const file of ['shared.json', 'cv.md', 'profile.yml', '_profile.md']) {
        const s = path.join(srcDir, file);
        if (fs.existsSync(s)) fs.copyFileSync(s, path.join(profileDir, file));
      }
    }
    // Default foci: safety-ehs
    writeJson(path.join(profileDir, 'foci.json'), copyFrom ? getProfileFoci(source) : ['safety-ehs']);
    
    // Copy CV and profile if source has them
    if (!copyFrom) {
      // Copy root files as fallback
      for (const [srcRel, dstName] of [['cv.md','cv.md'], ['config/profile.yml','profile.yml'], ['modes/_profile.md','_profile.md']]) {
        const rootSrc = path.join(PROJECT_DIR, srcRel);
        if (fs.existsSync(rootSrc)) fs.copyFileSync(rootSrc, path.join(profileDir, dstName));
      }
    }
    
    res.json({ success: true, name: safeName, profiles: listProfiles() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Switch active profile
app.post('/api/profiles/switch', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Profile name required' });
    const profileDir = path.join(PROFILES_DIR, name);
    if (!fs.existsSync(profileDir)) return res.status(404).json({ error: `Profile "${name}" not found` });
    
    // Switch active
    fs.writeFileSync(ACTIVE_FILE, name, 'utf8');
    
    // Copy profile files to root
    activateProfileFiles(name);
    
    // Rebuild portals.yml from foci + shared config
    const result = rebuildPortalsYml(name);
    
    res.json({ success: true, active: name, focuses: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete profile
app.delete('/api/profiles/:name', (req, res) => {
  try {
    const { name } = req.params;
    const active = getActiveProfile();
    if (name === active) return res.status(400).json({ error: 'Cannot delete active profile' });
    
    const profileDir = path.join(PROFILES_DIR, name);
    if (!fs.existsSync(profileDir)) return res.status(404).json({ error: `Profile "${name}" not found` });
    
    fs.rmSync(profileDir, { recursive: true, force: true });
    res.json({ success: true, profiles: listProfiles(), active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get focuses: available definitions + current profile's selection
app.get('/api/profiles/focuses', (req, res) => {
  try {
    const active = getActiveProfile();
    const available = getFocusDefinitions();
    const selected = getProfileFoci(active);
    res.json({ available, selected, profile: active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Set focuses for active profile (regenerates portals.yml)
app.post('/api/profiles/focuses', (req, res) => {
  try {
    const { focusIds } = req.body;
    if (!Array.isArray(focusIds)) return res.status(400).json({ error: 'focusIds must be an array' });
    if (focusIds.length === 0) return res.status(400).json({ error: 'Select at least one focus' });
    if (focusIds.length > 5) return res.status(400).json({ error: 'Select at most 5 focuses' });
    
    const active = getActiveProfile();
    const allFocuses = getFocusDefinitions();
    
    // Validate focus IDs
    const validIds = allFocuses.map(f => f.id);
    for (const id of focusIds) {
      if (!validIds.includes(id)) return res.status(400).json({ error: `Unknown focus: "${id}"` });
    }
    
    // Save selected foci
    writeJson(path.join(PROFILES_DIR, active, 'foci.json'), focusIds);
    
    // Rebuild portals.yml
    const result = rebuildPortalsYml(active);
    
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/profiles/active-profile', (req, res) => {
  try {
    const active = getActiveProfile();
    res.json({ name: active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Resume Upload ────────────────────────────────────────────────
const RESUME_DIR = path.join(PROJECT_DIR, 'resumes');

app.post('/api/resume/upload', express.raw({ type: 'application/json', limit: '10mb' }), async (req, res) => {
  try {
    const { filename, data } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!data) return res.status(400).json({ error: 'No file data provided' });

    const ext = path.extname(filename || 'resume.txt').toLowerCase();
    const buffer = Buffer.from(data, 'base64');
    let text = '';

    if (ext === '.txt') {
      text = buffer.toString('utf8');
    } else if (ext === '.pdf') {
      fs.mkdirSync(RESUME_DIR, { recursive: true });
      const tmpFile = path.join(RESUME_DIR, `upload-${Date.now()}.pdf`);
      try {
        fs.writeFileSync(tmpFile, buffer);
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(fs.readFileSync(tmpFile));
        text = pdfData.text || '';
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    } else if (ext === '.docx' || ext === '.doc') {
      return res.status(400).json({ error: 'DOCX files not yet supported. Please save as PDF or plain text.' });
    } else {
      return res.status(400).json({ error: 'Unsupported format. Use .pdf or .txt' });
    }

    if (!text.trim()) return res.status(400).json({ error: 'Could not extract text from file' });

    // Store raw text for CV generation
    fs.mkdirSync(RESUME_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESUME_DIR, 'resume-raw.txt'), text, 'utf8');

    res.json({ success: true, text: text.substring(0, 5000), filename, charCount: text.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/resume/generate-cv', async (req, res) => {
  try {
    const { text, questions } = req.body;
    const rawText = text || (() => { try { return fs.readFileSync(path.join(RESUME_DIR, 'resume-raw.txt'), 'utf8'); } catch { return ''; } })();
    if (!rawText.trim()) return res.status(400).json({ error: 'No resume text. Upload a resume first.' });

    const active = getActiveProfile();
    const q = questions || {};

    // Build cv.md from resume text + onboarding answers
    const name = q.name || 'Candidate';
    const location = q.location || '';
    const skills = q.skills || '';
    const experience = q.experience || '';
    const education = q.education || '';

    const sections = [`# ${name}`];
    if (location) sections.push(`\n**Location:** ${location}`);
    
    if (rawText) {
      // Extract summary from first few lines of resume
      const lines = rawText.split('\n').filter(l => l.trim()).slice(0, 5);
      sections.push(`\n## Summary\n\n${lines.join(' ').substring(0, 500)}`);
    }

    if (skills) {
      sections.push(`\n## Skills\n\n${skills.split(',').map(s => `- ${s.trim()}`).join('\n')}`);
    } else {
      // Extract skills section from raw text
      const match = rawText.match(/skills?:?\s*\n([\s\S]*?)(?:\n\w|$)/i);
      if (match) sections.push(`\n## Skills\n\n${match[1].trim().split('\n').map(l => `- ${l.trim()}`).join('\n')}`);
    }

    if (experience) {
      sections.push(`\n## Experience\n\n${experience}`);
    } else {
      sections.push(`\n## Experience\n\n<!-- PASTE YOUR WORK EXPERIENCE HERE -->\n${rawText.substring(0, 2000)}`);
    }

    if (education) {
      sections.push(`\n## Education\n\n${education}`);
    } else {
      const eduMatch = rawText.match(/education:?\s*\n([\s\S]*?)(?:\n\w|$)/i);
      if (eduMatch) sections.push(`\n## Education\n\n${eduMatch[1].trim()}`);
    }

    const cvMd = sections.join('\n\n');

    // Save to active profile and root
    const profileDir = path.join(PROFILES_DIR, active);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'cv.md'), cvMd, 'utf8');
    fs.writeFileSync(path.join(PROJECT_DIR, 'cv.md'), cvMd, 'utf8');

    res.json({ success: true, cvMd, profile: active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Profile Onboarding ──────────────────────────────────────────

function needsOnboarding(profileName) {
  const profileDir = path.join(PROFILES_DIR, profileName);
  try {
    const cvPath = path.join(profileDir, 'cv.md');
    const profilePath = path.join(profileDir, 'profile.yml');
    const fociPath = path.join(profileDir, 'foci.json');

    const cvExists = fs.existsSync(cvPath) ? fs.readFileSync(cvPath, 'utf8').trim().length > 50 : false;
    const profileExists = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8').includes('full_name') : false;
    const fociExists = fs.existsSync(fociPath) ? JSON.parse(fs.readFileSync(fociPath, 'utf8')).length > 0 : false;

    const missing = [];
    if (!cvExists) missing.push('cv');
    if (!profileExists) missing.push('profile');
    if (!fociExists) missing.push('focuses');
    return { needsOnboarding: missing.length > 0, missing };
  } catch {
    return { needsOnboarding: true, missing: ['cv', 'profile', 'focuses'] };
  }
}

app.get('/api/profiles/onboarding-status', (req, res) => {
  try {
    const active = getActiveProfile();
    const status = needsOnboarding(active);
    res.json({ profile: active, ...status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/profiles/onboarding', (req, res) => {
  try {
    const { name, email, location, targetRoles, skills, experience, education, salaryTarget, uniqueness } = req.body;
    const active = getActiveProfile();
    const profileDir = path.join(PROFILES_DIR, active);
    fs.mkdirSync(profileDir, { recursive: true });

    // 1. Write profile.yml
    const profileYml = yaml.dump({
      candidate: {
        full_name: name || 'New Candidate',
        email: email || '',
        location: location || '',
        timezone: 'America/Chicago',
        target_roles: (targetRoles || '').split(',').map(s => s.trim()).filter(Boolean),
        salary_target: { min: parseInt(salaryTarget) || 35000, max: 0, currency: 'USD' },
        skills: (skills || '').split(',').map(s => s.trim()).filter(Boolean),
        uniqueness: uniqueness || '',
      }
    }, { indent: 2, lineWidth: -1 });

    const profileDirConfig = path.join(profileDir, '..', '..', 'config');
    fs.mkdirSync(profileDirConfig, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'profile.yml'), profileYml, 'utf8');
    fs.writeFileSync(path.join(PROJECT_DIR, 'config', 'profile.yml'), profileYml, 'utf8');

    // 2. Write _profile.md
    const profileMd = `# User Profile Context — dafe-career-os\n\n## Your Target Roles\n\n${targetRoles || 'Not specified'}\n\n## Your Key Skills\n\n${skills || 'Not specified'}\n\n## Your Background\n\n${experience || 'Not specified'}\n\n## Education\n\n${education || 'Not specified'}\n\n## What Makes You Unique\n\n${uniqueness || 'Not specified'}\n\n## Your Salary Target\n\n${salaryTarget ? `$${salaryTarget}/year` : 'Not specified'}\n`;
    fs.writeFileSync(path.join(profileDir, '_profile.md'), profileMd, 'utf8');
    fs.writeFileSync(path.join(PROJECT_DIR, 'modes', '_profile.md'), profileMd, 'utf8');

    // 3. Write cv.md
    const cvMd = `# ${name || 'New Candidate'}\n\n${email ? `**Email:** ${email}  \n` : ''}${location ? `**Location:** ${location}\n\n` : '\n'}## Summary\n\n${experience ? experience.substring(0, 500) : `Experienced professional seeking ${targetRoles || 'new opportunities'}.`}\n\n## Skills\n\n${(skills || '').split(',').map(s => `- ${s.trim()}`).join('\n') || '- Skills not yet specified'}\n\n## Experience\n\n${experience || '<!-- Add your work experience here -->'}\n\n## Education\n\n${education || '<!-- Add your education here -->'}\n`;
    fs.writeFileSync(path.join(profileDir, 'cv.md'), cvMd, 'utf8');
    fs.writeFileSync(path.join(PROJECT_DIR, 'cv.md'), cvMd, 'utf8');

    res.json({
      success: true,
      profile: active,
      fields: { name, email, location, targetRoles, skills, experience, education, salaryTarget, uniqueness }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tracker ──
app.get('/api/tracker', (req, res) => {
  const tracker = safeRead('data/applications.md');
  // Parse into structured data
  const lines = tracker.split('\n');
  const entries = [];
  for (const line of lines) {
    if (!line.includes('|') || line.includes('---') || line.includes('#') || line.includes('| # |')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(c => c);
    if (cols.length >= 6) {
      entries.push({
        num: cols[0],
        date: cols[1] || '',
        company: cols[2] || '',
        role: cols[3] || '',
        score: cols[4] || '',
        status: cols[5] || '',
        pdf: cols[6] || '',
        report: cols[7] || '',
        notes: cols[8] || '',
      });
    }
  }
  res.json({ tracker, entries });
});

app.post('/api/tracker/update', (req, res) => {
  try {
    const { num, status, notes } = req.body;
    let tracker = safeRead('data/applications.md');
    const lines = tracker.split('\n');
    const newLines = lines.map(l => {
      if (l.includes(`| ${num} |`)) {
        const cols = l.split('|');
        if (status) cols[5] = ` ${status} `;
        if (notes !== undefined) cols[8] = ` ${notes} `;
        return cols.join('|');
      }
      return l;
    });
    fs.writeFileSync(path.join(PROJECT_DIR, 'data', 'applications.md'), newLines.join('\n'), 'utf8');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pipeline
app.get('/api/pipeline', (req, res) => {
  const pipeline = safeRead('data/pipeline.md');
  const lines = pipeline.split('\n');
  const entries = [];
  for (const line of lines) {
    if (!line.includes('|') || line.includes('---') || line.includes('#')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(c => c);
    if (cols.length >= 2) {
      entries.push({
        num: cols[0],
        url: cols[1] || '',
        source: cols[2] || '',
        notes: cols[3] || '',
      });
    }
  }
  res.json({ pipeline, entries });
});

app.post('/api/pipeline/add', (req, res) => {
  try {
    const { url, source, notes } = req.body;
    const pipelinePath = path.join(PROJECT_DIR, 'data', 'pipeline.md');
    let content = safeRead('data/pipeline.md');
    if (!content.trim()) {
      content = '# Job Pipeline\n\n| # | URL | Source | Notes |\n|---|-----|--------|-------|\n';
    }
    const lines = content.split('\n').filter(l => l.trim());
    const maxNum = lines.reduce((max, l) => {
      const m = l.match(/^\|\s*(\d+)\s*\|/);
      return m ? Math.max(max, parseInt(m[1])) : max;
    }, 0);
    const newLine = `| ${maxNum + 1} | ${url} | ${source || ''} | ${notes || ''} |`;
    fs.writeFileSync(pipelinePath, content.trim() + '\n' + newLine + '\n', 'utf8');
    res.json({ success: true, num: maxNum + 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run evaluation (uses gemini-eval.mjs or OpenCode for Ollama)
app.post('/api/evaluate', async (req, res) => {
  const { url, jd } = req.body;
  if (!url && !jd) return res.status(400).json({ error: 'URL or JD text required' });

  const model = getModelPref() || '';
  const isOllama = model.startsWith('ollama/');
  const safeName = `eval-${Date.now()}`;
  const jdFile = path.join(PROJECT_DIR, 'jds', `${safeName}.md`);

  try {
    // Get JD content: from URL (fetch) or from body text
    let jdContent = jd || '';
    if (url && !jd) {
      jdContent = `# Job URL: ${url}\n\n`;
      try {
        const https = url.startsWith('https') ? require('https') : require('http');
        jdContent += await new Promise((resolve, reject) => {
          https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
            let data = '';
            res.on('data', c => data += c.toString());
            res.on('end', () => resolve(data.substring(0, 10000)));
          }).on('error', reject);
        });
      } catch {
        jdContent += `(Could not fetch URL content automatically. Paste the job description manually.)`;
      }
    }
    fs.writeFileSync(jdFile, jdContent, 'utf8');

    let result;
    if (isOllama || isOllamaCloud) {
      const m = isOllamaCloud ? model.replace('ollama-cloud/', '') : model.replace('ollama/', '');
      const fullModel = isOllamaCloud ? `ollama-cloud/${m}` : m;
      result = await runOpenCode(`Run the dafe-career-os evaluation pipeline on the job description at jds/${safeName}.md. Use model ${fullModel}. Produce a full Blocks A-G evaluation report.`);
    } else {
      const modelArg = model.includes('/') ? model.split('/').pop() : (model || 'gemini-2.5-flash');
      result = await runNode('gemini-eval.mjs', ['--file', `jds/${safeName}.md`, '--model', modelArg], 180000);
    }

    const reports = fs.readdirSync(path.join(PROJECT_DIR, 'reports'), { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.md'))
      .sort()
      .reverse();
    const latestReport = reports.length > 0 ? safeRead(`reports/${reports[0].name}`) : '';

    const outputs = fs.readdirSync(path.join(PROJECT_DIR, 'output'), { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.pdf'))
      .sort()
      .reverse();
    const latestPdf = outputs.length > 0 ? outputs[0].name : null;

    res.json({
      success: result.code === 0,
      report: latestReport,
      pdf: latestPdf,
      reportFile: reports.length > 0 ? reports[0].name : null,
      log: result.stdout.substring(0, 3000),
      error: result.stderr.substring(0, 1000),
    });
  } catch (e) {
    const errMsg = e.message || '';
    if (errMsg.includes('Timeout')) {
      res.json({ success: false, report: '', pdf: null, log: '', error: 'Evaluation timed out. Check GEMINI_API_KEY in .env is correct.' });
    } else {
      res.status(500).json({ error: errMsg.substring(0, 1000) });
    }
  } finally {
    try { if (fs.existsSync(jdFile)) fs.unlinkSync(jdFile); } catch {}
  }
});

// Run scan
app.post('/api/scan', async (req, res) => {
  try {
    const result = await runNode('scan.mjs', [], 180000);
    const pipeline = safeRead('data/pipeline.md');
    // Parse filter stats from stdout
    const titleFiltered = (result.stdout.match(/Filtered by title:\s+(\d+)/) || [])[1] || '?';
    const locationFiltered = (result.stdout.match(/Filtered by location:\s+(\d+)/) || [])[1] || '?';
    const salaryFiltered = (result.stdout.match(/Filtered by salary:\s+(\d+)/) || [])[1] || '?';
    const newOffers = (result.stdout.match(/New offers added:\s+(\d+)/) || [])[1] || '?';
    res.json({
      success: result.code === 0,
      pipeline,
      log: result.stdout.substring(0, 3000),
      error: result.stderr.substring(0, 1000),
      stats: { titleFiltered, locationFiltered, salaryFiltered, newOffers },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate PDF
app.post('/api/generate-pdf', async (req, res) => {
  const { companySlug } = req.body;
  try {
    const args = companySlug ? [companySlug] : [];
    const result = await runNode('generate-pdf.mjs', args, 60000);
    const outputs = fs.readdirSync(path.join(PROJECT_DIR, 'output'), { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.pdf'))
      .sort((a, b) => b.name.localeCompare(a.name));
    res.json({
      success: result.code === 0,
      pdf: outputs.length > 0 ? outputs[0].name : null,
      log: result.stdout.substring(0, 2000),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download PDF (with path traversal protection)
app.get('/api/pdf/:name', (req, res) => {
  const safe = validatePath(path.join(PROJECT_DIR, 'output'), path.basename(req.params.name));
  if (!safe) return res.status(400).json({ error: 'Invalid path' });
  if (fs.existsSync(safe) && safe.endsWith('.pdf')) {
    res.download(safe);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Report
app.get('/api/reports', (req, res) => {
  const reportsDir = path.join(PROJECT_DIR, 'reports');
  const files = fs.readdirSync(reportsDir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.md'))
    .map(d => ({
      name: d.name,
      path: `reports/${d.name}`,
      mtime: fs.statSync(path.join(reportsDir, d.name)).mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

app.get('/api/report/:name', (req, res) => {
  const safe = validatePath(path.join(PROJECT_DIR, 'reports'), path.basename(req.params.name));
  if (!safe) return res.status(400).json({ error: 'Invalid path' });
  try {
    const content = fs.readFileSync(safe, 'utf8');
    res.json({ content });
  } catch {
    res.status(404).json({ error: 'Report not found' });
  }
});

// PDFs
app.get('/api/pdfs', (req, res) => {
  const outputDir = path.join(PROJECT_DIR, 'output');
  const files = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.pdf'))
    .map(d => ({
      name: d.name,
      path: `output/${d.name}`,
      size: fs.statSync(path.join(outputDir, d.name)).size,
      mtime: fs.statSync(path.join(outputDir, d.name)).mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

// Cover letter
app.post('/api/cover-letter', async (req, res) => {
  const { jd, company, role } = req.body;
  if (!jd) return res.status(400).json({ error: 'JD text required' });

  const jdFile = path.join(PROJECT_DIR, 'jds', `cl-${Date.now()}.md`);
  fs.writeFileSync(jdFile, jd, 'utf8');

  try {
    const prompt = `Run dafe-career-os cover mode. Generate a cover letter for this job description from ${company || 'the company'} for the ${role || 'stated'} role. The JD is at jds/${path.basename(jdFile)}.`;
    const result = await runOpenCode(prompt, 120000);
    res.json({
      success: result.code === 0,
      content: result.stdout.substring(0, 5000),
      log: result.stdout.substring(0, 2000),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (fs.existsSync(jdFile)) fs.unlinkSync(jdFile);
  }
});

// Agent chat (uses Gemini API directly)
app.post('/api/agent/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  try {
    const model = getModelPref() || '';
    const isOllama = model.startsWith('ollama/');
    const isOllamaCloud = model.startsWith('ollama-cloud/');

    // ── Ollama (local) path ────────────────────────────────────
    if (isOllama && !isOllamaCloud) {
      const modelName = model.replace('ollama/', '');
      const http = require('http');
      const body = JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: 'You are a dafe-career-os AI job search assistant. Help the user with their job search. Answer concisely and helpfully.' },
          { role: 'user', content: message }
        ],
        stream: false
      });

      const response = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost', port: 11434,
          path: '/api/chat', method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 120000,
        }, r => {
          let data = '';
          r.on('data', c => data += c.toString());
          r.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ error: data.substring(0, 500) }); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      const text = response?.message?.content || response?.error || '(no response)';
      return res.json({ success: !response.error, response: text.substring(0, 10000), error: response.error || '' });
    }

    // ── Ollama Cloud path ──────────────────────────────────────
    if (isOllamaCloud) {
      const modelName = model.replace('ollama-cloud/', '');
      const cloudUrl = process.env.OLLAMA_CLOUD_URL || 'https://api.ollama.com';
      const cloudKey = process.env.OLLAMA_CLOUD_API_KEY;
      if (!cloudKey) {
        return res.json({ success: false, response: '', error: 'OLLAMA_CLOUD_API_KEY not set. Add it to .env and restart.' });
      }
      const https = require('https');
      const url = new URL(cloudUrl);
      const body = JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: 'You are a dafe-career-os AI job search assistant. Help the user with their job search. Answer concisely and helpfully.' },
          { role: 'user', content: message }
        ],
        stream: false
      });

      const response = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: url.hostname, port: url.port || 443,
          path: '/api/chat', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cloudKey}` },
          timeout: 120000,
        }, r => {
          let data = '';
          r.on('data', c => data += c.toString());
          r.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ error: data.substring(0, 500) }); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      const text = response?.message?.content || response?.error || '(no response)';
      return res.json({ success: !response.error, response: text.substring(0, 10000), error: response.error || '' });
    }

    // ── Google Gemini path ──────────────────────────────────────
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.json({ success: false, response: '', error: 'GEMINI_API_KEY not set. Add it to .env and restart.' });
    }

    const modelName = model.includes('/') ? model.split('/').pop() : (model || 'gemini-2.5-flash');

    const https = require('https');
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `You are a dafe-career-os AI job search assistant. Help the user with their job search. Context: the user is looking for Safety Coordinator, Safety Specialist, Control Room Operation, Administrative Assistant, and Inside Sales Engineer roles. Their CV and profile are in C:\\dafe-career-os. Answer concisely and helpfully.\n\nUser: ${message}` }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
    });

    const response = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
      }, r => {
        let data = '';
        r.on('data', c => data += c.toString());
        r.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ error: data.substring(0, 500) }); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || response?.error || '(no response)';
    res.json({ success: !response.error, response: text.substring(0, 10000), error: response.error || '' });
  } catch (e) {
    res.json({ success: false, response: '', error: e.message.substring(0, 1000) });
  }
});

// Run any npm script
app.post('/api/run-script', async (req, res) => {
  const { script, args } = req.body;
  const scriptMap = {
    doctor: ['doctor.mjs', []],
    'sync-check': ['cv-sync-check.mjs', []],
    verify: ['verify-pipeline.mjs', []],
    normalize: ['normalize-statuses.mjs', []],
    dedup: ['dedup-tracker.mjs', []],
    merge: ['merge-tracker.mjs', []],
    tracker: ['tracker.mjs', []],
    patterns: ['analyze-patterns.mjs', []],
    reposts: ['detect-reposts.mjs', ['--summary']],
    followup: ['followup-cadence.mjs', []],
  };

  const [scriptFile, scriptArgs] = scriptMap[script] || [null, []];
  if (!scriptFile) return res.status(400).json({ error: `Unknown script: ${script}` });

  try {
    const result = await runNode(scriptFile, [...scriptArgs, ...(args || [])]);
    res.json({
      success: result.code === 0,
      stdout: result.stdout.substring(0, 5000),
      stderr: result.stderr.substring(0, 1000),
      code: result.code,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Env vars
app.get('/api/env', (req, res) => {
  res.json({
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ? '***configured***' : 'not set',
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? '***configured***' : 'not set',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '***configured***' : 'not set',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '***configured***' : 'not set',
    OLLAMA_CLOUD_API_KEY: process.env.OLLAMA_CLOUD_API_KEY ? '***configured***' : 'not set',
    OLLAMA_CLOUD_URL: process.env.OLLAMA_CLOUD_URL || 'https://api.ollama.com (default)',
  });
});

// Models (async to avoid blocking)
app.get('/api/models', async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('opencode', ['models'], {
        cwd: PROJECT_DIR,
        env: { ...process.env, PATH: PATH_ENV },
        shell: true,
        windowsHide: true,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());
      const timer = setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, 30000);
      child.on('close', code => { clearTimeout(timer); resolve(stdout); });
      child.on('error', reject);
    });
    const allModels = result.split(/\r?\n/).map(s => s.trim()).filter(s => s);
    const builtin = allModels.filter(s => s.startsWith('opencode/'));
    const googleModels = allModels.filter(s => s.startsWith('google/'));
    const list = allModels.filter(s => s.startsWith('opencode/') || s.startsWith('google/'));

    // Fetch local Ollama models (best-effort, short timeout)
    let ollamaModels = [];
    try {
      const ollamaRes = await new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.get('http://localhost:11434/api/tags', r => {
          let data = '';
          r.on('data', c => data += c.toString());
          r.on('end', () => resolve(data));
        });
        req.on('error', () => resolve('{}'));
        req.setTimeout(2000, () => { req.destroy(); resolve('{}'); });
        req.end();
      });
      const parsed = JSON.parse(ollamaRes);
      if (parsed.models && Array.isArray(parsed.models)) {
        ollamaModels = parsed.models.map(m => 'ollama/' + (m.name));
      }
    } catch {}

    // Fetch Ollama Cloud models (best-effort, if API key configured)
    let ollamaCloudModels = [];
    const cloudApiKey = process.env.OLLAMA_CLOUD_API_KEY;
    const cloudUrl = process.env.OLLAMA_CLOUD_URL || 'https://api.ollama.com';
    if (cloudApiKey) {
      try {
        const cloudRes = await new Promise((resolve, reject) => {
          const https = require('https');
          const url = new URL(cloudUrl);
          const req = https.get(`${cloudUrl}/api/tags`, {
            headers: { 'Authorization': `Bearer ${cloudApiKey}` },
            timeout: 5000,
          }, r => {
            let data = '';
            r.on('data', c => data += c.toString());
            r.on('end', () => resolve(data));
          });
          req.on('error', () => resolve('{}'));
          req.setTimeout(5000, () => { req.destroy(); resolve('{}'); });
          req.end();
        });
        const parsed = JSON.parse(cloudRes);
        if (parsed.models && Array.isArray(parsed.models)) {
          ollamaCloudModels = parsed.models.map(m => 'ollama-cloud/' + (m.name));
        }
      } catch {}
    }

    const knownFree = [
      { id: 'google/gemini-2.5-flash', provider: 'Google AI Studio', tier: 'Free (no CC)', best: 'Writing, analysis, 1M context', available: googleModels.includes('google/gemini-2.5-flash') },
      { id: 'google/gemini-2.5-pro', provider: 'Google AI Studio', tier: 'Free tier', best: 'Heavy reasoning', available: googleModels.includes('google/gemini-2.5-pro') },
      { id: 'groq/llama-3.3-70b-versatile', provider: 'Groq', tier: 'Free (no CC)', best: 'Fast evaluation, 500+ tok/s', available: allModels.includes('groq/llama-3.3-70b-versatile') },
      { id: 'groq/llama-4-scout-17b', provider: 'Groq', tier: 'Free (no CC)', best: 'Speed', available: allModels.includes('groq/llama-4-scout-17b') },
      { id: 'cerebras/llama-3.3-70b', provider: 'Cerebras', tier: 'Free (no CC)', best: '30 RPM, 1M tok/day', available: allModels.includes('cerebras/llama-3.3-70b') },
    ];
    res.json({ output: result.substring(0, 5000), list, builtin, googleModels, knownFree, ollamaModels, ollamaCloudModels });
  } catch {
    res.json({ output: 'Run `opencode models` in your terminal to see available models.', list: [], knownFree: [], ollamaModels: [], ollamaCloudModels: [] });
  }
});

// Provider status (async)
app.get('/api/providers', async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('opencode', ['providers', 'list'], {
        cwd: PROJECT_DIR,
        env: { ...process.env, PATH: PATH_ENV },
        shell: true,
        windowsHide: true,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());
      const timer = setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, 15000);
      child.on('close', code => { clearTimeout(timer); resolve(stdout); });
      child.on('error', reject);
    });
    const count = (result.match(/•/g) || []).length;
    res.json({ connected: count, output: result.substring(0, 2000) });
  } catch {
    res.json({ connected: 0, output: 'No provider info available.' });
  }
});

// Model preference (selected model)
app.get('/api/model', (req, res) => {
  const pref = getModelPref();
  res.json({ model: pref || 'opencode/big-pickle (default)' });
});

app.post('/api/model', (req, res) => {
  const { model } = req.body;
  if (model) {
    fs.writeFileSync(MODEL_PREF_FILE, JSON.stringify({ model }), 'utf8');
    res.json({ success: true, model });
  } else {
    try { fs.unlinkSync(MODEL_PREF_FILE); } catch {}
    res.json({ success: true, model: '(default)' });
  }
});

// Portal config
app.get('/api/portals', (req, res) => {
  const portals = safeReadYaml('portals.yml');
  res.json(portals || { companies: [], queries: [] });
});

app.get('/api/portals/companies', (req, res) => {
  const portals = safeReadYaml('portals.yml');
  res.json((portals?.companies || []).map(c => ({ name: c.name, enabled: c.enabled !== false })));
});

// Scan location config
app.get('/api/scan-config', (req, res) => {
  const portals = safeReadYaml('portals.yml') || {};
  const loc = portals.location || {};
  res.json({ zipcode: loc.zipcode || '75254', radius: loc.radius || 50, remoteOnly: loc.remote_only === true });
});

app.post('/api/scan-config', (req, res) => {
  try {
    const { zipcode, radius, remoteOnly } = req.body;
    const portalsPath = path.join(PROJECT_DIR, 'portals.yml');
    let config = {};
    try { config = yaml.load(fs.readFileSync(portalsPath, 'utf8')) || {}; } catch {}
    config.location = { zipcode: zipcode || '75254', radius: radius !== undefined ? Number(radius) : 50, remote_only: remoteOnly === true };
    const output = yaml.dump(config, { indent: 2, lineWidth: -1, quotingType: '"', forceQuotes: false });
    fs.writeFileSync(portalsPath, output, 'utf8');

    // Also persist to active profile's shared.json
    const active = getActiveProfile();
    if (active) {
      const sharedPath = path.join(PROFILES_DIR, active, 'shared.json');
      let shared = {};
      try { shared = JSON.parse(fs.readFileSync(sharedPath, 'utf8')); } catch {}
      shared.location = { zipcode: zipcode || '75254', radius: radius !== undefined ? Number(radius) : 50 };
      shared.remote_only = remoteOnly === true;
      fs.writeFileSync(sharedPath, JSON.stringify(shared, null, 2), 'utf8');
    }

    res.json({ success: true, zipcode, radius, remoteOnly });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scan history
app.get('/api/scan-history', (req, res) => {
  const history = safeRead('data/scan-history.tsv');
  const lines = history.split('\n').filter(l => l.trim());
  const entries = lines.slice(1).map(l => {
    const cols = l.split('\t');
    return { url: cols[1] || '', company: cols[2] || '', date: cols[0] || '', status: cols[4] || '' };
  });
  res.json({ entries, total: entries.length });
});

// Apply active profile (re-activate files + rebuild portals)
app.post('/api/profiles/apply', (req, res) => {
  try {
    const active = getActiveProfile();
    if (!active) return res.status(400).json({ error: 'No active profile' });
    activateProfileFiles(active);
    const result = rebuildPortalsYml(active);
    res.json({ success: true, active, focuses: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stories
app.get('/api/stories', (req, res) => {
  const stories = safeRead('interview-prep/story-bank.md');
  res.json({ stories: stories || 'No stories yet. Run /dafe-career-os interview to build your story bank.' });
});

// ── Serve SPA (catch-all) ────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ────────────────────────────────────────────────────────────
try {
  const opencodeVer = require('child_process').execSync('opencode --version 2>&1', {encoding:'utf8',cwd:PROJECT_DIR,env:{...process.env,PATH:PATH_ENV},shell:true,windowsHide:true}).trim();
  console.log(`  OpenCode: ${opencodeVer}`);
} catch { console.log('  OpenCode: not found (install with: npm i -g opencode-ai)'); }

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  DAFE Career OS Web Dashboard`);
  console.log(`  ─────────────────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Repo:    ${PROJECT_DIR}`);
  console.log(`\n  Press Ctrl+C to stop\n`);
});
