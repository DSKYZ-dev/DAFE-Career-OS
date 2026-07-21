# DAFE Career OS

<p align="center">
  <img src="branding/hero-banner.png" alt="DAFE Career OS — AI Job Search Command Center" width="900">
</p>

<p align="center">
  <em>I spent months applying to jobs the hard way. So I engineered the system I wish I had.</em><br>
  Companies use AI to filter candidates. <strong>I gave candidates AI to <em>choose</em> companies.</strong><br>
  <em>Now it's open source.</em>
</p>

<p align="center">
  <a href="https://github.com/DSKYZ-dev/DAFE-Career-OS/releases/latest"><img src="https://img.shields.io/github/v/release/DSKYZ-dev/DAFE-Career-OS?style=for-the-badge&label=release&color=2ea44f" alt="Latest release"></a>
  <a href="https://www.npmjs.com/package/dafe-career-os-init"><img src="https://img.shields.io/npm/v/dafe-career-os-init?style=for-the-badge&label=npx&color=2ea44f" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License"></a>
  <a href="TRADEMARK.md"><img src="https://img.shields.io/badge/Trademark-Policy-blue?style=for-the-badge" alt="Trademark Policy"></a>
</p>

<p align="center">
  <a href="https://discord.gg/8pRpHETxa4"><img src="https://img.shields.io/badge/Join_the_community-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  <sub>Also runs on any agent-skill-standard CLI:</sub><br>
  <img src="https://img.shields.io/badge/Claude_Code-000?style=flat&logo=anthropic&logoColor=white" alt="Claude Code">
  <img src="https://img.shields.io/badge/OpenCode-111827?style=flat&logo=terminal&logoColor=white" alt="OpenCode">
  <img src="https://img.shields.io/badge/Antigravity_CLI-4285F4?style=flat&logo=google&logoColor=white" alt="Antigravity CLI">
  <img src="https://img.shields.io/badge/Codex-412991?style=flat&logo=openai&logoColor=white" alt="Codex">
  <img src="https://img.shields.io/badge/Qwen-615CED?style=flat" alt="Qwen">
  <img src="https://img.shields.io/badge/Kimi-FF4B4B?style=flat" alt="Kimi">
  <img src="https://img.shields.io/badge/GitHub_Copilot-000?style=flat&logo=githubcopilot&logoColor=white" alt="GitHub Copilot">
  <img src="https://img.shields.io/badge/Grok_Build_CLI-000?style=flat&logo=x&logoColor=white" alt="Grok Build CLI">
  <br>
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
</p>

---

## 📖 Table of Contents

- [What Is This](#what-is-this)
- [Features](#features)
- [🚀 I Need A Job Now! (One-Click Entry-Level Blaster)](#-i-need-a-job-now-one-click-entry-level-blaster)
- [Quick Start](#quick-start)
- [CLI Integrations](#cli-integrations)
- [Usage](#usage)
- [How It Works](#how-it-works)
- [Pre-configured Portals](#pre-configured-portals)
- [Dashboard TUI](#dashboard-tui)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [Code of Conduct](#code-of-conduct)
- [License & Trademark](#license--trademark)
- [Disclaimer](#disclaimer)
- [About & Attribution](#about--attribution)

---

## What Is This

**DAFE Career OS** turns any AI coding CLI into a full job-search command center. Instead of tracking applications in a spreadsheet, you get an AI-powered pipeline that:

- **Evaluates offers** with a structured A–F scoring system (10 weighted dimensions)
- **Generates tailored PDFs** — ATS-optimized CVs customized per job description
- **Scans portals** automatically (Greenhouse, Ashby, Lever, company pages)
- **Processes in batch** — evaluate 10+ offers in parallel with sub-agents
- **Tracks everything** in a single source of truth with integrity checks
- **Blasts entry-level roles** — the *"I Need A Job Now!"* mode fires tailored CVs + cover letters at any role anyone can apply to

> **Important: This is NOT a spray-and-pray tool.** DAFE Career OS is a filter — it helps you find the few offers worth your time out of hundreds. The system strongly recommends against applying to anything scoring below 4.0/5 in normal mode. Your time is valuable, and so is the recruiter's. Always review before submitting.

DAFE Career OS is agentic: whichever AI coding CLI you choose navigates career pages with Playwright, evaluates fit by reasoning about your CV vs. the job description (not keyword matching), and adapts your resume per listing.

> **Heads up: the first evaluations won't be great.** The system doesn't know you yet. Feed it context — your CV, your career story, your proof points, your preferences. The more you nurture it, the better it gets.

---

## Features

| Feature                   | Description                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Auto-Pipeline**         | Paste a URL, get a full evaluation + PDF + tracker entry                                                                                                                 |
| **6-Block Evaluation**    | Role summary, CV match, level strategy, comp research, personalization, interview prep (STAR+R) — plus a Block G posting-legitimacy check that flags scams and ghost jobs |
| **🚀 I Need A Job Now!**   | Standalone entry-level blaster — finds junior/trainee/graduate/"willing to train" roles and auto-fills tailored applications                            |
| **Interview Story Bank**  | Accumulates STAR+Reflection stories across evaluations — 5–10 master stories that answer any behavioral question                                                       |
| **Negotiation Scripts**   | Salary negotiation frameworks, geographic discount pushback, competing-offer leverage                                                                                  |
| **ATS PDF Generation**    | Keyword-injected CVs with Space Grotesk + DM Sans design                                                                                                                 |
| **Cover Letter Generator**| Research-backed cover letters with keyword mirroring and A4 PDF via the same HTML + Playwright pipeline as CVs                                                          |
| **Portal Scanner**        | 45+ companies pre-configured + custom queries across Ashby, Greenhouse, Lever, Wellfound                                                                                |
| **Batch Processing**      | Parallel evaluation with headless CLI workers (`claude -p` / `opencode run`)                                                                                             |
| **Dashboard TUI**         | Terminal UI to browse, filter, and sort your pipeline                                                                                                                    |
| **Human-in-the-Loop**     | AI evaluates and recommends, you decide and act. The system never submits an application — you always have the final call                                               |
| **Pipeline Integrity**    | Automated merge, dedup, status normalization, health checks                                                                                                              |

<p align="center">
  <img src="branding/demo.gif" alt="DAFE Career OS demo" width="800">
</p>

<p align="center"><strong>740+ job listings evaluated · 100+ personalized CVs · 1 dream role landed</strong></p>

---

## 🚀 I Need A Job Now! (One-Click Entry-Level Blaster)

When you just need *a* job — any job — this mode finds roles anyone can apply to and fires tailored CVs + cover letters at them. It scans for **entry-level, junior, trainee, graduate, no-experience-needed, and "willing to train"** postings, generates a fully tailored CV + cover letter per role, and fills the application form.

<p align="center">
  <img src="branding/need-a-job-now-banner.png" alt="I Need A Job Now!" width="700">
</p>

**Easiest way — no terminal needed:** double-click **`Launch-DAFE-Career-OS.bat`**. It starts the app and opens your browser to the dashboard, where you click the big **🔥 I NEED A JOB NOW!** button. It scans, fills every application, and stages each one in the **Review Queue** tab — nothing is ever sent until you click Approve.

Or run directly:

```bash
# Scans, fills forms, and stages every result in the Review Queue — this
# never submits from the CLI. Open the dashboard's Review Queue to approve
# (individually or in a batch) and actually send them.
node need-a-job-now.mjs

# Limit volume / time
node need-a-job-now.mjs --max 15
node need-a-job-now.mjs --hours 3

# Skip the liveness check too — pure keyword gate
node need-a-job-now.mjs --force --max 30
```

| Flag        | Effect                                                            |
| ----------- | ------------------------------------------------------------------ |
| `--max N`   | Process at most N jobs                                             |
| `--hours N` | Run for at most N hours                                            |
| `--force`   | Skip the liveness/legitimacy check — keyword gate only             |
| `--verbose` | Verbose logging                                                    |

> ⚠ **Safety:** Entry-level jobs are never scored against your senior/target-role fit rubric (wrong tool for "any job, right now") — they're gated by keyword match plus a liveness check instead. And nothing here ever submits by itself: every staged application waits in the dashboard's **Review Queue** for one explicit click, individually or as a batch. No flag anywhere in this project submits an application without that click.

---

## Quick Start

**Fastest way — one command:**

```bash
npx dafe-career-os-init
```

> 💡 `npx` ships with [Node.js](https://nodejs.org). It runs the installer once without installing anything globally. No Node yet? Install it first.

This clones the latest release into `./dafe-career-os` and installs dependencies. Then:

```bash
cd dafe-career-os
claude   # or gemini / codex / qwen / opencode / agy / grok — open your AI CLI here
```

**On first launch, DAFE Career OS walks you through setup — your CV, profile and target roles — just by chatting. Nothing to edit by hand.**

<p align="center">
  <img src="branding/setup-screenshot.png" alt="First-run onboarding" width="700">
</p>

<details>
<summary><b>Prefer to set it up manually? (git clone)</b></summary>

```bash
git clone https://github.com/DSKYZ-dev/DAFE-Career-OS.git
cd DAFE-Career-OS && npm install
npx playwright install chromium   # only needed for PDF generation

# 2. Check setup
npm run doctor                     # Validates all prerequisites

# 3. Configure
cp config/profile.example.yml config/profile.yml  # Edit with your details
cp templates/portals.example.yml portals.yml       # Customize companies

# 4. Add your CV
# Create cv.md in the project root with your CV in markdown

# 5. Open your AI CLI in this directory
claude   # or codex / opencode / gemini / qwen / agy / grok

# Then ask your CLI to adapt the system to you:
# "Change the archetypes to backend engineering roles"
# "Translate the modes to English"
# "Add these 5 companies to portals.yml"
# "Update my profile with this CV I'm pasting"

# 6. Start using
# Paste a job URL or JD text to trigger auto-pipeline
```

</details>

> **The system is designed to be customized by your AI coding CLI itself.** Modes, archetypes, scoring weights, negotiation scripts — just ask it to change them.

See [docs/SETUP.md](docs/SETUP.md) for the full setup guide, [docs/RUNNING_ON_A_BUDGET.md](docs/RUNNING_ON_A_BUDGET.md) for running cheaply with custom/local models, and [docs/FAQ.md](docs/FAQ.md) for common questions.

---

## CLI Integrations

DAFE Career OS supports every major agent-skill-standard CLI through one shared skill entrypoint (`.agents/skills/dafe-career-os/SKILL.md`), symlinked for each CLI.

### Native CLIs (slash commands)

```bash
cd DAFE-Career-OS
agy        # Antigravity CLI
grok       # Grok Build CLI
claude     # Claude Code
opencode   # OpenCode
```

Use the unified command:

```
/dafe-career-os "Senior AI Engineer at Anthropic..."
/dafe-career-os pipeline
/dafe-career-os scan
/dafe-career-os pdf
/dafe-career-os tracker
```

### Codex (plain-language)

Slash commands aren't guaranteed in Codex. Ask in plain language or use `codex exec`:

```bash
codex exec "Evaluate this JD with dafe-career-os auto-pipeline: https://company.com/jobs/123"
codex exec "Run dafe-career-os scan mode and summarize new matches."
```

### Standalone Gemini API Script (no CLI install)

```bash
cp .env.example .env          # set GEMINI_API_KEY
npm install
node gemini-eval.mjs "We are looking for a Senior AI Engineer..."
```

> **Free tier:** Native CLI uses Google OAuth; the API script uses `gemini-3.5-flash` (free tier, no billing required — check [ai.google.dev](https://ai.google.dev/gemini-api/docs/models) for current rate limits, they change over time).

---

## Usage

```
/dafe-career-os                → Show all available commands
/dafe-career-os {paste a JD}   → Full auto-pipeline (evaluate + PDF + tracker)
/dafe-career-os scan           → Scan portals for new offers
/dafe-career-os pdf            → Generate ATS-optimized CV
/dafe-career-os cover          → Cover letter generator
/dafe-career-os batch          → Batch evaluate multiple offers
/dafe-career-os tracker        → View application status
/dafe-career-os apply          → Fill application forms with AI
/dafe-career-os pipeline       → Process pending URLs
/dafe-career-os contacto       → LinkedIn outreach message
/dafe-career-os deep           → Deep company research
/dafe-career-os training       → Evaluate a course/cert
/dafe-career-os project        → Evaluate a portfolio project
```

Or just paste a job URL or description directly — DAFE Career OS auto-detects it and runs the full pipeline.

---

## How It Works

```
You paste a job URL or description
        │
        ▼
┌──────────────────┐
│  Archetype       │  Classifies: LLMOps / Agentic / PM / SA / FDE / Transformation
│  Detection       │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  A–F Evaluation  │  Match, gaps, comp research, STAR stories
│  (reads cv.md)   │
└────────┬─────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
 Report  PDF  Tracker
  .md   .pdf   .tsv
```

---

## Pre-configured Portals

The scanner ships with **45+ companies** ready to scan and **19 search queries** across major job boards. Copy `templates/portals.example.yml` to `portals.yml` and add your own:

- **AI Labs:** Anthropic, OpenAI, Mistral, Cohere, LangChain, Pinecone
- **Voice AI:** ElevenLabs, PolyAI, Parloa, Hume AI, Deepgram, Vapi, Bland AI
- **AI Platforms:** Retool, Airtable, Vercel, Temporal, Glean, Arize AI
- **Contact Center:** Ada, LivePerson, Sierra, Decagon, Talkdesk, Genesys
- **Enterprise:** Salesforce, Twilio, Gong, Dialpad
- **LLMOps:** Langfuse, Weights & Biases, Lindy, Cognigy, Speechmatics
- **Automation:** n8n, Zapier, Make.com
- **European:** Factorial, Attio, Tinybird, Clarity AI, Travelperk

21 provider modules cover ATS APIs, board-wide feeds, XML/RSS feeds, markdown feeds, and local parsers. See [docs/SUPPORTED_JOB_BOARDS.md](docs/SUPPORTED_JOB_BOARDS.md).

Drop expired postings with a Playwright liveness check:

```bash
node scan.mjs --verify          # zero-token discovery + Playwright liveness check
```

---

## Web Dashboard (no terminal needed)

This is the **recommended way to use DAFE Career OS** — a website that runs on your own computer. You click buttons; you never type commands.

1. Double-click **`Launch-DAFE-Career-OS.bat`** (Windows) or run `node dashboard.mjs` (Mac/Linux).
2. Your browser opens to **http://localhost:3456**.

From the dashboard you can:

- Click **🔥 I NEED A JOB NOW!** to scan entry-level roles and stage tailored applications for you.
- Browse every job in a table with a per-row **Apply** button that fills and stages it.
- Review every staged application in the **Review Queue** tab — approve individually or in a batch, or reject. A CAPTCHA/challenge on a listing is flagged there for you to solve yourself; nothing is ever auto-solved.
- Search, filter, and sort your pipeline; change an application's status with one click.
- Pick your **Job Focus** in Settings — a 20+ category starter catalog plus your own custom focuses — so the scanner looks for what you actually do, not just one hard-coded track.
- Upload your **resume** (PDF, or paste text) directly in Settings — no dependency on LinkedIn access.
- Choose your **LLM provider** in Settings: Gemini, OpenRouter, OpenAI, Anthropic, or Ollama (local, free — or Ollama Cloud with your own key).
- Open the **War Room** for funnel stats, follow-ups due, and track performance.
- Use **Continuous** mode to keep evaluating and staging automatically until the pipeline is empty.

```bash
node dashboard.mjs              # start the web dashboard on http://localhost:3456
```

> 💡 The dashboard fills every application form for you, but it never clicks Submit on its own — that only happens when you click Approve on a staged entry in the Review Queue, one job or a batch at a time.

## Dashboard TUI

A built-in terminal dashboard is also available for browsing the pipeline visually:

```bash
npm run serve:dashboard   # launch the TUI
npm run build:dashboard   # optional: build the standalone binary
```

Features: 6 filter tabs, 4 sort modes, grouped/flat view, lazy-loaded previews, inline status changes.

<p align="center">
  <img src="branding/dashboard-screenshot.png" alt="Dashboard TUI" width="800">
</p>

---

## Project Structure

```
DAFE-Career-OS/
├── AGENTS.md                    # Canonical agent instructions (all CLIs)
├── CLAUDE.md / CODEX.md / OPENCODE.md / GEMINI.md   # CLI wrappers
├── cv.md                        # Your CV (gitignored, you create it)
├── config/
│   └── profile.example.yml      # Template for your profile
├── modes/                       # 15 skill modes
│   ├── _shared.md               # Shared context
│   ├── oferta.md                # Single evaluation
│   ├── pdf.md / cover.md        # PDF + cover letter generation
│   ├── scan.md / batch.md       # Portal scanner + batch
│   └── autonomous.md            # "I Need A Job Now!" mode
├── templates/                   # CV/portal/state templates
├── batch/                       # Batch worker prompt + runner
├── dashboard/                   # Go TUI pipeline viewer
├── data/                        # Tracking data (gitignored)
├── reports/                     # Evaluation reports (gitignored)
├── output/                      # Generated PDFs (gitignored)
├── branding/                    # Logos, banners, screenshots for this README
├── docs/                        # Setup, customization, budget, architecture
└── examples/                    # Sample CV, report, proof points
```

---

## Tech Stack

- **Agent:** AI coding CLI with shared skills and modes (`AGENTS.md` + CLI wrapper)
- **PDF:** Playwright + HTML template (Space Grotesk + DM Sans)
- **Cover letters:** HTML template + Playwright (A4 PDF, same pipeline as CVs)
- **Scanner:** Playwright + Greenhouse/Ashby/Lever APIs + WebSearch
- **Dashboard:** Go + Bubble Tea + Lipgloss (Catppuccin Mocha theme)
- **Data:** Markdown tables + YAML config + TSV batch files

---

## Contributing

We love contributions! 💙 Whether it's a bug fix, a new portal, a mode, or docs — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full guide.

Quick start for contributors:

```bash
git clone https://github.com/DSKYZ-dev/DAFE-Career-OS.git
cd DAFE-Career-OS && npm install
npm run doctor
node test-all.mjs --quick   # run the test suite
```

All PRs run `test-all.mjs` (855+ checks) via GitHub Actions. Branch protection requires status checks to pass before merge.

---

## Code of Conduct

This project adheres to the **Contributor Covenant 2.1**. We are committed to a welcoming, harassment-free experience for everyone. Read the full text in **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)**.

By participating, you agree to uphold these standards. Report issues to the maintainers via GitHub Issues.

---

## License & Trademark

The code is licensed under the [MIT License](LICENSE). The "DAFE Career OS" name and brand are governed by the [Trademark Policy](TRADEMARK.md) — permissive for community use, reserved for commercial product naming and endorsement.

DAFE Career OS is an independent fork of **career-ops** (MIT) by Santiago Fernández de Valderrama (santifer). Upstream authorship is credited in [ATTRIBUTIONS.md](ATTRIBUTIONS.md). The original `LICENSE` copyright is preserved.

---

## Disclaimer

**DAFE Career OS is a local, open-source tool, NOT a hosted service.** By using this software, you acknowledge:

1. **You control your data.** Your CV, contact info, and personal data stay on your machine and are sent directly to the AI provider you choose. We do not collect, store, or have access to any of your data.
2. **You control the AI.** Default prompts instruct the AI not to auto-submit applications, but AI models can behave unpredictably. **Always review AI-generated content before submitting.**
3. **You comply with third-party ToS.** Use this tool in accordance with the Terms of Service of the career portals you interact with. Do not spam employers or overwhelm ATS systems.
4. **No guarantees.** Evaluations are recommendations, not truth. The authors are not liable for employment outcomes, rejected applications, or account restrictions.

See [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) for full details.

---

## About & Attribution

DAFE Career OS is maintained by **DSKYZ-dev** (Shaun E. Lear). Originally forked from **career-ops** by santifer (MIT), this project has been rebranded and extended with new features including the autonomous entry-level application loop, LLM-tailored CV/cover-letter generation, and a live dashboard. See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for full details.

<p align="center">
  <a href="https://discord.gg/8pRpHETxa4"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/DSKYZ-dev/DAFE-Career-OS"><img src="https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub"></a>
</p>

<p align="center"><sub>© 2026 DSKYZ-dev · Fork of career-ops (MIT) by santifer</sub></p>
