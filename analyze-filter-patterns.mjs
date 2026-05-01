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
 * CLI usage:
 *   node analyze-filter-patterns.mjs                    # default (last 30 days)
 *   node analyze-filter-patterns.mjs --since 7          # last 7 days only
 *   node analyze-filter-patterns.mjs --min-freq 10      # require >=10 occurrences
 *   node analyze-filter-patterns.mjs --top 30           # top 30 each direction
 *   node analyze-filter-patterns.mjs --no-bigrams       # tokens only
 *
 * Programmatic API (used by scan.mjs at end of scan):
 *   import { summarizeForScan } from './analyze-filter-patterns.mjs';
 *   const summary = summarizeForScan({ topN: 3 });
 *   // → null  (log missing or below minClassified threshold)
 *   //   | { classifiedCount, sinceDays, suggestPositive, suggestNegative }
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'node:url';

const LOG_PATH = 'data/scan-semantic-log.tsv';

// Tokens we never suggest — too generic to be useful as filter keywords.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'of', 'on', 'or', 'the', 'to', 'with', 'i', 'ii', 'iii', 'iv', 'v',
  'remote', 'hybrid', 'onsite', 'usa', 'us', 'eu', 'uk',
  'sr', 'jr', 'junior', 'intern',  // already covered by negative filter or seniority_boost
]);

// ── Pure helpers ────────────────────────────────────────────────────

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

function indexCorpus(rows, includeBigrams) {
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

function score(accMap, rejMap, minFreq) {
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

function rankPositive(scores, topN) {
  return scores
    .filter(s => s.precision >= 0.85 && s.accCount >= 3)
    .sort((a, b) => (b.precision - a.precision) || (b.total - a.total))
    .slice(0, topN);
}

function rankNegative(scores, topN) {
  return scores
    .filter(s => s.precision <= 0.15 && s.rejCount >= 5)
    .sort((a, b) => (a.precision - b.precision) || (b.total - a.total))
    .slice(0, topN);
}

function loadDecisions(logPath, sinceDays) {
  if (!existsSync(logPath)) return { error: `${logPath} not found` };
  const raw = readFileSync(logPath, 'utf-8').split(/\r?\n/).filter(Boolean);
  if (raw.length < 2) return { error: `${logPath} is empty` };

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
    return { error: `No semantic decisions in the last ${sinceDays} days` };
  }
  return { accepts, rejects };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Compute the full ranked analysis. Returns structured data with no I/O
 * side effects — the CLI's output formatting is the caller's job.
 *
 * On failure (log missing/empty/no-data-in-window) returns `{ error }`.
 */
export function analyzeFilterPatterns({
  logPath = LOG_PATH,
  sinceDays = 30,
  minFreq = 5,
  topN = 20,
  includeBigrams = true,
} = {}) {
  const decisions = loadDecisions(logPath, sinceDays);
  if (decisions.error) return decisions;
  const { accepts, rejects } = decisions;

  const accIdx = indexCorpus(accepts, includeBigrams);
  const rejIdx = indexCorpus(rejects, includeBigrams);

  const tokenScores = score(accIdx.tokens, rejIdx.tokens, minFreq);
  const bigramScores = includeBigrams ? score(accIdx.bgrams, rejIdx.bgrams, minFreq) : [];

  return {
    sinceDays,
    minFreq,
    topN,
    totalAccept: accepts.length,
    totalReject: rejects.length,
    totalAcceptUnique: new Set(accepts.map(r => r.title)).size,
    totalRejectUnique: new Set(rejects.map(r => r.title)).size,
    positiveTokens: rankPositive(tokenScores, topN),
    negativeTokens: rankNegative(tokenScores, topN),
    positiveBigrams: rankPositive(bigramScores, topN),
    negativeBigrams: rankNegative(bigramScores, topN),
  };
}

/**
 * Compact summary used by scan.mjs at end of scan. Returns null when:
 *   - log file missing
 *   - log has fewer than `minClassified` rows in the window (cold start
 *     where suggestions would be statistical noise)
 *
 * Otherwise returns just the top-N each direction (tokens only — bigrams
 * are noisier and the scan footer needs to stay tight).
 */
export function summarizeForScan({
  logPath = LOG_PATH,
  sinceDays = 30,
  topN = 3,
  minClassified = 50,
} = {}) {
  const result = analyzeFilterPatterns({
    logPath,
    sinceDays,
    minFreq: 5,
    topN,
    includeBigrams: false,
  });
  if (result.error) return null;
  const total = result.totalAccept + result.totalReject;
  if (total < minClassified) return null;
  return {
    classifiedCount: total,
    sinceDays,
    suggestPositive: result.positiveTokens,
    suggestNegative: result.negativeTokens,
  };
}

// ── CLI entrypoint ──────────────────────────────────────────────────

function parsePositiveIntFlag(args, flag, def) {
  const i = args.indexOf(flag);
  const raw = i !== -1 ? args[i + 1] : String(def);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`✗ ${flag} requires a positive integer, got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return n;
}

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

function main() {
  const args = process.argv.slice(2);
  const sinceDays = parsePositiveIntFlag(args, '--since', 30);
  const minFreq = parsePositiveIntFlag(args, '--min-freq', 5);
  const topN = parsePositiveIntFlag(args, '--top', 20);
  const includeBigrams = !args.includes('--no-bigrams');

  const result = analyzeFilterPatterns({ sinceDays, minFreq, topN, includeBigrams });
  if (result.error) {
    console.error(`✗ ${result.error}`);
    process.exit(1);
  }

  console.log('━'.repeat(72));
  console.log(`Filter Pattern Analysis — last ${sinceDays} days, min-freq ${minFreq}, top ${topN}`);
  console.log('━'.repeat(72));
  console.log(`Decisions:         ${result.totalAccept + result.totalReject} (${result.totalAccept} accept, ${result.totalReject} reject)`);
  console.log(`Unique titles:     ${result.totalAcceptUnique + result.totalRejectUnique} (${result.totalAcceptUnique} accept, ${result.totalRejectUnique} reject)`);
  console.log('');

  console.log('═══ POSITIVE candidates (high precision = reliable accept signal) ═══\n');
  printTable('TOKENS:', result.positiveTokens, 'positive');
  if (includeBigrams) printTable('BIGRAMS:', result.positiveBigrams, 'positive');

  console.log('═══ NEGATIVE candidates (low precision = reliable reject signal) ═══\n');
  printTable('TOKENS:', result.negativeTokens, 'negative');
  if (includeBigrams) printTable('BIGRAMS:', result.negativeBigrams, 'negative');

  console.log('━'.repeat(72));
  console.log('SUGGESTED portals.yml CHANGES (review before applying — these are heuristic)');
  console.log('━'.repeat(72));
  console.log('');

  if (result.positiveTokens.length || result.positiveBigrams.length) {
    console.log('# Add to title_filter.positive:');
    for (const s of [...result.positiveTokens, ...result.positiveBigrams].slice(0, topN)) {
      console.log(`    - "${s.term}"`);
    }
    console.log('');
  }

  if (result.negativeTokens.length || result.negativeBigrams.length) {
    console.log('# Add to title_filter.negative:');
    for (const s of [...result.negativeTokens, ...result.negativeBigrams].slice(0, topN)) {
      console.log(`    - "${s.term}"`);
    }
    console.log('');
  }

  console.log('Note: examine the sample titles before adding any keyword. A high-precision');
  console.log('term may still be a poor fit if the sample reveals it captures the wrong');
  console.log('archetype. Adding terms reduces work in the semantic phase but a bad');
  console.log('positive will let through noise; a bad negative will silently drop matches.');
}

const isCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) main();
