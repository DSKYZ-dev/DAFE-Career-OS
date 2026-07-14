param(
  [string]$InstallDir = "C:\dafe-career-os",
  [switch]$Quick
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "DAFE Career OS Installer"

function Write-Step($s) { Write-Host "`n>>> $s" -ForegroundColor Cyan }
function Write-OK($s) { Write-Host "  OK  $s" -ForegroundColor Green }
function Write-Warn($s) { Write-Host "  !!  $s" -ForegroundColor Yellow }

# ── Prerequisites ──────────────────────────────────────────────────────
Write-Step "Checking prerequisites..."

$prereqs = @()
if (!(Get-Command node -ErrorAction SilentlyContinue)) { $prereqs += "Node.js (https://nodejs.org)" }
if (!(Get-Command git -ErrorAction SilentlyContinue))  { $prereqs += "Git (https://git-scm.com)" }
if ($prereqs.Count -gt 0) {
  Write-Warn "Missing: $($prereqs -join ', ')"
  Write-Host "Please install the missing prerequisites and re-run this script."
  Read-Host "Press Enter to exit"
  exit 1
}
Write-OK "Node.js $($node --version 2>$null)"
Write-OK "Git $((git --version 2>$null) -replace 'git version ','')"

# ── Clone / Pull ───────────────────────────────────────────────────────
Write-Step "Setting up DAFE Career OS at $InstallDir ..."

if (Test-Path "$InstallDir\.git") {
  Write-Host "  Repository exists. Updating..."
  Push-Location $InstallDir
  git pull --ff-only
  npm install 2>&1 | Out-Null
  Pop-Location
  Write-OK "Updated existing installation"
} else {
  if (Test-Path $InstallDir) {
    Write-Warn "Directory $InstallDir exists but is not a git repo."
    $r = Read-Host "  Remove it and clone fresh? (y/N)"
    if ($r -ne 'y') { Write-Host "Aborted."; exit }
    Remove-Item -Recurse -Force $InstallDir
  }
  git clone https://github.com/santifer/DAFE Career OS.git $InstallDir
  Push-Location $InstallDir
  npm install 2>&1 | Out-Null
  Pop-Location
  Write-OK "Cloned and installed dependencies"
}

# ── OpenCode AI CLI ────────────────────────────────────────────────────
Write-Step "Installing OpenCode CLI..."

$npmGlobal = npm root -g
$opencodePath = Join-Path (Split-Path $npmGlobal -Parent) "opencode"
$hasOpenCode = Test-Path "$opencodePath.cmd" -or (Get-Command opencode -ErrorAction SilentlyContinue)

if (!$hasOpenCode) {
  npm install -g opencode-ai 2>&1 | Out-Null
  Write-OK "Installed opencode-ai globally"
} else {
  Write-OK "OpenCode already installed"
}

# Add npm global to PATH for this session
$env:Path += ";$(Split-Path $npmGlobal -Parent)"

# ── OpenCode Integration ──────────────────────────────────────────────
Write-Step "Configuring OpenCode integration..."

$opencodeDir = "$InstallDir\.opencode"
$skillsDir = "$opencodeDir\skills\dafe-career-os"
$commandsDir = "$opencodeDir\commands"

if (!(Test-Path $skillsDir)) { New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null }
if (!(Test-Path $commandsDir)) { New-Item -ItemType Directory -Path $commandsDir -Force | Out-Null }

# Create SKILL.md
@"
# DAFE Career OS AI Job Search Skill

name: dafe-career-os
description: AI-powered job search automation — evaluate offers, generate CVs, scan portals, track applications
version: 1.0.0
"@ | Set-Content "$skillsDir\SKILL.md" -Encoding utf8

# Create commands
@"
# DAFE Career OS Interview Intel
Command: /dafe-career-os-interview-intel

Runs the dafe-career-os deep-dive mode for interview preparation at a specific company.
Usage: \`/dafe-career-os-interview-intel <company-name>\`
"@ | Set-Content "$commandsDir\dafe-career-os-interview-intel.md" -Encoding utf8

@"
# DAFE Career OS Interview Prep
Command: /dafe-career-os-interview-prep

Generates tailored interview preparation materials for a specific role.
Usage: \`/dafe-career-os-interview-prep <company> <role>\`
"@ | Set-Content "$commandsDir\dafe-career-os-interview-prep.md" -Encoding utf8

# AGENTS.md
$agentsContent = @"
# DAFE Career OS -- AI Job Search Pipeline

## Origin

This system was built and used by [santifer](https://santifer.io) to evaluate 740+ job offers, generate 100+ tailored CVs, and land a Head of Applied AI role.

**It will work out of the box, but it's designed to be made yours.**

## What is dafe-career-os

AI-powered, CLI-agnostic job search automation: pipeline tracking, offer evaluation, CV generation, portal scanning, batch processing.

### Quick Commands

- Paste a job URL → auto-evaluates
- \`/dafe-career-os\` → show all commands
- \`/dafe-career-os scan\` → search new offers
- \`/dafe-career-os pipeline\` → process pending URLs
- \`/dafe-career-os pdf\` → generate ATS CV
- \`/dafe-career-os tracker\` → application status

### Data Contract

**User Layer (NEVER auto-updated):**
- \`cv.md\`, \`config/profile.yml\`, \`modes/_profile.md\`, \`portals.yml\`

**System Layer (auto-updatable):**
- \`modes/_shared.md\`, \`modes/oferta.md\`, \`AGENTS.md\`, \`*.mjs\`, \`dashboard/*\`

### Ethical Use

**NEVER submit an application without user review.** Quality over quantity.
"@

$agentsContent | Set-Content "$InstallDir\AGENTS.md" -Encoding utf8

# OPENCODE.md
@"
> Import AGENTS.md
> Import .opencode/skills/dafe-career-os/SKILL.md
> IMPORTANT: AGENTS.md supersedes conflicting instructions in this file
"@ | Set-Content "$InstallDir\OPENCODE.md" -Encoding utf8

# Update .gitignore
$gitignore = Get-Content "$InstallDir\.gitignore" -Raw -ErrorAction SilentlyContinue
if ($gitignore -notmatch 'OPENCODE\.md') {
  @"

# OpenCode integration
OPENCODE.md
AGENTS.md
.opencode/
.opencode-commands.json
"@ | Add-Content "$InstallDir\.gitignore" -Encoding utf8
}

Write-OK "OpenCode integration files created"

# ── Profile Setup ──────────────────────────────────────────────────────
Write-Step "Setting up user profile..."

if (!(Test-Path "$InstallDir\cv.md")) {
  @"
# Your Name

<!-- PASTE YOUR CV HERE IN MARKDOWN FORMAT -->

## Summary
<!-- Brief professional summary -->

## Experience
<!-- Your work experience -->

## Education
<!-- Your education -->

## Skills
<!-- Your skills -->
"@ | Set-Content "$InstallDir\cv.md" -Encoding utf8
  Write-OK "Created placeholder cv.md — edit with your real CV"
}

if (!(Test-Path "$InstallDir\config\profile.yml")) {
  Copy-Item "$InstallDir\config\profile.example.yml" "$InstallDir\config\profile.yml"
  Write-OK "Created profile.yml from template"
}

if (!(Test-Path "$InstallDir\modes\_profile.md")) {
  Copy-Item "$InstallDir\modes\_profile.template.md" "$InstallDir\modes\_profile.md"
  Write-OK "Created _profile.md from template"
}

if (!(Test-Path "$InstallDir\portals.yml")) {
  Copy-Item "$InstallDir\templates\portals.example.yml" "$InstallDir\portals.yml"
  Write-OK "Created portals.yml from template"
}

# ── Web Dashboard ──────────────────────────────────────────────────────
Write-Step "Setting up Web Dashboard..."

$dashboardDir = "$InstallDir\dashboard-web"
$dashboardPkg = "$dashboardDir\package.json"

if (!(Test-Path $dashboardPkg)) {
  Write-Error "Dashboard package.json not found! Something went wrong during clone."
  exit 1
}

Push-Location $dashboardDir
npm install 2>&1 | Out-Null
Pop-Location
Write-OK "Web dashboard dependencies installed"

# ── Desktop Shortcuts ──────────────────────────────────────────────────
Write-Step "Creating desktop shortcuts..."

$desktop = [Environment]::GetFolderPath("Desktop")
$wshell = New-Object -ComObject WScript.Shell

# Dashboard shortcut
$shortcut = $wshell.CreateShortcut("$desktop\DAFE Career OS Dashboard.lnk")
$shortcut.TargetPath = "cmd.exe"
$shortcut.Arguments = "/c title DAFE Career OS Dashboard && cd /d $InstallDir && start http://localhost:3456 && node dashboard-web\server.js && pause"
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Description = "Launch DAFE Career OS Web Dashboard"
$shortcut.Save()
Write-OK "Desktop shortcut created: DAFE Career OS Dashboard.lnk"

# OpenCode shortcut
$shortcut2 = $wshell.CreateShortcut("$desktop\DAFE Career OS OpenCode.lnk")
$shortcut2.TargetPath = "cmd.exe"
$shortcut2.Arguments = "/k title DAFE Career OS OpenCode && cd /d $InstallDir && opencode"
$shortcut2.WorkingDirectory = $InstallDir
$shortcut2.Description = "Launch DAFE Career OS in OpenCode CLI"
$shortcut2.Save()
Write-OK "Desktop shortcut created: DAFE Career OS OpenCode.lnk"

# Menu shortcut
Write-OK "Desktop shortcut created: See DAFE Career OS Dashboard.lnk and DAFE Career OS OpenCode.lnk"

# ── Verify ─────────────────────────────────────────────────────────────
Write-Step "Verifying installation..."

Push-Location $InstallDir
$doctor = node -e "
  const fs = require('fs');
  const missing = [];
  ['cv.md','config/profile.yml','modes/_profile.md','portals.yml'].forEach(f => { if (!fs.existsSync(f)) missing.push(f); });
  const warns = [];
  if (!fs.existsSync('data/applications.md')) warns.push('applications.md missing (will be auto-created)');
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) warns.push('No API key set (use local models or .env)');
  console.log(JSON.stringify({missing,warnings:warns}));
"
$doctorObj = $doctor | ConvertFrom-Json

if ($doctorObj.missing.Count -eq 0) {
  Write-OK "All required files present"
} else {
  Write-Warn "Missing files: $($doctorObj.missing -join ', ')"
}

if ($doctorObj.warnings.Count -gt 0) {
  foreach ($w in $doctorObj.warnings) { Write-Warn $w }
}

Pop-Location

# ── Done ───────────────────────────────────────────────────────────────
Write-Step "Installation complete!"
Write-Host ""
Write-Host "  DAFE Career OS is ready at: $InstallDir"
Write-Host ""
Write-Host "  To get started:"
Write-Host "  1. Double-click 'DAFE Career OS Dashboard.lnk' on your desktop"
Write-Host "  2. Or open a terminal and run: cd $InstallDir && node dashboard-web\server.js"
Write-Host "  3. Open http://localhost:3456 in your browser"
Write-Host ""
Write-Host "  Configure your CV and profile:"
Write-Host "    CV:      $InstallDir\cv.md"
Write-Host "    Profile: $InstallDir\config\profile.yml"
Write-Host ""

if (!$Quick) {
  Write-Host "  Starting the dashboard now..."
  Push-Location $InstallDir
  Start-Process "http://localhost:3456"
  node dashboard-web\server.js
  Pop-Location
}
