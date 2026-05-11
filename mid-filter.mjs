#!/usr/bin/env node
// mid-filter.mjs — JD-snippet + full-profile filter for `## Pendientes` in pipeline.md.
//
// Why: title-only filters can't distinguish role scope when the same title
// (e.g. "Director of Engineering") spans 5-person startups to 50K-person
// enterprises. Full Sonnet batch evaluations CAN distinguish, but at ~3-5 min
// per job. This sits in between: pull a ~1500-char JD snippet, send a batched
// Haiku call with the candidate's full profile (CV + archetypes + comp/location
// preferences from config/profile.yml), and reject scores < threshold before
// they reach the full batch.
//
// Strategy:
//   1. Parse pending entries from data/pipeline.md
//   2. For each entry, fetch a JD snippet:
//      - local:jds/{file}.md → strip frontmatter, take body
//      - http(s)://...       → HTTP fetch, strip HTML tags, find the meat
//   3. Build a static system context (CV + profile + archetypes + rubric) used
//      across all chunks. API path enables prompt caching on this block.
//   4. Per chunk, send only the jobs as the user message — first chunk pays
//      full price, subsequent chunks hit the cache.
//   5. Move scores < threshold to ## Filtered (mid-{date})
//   6. Keep accepted entries unchanged in ## Pendientes
//
// Usage:
//   node mid-filter.mjs                  # apply (writes backup .bak)
//   node mid-filter.mjs --dry-run        # report only
//   node mid-filter.mjs --min-score 3.5  # tighter threshold (default 3)
//   node mid-filter.mjs --snippet-chars 2000  # bigger snippet (default 1500)

import { readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import yaml from 'js-yaml';
import { hasSemanticBackend } from './scan-semantic.mjs';
import { fetchText } from './providers/_http.mjs';
import { fetchText as browserFetchText, closeBrowser } from './providers/_browser.mjs';

const PIPELINE = 'data/pipeline.md';
const PROFILE = 'config/profile.yml';
const CV_PATH = 'cv.md';
const JDS_DIR = 'jds';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REFRESH = args.includes('--refresh');       // bypass JD cache read
const NO_BROWSER = args.includes('--no-browser'); // skip Playwright fallback
const argValue = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const MIN_SCORE = parseFloat(argValue('--min-score', '3'));
const SNIPPET_CHARS = parseInt(argValue('--snippet-chars', '1500'), 10);
// Default to single-threaded fetch with a polite delay — many job-board
// origins (dice, builtin, etc.) start returning 4xx or empty SPA shells when
// they see concurrent connections from the same IP.
const FETCH_CONCURRENCY = parseInt(argValue('--concurrency', '1'), 10);
const FETCH_DELAY_MS = parseInt(argValue('--delay-ms', '750'), 10);

// Match scan-semantic.mjs: same model, same env-var conventions.
const MODEL = 'claude-haiku-4-5-20251001';
const MODEL_ALIAS = 'haiku';
const MAX_TOKENS = 8192;
const CLI_TIMEOUT_MS = 360_000;
// Smaller chunk than title-semantic (CHUNK_SIZE=1500 there) since each snippet
// is ~1500 chars vs ~50 per title. 30 jobs × 1500 chars = ~45K char prompt;
// well under the model context window with headroom for archetype context.
const CHUNK_SIZE = 30;
const FETCH_TIMEOUT_MS = 30_000;
// Below this much cleaned text, HTTP probably returned an SPA shell or
// boilerplate — retry with the browser transport.
const MIN_USABLE_TEXT = 500;

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

// ── CV + extended profile for the static system context ────────────
let cvText;
try {
  cvText = readFileSync(CV_PATH, 'utf8').trim();
} catch (err) {
  console.error(`Could not read ${CV_PATH}: ${err.message}`);
  process.exit(1);
}
console.log(`CV loaded (${cvText.length} chars)`);

const candidate = profile?.candidate || {};
const narrative = profile?.narrative || {};
const compensation = profile?.compensation || {};
const candidateLocation = profile?.location || {};
const primaryTargets = profile?.target_roles?.primary || [];

const SYSTEM_CONTEXT = (() => {
  const archetypeBlock = archetypes
    .map((a, i) => `${i + 1}. **${a.name}** (${a.level}, ${a.fit} fit) — ${a.description}`)
    .join('\n');
  const primaryBlock = primaryTargets.length
    ? primaryTargets.map(t => `- ${t}`).join('\n')
    : '(none specified)';
  const supersBlock = (narrative.superpowers || []).map(s => `- ${s}`).join('\n') || '(none specified)';
  const locLine = [candidateLocation.city, candidateLocation.country].filter(Boolean).join(', ');
  const visa = candidateLocation.visa_status ? ` (${candidateLocation.visa_status})` : '';

  return `You filter job descriptions for a candidate to decide whether each is worth a full evaluation. Score each job against BOTH the candidate's target archetypes AND the candidate's actual CV experience.

# Candidate profile

**Name:** ${candidate.full_name || '(unspecified)'}
**Headline:** ${narrative.headline || '(unspecified)'}
**Location:** ${locLine}${visa}

## Compensation & location preferences
- Target total comp: ${compensation.target_range || '(unspecified)'}
- Walk-away floor: ${compensation.minimum || '(unspecified)'}
- Location flexibility: ${compensation.location_flexibility || '(unspecified)'}

## Superpowers
${supersBlock}

## Exit story
${narrative.exit_story || '(none)'}

## Target roles (primary)
${primaryBlock}

## Target archetypes
A job is a STRONG fit when it represents the same kind of role as a PRIMARY archetype at a comparable level/scope/function. Mismatches in level (IC vs management), function (sales-track vs eng-track), or scope (single-team vs org-level) score LOW even if the title matches.

${archetypeBlock}

# Candidate CV

${cvText}

# Scoring rubric (integer 1-5)

Score reflects how worth-it a full evaluation would be. Two dimensions combine into one integer score:

A. **Archetype fit** — does the JD represent one of the target archetypes at the right level/scope/function?
B. **CV alignment** — does the candidate's actual experience (per the CV above) plausibly map to what the JD requires — tech stack, domain, industry, seniority?

- **5** = strong PRIMARY archetype match AND CV experience clearly maps. A no-brainer to evaluate.
- **4** = strong primary archetype match with one minor mismatch (adjacent domain or slight scope difference), OR strong SECONDARY archetype match with clean CV fit.
- **3** = decent match — borderline. Adjacent archetype with right level, OR primary archetype with a notable CV gap (e.g. required tech stack the CV can't credibly bridge).
- **2** = weak match — clearly off on one dimension: wrong function (sales/SE/RVP for an eng-VP archetype), wrong level (IC engineer for management archetype), wrong scope (single-team for org-level archetype), or hard tech-stack mismatch.
- **1** = no match — wrong domain (civil/mechanical/electrical engineering for a software archetype), wrong function (CRM functional consulting, pure infra ops, support), or a hard filter triggered.

## Hard signals to flag in reason (push score to 1-2)
- Required tech stack/credentials the CV clearly lacks (e.g. JD requires 5+ years production Python ML; CV is .NET-only)
- Industry license required not in CV (PE, MD, defense clearance, regulated specialization)
- Visible total comp clearly below the walk-away floor (${compensation.minimum || 'N/A'})
- On-site only outside the candidate's commute range for a non-remote role

# Output format
Return ONLY a JSON object — no preamble, no commentary, no markdown fences:
{"scores": [{"id": 1, "score": N, "archetype": "name or null", "reason": "<= 14 words"}, ...]}

The "scores" array MUST have exactly one entry per job in the user message, in order. "id" is the 1-based job index. "score" is integer 1-5. "archetype" is the best-fit archetype name from the list above, or null if no match. "reason" is a short fragment (≤ 14 words) noting the dominant factor — archetype match, CV gap, or hard signal.`;
})();

console.log(`system context: ${SYSTEM_CONTEXT.length} chars (cached across chunks on API backend)`);

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

// ── JD cache helpers ────────────────────────────────────────────────
// On HTTP fetch success we save the cleaned JD text under jds/{slug}.md with
// the same frontmatter shape the linkedin provider uses, then rewrite the
// pipeline entry's URL to `local:jds/...`. Future mid-filter runs and the
// downstream batch evaluator can reuse the cached file instead of re-fetching.
function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug) return slug;
  return 'jd-' + createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10);
}

function yamlEscape(str) {
  const s = String(str ?? '').replace(/\n/g, ' ').trim();
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function cachePathFor(entry) {
  const slug = slugify(`${entry.company}-${entry.title}`);
  return path.join(JDS_DIR, `${slug}.md`);
}

function readCachedJd(entry) {
  const filepath = cachePathFor(entry);
  if (!existsSync(filepath)) return null;
  try {
    return { content: readFileSync(filepath, 'utf8'), localUrl: `local:${filepath.replace(/\\/g, '/')}` };
  } catch {
    return null;
  }
}

function writeCachedJd(entry, plainText) {
  mkdirSync(JDS_DIR, { recursive: true });
  const filepath = cachePathFor(entry);
  if (existsSync(filepath)) return `local:${filepath.replace(/\\/g, '/')}`;
  const today = new Date().toISOString().slice(0, 10);
  const content = `---
title: ${yamlEscape(entry.title)}
company: ${yamlEscape(entry.company)}
url: ${yamlEscape(entry.url)}
application_url: ""
scraped: "${today}"
source: mid-filter
---

# ${entry.title} — ${entry.company}

${plainText}
`;
  writeFileSync(filepath, content, 'utf-8');
  return `local:${filepath.replace(/\\/g, '/')}`;
}

async function fetchSnippet(entry) {
  if (entry.url.startsWith('local:')) {
    const filePath = entry.url.slice('local:'.length);
    try {
      const content = readFileSync(filePath, 'utf8');
      const body = stripFrontmatter(content).replace(/\s+/g, ' ').trim();
      return { snippet: extractMeat(body), source: 'local', cachedUrl: null };
    } catch (err) {
      return { snippet: '', source: 'local-missing', error: err.message, cachedUrl: null };
    }
  }

  // JD cache: hit serves the snippet AND rewrites the pipeline URL to local:.
  if (!REFRESH) {
    const cached = readCachedJd(entry);
    if (cached) {
      const body = stripFrontmatter(cached.content).replace(/\s+/g, ' ').trim();
      return { snippet: extractMeat(body), source: 'cache', cachedUrl: cached.localUrl };
    }
  }

  // HTTP fetch first.
  let plain = '';
  let source = 'http-fail';
  let httpError = null;
  try {
    const html = await fetchText(entry.url, { timeoutMs: FETCH_TIMEOUT_MS });
    plain = htmlToText(html);
    if (plain.length >= MIN_USABLE_TEXT) source = 'http';
  } catch (err) {
    httpError = (err.message || String(err)).slice(0, 120);
  }

  // Browser fallback when HTTP threw or returned a short / SPA-shell body.
  if (!NO_BROWSER && plain.length < MIN_USABLE_TEXT) {
    try {
      const html = await browserFetchText(entry.url, { timeoutMs: FETCH_TIMEOUT_MS });
      const browserPlain = htmlToText(html);
      if (browserPlain.length > plain.length) {
        plain = browserPlain;
        source = 'browser';
      }
    } catch (err) {
      // Browser failed too — keep whatever (likely empty) we had.
    }
  }

  if (!plain || plain.length < 100) {
    return { snippet: '', source: source === 'http' ? 'http-thin' : 'http-fail', error: httpError, cachedUrl: null };
  }

  // Cache and rewrite the pipeline URL.
  let cachedUrl = null;
  try { cachedUrl = writeCachedJd(entry, plain); } catch {}
  return { snippet: extractMeat(plain), source, cachedUrl };
}

async function runWithConcurrency(items, n, fn, label, delayMs = 0) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const total = items.length;
  let lastReport = 0;
  const reportThreshold = n === 1 ? 1 : 25;
  const workers = Array.from({ length: n }, async () => {
    let firstForWorker = true;
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      // Space requests per-worker. With n=1 this is global; with n>1 it
      // spaces each worker's stream while letting workers interleave.
      if (!firstForWorker && delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
      firstForWorker = false;
      results[idx] = await fn(items[idx]);
      done++;
      if (label && (done - lastReport >= reportThreshold || done === total)) {
        process.stdout.write(`\r  ${label}: ${done}/${total}`);
        lastReport = done;
      }
    }
  });
  await Promise.all(workers);
  if (label) process.stdout.write('\n');
  return results;
}

console.log(`\nfetching JD snippets (concurrency=${FETCH_CONCURRENCY}, delay=${FETCH_DELAY_MS}ms)...`);
const snippets = await runWithConcurrency(entries, FETCH_CONCURRENCY, fetchSnippet, 'fetched', FETCH_DELAY_MS);
const tally = snippets.reduce((acc, s) => { acc[s.source] = (acc[s.source] || 0) + 1; return acc; }, {});
const tallyStr = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ');
console.log(`  ${tallyStr}`);

const evaluable = [];
const unevaluable = [];
for (let i = 0; i < entries.length; i++) {
  const cachedUrl = snippets[i].cachedUrl;
  if (snippets[i].snippet) {
    evaluable.push({ ...entries[i], snippet: snippets[i].snippet, cachedUrl });
  } else {
    unevaluable.push({ ...entries[i], reason: snippets[i].source, cachedUrl });
  }
}
console.log(`${evaluable.length} evaluable, ${unevaluable.length} unevaluable (kept by default)`);

// ── Haiku scoring ───────────────────────────────────────────────────
// Per-chunk user message: just the jobs. All static context (CV, profile,
// archetypes, rubric, output format) lives in SYSTEM_CONTEXT above and is
// cached on the API backend across chunks.
function buildUserChunk(items) {
  const jobList = items
    .map((it, i) => {
      const company = it.company || '(unknown)';
      const location = it.location ? ` | ${it.location}` : '';
      const snippet = it.snippet.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
      return `### Job ${i + 1}: ${company} — ${it.title}${location}\n${snippet}`;
    })
    .join('\n\n');

  return `# Jobs to score (${items.length} jobs)

${jobList}

Return ONLY the JSON object with exactly ${items.length} entries, in order.`;
}

async function callApi(userChunk) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      { type: 'text', text: SYSTEM_CONTEXT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userChunk }],
  });
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function callCli(userChunk) {
  const { spawn } = await import('node:child_process');
  const tmpFile = path.join(os.tmpdir(), `career-ops-mid-${process.pid}-${Date.now()}.md`);
  writeFileSync(tmpFile, SYSTEM_CONTEXT + '\n\n' + userChunk, 'utf-8');
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
  const userChunk = buildUserChunk(chunk);
  let response;
  try {
    response = backend === 'api' ? await callApi(userChunk) : await callCli(userChunk);
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

// Rewrite the Pendientes line to point at the cached local: URL when we
// have one — keeps downstream tools off the network on re-runs.
function rebuildEntryLine(a) {
  if (!a.cachedUrl || a.url.startsWith('local:')) return a.raw;
  const parts = [`- [ ] ${a.cachedUrl}`, a.company, a.title];
  if (a.location) parts.push(a.location);
  return parts.join(' | ');
}

if (DRY_RUN) {
  console.log('\n(dry-run — no changes written)');
  await closeBrowser();
  process.exit(0);
}

// ── Apply changes ───────────────────────────────────────────────────
copyFileSync(PIPELINE, PIPELINE + '.bak');
console.log(`\n📦 backup → ${PIPELINE}.bak`);

const today = new Date().toISOString().slice(0, 10);
const newPendientes = ['## Pendientes', ''];
const rewritten = accepts.filter(a => a.cachedUrl && !a.url.startsWith('local:')).length;
for (const a of accepts) newPendientes.push(rebuildEntryLine(a));
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
console.log(`   Pendientes: ${accepts.length} (${rewritten} URLs rewritten to local:jds/)`);
console.log(`   Filtered:   ${rejects.length}`);

await closeBrowser();
