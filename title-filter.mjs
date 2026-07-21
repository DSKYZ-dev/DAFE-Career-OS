// @ts-check
/**
 * title-filter.mjs — Generic, profile-driven job-title filtering.
 *
 * The scanner no longer hard-codes any role list. Positive match terms are
 * derived from the ACTIVE USER'S profile (their target roles + skills), so the
 * same engine works for any user with any job focus and any skillset — not
 * just one person's roles. `portals.yml` title_filter remains an OPTIONAL
 * extra source (legacy / power-user override) but is no longer required.
 *
 * Aggressiveness (user-selectable, stored in data/settings.json):
 *   conservative — keep almost everything; only drop explicit user exclusions.
 *                  Positives are a soft signal only (never block). Max recall;
 *                  the LLM evaluator scores actual fit. DEFAULT (broadest —
 *                  the scan stays a wide net; evaluation narrows it down).
 *   balanced     — require a positive match (role OR skill). Drop explicit
 *                  exclusions.
 *   aggressive   — require a positive match on a TARGET ROLE specifically
 *                  (skills alone are too broad — "Python" would match every
 *                  posting). Drop explicit exclusions.
 */

import { readFileSync } from 'fs';
import { activeFocusKeywords } from './focus-catalog.mjs';

/**
 * Common multi-word technical phrases → their acronym, so a profile that
 * lists "Machine Learning Engineer" still matches real-world titles like
 * "ML Engineer". Only recognized phrases expand (no arbitrary acronyms), and
 * acronyms match on word boundaries so "ML" doesn't hit "HTML"/"Compile".
 */
const ACRONYM_EXPAND = {
  'machine learning': 'ml',
  'artificial intelligence': 'ai',
  'large language model': 'llm',
  'natural language processing': 'nlp',
  'deep learning': 'dl',
  'customer relationship management': 'crm',
  'business intelligence': 'bi',
  'user experience': 'ux',
  'user interface': 'ui',
  'information technology': 'it',
};

/** Escape a literal string for use inside a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a regex from a phrase: acronym tokens on word boundaries, other
 * tokens as escaped substrings, joined with optional non-word separators. */
function phraseToRegex(phrase) {
  const tokens = phrase.split(/\s+/).filter(Boolean);
  const parts = tokens.map((t) =>
    /^[a-z]{2,3}$/.test(t) ? `\\b${t}\\b` : escapeRe(t),
  );
  return new RegExp(parts.join('\\W?'));
}

/**
 * Compile a lowercased keyword into a matcher. Recognized multi-word phrases
 * expand so BOTH the full form and the acronym form match (e.g. "Machine
 * Learning Engineer" matches "ML Engineer"). Short all-letter acronyms
 * (2-3 chars: cfo, coo, sdr, ml…) match on WORD BOUNDARIES so "COO" no
 * longer matches "Coordinator" and "ML" no longer hits "HTML"/"Compile".
 * Multi-word phrases and keywords with non-letters (".NET", "L&D") keep
 * fast, permissive substring matching.
 * @param {string} kw
 */
export function compileKeyword(kw) {
  const lowerKw = kw.toLowerCase().trim();
  // Candidate phrases: the original plus any acronym-expanded variants.
  const candidates = new Set([lowerKw]);
  for (const phrase of Object.keys(ACRONYM_EXPAND).sort((a, b) => b.length - a.length)) {
    if (lowerKw.includes(phrase)) candidates.add(lowerKw.replace(phrase, ACRONYM_EXPAND[phrase]));
  }
  const regexes = [...candidates].map(phraseToRegex);
  return (lower) => regexes.some((re) => re.test(lower));
}

/**
 * Pull the positive/negative term sets out of the FULL active profile
 * (config/profile.yml root — NOT just the `candidate:` sub-object).
 *
 * `target_roles` (primary + archetype names) and the user's selected focus
 * catalog entries (config/focus-catalog.yml + config/profile.yml's
 * `active_focuses`, resolved via focus-catalog.mjs) drive rolePositives.
 * `skills`/`exclude_keywords` still live under `candidate:`.
 * @param {any} profile - The full parsed config/profile.yml object.
 * @returns {{ rolePositives: string[], skillPositives: string[], negatives: string[] }}
 */
export function deriveProfileFilter(profile = {}) {
  const candidate = profile.candidate || {};
  // activeFocusKeywords already covers target_roles.primary + archetype names
  // (via the fallback in focus-catalog.mjs when active_focuses isn't set yet),
  // pre-split into individually-matchable keywords — don't also mix in the
  // raw compound labels here, they'd never match anything (see labelToKeywords).
  const rolePositives = activeFocusKeywords(profile);
  const skillPositives = Array.isArray(candidate.skills) ? candidate.skills.map((s) => String(s).trim()).filter(Boolean) : [];
  const negatives = Array.isArray(candidate.exclude_keywords) ? candidate.exclude_keywords.map((s) => String(s).trim()).filter(Boolean) : [];
  return { rolePositives, skillPositives, negatives };
}

/** Read the user's aggressiveness preference (data/settings.json). */
export function loadAggressiveness(settingsPath = 'data/settings.json') {
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (['conservative', 'balanced', 'aggressive'].includes(s.filterAggressiveness)) return s.filterAggressiveness;
  } catch {}
  return 'conservative';
}

/**
 * Build the title matcher.
 * Accepts either:
 *   - legacy portals.yml title_filter node: { positive, negative }
 *   - new spec: { rolePositives, skillPositives, negatives, aggressiveness }
 * @param {any} input
 */
export function buildTitleFilter(input = {}) {
  // Legacy/optional sources (portals.yml) — still supported.
  const rolePositives = input.rolePositives ?? input.positive ?? [];
  const skillPositives = input.skillPositives ?? [];
  const negatives = input.negatives ?? input.negative ?? [];
  const aggressiveness = ['conservative', 'balanced', 'aggressive'].includes(input.aggressiveness) ? input.aggressiveness : 'conservative';

  const normalize = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((k) => typeof k === 'string')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .map(compileKeyword);

  const rolePos = normalize(rolePositives);
  const skillPos = normalize(skillPositives);
  const neg = normalize(negatives);

  return (title) => {
    const lower = (title || '').toLowerCase();

    // Explicit user exclusions always drop (highest priority).
    if (neg.length > 0 && neg.some((m) => m(lower))) return false;

    if (aggressiveness === 'conservative') {
      // Positives are a soft signal only — never block on their absence.
      return true;
    }

    const hasRole = rolePos.length > 0 && rolePos.some((m) => m(lower));
    const hasSkill = skillPos.length > 0 && skillPos.some((m) => m(lower));

    if (aggressiveness === 'aggressive') {
      // Require a TARGET ROLE match. If no role positives are defined at
      // all, fall back to "any positive" so we never accidentally nuke everything.
      if (rolePos.length === 0) return rolePos.length > 0 || skillPos.length > 0 ? (hasRole || hasSkill) : true;
      return hasRole;
    }

    // balanced (default): require any positive (role OR skill). If no
    // positives are defined, there is nothing to filter on — pass.
    if (rolePos.length === 0 && skillPos.length === 0) return true;
    return hasRole || hasSkill;
  };
}
