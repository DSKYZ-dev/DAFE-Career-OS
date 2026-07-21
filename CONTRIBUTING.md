# Contributing to DAFE Career OS

First off — thank you for taking the time to contribute! 💙 DAFE Career OS is a
community project and every fix, portal, mode, and doc improvement makes the job
search better for everyone.

The following is a set of guidelines (not rigid rules). Use your best judgment,
and feel free to propose changes to this document in a pull request.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Enhancements](#suggesting-enhancements)
- [Your First Code Contribution](#your-first-code-contribution)
- [Pull Request Process](#pull-request-process)
- [Development Setup](#development-setup)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Adding a Portal](#adding-a-portal)
- [Adding a Mode](#adding-a-mode)
- [Community & Governance](#community--governance)

## Code of Conduct

By participating, you agree to uphold the [Code of Conduct](CODE_OF_CONDUCT.md).
Be kind, be respectful, and assume good intent.

## How Can I Contribute?

### Reporting Bugs

Before creating a bug report, please search the
[existing issues](https://github.com/DSKYZ-dev/DAFE-Career-OS/issues) to avoid
duplicates. When you create a bug report, use the
[bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) and include as much
detail as possible:

- A clear, descriptive title
- Steps to reproduce (paste commands)
- Expected vs. actual behavior
- Your environment (`node --version`, OS, AI CLI used)
- Relevant log output (redact any personal data!)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. Use the
[feature request template](.github/ISSUE_TEMPLATE/feature_request.yml) and
describe:

- The problem you're trying to solve
- The proposed solution / behavior
- Any alternatives you've considered
- Mockups or examples if relevant

For larger changes, open an
[RFC discussion](https://github.com/DSKYZ-dev/DAFE-Career-OS/discussions/categories/rfc)
first so we can align before you invest time.

### Your First Code Contribution

Good first contributions:

- A new open-source **portal** in `templates/portals.example.yml`
- A **bug fix** in any `.mjs` script
- **Docs** improvements (setup, FAQ, translations)
- **Tests** in `test-all.mjs`
- A new **mode** under `modes/`

Look for issues labeled `good first issue` or `help wanted`.

## Pull Request Process

1. **Fork** the repo and create your branch from `main`
   (`git checkout -b fix/my-change`).
2. **Set up** the dev environment (see below) and make sure `npm run doctor`
   passes.
3. **Make your change.** Keep PRs focused — one logical change per PR.
4. **Test** with `node test-all.mjs --quick`. All checks must pass.
5. **Update docs** if your change affects usage (README, `docs/`, modes).
6. **Open the PR** against `main` using the PR template. Link the related issue.
7. **CI** runs automatically (`test-all.mjs`, auto-labeler, welcome bot).
   Address review feedback.
8. A maintainer reviews and merges once checks pass and the change is aligned
   with project direction.

> **Branch protection:** status checks must pass before merge. No direct pushes
> to `main` (admin bypass only).

## Development Setup

```bash
git clone https://github.com/DSKYZ-dev/DAFE-Career-OS.git
cd DAFE-Career-OS
npm install
npx playwright install chromium
npm run doctor
```

Copy and edit your local config (these files are gitignored — your personal data
never gets committed):

```bash
cp config/profile.example.yml config/profile.yml
cp templates/portals.example.yml portals.yml
# create cv.md with your CV in markdown
```

## Coding Standards

- **Language:** Node.js ES modules (`.mjs`). The dashboard is Go.
- **Style:** 2-space indent, no semicolons-free debate — match the surrounding
  file. Run `node --check <file>` before committing.
- **No secrets:** Never commit API keys, `.env`, `cv.md`, `profile.yml`, or
  `data/`. They are gitignored.
- **Source of truth:** System-layer files (`AGENTS.md`, `modes/_shared.md`,
  `*.mjs`, `templates/`, `dashboard/`) are auto-updatable. User-layer files
  (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `data/*`) are NEVER
  auto-edited by the system — respect that boundary.
- **Security:** PRs that introduce `child_process`, network calls, or file
  writes are reviewed carefully. The agent never auto-submits applications.
- **Attribution:** Keep the MIT `LICENSE` and `ATTRIBUTIONS.md` intact.

## Testing

The full suite has 855+ checks:

```bash
node test-all.mjs          # run everything
node test-all.mjs --quick  # skip the dashboard Go build (faster)
```

Add regression tests for bug fixes. New modes/scripts should include at least a
syntax + happy-path assertion.

## Adding a Portal

Edit `templates/portals.example.yml` and add a company under
`tracked_companies` with its ATS board (Greenhouse/Ashby/Lever) URL, or add a
search query under `search_queries`. Open a PR with the addition.

## Adding a Mode

1. Create `modes/your-mode.md` following the structure of `modes/oferta.md`.
2. Register it in `AGENTS.md`'s Skill Modes table and the CLI skill entrypoint
   (`.agents/skills/dafe-career-os/SKILL.md`).
3. Add a short test or doc note.

## Community & Governance

- **Discord:** https://discord.gg/8pRpHETxa4 — questions, showcases, help
- **Discussions:** RFCs, ideas, and Q&A on GitHub Discussions
- **Governance:** BDFL model with a contributor ladder — Participant →
  Contributor → Triager → Reviewer → Maintainer. See [GOVERNANCE.md](GOVERNANCE.md).
- **Security:** report vulnerabilities via GitHub Issues (do not open public
  issues for exploits — use the private reporting flow).

Thank you for contributing! 🚀
