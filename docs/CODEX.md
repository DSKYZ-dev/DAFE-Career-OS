# Codex Guide

DAFE Career OS supports Codex through the same shared router used by the other CLI integrations.

## How Codex maps to dafe-career-os

- `AGENTS.md` is the shared instruction source.
- Root `CODEX.md` is the thin Codex wrapper that imports `AGENTS.md`.
- This file is the human-facing guide for running dafe-career-os workflows from Codex.

## Interactive Codex

Start Codex in the repository root:

```bash
cd dafe-career-os
codex
```

Codex may not expose a native `/dafe-career-os` slash command. When it does not, ask for the same workflow in plain language:

```text
Evaluate this JD with dafe-career-os auto-pipeline: https://company.com/jobs/123
Run the dafe-career-os scan mode and summarize new matches.
Run the dafe-career-os pipeline mode for data/pipeline.md.
Run the dafe-career-os pdf mode for the latest evaluated role.
Run the dafe-career-os tracker mode and summarize the current statuses.
```

## One-shot workers

For single commands or batch workers, use `codex exec`:

```bash
codex exec "Evaluate this JD with dafe-career-os auto-pipeline: https://company.com/jobs/123"
codex exec "Run dafe-career-os scan mode in this repo and summarize new matches."
codex exec "Run dafe-career-os pipeline mode for data/pipeline.md."
codex exec "Run dafe-career-os pdf mode for the latest evaluated role."
codex exec "Run dafe-career-os tracker mode and summarize the current statuses."
```

## Notes

- If your Codex environment exposes slash commands, the shared `/dafe-career-os` router semantics still apply.
- If it does not, use the same mode names through prompts or `codex exec`.
- Browser-heavy flows such as `scan`, `pipeline`, and `apply` still depend on Playwright browser tools being available in the active agent setup.
