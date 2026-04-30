#!/usr/bin/env node

/**
 * analyze-filter-patterns.mjs — Mine `data/scan-semantic-log.tsv` for tokens
 * and bigrams that distinguish accepted titles from rejected ones.
 *
 * The log is populated by scan.mjs every time the semantic phase runs.
 * Each row is one neutral title's verdict (ACCEPT or REJECT) from the LLM.
 *
 * The script computes per-token precision:
 *   precision = count_in_accepts / (count_in_accepts + count_in_rejects)
 *
 * Tokens with high precision (≥0.85) and frequency ≥ MIN_FREQ are candidates
 * to ADD to title_filter.positive — they reliably indicate a match.
 *
 * Tokens with low precision (≤0.15) and frequency ≥ MIN_FREQ are candidates
 * to ADD to title_filter.negative — they reliably indicate a non-match.
 *
 * Output: ranked tables with per-suggestion example titles, plus a final
 * "suggested portals.yml diff" block the user can copy-paste.
 *
 * Usage:
 *   node analyze-filter-patterns.mjs                    # default (last 30 days)
 *   node analyze-filter-patterns.mjs --since 7          # last 7 days only
 *   node analyze-filter-patterns.mjs --min-freq 10      # require >=10 occurrences
 *   node analyze-filter-patterns.mjs --top 30           # top 30 each direction
 *   node analyze-filter-patterns.mjs --no-bigrams       # tokens only
 */

import { readFileSync, existsSync } from 'fs';

const LOG_PATH = 'data/scan-semantic-log.tsv';

// CLI args
const args = process.argv.slice(2);
const argValue = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
};
const sinceDays = parseInt(argValue('--since', '30'), 10);
const minFreq = parseInt(argValue('--min-freq', '5'), 10);
const topN = parseInt(argValue('--top', '20'), 10);
const includeBigrams = !args.includes('--no-bigrams');

// Tokens we never suggest — too generic to be useful as filter keywords.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'of', 'on', 'or', 'the', 'to', 'with', 'i', 'ii', 'iii', 'iv', 'v',
  'remote', 'hybrid', 'onsite', 'usa', 'us', 'eu', 'uk',
  'sr', 'jr', 'junior', 'intern',  // already covered by negative filter or seniority_boost
]);

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }

if (!existsSync(LOG_PATH)) {
  fail(`${LOG_PATH} not found. Run \`node scan.mjs\` once with the semantic phase to populate it.`);
}

// ── Load log ────────────────────────────────────────────────────────

const raw = readFileSync(LOG_PATH, 'utf-8').split(/\r?\n/).filter(Boolean);
if (raw.length < 2) fail(`${LOG_PATH} is empty.`);

const sinceCutoff = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - sinceDays);
  return d.toISOString().slice(0, 10);
})();

const accepts = [];
const rejects = [];
for (const line of raw.slice(1)) {
  const cols = line.split('\t');
  if (cols.length < 5) continue;
  const [date, verdict, title, company, provider] = cols;
  if (date < sinceCutoff) continue;
  const row = { date, title, company, provider };
  if (verdict === 'ACCEPT') accepts.push(row);
  else if (verdict === 'REJECT') rejects.push(row);
}

if (accepts.length === 0 && rejects.length === 0) {
  fail(`No semantic decisions in the last ${sinceDays} days.`);
}

// ── Tokenize ────────────────────────────────────────────────────────

function tokenize(title) {
  return String(title)
    .toLowerCase()
    .replace(/[\(\)\[\]\{\},\.;:!?'"&|/\\@#$%^*+=<>~`]/g, ' ')
    .replace(/\s+-\s+|—|–/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t) && t.length >= 2);
}

function bigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

function indexCorpus(rows) {
  // term → { freq: total occurrences, titles: Set of unique title strings }
  const tokens = new Map();
  const bgrams = new Map();
  for (const row of rows) {
    const ts = tokenize(row.title);
    for (const t of ts) {
      if (!tokens.has(t)) tokens.set(t, { freq: 0, titles: new Set() });
      const e = tokens.get(t);
      e.freq++;
      e.titles.add(row.title);
    }
    if (includeBigrams) {
      for (const b of bigrams(ts)) {
        if (!bgrams.has(b)) bgrams.set(b, { freq: 0, titles: new Set() });
        const e = bgrams.get(b);
        e.freq++;
        e.titles.add(row.title);
      }
    }
  }
  return { tokens, bgrams };
}

const accIdx = indexCorpus(accepts);
const rejIdx = indexCorpus(rejects);

// ── Score tokens ────────────────────────────────────────────────────

function score(termMap, accMap, rejMap) {
  const allTerms = new Set([...accMap.keys(), ...rejMap.keys()]);
  const out = [];
  for (const term of allTerms) {
    const accE = accMap.get(term) || { freq: 0, titles: new Set() };
    const rejE = rejMap.get(term) || { freq: 0, titles: new Set() };
    const accCount = accE.titles.size;       // unique titles, not raw occurrences
    const rejCount = rejE.titles.size;
    const total = accCount + rejCount;
    if (total < minFreq) continue;
    const precision = accCount / total;
    out.push({
      term,
      accCount,
      rejCount,
      total,
      precision,
      examples: {
        accept: [...accE.titles].slice(0, 3),
        reject: [...rejE.titles].slice(0, 3),
      },
    });
  }
  return out;
}

const tokenScores = score('token', accIdx.tokens, rejIdx.tokens);
const bigramScores = includeBigrams ? score('bigram', accIdx.bgrams, rejIdx.bgrams) : [];

// ── Rank suggestions ────────────────────────────────────────────────

function rankPositive(scores) {
  return scores
    .filter(s => s.precision >= 0.85 && s.accCount >= 3)
    .sort((a, b) => (b.precision - a.precision) || (b.total - a.total))
    .slice(0, topN);
}

function rankNegative(scores) {
  return scores
    .filter(s => s.precision <= 0.15 && s.rejCount >= 5)
    .sort((a, b) => (a.precision - b.precision) || (b.total - a.total))
    .slice(0, topN);
}

const positiveTokens = rankPositive(tokenScores);
const negativeTokens = rankNegative(tokenScores);
const positiveBigrams = rankPositive(bigramScores);
const negativeBigrams = rankNegative(bigramScores);

// ── Output ──────────────────────────────────────────────────────────

const totalAccept = accepts.length;
const totalReject = rejects.length;
const totalAcceptUnique = new Set(accepts.map(r => r.title)).size;
const totalRejectUnique = new Set(rejects.map(r => r.title)).size;

console.log('━'.repeat(72));
console.log(`Filter Pattern Analysis — last ${sinceDays} days, min-freq ${minFreq}, top ${topN}`);
console.log('━'.repeat(72));
console.log(`Decisions:         ${totalAccept + totalReject} (${totalAccept} accept, ${totalReject} reject)`);
console.log(`Unique titles:     ${totalAcceptUnique + totalRejectUnique} (${totalAcceptUnique} accept, ${totalRejectUnique} reject)`);
console.log('');

function printTable(label, suggestions, direction) {
  if (suggestions.length === 0) {
    console.log(`  (none above threshold)\n`);
    return;
  }
  console.log(label);
  console.log('  ' + '-'.repeat(70));
  for (const s of suggestions) {
    const pct = (s.precision * 100).toFixed(0).padStart(3);
    const term = `"${s.term}"`.padEnd(28);
    const counts = `${s.accCount}A/${s.rejCount}R`.padStart(10);
    console.log(`  ${term} ${pct}% accept  ${counts}`);
    const exKey = direction === 'positive' ? 'accept' : 'reject';
    for (const ex of s.examples[exKey].slice(0, 2)) {
      console.log(`    e.g. ${ex.slice(0, 80)}`);
    }
  }
  console.log('');
}

console.log('═══ POSITIVE candidates (high precision = reliable accept signal) ═══\n');
printTable('TOKENS:', positiveTokens, 'positive');
if (includeBigrams) printTable('BIGRAMS:', positiveBigrams, 'positive');

console.log('═══ NEGATIVE candidates (low precision = reliable reject signal) ═══\n');
printTable('TOKENS:', negativeTokens, 'negative');
if (includeBigrams) printTable('BIGRAMS:', negativeBigrams, 'negative');

// ── Suggested diff ──────────────────────────────────────────────────

console.log('━'.repeat(72));
console.log('SUGGESTED portals.yml CHANGES (review before applying — these are heuristic)');
console.log('━'.repeat(72));
console.log('');

if (positiveTokens.length || positiveBigrams.length) {
  console.log('# Add to title_filter.positive:');
  for (const s of [...positiveTokens, ...positiveBigrams].slice(0, topN)) {
    console.log(`    - "${s.term}"`);
  }
  console.log('');
}

if (negativeTokens.length || negativeBigrams.length) {
  console.log('# Add to title_filter.negative:');
  for (const s of [...negativeTokens, ...negativeBigrams].slice(0, topN)) {
    console.log(`    - "${s.term}"`);
  }
  console.log('');
}

console.log('Note: examine the sample titles before adding any keyword. A high-precision');
console.log('term may still be a poor fit if the sample reveals it captures the wrong');
console.log('archetype. Adding terms reduces work in the semantic phase but a bad');
console.log('positive will let through noise; a bad negative will silently drop matches.');
