// @ts-check
/**
 * focus-catalog.mjs — Resolves the user's active "job focuses" into keywords.
 *
 * A focus is a job category the user wants the scanner to look for — from the
 * system-provided starter catalog (config/focus-catalog.yml, ~20 common
 * categories spanning any industry) and/or free-text custom entries the user
 * adds themselves. Selections are stored in config/profile.yml's
 * `active_focuses` (user layer, never touched by updates).
 *
 * This is the single place "what should the scanner match on" gets resolved —
 * title-filter.mjs, auto-pipeline.mjs, and web-search.mjs all consume it
 * instead of each maintaining their own (previously inconsistent) reading of
 * profile data.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(ROOT, 'config', 'focus-catalog.yml');

/** Load the system-provided focus catalog. Returns [] if missing/invalid. */
export function loadCatalog() {
  try {
    const doc = yaml.load(readFileSync(CATALOG_PATH, 'utf-8'));
    return Array.isArray(doc?.focuses) ? doc.focuses : [];
  } catch {
    return [];
  }
}

/**
 * Turn a human-readable label like "Trading Systems Developer (Pine Script /
 * MQL5)" into clean, individually-matchable keyword phrases. Compound labels
 * read well but break literal/regex matching against real job titles
 * (title-filter.mjs's compileKeyword treats "/" and "()" as required literal
 * characters) — so split parenthetical content out, then split on "/" and
 * ",", trimming each fragment into its own standalone keyword.
 * @param {string} label
 * @returns {string[]}
 */
export function labelToKeywords(label) {
  const text = String(label || '');
  const parenMatch = text.match(/^(.*?)\(([^)]*)\)\s*$/);
  const base = parenMatch ? parenMatch[1] : text;
  const inner = parenMatch ? parenMatch[2] : '';
  return [base, inner]
    .flatMap((part) => part.split(/[/,]/))
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

/**
 * Fallback for a profile that hasn't visited Settings > Job Focus yet:
 * derive a working focus list straight from target_roles, so filtering
 * isn't a no-op out of the box just because nothing's been checked in the UI.
 */
function focusesFromTargetRoles(profile) {
  const targetRoles = (profile && profile.target_roles) || {};
  const archetypes = Array.isArray(targetRoles.archetypes) ? targetRoles.archetypes : [];
  const primary = Array.isArray(targetRoles.primary) ? targetRoles.primary.filter(Boolean) : [];

  const out = archetypes
    .filter((a) => a && a.name)
    .map((a) => ({ id: `archetype:${a.name}`, label: a.name, keywords: labelToKeywords(a.name) }));

  if (primary.length) {
    out.push({ id: 'target-roles-primary', label: 'Target roles', keywords: primary.flatMap(labelToKeywords) });
  }

  return out;
}

/**
 * Resolve the profile's `active_focuses` (catalog id references + inline
 * custom entries) into full {id, label, keywords} objects. Falls back to
 * target_roles when nothing's been actively selected yet.
 * @param {any} profile - The full parsed config/profile.yml object.
 */
export function resolveActiveFocuses(profile = {}) {
  const active = Array.isArray(profile.active_focuses) ? profile.active_focuses : [];
  if (!active.length) return focusesFromTargetRoles(profile);

  const catalog = loadCatalog();
  const byId = new Map(catalog.map((f) => [f.id, f]));

  return active
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      if (entry.id === 'custom') {
        const keywords = Array.isArray(entry.keywords) ? entry.keywords.filter(Boolean) : [];
        const label = typeof entry.label === 'string' ? entry.label.trim() : '';
        if (!label && !keywords.length) return null;
        return { id: 'custom', label: label || keywords[0], keywords: keywords.length ? keywords : [label] };
      }
      const cat = byId.get(entry.id);
      return cat ? { id: cat.id, label: cat.label, keywords: Array.isArray(cat.keywords) ? cat.keywords : [] } : null;
    })
    .filter(Boolean);
}

/** Flat, deduped, trimmed keyword list across every active focus. */
export function activeFocusKeywords(profile = {}) {
  const focuses = resolveActiveFocuses(profile);
  const all = focuses.flatMap((f) => f.keywords || []);
  return [...new Set(all.map((k) => String(k).trim()).filter(Boolean))];
}
