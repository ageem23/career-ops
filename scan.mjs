#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner with a plugin-based provider layer.
 *
 * Providers live in providers/*.mjs and are loaded at startup. Each provider
 * exports an object with:
 *   - id: string — matched against `provider:` in portals.yml
 *   - detect(entry): {url}|null — optional auto-detection from careers_url
 *   - fetch(entry, ctx): [{title,url,company,location}] — required
 *
 * A tracked_companies entry can set `provider:` explicitly to bypass
 * URL-based auto-detection, and `transport: browser` to route fetches
 * through Playwright instead of plain HTTP. Both fields are optional.
 *
 * Zero Claude API tokens — pure HTTP + JSON (or Apify, if a provider opts in).
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import path from 'path';
import yaml from 'js-yaml';

// Load .env so providers can read API tokens (e.g. APIFY_TOKEN).
// dotenv is already declared in package.json; wrap in try/catch so a
// minimal install still works for users who only use the free providers.
try {
  const { config } = await import('dotenv');
  config();
} catch {}

import { makeHttpCtx } from './providers/_http.mjs';
import { makeBrowserCtx, closeBrowser } from './providers/_browser.mjs';

const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const PROFILE_PATH = 'config/profile.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const SEMANTIC_LOG_PATH = 'data/scan-semantic-log.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const PROVIDERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'providers');

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;

// ── Provider loading ────────────────────────────────────────────────

async function loadProviders(dir) {
  const providers = new Map();
  if (!existsSync(dir)) return providers;
  const entries = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_'));
  for (const file of entries) {
    const full = path.join(dir, file);
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (err) {
      console.error(`⚠️  ${file}: failed to load — ${err.message}`);
      continue;
    }
    const p = mod.default;
    if (!p || typeof p.fetch !== 'function' || !p.id) {
      console.error(`⚠️  ${file}: skipping — default export must be { id, fetch }`);
      continue;
    }
    if (providers.has(p.id)) {
      console.error(`⚠️  ${file}: duplicate provider id "${p.id}" — keeping first`);
      continue;
    }
    providers.set(p.id, p);
  }
  return providers;
}

// Resolve which provider handles a tracked_companies entry.
// 1. Explicit `provider:` field wins.
// 2. Otherwise each provider's detect() is called in load order; first hit wins.
function resolveProvider(entry, providers) {
  if (entry.provider) {
    const p = providers.get(entry.provider);
    if (!p) return { error: `unknown provider: ${entry.provider}` };
    return { provider: p };
  }
  for (const p of providers.values()) {
    const hit = p.detect?.(entry);
    if (hit) return { provider: p };
  }
  return null;
}

// ── Title filter ────────────────────────────────────────────────────
//
// Returns an object exposing classify(title, opts) → 'reject' | 'accept' | 'neutral'.
//
//   reject  — title contains a negative keyword (hard reject, never recovered)
//   accept  — title contains a positive keyword OR opts.skipPositive set
//             (provider already pre-filtered, e.g. linkedin keyword search)
//   neutral — neither positive nor negative; sent to the semantic phase
//             (in scan.mjs main(), after parallelFetch completes) for an
//             LLM-backed match against the positive list + archetypes.
//
// Negative is always literal-substring; deliberately NOT subject to the
// semantic phase (those are intentional hard rejects).

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return {
    classify(title, opts = {}) {
      const lower = title.toLowerCase();
      if (negative.some(k => lower.includes(k))) return 'reject';
      if (opts.skipPositive) return 'accept';
      if (positive.length === 0) return 'accept';
      if (positive.some(k => lower.includes(k))) return 'accept';
      return 'neutral';
    },
  };
}

// ── Location filter ─────────────────────────────────────────────────
// Optional. If `location_filter` is absent from portals.yml, all locations pass.
// Semantics:
//   - Empty location string → pass (don't penalize missing data)
//   - `block` matches → reject (takes precedence over allow)
//   - `allow` empty → pass (already cleared block)
//   - `allow` non-empty → must match at least one keyword
// All matches are case-insensitive substring.

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const allow = (locationFilter.allow || []).map(k => k.toLowerCase());
  const block = (locationFilter.block || []).map(k => k.toLowerCase());

  return (location) => {
    if (!location) return true;
    const lower = location.toLowerCase();
    if (block.length > 0 && block.some(k => lower.includes(k))) return false;
    if (allow.length === 0) return true;
    return allow.some(k => lower.includes(k));
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

// Format an entry line for pipeline.md. Includes location as a 4th field when
// the provider supplied one — preserves it for downstream triage scoring.
// Older 3-field lines remain valid since parsers treat the 4th field as
// optional (see triage-pending.mjs and update-pipeline-scores.mjs).
function formatPipelineLine(o) {
  const base = `- [ ] ${o.url} | ${o.company} | ${o.title}`;
  return o.location ? `${base} | ${o.location}` : base;
}

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(formatPipelineLine).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(formatPipelineLine).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist. Location appended as 7th column for non-breaking
  // backward compat — older scan-history.tsv files with 6 columns still parse fine
  // since loadSeenUrls only reads column 0.
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

function appendToSemanticLog(rows, date) {
  if (rows.length === 0) return;
  if (!existsSync(SEMANTIC_LOG_PATH)) {
    writeFileSync(SEMANTIC_LOG_PATH, 'date\tverdict\ttitle\tcompany\tprovider\n', 'utf-8');
  }
  const lines = rows.map(r =>
    `${date}\t${r.verdict}\t${escapeTab(r.title)}\t${escapeTab(r.company)}\t${r.providerId}`
  ).join('\n') + '\n';
  appendFileSync(SEMANTIC_LOG_PATH, lines, 'utf-8');
}

function escapeTab(s) {
  return String(s ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noSuggest = args.includes('--no-suggest');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const loginFlag = args.indexOf('--login');
  let loginProviderId = null;
  if (loginFlag !== -1) {
    const next = args[loginFlag + 1];
    // Bare --login (or --login --some-other-flag) is almost certainly a typo;
    // falling through to a real scan would be a surprising side effect.
    if (!next || next.startsWith('--')) {
      console.error('Error: --login requires a provider id (e.g. `node scan.mjs --login linkedin`)');
      process.exit(1);
    }
    loginProviderId = next;
  }

  // 1. Load providers
  const providers = await loadProviders(PROVIDERS_DIR);
  loadedProviders = providers;
  if (providers.size === 0) {
    console.error('Error: no providers loaded from providers/');
    process.exit(1);
  }

  // 1b. Login mode — delegate to a provider's login() method and exit.
  if (loginProviderId) {
    const provider = providers.get(loginProviderId);
    if (!provider) {
      console.error(`Error: unknown provider "${loginProviderId}". Available: ${[...providers.keys()].join(', ')}`);
      process.exitCode = 1;
      return;
    }
    if (typeof provider.login !== 'function') {
      console.error(`Error: provider "${loginProviderId}" does not support --login`);
      process.exitCode = 1;
      return;
    }
    const ok = await provider.login();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  // 2. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  // Archetype descriptions for the semantic title-filter come from
  // config/profile.yml (target_roles.archetypes[].semantic_description) so
  // the user has a single place to edit. Fall back to the legacy
  // portals.yml.title_filter.archetypes block for backward compatibility
  // with setups that haven't migrated yet.
  let semanticArchetypes = [];
  if (existsSync(PROFILE_PATH)) {
    try {
      const profile = parseYaml(readFileSync(PROFILE_PATH, 'utf-8'));
      semanticArchetypes = (profile?.target_roles?.archetypes || [])
        .map(a => a?.semantic_description)
        .filter(d => typeof d === 'string' && d.trim().length > 0);
    } catch (err) {
      console.error(`⚠️  Failed to read ${PROFILE_PATH}: ${err.message}`);
    }
  }
  if (semanticArchetypes.length === 0) {
    semanticArchetypes = config.title_filter?.archetypes || [];
  }

  // 3. Resolve a provider for each enabled company
  const targets = [];
  let skippedCount = 0;
  const resolveErrors = [];
  for (const company of companies) {
    if (company.enabled === false) continue;
    if (filterCompany && !company.name.toLowerCase().includes(filterCompany)) continue;
    const resolved = resolveProvider(company, providers);
    if (!resolved) { skippedCount++; continue; }
    if (resolved.error) { resolveErrors.push({ company: company.name, error: resolved.error }); continue; }
    targets.push({ ...company, _provider: resolved.provider });
  }

  console.log(`Scanning ${targets.length} companies via providers (${skippedCount} skipped — no provider matched)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 4. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 5. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFilteredNegative = 0;
  let totalFilteredLocation = 0;
  let totalAcceptedLiteral = 0;
  let totalDupes = 0;
  const newOffers = [];
  const neutrals = [];           // { job, providerId } — sent to semantic phase
  const errors = [...resolveErrors];

  // Try-accept helper: applies dedup and pushes to newOffers if novel.
  // Returns true if accepted, false if duplicate (counters bumped accordingly).
  function tryAccept(job, source) {
    if (seenUrls.has(job.url)) { totalDupes++; return false; }
    const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key)) { totalDupes++; return false; }
    seenUrls.add(job.url);
    seenCompanyRoles.add(key);
    newOffers.push({ ...job, source });
    return true;
  }

  const tasks = targets.map(company => async () => {
    const provider = company._provider;
    const ctx = company.transport === 'browser' ? makeBrowserCtx() : makeHttpCtx();
    const skipPositive = provider.bypassPositiveFilter === true;
    try {
      const jobs = await provider.fetch(company, ctx);
      totalFound += jobs.length;

      for (const job of jobs) {
        const verdict = titleFilter.classify(job.title, { skipPositive });
        if (verdict === 'reject') {
          totalFilteredNegative++;
          continue;
        }
        // Location filter (from upstream/main) runs after title-reject so we
        // don't waste a check on jobs that wouldn't pass title anyway.
        if (!locationFilter(job.location)) {
          totalFilteredLocation++;
          continue;
        }
        if (verdict === 'neutral') {
          neutrals.push({ job, providerId: provider.id });
          continue;
        }
        // verdict === 'accept'
        if (tryAccept(job, `${provider.id}-api`)) {
          totalAcceptedLiteral++;
        }
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5b. Semantic phase — second-chance the neutral bucket against the
  // positive keyword list + optional archetype descriptions.
  //
  // Backend selection (handled inside scan-semantic.mjs):
  //   - CAREER_OPS_SEMANTIC_BACKEND=api|cli  (explicit override)
  //   - ANTHROPIC_API_KEY set                → API (faster, separate billing)
  //   - `claude` CLI in PATH                 → CLI (subscription billing)
  //   - neither                              → no backend, neutrals rejected
  //
  // On call failure (rate limit, network, etc.), neutrals are rejected with
  // the error surfaced. Negative filter has already run before this phase.
  let totalAcceptedSemantic = 0;
  let totalFilteredSemantic = 0;
  let semanticError = null;

  if (neutrals.length > 0) {
    const { hasSemanticBackend, classifyTitles } = await import('./scan-semantic.mjs');
    const backend = hasSemanticBackend();
    if (!backend) {
      console.log(`\nℹ ${neutrals.length} neutral titles rejected — set ANTHROPIC_API_KEY or install Claude Code (claude CLI) to enable semantic recovery`);
      totalFilteredSemantic = neutrals.length;
    } else {
      console.log(`\nRunning semantic check on ${neutrals.length} neutral titles (backend: ${backend})...`);
      try {
        // Dedup titles before sending — the LLM doesn't need to see "Director, Engineering" twice.
        const uniqueTitles = [...new Set(neutrals.map(n => n.job.title))];
        const decisions = await classifyTitles({
          positive: config.title_filter?.positive || [],
          archetypes: semanticArchetypes,
          titles: uniqueTitles,
        });

        // Persist every successfully-classified decision (accept + reject)
        // so we can mine the log later for filter refinements via
        // analyze-filter-patterns.mjs. Titles not in the decisions Map come
        // from chunks that errored out — we don't log those (no verdict to
        // record) and treat them as rejected for accept/reject accounting.
        const semanticLogRows = [];
        let unclassified = 0;
        for (const { job, providerId } of neutrals) {
          if (!decisions.has(job.title)) {
            unclassified++;
            continue;
          }
          const accepted = decisions.get(job.title);
          semanticLogRows.push({
            verdict: accepted ? 'ACCEPT' : 'REJECT',
            title: job.title,
            company: job.company,
            providerId,
          });
        }
        if (!dryRun) appendToSemanticLog(semanticLogRows, date);
        if (unclassified > 0) {
          console.log(`  ⚠ ${unclassified} titles unclassified (chunk failures) — treated as rejected`);
        }

        for (const { job, providerId } of neutrals) {
          if (decisions.get(job.title)) {
            if (tryAccept(job, `${providerId}-semantic`)) {
              totalAcceptedSemantic++;
            }
          } else {
            totalFilteredSemantic++;
          }
        }
      } catch (err) {
        semanticError = err.message;
        console.log(`⚠ Semantic check failed: ${err.message} — rejecting neutrals`);
        totalFilteredSemantic = neutrals.length;
      }
    }
  }

  // 6. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 7. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered (negative):   ${totalFilteredNegative}`);
  console.log(`Filtered (location):   ${totalFilteredLocation}`);
  console.log(`Accepted (literal):    ${totalAcceptedLiteral}`);
  if (neutrals.length > 0) {
    console.log(`Neutrals (semantic):   ${totalAcceptedSemantic} matched / ${totalFilteredSemantic} rejected / ${neutrals.length} total`);
  }
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);
  if (semanticError) {
    console.log(`\n⚠ Semantic phase error: ${semanticError}`);
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  // Filter-refinement suggestions from the semantic-log corpus. Surfaced
  // here so the user sees high-confidence positive/negative candidates
  // inline after every scan instead of having to remember a separate
  // command. Skipped when --no-suggest is passed, when there are too few
  // classified titles to be meaningful, or when no high-confidence terms
  // surface above threshold.
  //
  // Also persisted to tmp/last-scan-suggestions.md so a subagent or
  // /career-ops scan flow that doesn't relay stdout cleanly can still
  // recover the suggestions from disk and surface them to the user.
  if (!noSuggest && !dryRun) {
    try {
      const { summarizeForScan } = await import('./analyze-filter-patterns.mjs');
      const suggest = summarizeForScan({ topN: 3 });
      if (suggest && (suggest.suggestPositive.length || suggest.suggestNegative.length)) {
        const lines = [];
        const header = `📊 Filter refinement suggestions (last ${suggest.sinceDays}d, ${suggest.classifiedCount.toLocaleString()} classified titles):`;
        console.log('\n' + header);
        lines.push(header);

        const renderSection = (label, items, exKey) => {
          if (items.length === 0) return;
          console.log(`  ${label}:`);
          lines.push(`  ${label}:`);
          for (const s of items) {
            const pct = (s.precision * 100).toFixed(0);
            const row = `    - "${s.term}" (${s.accCount}A/${s.rejCount}R, ${pct}% accept)`;
            console.log(row);
            lines.push(row);
            const ex = s.examples[exKey][0];
            if (ex) {
              const exRow = `        e.g. ${ex.slice(0, 80)}`;
              console.log(exRow);
              lines.push(exRow);
            }
          }
        };
        renderSection('Add to title_filter.positive', suggest.suggestPositive, 'accept');
        renderSection('Add to title_filter.negative', suggest.suggestNegative, 'reject');

        const footer = `  → Full analysis: node analyze-filter-patterns.mjs   (--no-suggest to skip)`;
        console.log(footer);
        lines.push(footer);

        // Persist a stable-name copy so subagents can recover after the fact.
        try {
          mkdirSync('tmp', { recursive: true });
          const out = [
            `# Last scan filter-refinement suggestions`,
            `# Generated by scan.mjs at ${new Date().toISOString()}`,
            ``,
            ...lines,
            ``,
          ].join('\n');
          writeFileSync('tmp/last-scan-suggestions.md', out);
        } catch (err) {
          console.error(`⚠ couldn't persist suggestions to tmp/last-scan-suggestions.md: ${err.message}`);
        }
      } else {
        // No high-confidence signal — clear any stale suggestions file so a
        // subagent doesn't re-surface yesterday's output.
        try { unlinkSync('tmp/last-scan-suggestions.md'); } catch {}
      }
    } catch (err) {
      // Don't let a suggestion-render failure break the scan summary.
      console.error(`⚠ filter suggestions skipped: ${err.message}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

// Tracked across main() and the finally hook so cleanup hits the same
// provider instances that fetch() used.
let loadedProviders = null;

async function cleanupProviders() {
  if (!loadedProviders) return;
  await Promise.allSettled(
    [...loadedProviders.values()]
      .filter(p => typeof p.cleanup === 'function')
      .map(p => p.cleanup())
  );
}

main()
  .catch(err => {
    console.error('Fatal:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeBrowser();
    await cleanupProviders();
  });
