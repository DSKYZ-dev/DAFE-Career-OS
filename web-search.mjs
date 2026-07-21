#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import yaml from 'js-yaml';
import { deriveProfileFilter, buildTitleFilter, loadAggressiveness } from './title-filter.mjs';
import { resolveActiveFocuses } from './focus-catalog.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const PORTALS_PATH = join(ROOT, 'portals.yml');

function readLines(p) {
  try { return readFileSync(p, 'utf-8').split('\n'); } catch { return []; }
}

function loadPortals() {
  try { return yaml.load(readFileSync(PORTALS_PATH, 'utf-8')); }
  catch { console.error('Failed to load portals.yml'); return null; }
}

function loadProfile() {
  try {
    return yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8')) || null;
  } catch { return null; }
}

// Build focused search queries from the user's active focuses (config/
// profile.yml active_focuses + config/focus-catalog.yml, resolved via
// focus-catalog.mjs — the same canonical source scan.mjs's title filter and
// auto-pipeline.mjs's track labeling use). Each focus yields a compact
// OR-query per job board. Returns null if nothing resolves (caller falls
// back to portals.yml search_queries). Works for ANY user with any job
// focus — not a hard-coded set of roles.
function buildTrackQueries(profile) {
  const focuses = resolveActiveFocuses(profile || {});
  const effective = focuses
    .filter((f) => f.keywords && f.keywords.length)
    .map((f) => ({ name: f.id, label: f.label, target_roles: f.keywords.slice(0, 12) }));
  if (!effective.length) return null;
  const domains = [
    'indeed.com', 'linkedin.com/jobs', 'simplyhired.com',
    'job-boards.greenhouse.io', 'myworkdayjobs.com',
    'remoteok.com', 'weworkremotely.com', 'remotive.com', 'himalayas.app'
  ];
  const queries = [];
  for (const track of effective) {
    const roles = (track.target_roles || []).filter(Boolean);
    if (!roles.length) continue;
    const pick = roles.slice(0, 4);
    const orExpr = pick.map(r => `"${r}"`).join(' OR ');
    for (const domain of domains) {
      const loc = (domain.includes('linkedin') || domain.includes('indeed') || domain.includes('simplyhired'))
        ? 'remote OR United States'
        : 'remote';
      const q = `site:${domain} ${orExpr} ${loc}`;
      queries.push({ name: `${track.label} — ${domain}`, query: q, track: track.name });
    }
  }
  const seen = new Set();
  return queries.filter(x => { if (seen.has(x.query)) return false; seen.add(x.query); return true; });
}

function loadSeenUrls() {
  const seen = new Set();
  for (const line of readLines(SCAN_HISTORY_PATH)) {
    const parts = line.split('\t');
    if (parts.length >= 2) seen.add(parts[1].trim());
  }
  return seen;
}

function loadPipelineUrls() {
  const urls = new Set();
  for (const line of readLines(PIPELINE_PATH)) {
    const m = line.match(/\[.?\]\s*(https?:\/\/[^\s|]+)/);
    if (m) urls.add(m[1].replace(/[|].*$/, '').trim());
  }
  return urls;
}

function appendToPipeline(entries) {
  mkdirSync(dirname(PIPELINE_PATH), { recursive: true });
  let content = '';
  if (existsSync(PIPELINE_PATH)) content = readFileSync(PIPELINE_PATH, 'utf-8');
  for (const e of entries) {
    const track = e.track ? ` | ${e.track}` : '';
    content += `\n- [ ] ${e.url} | ${e.company} | ${e.role} | ${e.location}${track}`;
  }
  writeFileSync(PIPELINE_PATH, content, 'utf-8');
}

function appendToScanHistory(entries) {
  const date = new Date().toISOString().slice(0, 10);
  let tsv = '';
  if (existsSync(SCAN_HISTORY_PATH)) tsv = readFileSync(SCAN_HISTORY_PATH, 'utf-8');
  if (tsv && !tsv.endsWith('\n')) tsv += '\n';
  for (const e of entries) {
    tsv += `${date}\t${e.url}\t${e.company}\t${e.role}\t${e.location}\n`;
  }
  writeFileSync(SCAN_HISTORY_PATH, tsv, 'utf-8');
}

function normalizeUrl(url) {
  return url.replace(/#.*$/, '').replace(/&from\=[^&]+/, '').replace(/&src\=[^&]+/, '').trim();
}

function buildSearchUrl(domain, query) {
  const keywords = extractKeywords(query);
  const location = extractLocation(query);
  const domainMap = {
    'indeed.com': (kw, loc) =>
      `https://www.indeed.com/jobs?q=${encodeURIComponent(kw)}&l=${encodeURIComponent(loc)}&sort=date`,
    'simplyhired.com': (kw, loc) =>
      `https://www.simplyhired.com/search?q=${encodeURIComponent(kw)}&l=${encodeURIComponent(loc)}&fdb=1`,
    'linkedin.com/jobs': (kw, loc) =>
      `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&f_TPR=r604800`,
    'careerbuilder.com': (kw, loc) =>
      `https://www.careerbuilder.com/jobs?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}`,
    'monster.com': (kw, loc) =>
      `https://www.monster.com/jobs/search?q=${encodeURIComponent(kw)}&where=${encodeURIComponent(loc)}`,
  };
  const builder = domainMap[domain];
  return builder ? builder(keywords, location) : null;
}

function extractKeywords(query) {
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  if (quoted.length) return quoted.join(' ');
  return query.replace(/site:\S+/g, '').replace(/\b(OR|AND|-onsite)\b/gi, '').trim();
}

function extractLocation(query) {
  if (/\bremote\b/i.test(query)) return 'remote';
  if (/united\s*states/i.test(query)) return 'United States';
  return 'remote';
}

function extractDomain(query) {
  const m = query.match(/site:([a-z0-9.-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function scrapeJobs(url, domain, track) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);

    let raw = [];
    if (domain === 'indeed.com') {
      raw = await scrapeIndeed(page);
    } else if (domain === 'simplyhired.com') {
      raw = await scrapeSimplyHired(page);
    } else if (domain === 'linkedin.com/jobs') {
      raw = await scrapeLinkedIn(page);
    } else {
      raw = await scrapeGeneric(page, domain, url);
    }
    return raw.map(r => ({ ...r, track: track || 'unknown' }));
  } catch (err) {
    console.error(`    Scrape error: ${err.message}`);
    return [];
  } finally {
    await browser.close();
  }
}

async function scrapeIndeed(page) {
  // Extract job data from Indeed's structured HTML + text
  return await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Method 1: Find all job links (viewjob and sponsored)
    const links = document.querySelectorAll('a[href*="viewjob?jk="], a[href*="/rc/clk"]');
    const linkSet = new Set();

    links.forEach(a => {
      const href = a.href || '';
      // Normalize to base job link
      const jkMatch = href.match(/jk=([^&]+)/);
      const baseHref = jkMatch ? `https://www.indeed.com/viewjob?jk=${jkMatch[1]}` : href;
      if (linkSet.has(baseHref)) return;
      linkSet.add(baseHref);

      // Walk up to find the job card
      let card = a.closest('.job_seen_beacon, .card, li, [data-testid*="job"], .slider_container, div[class*="job"]');
      if (!card) card = a.parentElement;
      if (!card) return;

      const title = (card.querySelector('[data-testid*="title"], .jobTitle, h2, .title, [class*="title"]') || {}).textContent || '';
      const company = (card.querySelector('[data-testid*="company"], .companyName, .company, [class*="company"]') || {}).textContent || '';
      const location = (card.querySelector('[data-testid*="location"], .companyLocation, .location, [class*="location"]') || {}).textContent || '';

    let c = company.trim() || 'Unknown';
    let l = location.trim() || 'Remote';
    // Fix: company name sometimes bleeds into location field
    if (l.startsWith(c)) l = l.slice(c.length).trim();
    if (l.startsWith('Remote')) l = 'Remote' + (l.length > 6 ? ' ' + l.slice(6).trim() : '');
    if (c.endsWith('Remote') && c.length > 7) { l = 'Remote ' + l; c = c.slice(0, -6).trim(); }

    if (title && title.trim().length > 3) {
      const key = title.trim() + '|' + c;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          url: baseHref,
          company: c || 'Unknown',
          role: title.trim(),
          location: l || 'Remote'
        });
      }
    }
    });

    // Method 2: If no structured cards found, parse text content
    if (results.length === 0) {
      const text = document.body.innerText;
      const lines = text.split('\n');
      let i = 0;
      while (i < lines.length) {
        const line = lines[i].trim();
        // Look for title patterns (starts with capital letter, contains common job words)
        if (line.match(/^[A-Z][a-z]/) && line.length > 10 && line.length < 120) {
          const company = lines[i + 1]?.trim() || '';
          const location = lines[i + 2]?.trim() || '';
          if (company && company.length > 2 && company.length < 80 && !company.match(/^\d/)) {
            const key = line + '|' + company;
            if (!seen.has(key)) {
              seen.add(key);
              results.push({
                url: '',
                company: company,
                role: line,
                location: location || 'Remote'
              });
            }
          }
        }
        i++;
      }
    }

    return results;
  });
}

async function scrapeSimplyHired(page) {
  return await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const cards = document.querySelectorAll('.SerpJob-card, article, [data-testid="jobListing"], .job-card');

    cards.forEach(card => {
      const link = card.querySelector('a[href*="/job/"], a[data-testid*="job"]');
      const href = link ? link.href : '';
      const title = (card.querySelector('a[href*="/job/"], h2, .jobTitle, [data-testid*="title"]') || {}).textContent || '';
      const company = (card.querySelector('[data-testid="companyName"], .jobCompany, .company, [class*="company"]') || {}).textContent || '';
      const location = (card.querySelector('[data-testid="location"], .jobLocation, .location, [class*="location"]') || {}).textContent || '';

      if (title && title.trim().length > 3) {
        const key = title.trim() + '|' + company.trim();
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            url: href || '',
            company: company.trim() || 'Unknown',
            role: title.trim(),
            location: location.trim() || 'Remote'
          });
        }
      }
    });

    if (results.length === 0) {
      // Fallback: parse text
      const text = document.body.innerText;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/([A-Z][A-Za-z\s\/&-]{5,60}(?:Specialist|Representative|Agent|Coordinator|Analyst|Associate|Technician|Engineer|Manager|Developer|Assistant|Advisor|Clerk|Operator|Tester|Reviewer|Writer|Editor|Lead|Director|Consultant|Architect))/);
        if (m) {
          const title = m[1].trim();
          const company = lines[i + 1]?.trim() || '';
          const location = lines[i + 2]?.trim() || '';
          const key = title + '|' + company;
          if (!seen.has(key) && company.length > 2) {
            seen.add(key);
            results.push({ url: '', company, role: title, location: location || 'Remote' });
          }
        }
      }
    }

    return results;
  });
}

async function scrapeLinkedIn(page) {
  return await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const cards = document.querySelectorAll('.job-card-container, .job-search-card, .occludable-update');

    cards.forEach(card => {
      const link = card.querySelector('a[href*="/jobs/view"], a.job-card-list__title');
      const href = link ? link.href : '';
      const title = (card.querySelector('.job-card-list__title, .job-title, h3, [class*="title"]') || {}).textContent || '';
      const company = (card.querySelector('[class*="company-name"], [class*="company"], [class*="employer"]') || {}).textContent || '';
      const location = (card.querySelector('[class*="metadata"], [class*="location"]') || {}).textContent || '';

      if (title && title.trim().length > 3) {
        const key = title.trim() + '|' + company.trim();
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            url: href || '',
            company: company.trim() || 'Unknown',
            role: title.trim(),
            location: location.trim() || 'Remote'
          });
        }
      }
    });

    return results;
  });
}

async function scrapeGeneric(page, domain, url) {
  // For other job boards: extract all links and job-like text.
  // Prefer an ATS apply-form link (Greenhouse/Lever/Ashby/Workday/...) when
  // the card exposes one, so pipeline.md holds a submittable URL.
  // Match on the HOSTNAME (e.g. boards.greenhouse.io), never on a
  // job-title slug that merely mentions "workday"/"greenhouse".
  const ATS_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'workday.com', 'taleo.net', 'smartrecruiters.com', 'icims.com'];
  return await page.evaluate((ATS) => {
    const results = [];
    const seen = new Set();

    const links = document.querySelectorAll('a[href*="job"], a[href*="career"], a[href*="position"], a[href*="opening"], a[href*="apply"]');
    const hostMatches = (href) => { try { const u = new URL(href); return ATS.some(d => u.hostname.toLowerCase().includes(d)); } catch { return false; } };
    links.forEach(a => {
      const href = a.href || '';
      // Prefer an ATS-host link within the same card
      let finalUrl = href;
      const card = a.closest('article, .job, li, div') || a.parentElement;
      if (card) {
        const cardLinks = card.querySelectorAll('a[href]');
        for (const cl of cardLinks) {
          if (hostMatches(cl.href)) { finalUrl = cl.href; break; }
        }
      }
      const title = a.textContent.trim();
      if (title.length > 10 && title.length < 150 && finalUrl.startsWith('http') && !finalUrl.includes('#') && !finalUrl.includes('logout')) {
        const key = title + '|' + finalUrl;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ url: finalUrl, company: '', role: title, location: 'Remote' });
        }
      }
    });

    return results;
  }, ATS);
}

async function main() {
  console.log('=== Web Job Search (Playwright-based) ===\n');

  const config = loadPortals();
  if (!config) return;

  const profile = loadProfile();
  // Build focused queries from the profile's tracks (integrated with targeting).
  // Fall back to portals.yml search_queries if no tracks are configured.
  let queries = buildTrackQueries(profile);
  let source = 'profile tracks';
  if (!queries) {
    queries = config.search_queries || [];
    source = 'portals.yml search_queries';
  }
  if (queries.length === 0) { console.log('No search queries available (configure profile.tracks or portals.search_queries)'); return; }
  console.log(`Query source: ${source} (${queries.length} queries)\n`);

  const seenUrls = loadSeenUrls();
  const pipelineUrls = loadPipelineUrls();
  const allNew = [];

  // Prioritize Indeed + SimplyHired (most scrapable), then LinkedIn, then others
  const priorityBoards = ['indeed.com', 'simplyhired.com', 'linkedin.com/jobs'];
  const prioritized = [...queries].sort((a, b) => {
    const aDom = extractDomain(a.query) || '';
    const bDom = extractDomain(b.query) || '';
    const aIdx = priorityBoards.findIndex(p => aDom.includes(p));
    const bIdx = priorityBoards.findIndex(p => bDom.includes(p));
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });

  // Cap total queries but keep both tracks represented (interleave by track).
  const trackOrder = [...new Set(prioritized.map(q => q.track))];
  const interleaved = [];
  let added = true;
  for (let round = 0; added && interleaved.length < 18; round++) {
    added = false;
    for (const t of trackOrder) {
      const q = prioritized.find(x => x.track === t && !interleaved.includes(x));
      if (q) { interleaved.push(q); added = true; if (interleaved.length >= 18) break; }
    }
  }
  const targetQueries = interleaved;

  // Apply the SAME profile-driven title filter the portal scanner uses, so
  // web-search results stay consistent with `scan.mjs` and respect the
  // user's aggressiveness setting (Conservative keeps everything).
  const activeProfile = loadProfile();
  const pf = deriveProfileFilter(activeProfile);
  const portalPos = config.title_filter?.positive;
  const rolePositives = pf.rolePositives.length
    ? pf.rolePositives
    : (Array.isArray(portalPos) ? portalPos : []);
  const skillPositives = pf.skillPositives;
  const negPositives = [...new Set([
    ...pf.negatives,
    ...(Array.isArray(config.title_filter?.negative) ? config.title_filter.negative : []),
  ])];
  const titleFilter = buildTitleFilter({
    rolePositives,
    skillPositives,
    negatives: negPositives,
    aggressiveness: loadAggressiveness(),
  });

  console.log(`Scraping ${targetQueries.length} job board queries with Playwright...\n`);

  for (let i = 0; i < targetQueries.length; i++) {
    const q = targetQueries[i];
    const domain = extractDomain(q.query);
    const searchUrl = domain ? buildSearchUrl(domain, q.query) : null;

    if (!searchUrl) {
      console.log(`  [${i + 1}/${targetQueries.length}] ${q.name} — unsupported domain (${domain})`);
      continue;
    }

    const trackTag = q.track ? ` [${q.track}]` : '';
    console.log(`  [${i + 1}/${targetQueries.length}] ${q.name}${trackTag}`);

    const jobs = await scrapeJobs(searchUrl, domain, q.track);

    const newJobs = [];
    for (const job of jobs) {
      const url = normalizeUrl(job.url);
      if (url && !seenUrls.has(url) && !pipelineUrls.has(url) && titleFilter(job.role || '')) {
        newJobs.push(job);
      }
    }

    if (newJobs.length > 0) {
      console.log(`    → ${newJobs.length} new jobs`);
      for (const j of newJobs.slice(0, 3)) {
        console.log(`       - ${j.company}: ${j.role} (${j.location})`);
      }
      if (newJobs.length > 3) console.log(`       ... and ${newJobs.length - 3} more`);
      allNew.push(...newJobs);
    } else {
      console.log(`    → ${jobs.length > 0 ? `${jobs.length} found, all already in pipeline` : 'No jobs found'}`);
    }
  }

  if (allNew.length > 0) {
    appendToPipeline(allNew);
    appendToScanHistory(allNew);
    console.log(`\n✓ Added ${allNew.length} new jobs to pipeline.md`);
  } else {
    console.log('\nNo new jobs found.');
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
