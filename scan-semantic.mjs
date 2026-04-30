// scan-semantic.mjs — Semantic title classifier for the scan pipeline.
//
// Used by scan.mjs to second-pass any title that didn't match a literal
// negative (hard reject) or literal positive (definite accept). Calls
// Claude Haiku 4.5 once per scan run with all neutral titles batched
// together, returns a Map<title, boolean> of accept/reject decisions.
//
// Inputs:
//   - positive[]    : title_filter.positive — literal keywords from portals.yml
//   - archetypes[]  : title_filter.archetypes — optional canonical role-family
//                     descriptions, used by the LLM only (richer signal than
//                     the literal positive list alone)
//   - titles[]      : the neutral titles to classify (deduped at the call site)
//
// Returns: Map<originalTitle, true|false> where true = accept (semantic match).
//
// Backend selection:
//   - CAREER_OPS_SEMANTIC_BACKEND=api|cli  (explicit override)
//   - ANTHROPIC_API_KEY set                → API (faster, separate billing)
//   - `claude` CLI in PATH                 → CLI (zero setup, uses subscription)
//   - neither                              → throws "no backend available"
//
// Failure modes:
//   - No backend available → throws (caller checks via hasSemanticBackend())
//   - SDK import / spawn fails → throws
//   - Network/API error or non-zero CLI exit → throws (caller decides fallback)
//   - Malformed JSON response → throws

import path from 'node:path';
import fs from 'node:fs';

const MODEL = 'claude-haiku-4-5-20251001';
const MODEL_ALIAS = 'haiku';      // CLI accepts aliases, version drift-safe
const MAX_TOKENS = 4096;
const CLI_TIMEOUT_MS = 240_000;   // Per chunk — generous; CLI latency varies with model load.

// Cap titles per LLM call. Two reasons:
//   1. CLI: claude -p with 2K+ titles times out (model has to read all input,
//      and CLI startup + model latency add up).
//   2. Output budget: even with the compact {"matches":[...]} format, very
//      large chunks risk truncated output if many titles match.
// 250 keeps each call to ~5-15s on CLI, well under the timeout.
const CHUNK_SIZE = 250;

function buildPrompt({ positive, archetypes, titles }) {
  const targetLines = [];
  for (const p of positive || []) {
    targetLines.push(`- "${p}" (literal keyword from positive filter)`);
  }
  for (const a of archetypes || []) {
    targetLines.push(`- ${a} (role-family archetype)`);
  }
  const targetList = targetLines.join('\n');
  const candidateList = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');

  return `You classify candidate job titles by whether they semantically match a list of target role types. The candidates have already passed a literal substring filter and reached a "neutral" bucket — they need a semantic decision now.

# Target role types
A candidate matches if it represents the same KIND of role as ANY of the targets below:

${targetList}

# Match rules
- Punctuation and whitespace differences ALWAYS match: "Director of Engineering" = "Director, Engineering" = "Director - Engineering" = "Director Engineering"
- Seniority modifiers ALWAYS match: "Sr. Engineering Manager" = "Senior Engineering Manager" = "engineering manager"
- Subject-area suffixes ALWAYS match if the base role matches: "Engineering Manager, Platform" matches "Engineering Manager"; "Director of Engineering, AI" matches "Director of Engineering"
- "Head of X Engineering" / "VP, Engineering" / "VP X Engineering" all match "VP of Engineering"
- Different functional area = NO MATCH: "Director of Marketing" does NOT match "Director of Engineering"
- Different career track = NO MATCH (despite shared word):
    "Sales Engineer" / "Solutions Engineer" / "Site Reliability Engineer" do NOT match "Engineering Manager" or "VP of Engineering"
    "Director of Solutions Engineering" does NOT match "Director of Engineering" (sales/SE track, not eng leadership)
- IC engineering titles do NOT match management titles: "Senior Software Engineer" does NOT match "Engineering Manager"

# Candidate titles to classify
${candidateList}

# Output format
Return ONLY a JSON object with this exact shape, no preamble or commentary:
{"matches": [1, 5, 7, ...]}

The "matches" array lists the 1-based indices of candidates that match (ACCEPT). Omit indices that don't match — do not list them as REJECT. If no candidates match, return {"matches": []}. Indices must be integers between 1 and ${titles.length} inclusive.`;
}

function extractJson(text) {
  // Models sometimes wrap JSON in code fences or add commentary despite
  // instructions. Pull out the first {...} block.
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1]);
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    return JSON.parse(text.slice(braceStart, braceEnd + 1));
  }
  throw new Error(`No JSON object found in response: ${text.slice(0, 200)}`);
}

// ── Backend resolution ──────────────────────────────────────────────

function resolveBackend() {
  const override = process.env.CAREER_OPS_SEMANTIC_BACKEND;
  if (override === 'api' || override === 'cli') return override;
  if (override) {
    throw new Error(`Invalid CAREER_OPS_SEMANTIC_BACKEND="${override}" — must be "api" or "cli"`);
  }
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  if (claudeCliInPath()) return 'cli';
  return null;
}

function claudeCliInPath() {
  // Cheap path check — avoids spawning until we know it's worth it.
  // Works on Windows (PATHEXT extensions) and Unix (literal binary name).
  const PATH = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(e => e.toLowerCase())
    : [''];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `claude${ext}`);
      try { if (fs.statSync(candidate).isFile()) return true; } catch {}
    }
  }
  return false;
}

// Used by scan.mjs to decide whether to attempt the semantic phase at all.
// Returns the resolved backend ('api' | 'cli') or null if neither is available.
export function hasSemanticBackend() {
  try { return resolveBackend(); } catch { return null; }
}

// ── Public entry ────────────────────────────────────────────────────

export async function classifyTitles({ positive = [], archetypes = [], titles }) {
  if (!Array.isArray(titles) || titles.length === 0) {
    return new Map();
  }
  const backend = resolveBackend();
  if (!backend) {
    throw new Error('No semantic backend: set ANTHROPIC_API_KEY or install Claude Code (claude CLI)');
  }

  const chunks = [];
  for (let i = 0; i < titles.length; i += CHUNK_SIZE) {
    chunks.push(titles.slice(i, i + CHUNK_SIZE));
  }

  // Catch per-chunk errors and continue. Partial classifications are still
  // useful — successful chunks contribute their verdicts, the rest of the
  // titles are reported as un-classified (callers should treat as reject).
  // If every chunk fails, throw so the caller knows it was a total failure.
  const verdicts = new Map();
  const chunkErrors = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunks.length > 1) {
      console.log(`  chunk ${i + 1}/${chunks.length} (${chunk.length} titles)`);
    }
    try {
      const text = backend === 'api'
        ? await callApi({ positive, archetypes, titles: chunk })
        : await callCli({ positive, archetypes, titles: chunk });
      const chunkVerdicts = parseResultsToVerdicts(text, chunk);
      for (const [title, v] of chunkVerdicts) verdicts.set(title, v);
    } catch (err) {
      console.log(`  ⚠ chunk ${i + 1}/${chunks.length} failed: ${err.message}`);
      chunkErrors.push({ chunk: i + 1, error: err.message });
    }
  }
  if (chunkErrors.length === chunks.length) {
    throw new Error(`All ${chunks.length} semantic chunks failed (first error: ${chunkErrors[0].error})`);
  }
  return verdicts;
}

// ── Backend implementations ─────────────────────────────────────────

async function callApi({ positive, archetypes, titles }) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (err) {
    throw new Error(`@anthropic-ai/sdk not installed (run \`npm install\`): ${err.message}`);
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = buildPrompt({ positive, archetypes, titles });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

async function callCli({ positive, archetypes, titles }) {
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');

  const prompt = buildPrompt({ positive, archetypes, titles });

  // The full prompt with all titles can easily exceed the OS argv limit
  // (~32 KB on Windows). Write to a temp file and feed it via
  // --append-system-prompt-file; argv stays tiny.
  const tmpFile = path.join(os.tmpdir(), `career-ops-semantic-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, prompt, 'utf-8');

  try {
    return await new Promise((resolve, reject) => {
      const userInstruction =
        'Classify the candidate titles using the rules in the system prompt. Output ONLY a valid JSON object as specified — no preamble, no commentary, no markdown fences.';
      const args = [
        '-p',
        '--model', MODEL_ALIAS,
        '--append-system-prompt-file', tmpFile,
        userInstruction,
      ];
      const proc = spawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`claude -p timed out after ${CLI_TIMEOUT_MS}ms`));
      }, CLI_TIMEOUT_MS);
      proc.on('error', err => {
        clearTimeout(timer);
        reject(new Error(`Could not spawn claude CLI: ${err.message}`));
      });
      proc.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          return reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 300).trim()}`));
        }
        resolve(stdout);
      });
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Response parsing ────────────────────────────────────────────────

function parseResultsToVerdicts(text, titles) {
  const parsed = extractJson(text);
  if (!parsed.matches || !Array.isArray(parsed.matches)) {
    throw new Error(`Malformed semantic response — expected matches[]: ${text.slice(0, 200)}`);
  }
  const matched = new Set(
    parsed.matches
      .map(Number)
      .filter(n => Number.isInteger(n) && n >= 1 && n <= titles.length)
  );
  const verdicts = new Map();
  for (let i = 0; i < titles.length; i++) {
    verdicts.set(titles[i], matched.has(i + 1));
  }
  return verdicts;
}
