# Attributions

## Structural Origin

**DAFE Career OS** is an independent fork of **career-ops** (MIT) by Santiago Fernández de Valderrama (santifer). The original codebase provided the structural foundation — the evaluation framework, provider architecture, and pipeline model — which has been significantly extended, rewritten, and customized for this project's specific requirements.

Per the MIT license terms, upstream authorship is credited below. This project is not affiliated with or endorsed by santifer or the original career-ops project.

## Upstream — Original Author (credit retained)

- **career-ops** by santifer — https://santifer.io · https://github.com/santifer/career-ops
  - License: MIT (see `LICENSE`)
  - Docs: https://career-ops-docs.vercel.app
  - Companion portfolio template: https://github.com/santifer/cv-santiago
- Agent-skill spec: https://agentskills.io

The structural architecture (provider-based scanning, A-G evaluation framework, pipeline model) is derived from the career-ops project and used under MIT terms.

## This Project — Independent Work

**DAFE Career OS** — fork, rebrand, and extensive customization by Shaun E. Lear.

This project retains the original architectural patterns but includes substantial independent development:

- Pipeline architecture and evaluation framework (derived)
- Provider-based portal scanning layer (derived and extended)
- Dashboard and live-streaming SSE implementation
- Auto-apply browser automation with ATS detection
- Autonomous entry-level application loop (`autonomous-loop.mjs`)
- LLM-based tailored CV and cover letter generation
- Dual-stack networking, stale-process recovery, and reliability improvements
- Custom modes, prompts, and scoring adjustments

Contains contributions from the community (see `CONTRIBUTORS.md` for details).

## Author's Own Work

The following repositories are the author's own independent work (not derived from career-ops):

- **RCMTrendState** (private) — AI/quant trend-state analysis.
- **Universal Trading Brain** (private) — trading-brain platform.
- **DAFECharts** (private) — self-contained professional trading charting platform.
- **rise-alpha-engine** (private) — quantitative analysis engine for Indian markets.

> Note: the repositories above are currently private. They are available for collaboration or code review on request.
