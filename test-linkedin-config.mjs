#!/usr/bin/env node

/**
 * test-linkedin-config.mjs — Validate LinkedIn entries in portals.yml
 *
 * Catches the kind of config mistakes that would otherwise surface only
 * mid-scan (after a browser has been launched, time has been wasted, etc.):
 *   - missing or empty `search` keyword
 *   - misspelled `date_posted` (must be "24" | "Week" | "Month")
 *   - `experience_level` not a list of strings
 *   - `max_results` not a positive integer
 *
 * Also checks whether the persistent auth profile exists at the expected
 * path — warns (not errors) if missing, since `--login linkedin` is the fix.
 *
 * Usage:
 *   node test-linkedin-config.mjs
 *
 * Exit codes:
 *   0 — all enabled LinkedIn entries pass
 *   1 — at least one entry has a validation error
 *   2 — portals.yml missing or unparseable
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';

const PORTALS_PATH = 'portals.yml';
const PROFILE_DIR = join(homedir(), '.career-ops-auth', 'linkedin', 'profile');
const VALID_DATE_POSTED = new Set(['24', 'Week', 'Month']);

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

function loadConfig() {
  if (!existsSync(PORTALS_PATH)) {
    fail(`${PORTALS_PATH} not found in current directory. Run from project root.`);
  }
  let raw;
  try {
    raw = readFileSync(PORTALS_PATH, 'utf-8');
  } catch (err) {
    fail(`Could not read ${PORTALS_PATH}: ${err.message}`);
  }
  try {
    return yaml.load(raw);
  } catch (err) {
    fail(`${PORTALS_PATH} is not valid YAML: ${err.message}`);
  }
}

// ── Validators ──────────────────────────────────────────────────────

function validateEntry(entry, idx) {
  const errors = [];
  const warnings = [];
  const label = entry.name || `entry #${idx + 1}`;

  // search
  if (entry.search == null || entry.search === '') {
    errors.push(`missing required field "search" (the keyword query)`);
  } else if (typeof entry.search !== 'string') {
    errors.push(`"search" must be a string, got ${typeof entry.search}`);
  } else if (entry.search.trim().length < 2) {
    errors.push(`"search" is too short (got "${entry.search}") — provide a meaningful keyword`);
  }

  // date_posted (optional)
  if (entry.date_posted != null) {
    if (typeof entry.date_posted !== 'string') {
      errors.push(`"date_posted" must be a string ("24", "Week", or "Month"), got ${typeof entry.date_posted}`);
    } else if (!VALID_DATE_POSTED.has(entry.date_posted)) {
      const suggestion = suggestDatePosted(entry.date_posted);
      const suffix = suggestion ? ` — did you mean "${suggestion}"?` : '';
      errors.push(`invalid "date_posted" value "${entry.date_posted}". Must be one of: 24, Week, Month${suffix}`);
    }
  }

  // experience_level (optional)
  if (entry.experience_level != null) {
    if (!Array.isArray(entry.experience_level)) {
      errors.push(`"experience_level" must be a YAML list, e.g. ["Director", "VP"]`);
    } else {
      for (const lvl of entry.experience_level) {
        if (typeof lvl !== 'string' || !lvl.trim()) {
          errors.push(`"experience_level" entries must be non-empty strings (got ${JSON.stringify(lvl)})`);
          break;
        }
      }
    }
  }

  // max_results (optional)
  if (entry.max_results != null) {
    if (!Number.isInteger(entry.max_results) || entry.max_results <= 0) {
      errors.push(`"max_results" must be a positive integer, got ${JSON.stringify(entry.max_results)}`);
    } else if (entry.max_results > 100) {
      warnings.push(`"max_results" is ${entry.max_results} — LinkedIn typically caps at 100/search; over-large values just slow the scan`);
    }
  }

  // enabled (optional)
  if (entry.enabled != null && typeof entry.enabled !== 'boolean') {
    errors.push(`"enabled" must be true or false, got ${JSON.stringify(entry.enabled)}`);
  }

  // delay_pages / delay_searches (optional) — providers/linkedin.mjs treats
  // these as [min, max] tuples passed to randomDelay(); a scalar or non-tuple
  // produces NaN delays at runtime. Validate the shape here.
  for (const key of ['delay_pages', 'delay_searches']) {
    if (entry[key] == null) continue;
    const v = entry[key];
    if (!Array.isArray(v) || v.length !== 2 ||
        !Number.isFinite(v[0]) || !Number.isFinite(v[1]) ||
        v[0] < 0 || v[1] < 0 || v[0] > v[1]) {
      errors.push(`"${key}" must be a [min, max] number tuple in milliseconds with 0 <= min <= max, got ${JSON.stringify(v)}`);
    }
  }

  // surface unknown top-level fields so typos don't get silently ignored.
  // Keep this list in sync with the fields LinkedIn provider actually
  // reads in providers/linkedin.mjs (location, geo_id, distance, work_mode
  // were missed here and triggered false "unknown field" warnings).
  const KNOWN = new Set([
    'name', 'provider', 'enabled', 'search',
    'date_posted', 'experience_level', 'max_results',
    'delay_pages', 'delay_searches',
    'location', 'geo_id', 'distance', 'work_mode',
  ]);
  for (const key of Object.keys(entry)) {
    if (!KNOWN.has(key)) {
      warnings.push(`unknown field "${key}" — will be ignored. Supported: ${[...KNOWN].join(', ')}`);
    }
  }

  return { label, errors, warnings, enabled: entry.enabled !== false };
}

function suggestDatePosted(input) {
  const lower = input.toLowerCase();
  if (lower.includes('day') || lower.includes('24')) return '24';
  if (lower.includes('week')) return 'Week';
  if (lower.includes('month')) return 'Month';
  return null;
}

// ── Main ────────────────────────────────────────────────────────────

const config = loadConfig();
const rawEntries = config?.tracked_companies;
if (rawEntries != null && !Array.isArray(rawEntries)) {
  console.error(`Error: tracked_companies in ${PORTALS_PATH} must be a YAML list (array), got ${typeof rawEntries}.`);
  process.exit(2);
}
const entries = rawEntries || [];
const linkedinEntries = entries
  .map((e, i) => ({ entry: e, idx: i }))
  .filter(({ entry }) => entry?.provider === 'linkedin');

console.log(`Checking ${PORTALS_PATH}...`);
console.log(`Found ${linkedinEntries.length} LinkedIn entries\n`);

if (linkedinEntries.length === 0) {
  console.log('No entries with `provider: linkedin` to validate.');
  console.log('Add entries to portals.yml under tracked_companies — see templates/portals.example.yml for the shape.');
  process.exit(0);
}

let totalErrors = 0;
let totalWarnings = 0;
let enabledCount = 0;

for (const { entry, idx } of linkedinEntries) {
  const result = validateEntry(entry, idx);
  if (result.enabled) enabledCount++;
  const status = result.errors.length === 0 ? '✓' : '✗';
  const enabledLabel = result.enabled ? '' : ' (disabled)';
  console.log(`${status} ${result.label}${enabledLabel}`);
  for (const err of result.errors) {
    console.log(`    error:   ${err}`);
    totalErrors++;
  }
  for (const w of result.warnings) {
    console.log(`    warning: ${w}`);
    totalWarnings++;
  }
}

// Auth profile check (warning only — don't fail validation if user hasn't logged in yet)
console.log('');
if (existsSync(PROFILE_DIR)) {
  console.log(`✓ Auth profile present at ${PROFILE_DIR}`);
} else if (enabledCount > 0) {
  console.log(`⚠ Auth profile NOT found at ${PROFILE_DIR}`);
  console.log('  Run: node scan.mjs --login linkedin');
  console.log('  (one-time setup; opens a visible browser)');
  totalWarnings++;
}

// Summary
console.log('');
console.log('━'.repeat(45));
console.log(`Entries:   ${linkedinEntries.length} (${enabledCount} enabled)`);
console.log(`Errors:    ${totalErrors}`);
console.log(`Warnings:  ${totalWarnings}`);

if (totalErrors > 0) {
  console.log('\nFix the errors above and re-run, then `node scan.mjs` to scan.');
  process.exit(1);
}

console.log('\nAll LinkedIn entries valid.');
