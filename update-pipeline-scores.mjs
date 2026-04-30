#!/usr/bin/env node
// Updates data/pipeline.md by moving evaluated entries from "Pendientes" to "Procesadas"
// with their score, report number, and PDF flag (based on min-score=3.0 threshold).

import fs from 'node:fs';
import path from 'node:path';

const PIPELINE = 'data/pipeline.md';
const STATE = 'batch/batch-state.tsv';
const REPORTS = 'reports';

// 1. URL → {status, report_num, score} from batch-state.tsv
// Treat a missing state file as "no completed runs yet" so a clean checkout
// or a fresh setup can run this script without crashing.
const stateLines = fs.existsSync(STATE)
  ? fs.readFileSync(STATE, 'utf8').split(/\r?\n/).filter(Boolean)
  : [];
const urlMap = new Map();
for (const line of stateLines.slice(1)) {
  const cols = line.split('\t');
  if (cols.length < 7) continue;
  const [id, url, status, , , reportNum, score] = cols;
  if (status !== 'completed') continue;
  urlMap.set(url, { id, reportNum, score });
}

// 2. report_num → report file (for slug + date) — same gentle fallback for
// the reports directory.
const reportFiles = fs.existsSync(REPORTS)
  ? fs.readdirSync(REPORTS).filter(f => f.endsWith('.md'))
  : [];
const reportByNum = new Map();
for (const f of reportFiles) {
  const m = f.match(/^(\d{3})-(.+)\.md$/);
  if (m) reportByNum.set(m[1], f);
}

if (urlMap.size === 0) {
  console.log('No completed batch runs found — leaving pipeline.md untouched.');
  process.exit(0);
}

// 3. Read pipeline.md
const original = fs.readFileSync(PIPELINE, 'utf8');
const lines = original.split(/\r?\n/);

const pending = [];
const processed = [];

// Pipeline lines may be either http(s) URLs or `local:jds/<file>` references
// (the convention LinkedIn-provider entries use because the search URL isn't
// stable without an authenticated session). Match both — dropping local: URLs
// here would silently delete every LinkedIn entry on rewrite.
function findUrl(line) {
  const m = line.match(/(?:https?:\/\/|local:jds\/)\S+/);
  return m ? m[0] : null;
}

function metaFromPending(line) {
  // Format: - [ ] {url} | {company} | {role}...
  const after = line.replace(/^- \[ \] \S+\s*/, '');
  return after.startsWith('|') ? after.replace(/^\|\s*/, '') : after;
}

function metaFromProcessed(line) {
  // Format: - [x] {report-link} | {url} | {company} | {role} | {score}/5 | PDF {emoji}
  // Strip the score and PDF columns to recover original "company | role" meta.
  const m = line.match(/^- \[x\] \S+(?:\([^)]+\))? \| \S+ \| (.+) \| [^|]+\/5 \| PDF [✅❌]\s*$/);
  return m ? m[1] : '';
}

for (const line of lines) {
  if (line.startsWith('- [ ] ')) {
    const url = findUrl(line);
    if (!url) continue;
    const meta = metaFromPending(line);
    const entry = urlMap.get(url);
    if (entry) {
      const { reportNum, score } = entry;
      const reportFile = reportByNum.get(reportNum);
      const reportLink = reportFile ? `[${reportNum}](reports/${reportFile})` : `#${reportNum}`;
      const scoreNum = parseFloat(score);
      const pdf = (!isNaN(scoreNum) && scoreNum >= 3.0) ? '✅' : '❌';
      const scoreStr = isNaN(scoreNum) ? '-/5' : `${score}/5`;
      processed.push(`- [x] ${reportLink} | ${url} | ${meta} | ${scoreStr} | PDF ${pdf}`);
    } else {
      pending.push(`- [ ] ${url}${meta ? ' | ' + meta : ''}`);
    }
  } else if (line.startsWith('- [x] ')) {
    // Already processed — re-emit, but refresh score/report from current state if available.
    const url = findUrl(line);
    if (!url) continue;
    const meta = metaFromProcessed(line);
    const entry = urlMap.get(url);
    if (entry) {
      const { reportNum, score } = entry;
      const reportFile = reportByNum.get(reportNum);
      const reportLink = reportFile ? `[${reportNum}](reports/${reportFile})` : `#${reportNum}`;
      const scoreNum = parseFloat(score);
      const pdf = (!isNaN(scoreNum) && scoreNum >= 3.0) ? '✅' : '❌';
      const scoreStr = isNaN(scoreNum) ? '-/5' : `${score}/5`;
      processed.push(`- [x] ${reportLink} | ${url} | ${meta} | ${scoreStr} | PDF ${pdf}`);
    } else {
      // Keep the existing line as-is (state file may have been pruned)
      processed.push(line);
    }
  }
}

// Sort processed by score descending; entries with no score at the bottom
processed.sort((a, b) => {
  const sa = parseFloat(a.match(/\| (\d+(?:\.\d+)?)\/5 \|/)?.[1] ?? 'NaN');
  const sb = parseFloat(b.match(/\| (\d+(?:\.\d+)?)\/5 \|/)?.[1] ?? 'NaN');
  const aHas = !isNaN(sa);
  const bHas = !isNaN(sb);
  if (aHas && bHas) return sb - sa;
  if (aHas) return -1;
  if (bHas) return 1;
  return 0;
});

// 4. Build new pipeline.md
const out = [
  '',
  '## Pendientes',
  '',
  ...pending,
  '',
  '## Procesadas',
  '',
  ...processed,
  '',
].join('\n');

fs.writeFileSync(PIPELINE, out);

console.log(`Pipeline updated:`);
console.log(`  Pendientes:  ${pending.length}`);
console.log(`  Procesadas:  ${processed.length}`);
console.log(`  Score >= 3.0 (PDF ✅): ${processed.filter(l => l.endsWith('✅')).length}`);
console.log(`  Score <  3.0 (PDF ❌): ${processed.filter(l => l.endsWith('❌')).length}`);
