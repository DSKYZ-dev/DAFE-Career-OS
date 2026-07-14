---
name: dafe-career-os
description: AI job search command center -- evaluate offers, generate CVs, scan portals, track applications
arguments: mode
user_invocable: true
user-invocable: true
argument-hint: "[scan | deep | pdf | latex | cover | eu-swe | oferta | ofertas | apply | batch | tracker | pipeline | contacto | training | project | interview-prep | interview | patterns | followup | update]"
license: MIT
---

# dafe-career-os -- Router

dafe-career-os is a multi-CLI job-search command center. The routing below is shared across supported agent CLIs even when the invocation surface differs.

## Invocation Notes

- CLIs with slash-command registration can expose this router as `/dafe-career-os`.
- Interactive Codex sessions use `codex` in the repo root. Slash commands are not guaranteed in Codex, so ask Codex to run the same mode by name if `/dafe-career-os` is unavailable.
- Headless Codex workers use `codex exec "prompt"`.
- The routing semantics below stay the same regardless of whether the entrypoint is a slash command or a natural-language prompt.

Codex prompt examples that map to the same router semantics:

```text
Evaluate this JD with dafe-career-os auto-pipeline: https://company.com/jobs/123
Run the dafe-career-os scan mode and summarize new matches.
Run the dafe-career-os pipeline mode for data/pipeline.md.
Run the dafe-career-os pdf mode for the latest evaluated role.
Run the dafe-career-os tracker mode and summarize the current statuses.
```

## Mode Routing

Determine the mode from `$mode`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `oferta` | `oferta` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `deep` | `deep` |
| `interview-prep` | `interview-prep` |
| `interview` | `interview` |
| `eu-swe` | `regional/eu-swe` |
| `pdf` | `pdf` |
| `latex` | `latex` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |
| `update` | `update` |
| `cover` | `cover` |

**Auto-pipeline detection:** If `$mode` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `$mode` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

If your CLI supports `/dafe-career-os`, show this menu. In Codex, surface the same options in plain text and map the requested mode the same way.

Concrete equivalents for Codex prompt-driven sessions:

```text
/dafe-career-os {JD}           ↔ "Evaluate this JD with dafe-career-os auto-pipeline: {JD or URL}"
/dafe-career-os scan           ↔ "Run the dafe-career-os scan mode and summarize new matches."
/dafe-career-os pipeline       ↔ "Run the dafe-career-os pipeline mode for data/pipeline.md."
/dafe-career-os pdf            ↔ "Run the dafe-career-os pdf mode for the latest evaluated role."
/dafe-career-os tracker        ↔ "Run the dafe-career-os tracker mode and summarize the current statuses."
```

Show this menu:

```
dafe-career-os -- Command Center

Available commands:
  /dafe-career-os {JD}      → AUTO-PIPELINE: evaluate + report + PDF + tracker (paste text or URL)
  /dafe-career-os pipeline  → Process pending URLs from inbox (data/pipeline.md)
  /dafe-career-os oferta    → Evaluation only A-F (no auto PDF)
  /dafe-career-os ofertas   → Compare and rank multiple offers
  /dafe-career-os contacto  → LinkedIn power move: find contacts + draft message
  /dafe-career-os deep      → Deep research prompt about company
  /dafe-career-os interview-prep → Generate company-specific interview prep doc
  /dafe-career-os interview    → Interactive profile/CV onboarding interview
  /dafe-career-os eu-swe    → Calibrate a European SWE application before CV/apply/interview
  /dafe-career-os pdf       → PDF only, ATS-optimized CV
  /dafe-career-os latex     → Export CV as LaTeX/Overleaf .tex
  /dafe-career-os cover     → Cover letter: standalone JD paste or /dafe-career-os cover {slug}
  /dafe-career-os training  → Evaluate course/cert against North Star
  /dafe-career-os project   → Evaluate portfolio project idea
  /dafe-career-os tracker   → Application status overview
  /dafe-career-os apply     → Live application assistant (reads form + generates answers)
  /dafe-career-os scan      → Scan portals and discover new offers
  /dafe-career-os batch     → Batch processing with parallel workers
  /dafe-career-os patterns  → Analyze rejection patterns and improve targeting
  /dafe-career-os followup  → Follow-up cadence tracker: flag overdue, generate drafts
  /dafe-career-os update    → Update dafe-career-os system files with diff preview + compat check

Inbox: add URLs to data/pipeline.md → /dafe-career-os pipeline
Or paste a JD directly to run the full pipeline.
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `interview-prep`, `interview`, `regional/eu-swe`, `latex`, `training`, `project`, `patterns`, `followup`, `cover`

### Modes delegated to subagent:
For `scan`, `apply` (with Playwright), and `pipeline` (3+ URLs): launch as a worker/subagent with the content of `_shared.md` + `modes/{mode}.md` injected into the worker prompt. If your CLI exposes an `Agent(...)` primitive, the call looks like this:

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="dafe-career-os {mode}"
)
```

Execute the instructions from the loaded mode file.
