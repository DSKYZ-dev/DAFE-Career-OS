#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import yaml from "js-yaml";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(ROOT, "templates", "cv-template.html");
const CV_PATH = join(ROOT, "cv.md");
const PROFILE_PATH = join(ROOT, "config", "profile.yml");
const OUTPUT_ROOT = join(ROOT, "output");

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, "\"")
    .replace(/'/g, "'");
}

function safeOutputPath(raw) {
  const filename = raw.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.{2,}/g, "-");
  return join(OUTPUT_ROOT, filename);
}

function parseCV(cvText) {
  const sections = {};
  let currentSection = "";
  let content = [];
  
  for (const line of cvText.split("\n")) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      if (currentSection) {
        sections[currentSection] = content.join("\n").trim();
      }
      currentSection = headerMatch[1].toLowerCase().replace(/\s+/g, "_");
      content = [];
    } else if (currentSection) {
      content.push(line);
    }
  }
  if (currentSection) {
    sections[currentSection] = content.join("\n").trim();
  }
  return sections;
}

function parseProfile(profileText) {
  try {
    return yaml.load(profileText);
  } catch {
    return {};
  }
}

function buildContactLine(candidate) {
  const parts = [];
  if (candidate.phone) parts.push(`<a href="tel:${escapeHtml(candidate.phone)}">${escapeHtml(candidate.phone)}</a>`);
  if (candidate.email) parts.push(`<a href="mailto:${escapeHtml(candidate.email)}">${escapeHtml(candidate.email)}</a>`);
  if (candidate.linkedin) {
    const display = candidate.linkedin.replace(/^https?:\/\//, "").replace(/\/$/, "");
    parts.push(`<a href="${escapeHtml(candidate.linkedin)}">${escapeHtml(display)}</a>`);
  }
  if (candidate.portfolio) {
    const display = candidate.portfolio.replace(/^https?:\/\//, "").replace(/\/$/, "");
    parts.push(`<a href="${escapeHtml(candidate.portfolio)}">${escapeHtml(display)}</a>`);
  }
  if (candidate.location) parts.push(escapeHtml(candidate.location));
  return parts.join(' <span class="separator">|</span> ');
}

function buildCompetencies(skills) {
  if (!skills || !skills.length) return "";
  return skills.map(s => `<span class="competency-tag">${escapeHtml(s)}</span>`).join("\n");
}

function buildExperience(cvSections) {
  const exp = cvSections.experience || cvSections.work_experience || cvSections.employment || "";
  if (!exp) return "";
  
  const jobs = exp.split(/\n\s*\n/).filter(j => j.trim());
  return jobs.map(job => {
    const lines = job.trim().split("\n");
    const header = lines[0] || "";
    const bullets = lines.slice(1).filter(l => l.trim().startsWith("-") || l.trim().startsWith("\u2022"));
    
    const headerMatch = header.match(/^(.+?)\s*[|\u2013-]\s*(.+?)\s*[|\u2013-]\s*(.+?)\s*[|\u2013-]\s*(.+)$/);
    let company = "", role = "", period = "", location = "";
    if (headerMatch) {
      [, company, role, period, location] = headerMatch;
    } else {
      company = header;
    }
    
    let html = `<div class="job">\n`;
    html += `  <div class="job-header">\n`;
    html += `    <span class="job-company">${escapeHtml(company)}</span>\n`;
    if (period) html += `    <span class="job-period">${escapeHtml(period)}</span>\n`;
    html += `  </div>\n`;
    if (role) html += `  <div class="job-role">${escapeHtml(role)}</div>\n`;
    if (location) html += `  <div class="job-location">${escapeHtml(location)}</div>\n`;
    if (bullets.length > 0) {
      html += `  <ul>\n`;
      for (const bullet of bullets) {
        const text = bullet.replace(/^[-•]\s*/, "");
        const boldMatch = text.match(/^(.+?):\s*(.+)$/);
        if (boldMatch) {
          html += `    <li><strong>${escapeHtml(boldMatch[1])}:</strong> ${escapeHtml(boldMatch[2])}</li>\n`;
        } else {
          html += `    <li>${escapeHtml(text)}</li>\n`;
        }
      }
      html += `  </ul>\n`;
    }
    html += `</div>\n`;
    return html;
  }).join("\n");
}

function buildProjects(cvSections) {
  const projects = cvSections.projects || cvSections.portfolio || "";
  if (!projects) return "";
  
  const projs = projects.split(/\n\s*\n/).filter(p => p.trim());
  return projs.map(p => {
    const lines = p.trim().split("\n");
    const title = lines[0] || "";
    const desc = lines.slice(1).join("\n");
    return `<div class="project">\n  <div class="project-title">${escapeHtml(title)}</div>\n  <div class="project-desc">${escapeHtml(desc)}</div>\n</div>`;
  }).join("\n");
}

function buildEducation(cvSections) {
  const edu = cvSections.education || "";
  if (!edu) return "";
  
  const items = edu.split(/\n\s*\n/).filter(e => e.trim());
  return items.map(e => {
    const lines = e.trim().split("\n");
    const header = lines[0] || "";
    const desc = lines.slice(1).join("\n");
    
    const headerMatch = header.match(/^(.+?)\s*[|\u2013-]\s*(.+?)\s*[|\u2013-]\s*(.+)$/);
    let title = "", org = "", year = "";
    if (headerMatch) {
      [, title, org, year] = headerMatch;
    } else {
      title = header;
    }
    
    return `<div class="edu-item">\n  <div class="edu-header">\n    <span class="edu-title">${escapeHtml(title)}</span>\n    ${org ? `<span class="edu-org">${escapeHtml(org)}</span>` : ""}\n    ${year ? `<span class="edu-year">${escapeHtml(year)}</span>` : ""}\n  </div>\n  ${desc ? `<div class="edu-desc">${escapeHtml(desc)}</div>` : ""}\n</div>`;
  }).join("\n");
}

function buildCertifications(cvSections) {
  const certs = cvSections.certifications || cvSections.certificates || "";
  if (!certs) return "";
  
  const items = certs.split("\n").filter(c => c.trim().startsWith("-") || c.trim().startsWith("\u2022"));
  return items.map(c => {
    const text = c.replace(/^[-•]\s*/, "");
    const parts = text.split(/\s*[|\u2013-]\s*/);
    const title = parts[0] || "";
    const org = parts[1] || "";
    const year = parts[2] || "";
    
    return `<div class="cert-item">\n    <div class="cert-title">${escapeHtml(title)}</div>\n    ${org ? `<div class="cert-org">${escapeHtml(org)}</div>` : ""}\n    ${year ? `<div class="cert-year">${escapeHtml(year)}</div>` : ""}\n  </div>`;
  }).join("\n");
}

function buildSkills(cvSections, profile) {
  const skills = profile.candidate?.skills || cvSections.skills || [];
  if (!skills || !skills.length) return "";
  
  const categorized = {
    "Programming": [],
    "Tools & Platforms": [],
    "Methodologies": [],
    "Other": []
  };
  
  for (const skill of skills) {
    const s = skill.toLowerCase();
    if (s.includes("python") || s.includes("javascript") || s.includes("typescript") || s.includes("c#") || s.includes("java") || s.includes("go") || s.includes("rust") || s.includes("sql")) {
      categorized["Programming"].push(skill);
    } else if (s.includes("aws") || s.includes("azure") || s.includes("gcp") || s.includes("docker") || s.includes("kubernetes") || s.includes("git") || s.includes("ci/cd") || s.includes("terraform") || s.includes("linux")) {
      categorized["Tools & Platforms"].push(skill);
    } else if (s.includes("agile") || s.includes("scrum") || s.includes("kanban") || s.includes("mlops") || s.includes("devops") || s.includes("machine learning") || s.includes("ai") || s.includes("llm") || s.includes("agent")) {
      categorized["Methodologies"].push(skill);
    } else {
      categorized["Other"].push(skill);
    }
  }
  
  let html = "";
  for (const [cat, items] of Object.entries(categorized)) {
    if (items.length === 0) continue;
    html += `    <div class="skill-category">${escapeHtml(cat)}</div>\n`;
    for (const item of items) {
      html += `    <div class="skill-item">${escapeHtml(item)}</div>\n`;
    }
  }
  return html;
}

function buildHtml(cvSections, profile) {
  const candidate = profile.candidate || {};
  // Overlay dashboard Settings (data/settings.json) so contact details
  // entered in the UI actually reach the generated CV.
  try {
    const s = JSON.parse(readFileSync(join(ROOT, 'data', 'settings.json'), 'utf-8'));
    for (const k of ['email', 'phone', 'linkedin', 'portfolio', 'scoreThreshold']) {
      if (s[k] !== undefined && s[k] !== '') candidate[k] = s[k];
    }
  } catch {}
  const template = readFileSync(TEMPLATE_PATH, "utf-8");
  
  const photoHtml = candidate.photo 
    ? `<img class="cv-photo" src="${escapeHtml(candidate.photo)}" alt="Photo" />` 
    : "";
  
  const linkedinDisplay = candidate.linkedin 
    ? candidate.linkedin.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : "";
  const portfolioDisplay = candidate.portfolio
    ? candidate.portfolio.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : "";
  
  const replacements = {
    "{{LANG}}": "en",
    "{{PAGE_WIDTH}}": "800px",
    "{{PHOTO}}": photoHtml,
    "{{NAME}}": escapeHtml(candidate.full_name || candidate.name || "Candidate"),
    "{{PHONE}}": escapeHtml(candidate.phone || ""),
    "{{EMAIL}}": escapeHtml(candidate.email || ""),
    "{{LINKEDIN_URL}}": escapeHtml(candidate.linkedin || "#"),
    "{{LINKEDIN_DISPLAY}}": escapeHtml(linkedinDisplay),
    "{{PORTFOLIO_URL}}": escapeHtml(candidate.portfolio || "#"),
    "{{PORTFOLIO_DISPLAY}}": escapeHtml(portfolioDisplay),
    "{{LOCATION}}": escapeHtml(candidate.location || ""),
    "{{SECTION_SUMMARY}}": "Professional Summary",
    "{{SUMMARY_TEXT}}": escapeHtml(cvSections.summary || cvSections.profile || cvSections.about || ""),
    "{{SECTION_COMPETENCIES}}": "Core Competencies",
    "{{COMPETENCIES}}": buildCompetencies(candidate.skills || []),
    "{{SECTION_EXPERIENCE}}": "Work Experience",
    "{{EXPERIENCE}}": buildExperience(cvSections),
    "{{SECTION_PROJECTS}}": "Projects",
    "{{PROJECTS}}": buildProjects(cvSections),
    "{{SECTION_EDUCATION}}": "Education",
    "{{EDUCATION}}": buildEducation(cvSections),
    "{{SECTION_CERTIFICATIONS}}": "Certifications",
    "{{CERTIFICATIONS}}": buildCertifications(cvSections),
    "{{SECTION_SKILLS}}": "Skills",
    "{{SKILLS}}": buildSkills(cvSections, profile),
  };
  
  return template.replace(/\{\{[A-Z_]+\}\}/g, (token) => replacements[token] ?? token);
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      profile: { type: "string" },
      company: { type: "string" },
      role: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: false
  });

  if (args.help || !args.profile) {
    console.log(`
Usage: node generate-cv.mjs --profile <name> [--company <name>] [--role <title>] [--out <path>]

Generates a tailored CV PDF from the profile and cv.md template.
`);
    process.exit(args.help ? 0 : 1);
  }

  const profileName = args.profile;
  const profile = parseProfile(readFileSync(PROFILE_PATH, "utf-8"));
  const cvSections = parseCV(readFileSync(CV_PATH, "utf-8"));

  const html = buildHtml(cvSections, profile);

  let outPath = args.out || safeOutputPath(`${profileName}-cv.pdf`);
  outPath = resolve(outPath);
  mkdirSync(dirname(outPath), { recursive: true });

  const { renderHtmlToPdf } = await import("./generate-pdf.mjs");
  await renderHtmlToPdf(html, outPath, { format: "a4" });

  console.log(`\nCV PDF: ${outPath}`);
}

main().catch(err => { console.error("ERROR:", err.message); process.exit(1); });