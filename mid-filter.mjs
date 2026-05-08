#!/usr/bin/env node
// mid-filter.mjs — JD-snippet archetype filter for `## Pendientes` in pipeline.md.
//
// Why: title-only filters can't distinguish role scope when the same title
// (e.g. "Director of Engineering") spans 5-person startups to 50K-person
// enterprises. Full Sonnet batch evaluations CAN distinguish, but at ~3-5 min
// per job. This sits in between: pull a ~1500-char JD snippet, send a batched
// Haiku call with the candidate's archetypes from config/profile.yml, and
// reject scores < threshold before they reach the full batch.
//
// Strategy:
//   1. Parse pending entries from data/pipeline.md
//   2. For each entry, fetch a JD snippet:
//      - local:jds/{file}.md → strip frontmatter, take body
//      - http(s)://...       → HTTP fetch, strip HTML tags, find the meat
//   3. Batch the snippets through Haiku with archetype context
//   4. Move scores < threshold to ## Filtered (mid-{date})
//   5. Keep accepted entries unchanged in ## Pendientes
//
// Usage:
//   node mid-filter.mjs                  # apply (writes backup .bak)
//   node mid-filter.mjs --dry-run        # report only
//   node mid-filter.mjs --min-score 3.5  # tighter threshold (default 3)
//   node mid-filter.mjs --snippet-chars 2000  # bigger snippet (default 1500)

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { hasSemanticBackend } from './scan-semantic.mjs';
import { fetchText } from './providers/_http.mjs';

const PIPELINE = 'data/pipeline.md';
const PROFILE = 'config/profile.yml';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const argValue = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const MIN_SCORE = parseFloat(argValue('--min-score', '3'));
const SNIPPET_CHARS = parseInt(argValue('--snippet-chars', '1500'), 10);

// Match scan-semantic.mjs: same model, same env-var conventions.
const MODEL = 'claude-haiku-4-5-20251001';
const MODEL_ALIAS = 'haiku';
const MAX_TOKENS = 8192;
const CLI_TIMEOUT_MS = 360_000;
// Smaller chunk than title-semantic (CHUNK_SIZE=1500 there) since each snippet
// is ~1500 chars vs ~50 per title. 30 jobs × 1500 chars = ~45K char prompt;
// well under the model context window with headroom for archetype context.
const CHUNK_SIZE = 30;
const FETCH_CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 30_000;

const backend = hasSemanticBackend();
if (!backend) {
  console.error('No semantic backend. Set ANTHROPIC_API_KEY or install the claude CLI.');
  process.exit(1);
}
console.log(`backend: ${backend} | min-score: ${MIN_SCORE} | snippet: ${SNIPPET_CHARS} chars`);

// ── Archetypes from profile.yml ─────────────────────────────────────
const profile = yaml.load(readFileSync(PROFILE, 'utf8'));
const archetypes = (profile?.target_roles?.archetypes || []).map(a => ({
  name: a.name,
  level: a.level || 'unspecified',
  fit: a.fit || 'unspecified',
  description: a.semantic_description || `${a.name} (${a.level || 'role'}, ${a.fit || 'fit'})`,
}));
if (archetypes.length === 0) {
  console.error('No archetypes found in config/profile.yml under target_roles.archetypes');
  process.exit(1);
}
console.log(`${archetypes.length} archetypes loaded`);

// ── Pipeline parser ─────────────────────────────────────────────────
const text = readFileSync(PIPELINE, 'utf8');
const lines = text.split(/\r?\n/);
let pStart = -1;
let pEnd = lines.length;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === '## Pendientes') {
    pStart = i;
  } else if (pStart >= 0 && lines[i].startsWith('## ')) {
    pEnd = i;
    break;
  }
}
if (pStart < 0) {
  console.error('No `## Pendientes` section in pipeline.md');
  process.exit(1);
}

const PEND_RE = /^- \[ \] (\S+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)(?:\s*\|\s*(.+?))?\s*$/;
const entries = [];
for (let i = pStart + 1; i < pEnd; i++) {
  const m = lines[i].match(PEND_RE);
  if (!m) continue;
  entries.push({
    url: m[1],
    company: m[2].trim(),
    title: m[3].trim(),
    location: (m[4] || '').trim(),
    raw: lines[i],
  });
}
console.log(`${entries.length} pending entries`);
if (entries.length === 0) {
  console.log('Nothing to filter.');
  process.exit(0);
}

// ── Snippet extraction ──────────────────────────────────────────────
function stripFrontmatter(s) {
  return s.startsWith('---') ? s.replace(/^---[\s\S]*?\n---\n?/, '') : s;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeat(plain) {
  // Anchor-first: try to find a "Responsibilities" / "About this role" /
  // "What you'll do" section header. JDs that have one tend to put the
  // useful content right after; everything before is boilerplate.
  const anchor = plain.match(
    /(About this role|About the role|About the position|About the job|Job description|Responsibilities|What you('| wi)ll do|What you('| wi)ll be doing|The role|Your role|Role overview|Key responsibilities|What we're looking for|Requirements)/i
  );
  if (anchor) return plain.slice(anchor.index, anchor.index + SNIPPET_CHARS);
  // Fall back: skip ~200 chars of header (company name / location / posting
  // date boilerplate) and take a window. Short docs return whatever's there.
  if (plain.length <= SNIPPET_CHARS + 200) return plain.slice(0, SNIPPET_CHARS);
  return plain.slice(200, 200 + SNIPPET_CHARS);
}

async function fetchSnippet(entry) {
  if (entry.url.startsWith('local:')) {
    const filePath = entry.url.slice('local:'.length);
    try {
      const content = readFileSync(filePath, 'utf8');
      const body = stripFrontmatter(content).replace(/\s+/g, ' ').trim();
      return { snippet: extractMeat(body), source: 'local' };
    } catch (err) {
      return { snippet: '', source: 'local-missing', error: err.message };
    }
  }
  try {
    const html = await fetchText(entry.url, { timeoutMs: FETCH_TIMEOUT_MS });
    return { snippet: extractMeat(htmlToText(html)), source: 'http' };
  } catch (err) {
    return { snippet: '', source: 'http-fail', error: (err.message || String(err)).slice(0, 120) };
  }
}

async function runWithConcurrency(items, n, fn, label) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const total = items.length;
  let lastReport = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]);
      done++;
      if (label && (done - lastReport >= 25 || done === total)) {
        process.stdout.write(`\r  ${label}: ${done}/${total}`);
        lastReport = done;
      }
    }
  });
  await Promise.all(workers);
  if (label) process.stdout.write('\n');
  return results;
}

console.log('\nfetching JD snippets...');
const snippets = await runWithConcurrency(entries, FETCH_CONCURRENCY, fetchSnippet, 'fetched');
const localOk = snippets.filter(s => s.source === 'local').length;
const httpOk = snippets.filter(s => s.source === 'http').length;
const localMiss = snippets.filter(s => s.source === 'local-missing').length;
const httpFail = snippets.filter(s => s.source === 'http-fail').length;
console.log(`  ${localOk} local, ${httpOk} http, ${localMiss} local-missing, ${httpFail} http-fail`);

const evaluable = [];
const unevaluable = [];
for (let i = 0; i < entries.length; i++) {
  if (snippets[i].snippet) evaluable.push({ ...entries[i], snippet: snippets[i].snippet });
  else unevaluable.push({ ...entries[i], reason: snippets[i].source });
}
console.log(`${evaluable.length} evaluable, ${unevaluable.length} unevaluable (kept by default)`);

// ── Haiku scoring ───────────────────────────────────────────────────
function buildPrompt(items) {
  const archetypeList = archetypes
    .map((a, i) => `${i + 1}. **${a.name}** (${a.level}, ${a.fit} fit) — ${a.description}`)
    .join('\n');
  const jobList = items
    .map((it, i) => {
      const company = it.company || '(unknown)';
      const snippet = it.snippet.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
      return `### Job ${i + 1}: ${company} — ${it.title}\n${snippet}`;
    })
    .join('\n\n');

  return `You score whether each job description matches the candidate's target archetypes.

# Candidate target archetypes
A job is a STRONG fit when it represents the same kind of role as ANY archetype below at a comparable level. Mismatches in level (IC vs management), function (sales-track VP vs eng-track VP), or scope (regional GTM head vs eng head) score LOW even if the title matches.

${archetypeList}

# Scoring rubric (1-5, integer)
- 5 = excellent match — title, level, scope, and function all align with a primary archetype
- 4 = strong match — solid alignment, possibly with a minor mismatch (e.g. adjacent domain)
- 3 = decent match — borderline; could fit a secondary archetype or a primary with notable scope mismatch
- 2 = weak match — title may fit but the role is wrong scope, function, or level
- 1 = no match — clearly off-archetype (IC engineer for a management archetype, sales VP for an eng VP archetype, etc.)

# Jobs to score
${jobList}

# Output format
Return ONLY a JSON object, no preamble, no commentary, no markdown fences:
{"scores": [{"id": 1, "score": N, "archetype": "name or null", "reason": "<= 12 words"}, ...]}

The "scores" array MUST have exactly ${items.length} entries, one per job, in order. "id" is the 1-based job index. "score" is an integer 1-5. "archetype" is the best-fit archetype name from the list above, or null if no match. "reason" is a short fragment explaining the score — no period needed.`;
}

async function callApi(prompt) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function callCli(prompt) {
  const { spawn } = await import('node:child_process');
  const tmpFile = path.join(os.tmpdir(), `career-ops-mid-${process.pid}-${Date.now()}.md`);
  writeFileSync(tmpFile, prompt, 'utf-8');
  try {
    return await new Promise((resolve, reject) => {
      const args = [
        '-p',
        '--model', MODEL_ALIAS,
        '--append-system-prompt-file', tmpFile,
        'Score the jobs using the rules in the system prompt. Output ONLY the JSON object — no preamble, no commentary, no fences.',
      ];
      const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`claude -p timed out after ${CLI_TIMEOUT_MS}ms`));
      }, CLI_TIMEOUT_MS);
      proc.on('error', err => { clearTimeout(timer); reject(err); });
      proc.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 300).trim()}`));
        else resolve(stdout);
      });
    });
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) return JSON.parse(fence[1]);
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`No JSON object in response: ${text.slice(0, 200)}`);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  throw new Error(`Unterminated JSON object: ${text.slice(start, start + 200)}`);
}

console.log('\nscoring chunks...');
const chunks = [];
for (let i = 0; i < evaluable.length; i += CHUNK_SIZE) chunks.push(evaluable.slice(i, i + CHUNK_SIZE));
console.log(`  ${chunks.length} chunk(s) of up to ${CHUNK_SIZE} jobs each`);

const verdicts = new Map();
const t0 = Date.now();
for (let ci = 0; ci < chunks.length; ci++) {
  const chunk = chunks[ci];
  console.log(`  chunk ${ci + 1}/${chunks.length} (${chunk.length} jobs)`);
  const prompt = buildPrompt(chunk);
  let response;
  try {
    response = backend === 'api' ? await callApi(prompt) : await callCli(prompt);
  } catch (err) {
    console.log(`    ⚠ chunk failed: ${err.message}`);
    for (const it of chunk) verdicts.set(it.url, { score: null, archetype: null, reason: 'chunk-failed' });
    continue;
  }
  let parsed;
  try {
    parsed = extractJson(response);
  } catch (err) {
    console.log(`    ⚠ parse failed: ${err.message}`);
    for (const it of chunk) verdicts.set(it.url, { score: null, archetype: null, reason: 'parse-failed' });
    continue;
  }
  if (!Array.isArray(parsed.scores)) {
    console.log(`    ⚠ malformed (no scores[]): ${response.slice(0, 200)}`);
    for (const it of chunk) verdicts.set(it.url, { score: null, archetype: null, reason: 'bad-shape' });
    continue;
  }
  for (const s of parsed.scores) {
    const idx = Number(s.id) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= chunk.length) continue;
    const it = chunk[idx];
    const score = typeof s.score === 'number' ? s.score : null;
    verdicts.set(it.url, {
      score,
      archetype: s.archetype || null,
      reason: (s.reason || '').toString().slice(0, 100),
    });
  }
}
console.log(`  classified in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── Verdict tally ───────────────────────────────────────────────────
const accepts = [];
const rejects = [];
for (const it of evaluable) {
  const v = verdicts.get(it.url) || { score: null, archetype: null, reason: 'no-verdict' };
  if (v.score == null) {
    // Unscored evaluable entries are kept (don't reject for tooling failure)
    accepts.push({ ...it, ...v });
  } else if (v.score >= MIN_SCORE) {
    accepts.push({ ...it, ...v });
  } else {
    rejects.push({ ...it, ...v });
  }
}
for (const u of unevaluable) {
  accepts.push({ ...u, score: null, archetype: null });
}

console.log('\nVerdicts:');
console.log(`  ${accepts.length} accepted (kept in Pendientes)`);
console.log(`  ${rejects.length} rejected (score < ${MIN_SCORE})`);
console.log(`  ${unevaluable.length} unevaluable (kept; couldn't read JD)`);

const sample = (arr, n = 6) =>
  arr.slice(0, n).forEach(e => {
    const score = e.score == null ? '?' : e.score.toString();
    console.log(`    ${score.padStart(3)} ${e.company.slice(0, 24).padEnd(24)} | ${e.title.slice(0, 50).padEnd(50)} ${e.reason ? '| ' + e.reason : ''}`);
  });
const scored = accepts.filter(a => a.score != null);
console.log(`\n  Sample accepted (top by score):`);
sample([...scored].sort((a, b) => (b.score || 0) - (a.score || 0)));
console.log(`\n  Sample rejected (lowest scores):`);
sample([...rejects].sort((a, b) => (a.score || 0) - (b.score || 0)));

if (DRY_RUN) {
  console.log('\n(dry-run — no changes written)');
  process.exit(0);
}

// ── Apply changes ───────────────────────────────────────────────────
copyFileSync(PIPELINE, PIPELINE + '.bak');
console.log(`\n📦 backup → ${PIPELINE}.bak`);

const today = new Date().toISOString().slice(0, 10);
const newPendientes = ['## Pendientes', ''];
for (const a of accepts) newPendientes.push(a.raw);
newPendientes.push('');

const filtered = [
  `## Filtered (mid-${today})`,
  '',
  `<!-- ${rejects.length} entries removed by mid-filter.mjs on ${today}. Threshold: score < ${MIN_SCORE}. To restore, move lines back to ## Pendientes. -->`,
  '',
];
for (const r of rejects) {
  filtered.push(`- [~] ${r.url} | ${r.company} | ${r.title} | mid:${r.score}/${r.archetype || '?'}: ${r.reason}`);
}
filtered.push('');

const head = lines.slice(0, pStart);
const tail = lines.slice(pEnd);
writeFileSync(PIPELINE, [...head, ...newPendientes, ...filtered, ...tail].join('\n'));

console.log(`✅ wrote ${PIPELINE}`);
console.log(`   Pendientes: ${accepts.length}`);
console.log(`   Filtered:   ${rejects.length}`);
