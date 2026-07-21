#!/usr/bin/env node
/**
 * need-a-job-now.mjs — "I NEED A JOB NOW!" Standalone Entry-Level Blaster
 *
 * This is a self-contained launcher for the Autonomous Entry-Level Job
 * Application Loop. It finds roles anyone can apply to — entry-level,
 * junior, trainee, graduate, no-experience-needed, "willing to train" —
 * regardless of the user's primary focus, and generates a fully tailored
 * CV + cover letter per job, then fills (and optionally submits) the
 * application form.
 *
 * It does NOT require the AI agent harness. It is a standalone function
 * that can be run directly:
 *
 *     node need-a-job-now.mjs                # Scan + fill, stage for review
 *     node need-a-job-now.mjs --max 15       # Process at most 15 jobs
 *     node need-a-job-now.mjs --hours 2      # Run for at most 2 hours
 *
 * ⚠ SAFETY: This never submits anything itself. It fills forms and stages
 * each one in the dashboard's Review Queue — approving a staged entry there
 * is the only way an application actually gets sent (see submit-application.mjs).
 * --auto-submit is accepted for backwards compatibility but ignored.
 *
 * Requires: node_modules installed (npm install) and a configured profile
 * (config/profile.yml + cv.md). An LLM provider key (OPENROUTER_API_KEY or
 * similar) is recommended for tailoring; without it the loop falls back to
 * the base CV.
 */

import { parseArgs } from "util";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOOP = join(ROOT, "autonomous-loop.mjs");

function banner() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║                                                                        ║
║          🔥  I  N E E D   A   J O B   N O W !  🔥                      ║
║                                                                        ║
║   Autonomous entry-level / low-barrier application blaster            ║
║   Finds ANY role you can apply to — no experience needed, trainee,    ║
║   junior, graduate, "willing to train" — and fires tailored CVs +     ║
║   cover letters at them.                                              ║
║                                                                        ║
╚════════════════════════════════════════════════════════════════════════╝
`);
}

function showHelp() {
  banner();
  console.log(`Usage: node need-a-job-now.mjs [options]

Options:
  --max N           Max jobs to process (default: 20)
  --hours N         Max hours to run (default: unlimited)
  --verbose         Verbose logging
  --help            Show this help

This always fills and stages — it never submits. Approve staged entries in
the dashboard's Review Queue to actually send them.

Examples:
  node need-a-job-now.mjs
  node need-a-job-now.mjs --max 10
  node need-a-job-now.mjs --hours 3
`);
}

const { values: args } = parseArgs({
  options: {
    autoSubmit: { type: "boolean" },
    max: { type: "string" },
    hours: { type: "string" },
    dryRun: { type: "boolean" },
    force: { type: "boolean" },
    verbose: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: false,
});

if (args.help) {
  showHelp();
  process.exit(0);
}

banner();

if (args.autoSubmit) {
  console.log("⚠ --auto-submit is ignored — applications are staged in the Review Queue and submitted only from the dashboard, after you approve them.\n");
}
console.log("📋 MODE: STAGE FOR REVIEW — forms will be filled and staged, nothing will be submitted.\n");

const loopArgs = ["autonomous-loop.mjs"];
if (args.max) loopArgs.push("--max", String(args.max));
if (args.hours) loopArgs.push("--hours", String(args.hours));
if (args.force) loopArgs.push("--force");
if (args.verbose) loopArgs.push("--verbose");

console.log("🚀 Launching autonomous entry-level loop...\n");

const result = spawnSync("node", loopArgs, {
  cwd: ROOT,
  stdio: "inherit",
  timeout: 0,
});

if (result.error) {
  console.error("\n❌ Failed to launch loop:", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
