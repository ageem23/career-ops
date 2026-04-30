#!/usr/bin/env node

/**
 * triage-pending.mjs — Heuristic ranking of pending pipeline.md entries.
 *
 * Reads `## Pendientes` from data/pipeline.md, scores each entry on cheap
 * signals (title patterns, company name recognition, URL slug hints), and
 * groups into 4 tiers:
 *
 *   Tier 1 (80+):  strong fit — evaluate today
 *   Tier 2 (60-79): good fit — evaluate if bandwidth
 *   Tier 3 (40-59): review only
 *   Tier 4 (<40):   recommend skip
 *
 * Default behavior also writes Tier 1+2 entries to batch/batch-input.tsv
 * (archiving any existing batch input + state files first), so the user can
 * immediately run `bash batch/batch-runner.sh --parallel 3 --min-score 3.0`
 * to evaluate them.
 *
 * Usage:
 *   node triage-pending.mjs              # rank + write batch input
 *   node triage-pending.mjs --dry-run    # rank only, don't write batch input
 *   node triage-pending.mjs --top 30     # show top N (still bucketed by tier)
 *   node triage-pending.mjs --tiers 3    # also include tier 3 in batch input
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';

const PIPELINE_PATH = 'data/pipeline.md';
const BATCH_INPUT_PATH = 'batch/batch-input.tsv';
const BATCH_STATE_PATH = 'batch/batch-state.tsv';

// CLI
const args = process.argv.slice(2);
const argValue = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
};
const dryRun = args.includes('--dry-run');
const topN = parseInt(argValue('--top', '50'), 10);
const includeTiers = parseInt(argValue('--tiers', '2'), 10);  // 2 = tier 1+2

// ── Heuristic scoring ───────────────────────────────────────────────

// Companies recognized as top AI-native or strong SaaS (case-insensitive).
const TOP_TIER_COMPANIES = new Set([
  'anthropic', 'openai', 'decagon', 'sierra', 'glean', 'hightouch',
  'arize ai', 'vercel', 'workos', 'cohere', 'perplexity', 'mistral',
]);
const STRONG_SAAS = new Set([
  'airtable', 'amplemarket', 'clay labs', 'coderpad', 'evermore',
  'intercom', 'n8n', 'okta', 'parloa', 'polyai', 'runpod', 'stripe',
  'supabase', 'zapier', 'datadog', 'snowflake', 'mongodb', 'gitlab',
  'rula',
]);

const ARCHETYPE_KEYWORDS = [
  // High-value AI/agentic signals
  { kw: 'agentic', weight: 8 },
  { kw: 'llm', weight: 8 },
  { kw: 'genai', weight: 8 },
  { kw: 'generative ai', weight: 8 },
  { kw: 'applied ai', weight: 8 },
  { kw: 'ai/ml', weight: 8 },
  { kw: 'inference', weight: 6 },
  { kw: 'platform', weight: 5 },
  { kw: 'infrastructure', weight: 5 },
  { kw: 'foundation', weight: 5 },
  // Lower weight — common in many irrelevant titles too
  { kw: 'machine learning', weight: 5 },
  { kw: ' ai ', weight: 4 },           // standalone " ai " — boundaries matter
  { kw: ', ai', weight: 4 },
  { kw: 'ai)', weight: 4 },
];
const ARCHETYPE_CAP = 20;

const ANTI_ARCHETYPE = [
  { kw: 'solutions engineering', weight: -15 },
  { kw: 'solutions engineer',    weight: -15 },
  { kw: 'solutions architecture', weight: -10 }, // SA track, not eng mgmt
  { kw: 'applied ai architecture', weight: -10 }, // pre-sales SA at AI labs
  { kw: 'sales engineering',     weight: -15 },
  { kw: 'pre-sales',             weight: -12 },
  { kw: 'customer success',      weight: -12 },
  { kw: 'customer experience',   weight: -10 },
  { kw: 'field engineering',     weight: -15 }, // field eng = sales/customer-engineering track
  { kw: 'field operations',      weight: -15 },
  { kw: 'revenue operations',    weight: -25 },  // common false-positive at VP level
  { kw: 'regional vice',         weight: -25 },  // sales-track VP
  { kw: 'rvp',                   weight: -25 },
  { kw: 'sales executive',       weight: -20 },
  { kw: 'account manager',       weight: -15 },
  { kw: 'account executive',     weight: -15 },
  { kw: 'business development',  weight: -15 },
  { kw: 'marketing',             weight: -15 },
  { kw: 'hardware',              weight: -10 },
  { kw: 'mechanical',            weight: -10 },
  { kw: 'civil',                 weight: -10 },
  { kw: 'manufacturing',         weight: -10 },
  { kw: 'plant',                 weight: -8 },
  { kw: 'qa engineering',        weight: -8 },
  { kw: 'data engineering',      weight: -3 },  // adjacent, not target
];

// Geographic-region suffixes — heavy penalty when paired with "Head of" /
// "VP" / "Director" because they signal regional GTM leadership for a
// non-US market. Standalone occurrences (e.g. a software role posted with
// "EMEA" in the location) get a much smaller penalty since the user IS
// open to remote work outside the US for the right role.
const REGION_SUFFIXES = ['anz', 'apac', 'emea', 'latam', 'mena', 'iberia', 'dach', 'asia pacific', 'middle east'];
const REGION_HEAD_PENALTY = -25;
const REGION_NEUTRAL_PENALTY = -3;

function scoreEntry(entry, recencyBonus) {
  const title = (entry.title || '').toLowerCase();
  const company = (entry.company || '').toLowerCase();
  const url = (entry.url || '').toLowerCase();
  const blob = `${title} ${url}`;

  let breakdown = [];
  let score = 0;

  // Seniority — take max of matching prefixes
  const seniority = (() => {
    if (/\bvp\b|vice president|head of/i.test(title)) return { v: 20, label: 'VP/Head' };
    if (/\bdirector\b/i.test(title))                   return { v: 15, label: 'Director' };
    if (/\b(sr|senior)\b.*manager/i.test(title))       return { v: 10, label: 'Sr Manager' };
    if (/\bmanager\b/i.test(title))                    return { v: 5,  label: 'Manager' };
    if (/\b(staff|principal|lead)\b/i.test(title))     return { v: 6,  label: 'Staff/Principal' };
    return null;
  })();
  if (seniority) {
    score += seniority.v;
    breakdown.push(`+${seniority.v} ${seniority.label}`);
  }

  // Archetype keywords (cap)
  let arche = 0;
  const archeHits = [];
  for (const { kw, weight } of ARCHETYPE_KEYWORDS) {
    if (blob.includes(kw)) {
      arche += weight;
      archeHits.push(kw.trim());
    }
  }
  arche = Math.min(arche, ARCHETYPE_CAP);
  if (arche > 0) {
    score += arche;
    breakdown.push(`+${arche} archetype (${archeHits.slice(0, 3).join(', ')})`);
  }

  // Anti-archetype
  for (const { kw, weight } of ANTI_ARCHETYPE) {
    if (title.includes(kw)) {
      score += weight;
      breakdown.push(`${weight} anti (${kw})`);
    }
  }

  // Geographic-region penalty — heavy if paired with leadership prefix
  // (signals regional GTM leadership for a non-US market), lighter otherwise.
  const hasLeadershipPrefix = /\b(head of|vp|vice president|director|managing director)\b/i.test(title);
  for (const region of REGION_SUFFIXES) {
    const regex = new RegExp(`\\b${region}\\b`, 'i');
    if (regex.test(title)) {
      const penalty = hasLeadershipPrefix ? REGION_HEAD_PENALTY : REGION_NEUTRAL_PENALTY;
      score += penalty;
      breakdown.push(`${penalty} region (${region})`);
      break;  // one region match is enough
    }
  }

  // Company tier
  if (TOP_TIER_COMPANIES.has(company)) {
    score += 15;
    breakdown.push(`+15 top-tier co`);
  } else if (STRONG_SAAS.has(company)) {
    score += 10;
    breakdown.push(`+10 strong SaaS`);
  } else if (company.startsWith('scraper #')) {
    score -= 2;
    breakdown.push(`-2 generic scraper`);
  } else if (company) {
    score += 3;
    breakdown.push(`+3 named co`);
  }

  // Location signals — only fire when the provider supplied a location.
  // Candidate is Chicago-based, prefers remote in the US.
  const location = (entry.location || '').toLowerCase();
  if (location) {
    if (/\bchicago\b|\bil\b/.test(location)) {
      score += 5;
      breakdown.push(`+5 Chicago/IL`);
    } else if (/\bremote\b/.test(location)) {
      score += 3;
      breakdown.push(`+3 remote`);
    } else if (/\b(sydney|australia|tokyo|japan|berlin|munich|london|uk|paris|france|amsterdam|netherlands|dublin|ireland|singapore|bangalore|india|hong kong|toronto|canada)\b/.test(location)) {
      // Non-US location with no remote indicator — heavy penalty since the
      // candidate is Chicago-based with no visa-sponsorship setup elsewhere.
      score -= 10;
      breakdown.push(`-10 non-US location (${location.slice(0, 30)})`);
    } else if (/\b(new york|nyc|san francisco|seattle|boston|austin|denver|atlanta|los angeles|miami)\b/.test(location)) {
      // Other US tech hubs — neutral, often hybrid/remote-friendly. No bonus,
      // no penalty; let the JD evaluation decide.
    }
  }

  // URL slug hint
  if (url.includes('builtin.com')) {
    if (/-ai[-/]|\/ai-|ai-engineering/.test(url)) {
      score += 3;
      breakdown.push(`+3 AI in URL`);
    }
    if (/-platform[-/]|\/platform-/.test(url)) {
      score += 2;
      breakdown.push(`+2 platform in URL`);
    }
  }

  // Recency (later in pending list = newer)
  if (recencyBonus > 0) {
    score += recencyBonus;
    breakdown.push(`+${recencyBonus} recent`);
  }

  return { score: Math.max(0, score), breakdown };
}

// ── Pipeline parser ─────────────────────────────────────────────────

function parsePending(text) {
  // Find Pendientes section
  const startIdx = text.indexOf('## Pendientes');
  if (startIdx === -1) return [];
  const endIdx = text.indexOf('\n## ', startIdx + 1);
  const block = endIdx === -1 ? text.slice(startIdx) : text.slice(startIdx, endIdx);

  const entries = [];
  for (const line of block.split('\n')) {
    if (!line.startsWith('- [ ] ')) continue;
    // Format: "- [ ] {url} | {company} | {title}[ | {location}]"
    // Split manually on " | " so trailing pipes don't get folded into title.
    const after = line.slice('- [ ] '.length);
    const parts = after.split(' | ').map(p => p.trim());
    if (parts.length < 1) continue;
    entries.push({
      url:      parts[0] || '',
      company:  parts[1] || '',
      title:    parts[2] || '',
      location: parts[3] || '',  // empty for older 3-field lines
    });
  }
  return entries;
}

function parseProcessedUrls(text) {
  // Pull all URLs that appear in `## Procesadas` (already-evaluated)
  const startIdx = text.indexOf('## Procesadas');
  if (startIdx === -1) return new Set();
  const block = text.slice(startIdx);
  const urls = new Set();
  for (const m of block.matchAll(/https?:\/\/\S+|local:\S+/g)) {
    urls.add(m[0].replace(/[)\]\s,]+$/, ''));
  }
  return urls;
}

// ── Main ────────────────────────────────────────────────────────────

if (!existsSync(PIPELINE_PATH)) {
  console.error(`✗ ${PIPELINE_PATH} not found.`);
  process.exit(1);
}

const text = readFileSync(PIPELINE_PATH, 'utf-8');
const allPending = parsePending(text);
const processedUrls = parseProcessedUrls(text);

// Filter: skip entries already evaluated (URL appears in Procesadas)
const pending = allPending.filter(e => !processedUrls.has(e.url));
const skippedAsProcessed = allPending.length - pending.length;

if (pending.length === 0) {
  console.log('No pending entries to triage.');
  process.exit(0);
}

// Score everything
const total = pending.length;
const ranked = pending.map((entry, i) => {
  const recencyBonus = Math.floor((i / Math.max(1, total - 1)) * 5);
  const { score, breakdown } = scoreEntry(entry, recencyBonus);
  return { ...entry, score, breakdown };
});
ranked.sort((a, b) => b.score - a.score);

// Bucket into tiers — calibrated against observed score distribution.
// Top picks (VP at top-tier co + AI archetype) cluster around 40-50.
// Generic scraper "Engineering Manager" baseline is ~3.
const TIER_1_MIN = 35;   // strong fit
const TIER_2_MIN = 22;   // worth evaluating
const TIER_3_MIN = 12;   // review only
const tier1 = ranked.filter(r => r.score >= TIER_1_MIN);
const tier2 = ranked.filter(r => r.score >= TIER_2_MIN && r.score < TIER_1_MIN);
const tier3 = ranked.filter(r => r.score >= TIER_3_MIN && r.score < TIER_2_MIN);
const tier4 = ranked.filter(r => r.score < TIER_3_MIN);

// ── Print ranked output ─────────────────────────────────────────────

function printEntry(rank, e) {
  const co = (e.company || '?').padEnd(28).slice(0, 28);
  const title = e.title.length > 70 ? e.title.slice(0, 67) + '...' : e.title;
  console.log(`  ${String(rank).padStart(3)}. ${String(e.score).padStart(3)}  ${co} ${title}`);
  console.log(`        ${e.url.length > 100 ? e.url.slice(0, 97) + '...' : e.url}`);
  console.log(`        ${e.breakdown.join(' · ')}`);
}

console.log('━'.repeat(78));
console.log(`Pipeline Triage — ${pending.length} pending (${skippedAsProcessed} already evaluated, skipped)`);
console.log('━'.repeat(78));
console.log(`Tier 1 (${TIER_1_MIN}+):     ${String(tier1.length).padStart(3)} entries — strong fit, evaluate today`);
console.log(`Tier 2 (${TIER_2_MIN}-${TIER_1_MIN - 1}):   ${String(tier2.length).padStart(3)} entries — worth evaluating`);
console.log(`Tier 3 (${TIER_3_MIN}-${TIER_2_MIN - 1}):   ${String(tier3.length).padStart(3)} entries — review if bandwidth`);
console.log(`Tier 4 (<${TIER_3_MIN}):     ${String(tier4.length).padStart(3)} entries — recommend skip`);
console.log('');

if (tier1.length > 0) {
  console.log(`═══ TIER 1 — strong fit (${tier1.length}) ═══`);
  tier1.slice(0, topN).forEach((e, i) => printEntry(i + 1, e));
  console.log('');
}
if (tier2.length > 0) {
  console.log(`═══ TIER 2 — worth evaluating (${tier2.length}) ═══`);
  tier2.slice(0, topN).forEach((e, i) => printEntry(i + 1, e));
  console.log('');
}
if (tier3.length > 0) {
  console.log(`═══ TIER 3 — review only (showing top 10 of ${tier3.length}) ═══`);
  tier3.slice(0, 10).forEach((e, i) => printEntry(i + 1, e));
  console.log('');
}
console.log(`(Tier 4: ${tier4.length} entries below threshold — not shown)`);
console.log('');

// ── Write batch input ───────────────────────────────────────────────

const targets = [...tier1, ...tier2];
if (includeTiers >= 3) targets.push(...tier3);

if (dryRun) {
  console.log('━'.repeat(78));
  console.log(`DRY RUN — would have written ${targets.length} entries to ${BATCH_INPUT_PATH}`);
  console.log('━'.repeat(78));
  process.exit(0);
}

if (targets.length === 0) {
  console.log('No entries qualified for batch — nothing written.');
  process.exit(0);
}

// Archive existing batch input/state so the new run starts clean.
mkdirSync('batch', { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const archive = path => {
  if (existsSync(path)) {
    const dest = `${path}.${stamp}.bak`;
    renameSync(path, dest);
    console.log(`Archived ${path} → ${dest}`);
  }
};
archive(BATCH_INPUT_PATH);
archive(BATCH_STATE_PATH);

// Build TSV: id, url, source, notes
const today = new Date().toISOString().slice(0, 10);
const lines = ['id\turl\tsource\tnotes'];
let id = 1;
for (const t of targets) {
  const notes = `${t.company} | ${t.title} (triage score ${t.score})`;
  lines.push(`${id}\t${t.url}\ttriage-${today}\t${notes.replace(/\t/g, ' ').replace(/\n/g, ' ')}`);
  id++;
}
writeFileSync(BATCH_INPUT_PATH, lines.join('\n') + '\n');

console.log('━'.repeat(78));
console.log(`✓ Wrote ${targets.length} entries to ${BATCH_INPUT_PATH}`);
console.log('━'.repeat(78));
console.log('');
console.log('Next step — run the batch:');
console.log('  bash batch/batch-runner.sh --parallel 3 --min-score 3.0 --model sonnet');
console.log('');
console.log('Or preview without running:');
console.log('  bash batch/batch-runner.sh --dry-run');
