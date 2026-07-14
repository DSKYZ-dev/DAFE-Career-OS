#!/usr/bin/env node
/**
 * profile-helper.mjs — Shared access to the active profile + candidate identity.
 *
 * The active profile is selected at onboarding and stored in profiles/active.txt
 * (user-specific, gitignored). Every script reads it through here so no personal
 * data is ever hardcoded into the source.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function getActiveProfile() {
  try {
    const p = readFileSync(join(ROOT, 'profiles', 'active.txt'), 'utf-8').trim();
    if (p) return p;
  } catch {}
  return process.env.DAFE_PROFILE || 'default';
}

export function getCandidate() {
  try {
    const profile = yaml.load(readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf-8')) || {};
    return profile.candidate || {};
  } catch {
    return {};
  }
}

export function coverCandidate() {
  const c = getCandidate();
  return {
    name: c.full_name || c.name || '',
    email: c.email || '',
    location: c.location || '',
    phone: c.phone || '',
    linkedin: c.linkedin || '',
    github: c.github || '',
  };
}
