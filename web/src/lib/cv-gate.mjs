/**
 * cv-gate.mjs — turn a refused tailored CV into decisions the candidate can make.
 *
 * generate-pdf.mjs runs two content gates before it renders: the voice check
 * (cv-voice.mjs: stock phrases the candidate never wrote) and the fact gate
 * (verify-cv-facts.mjs). Either one refusing the CV used to end the web run
 * with an error string, cut to 1,500 characters, and no way forward on the
 * page. This module rebuilds that refusal as findings: one row per flagged
 * line, with what the CV said, what the source says, why it was refused, and
 * which of three ways out applies (Claude rewords it, the candidate allows
 * the wording, or the candidate edits the line).
 *
 * Plain .mjs so it is unit-tested without a build. The checks themselves are
 * never reimplemented here: collectGateFindings runs the real ones on the
 * refused HTML.
 */
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

/** A render failure from one of the content gates (as opposed to Chromium, a page budget, ...). */
export function isContentGateFailure(error) {
  return /\b(?:Fact|Voice) check failed\b/.test(String(error ?? ""));
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

/** Visible text of an HTML fragment, whitespace collapsed. */
export function htmlText(fragment) {
  return String(fragment ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#39|[a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function comparable(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

const BLOCK_RE = /<(li|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

/**
 * The first <li>/<p> whose visible text contains `needle`. Bullets and the
 * summary are the only places a flagged line can be edited; a line anywhere
 * else (a title, a table cell) still gets the reword and allow options.
 * @returns {{start: number, end: number, open: string, inner: string, text: string} | null}
 */
export function findBlock(html, needle) {
  const want = comparable(needle);
  if (!want) return null;
  for (const m of String(html).matchAll(BLOCK_RE)) {
    const text = htmlText(m[3]);
    if (comparable(text).includes(want)) {
      return { start: m.index, end: m.index + m[0].length, open: `<${m[1]}${m[2]}>`, close: `</${m[1]}>`, inner: m[3], text };
    }
  }
  return null;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Replace a flagged block's text with the candidate's own wording. A bold
 * label at the start of the block ("<strong>Label:</strong> …") is kept as
 * bold when the new text still starts with it; other inline markup in the
 * block is dropped, since the candidate typed plain text.
 * @returns {string | null} the new HTML, or null when the block is gone.
 */
export function replaceBlockText(html, needle, newText) {
  const block = findBlock(html, needle);
  if (!block) return null;
  const text = String(newText).replace(/\s+/g, " ").trim();
  const label = /^\s*(<(strong|b)\b[^>]*>)([\s\S]*?)<\/\2>/i.exec(block.inner);
  let inner = escapeHtml(text);
  if (label) {
    const labelText = htmlText(label[3]);
    if (labelText && text.startsWith(labelText)) {
      inner = `${label[1]}${escapeHtml(labelText)}</${label[2]}> ${escapeHtml(text.slice(labelText.length).trim())}`;
    }
  }
  return String(html).slice(0, block.start) + block.open + inner + block.close + String(html).slice(block.end);
}

function wordPattern(word) {
  const body = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, " ?- ?");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

/** Visible lines of the CV (bullets, paragraphs), for locating a flagged word. */
function cvLines(html) {
  return [...String(html).matchAll(BLOCK_RE)].map((m) => htmlText(m[3])).filter(Boolean);
}

/** The swap the fact gate's own advice names: `e.g. "from -> to"`. */
function adviceSwapFrom(advice) {
  return /e\.g\. "([^"]+?) -> [^"]+"/.exec(String(advice ?? ""))?.[1] ?? null;
}

const FACT_WHY = {
  drift: (f) => `Uses ${(f.added ?? []).map((w) => `"${w}"`).join(", ")} to start a phrase, but the closest line in cv.md or article-digest.md does not.`,
  scope: () => "Describes this work more strongly than your CV does.",
  metric: () => "This number is not in cv.md or article-digest.md.",
  forbidden: () => "This phrase is on your forbidden list in config/cv-facts.json.",
};

/**
 * Findings rows from the two gates' structured output.
 *
 * Allow is offered only where a checker itself names the user's override:
 * a stock word goes to allow_facts (cv-voice.mjs reads it as the candidate's
 * own wording), a changed verb to allow_swaps, a scope claim to allow_facts
 * (verify-cv-facts.mjs scopeClaimAdvice). An invented metric or an unknown
 * employer/tool has no allow: if it is true it belongs in cv.md first.
 *
 * @param {{voice?: {kind: string, value: string}[], facts?: {invented?: string[], unsupportedFacts?: object[], forbidden?: string[]} | null, html: string, driftAdvice?: (f: object) => string}} input
 */
export function buildFindings({ voice = [], facts = null, html, driftAdvice }) {
  const rows = [];
  const lines = cvLines(html);
  for (const issue of voice) {
    if (issue.kind !== "banned-phrase") continue;
    const line = lines.find((l) => wordPattern(issue.value).test(l)) ?? "";
    rows.push({
      kind: "voice",
      line,
      words: [issue.value],
      source: null,
      why: `"${issue.value}" is a stock CV phrase, and it is not in your own writing (cv.md or config/cv-facts.json).`,
      allow: { type: "fact", value: issue.value, label: `Allow "${issue.value}" from now on` },
    });
  }
  for (const value of facts?.invented ?? []) {
    rows.push({ kind: "metric", line: lines.find((l) => l.includes(value)) ?? "", words: [value], source: null, why: FACT_WHY.metric(), allow: null });
  }
  for (const f of facts?.unsupportedFacts ?? []) {
    const kind = String(f.kind ?? "fact");
    const line = f.line ?? lines.find((l) => comparable(l).includes(comparable(f.value))) ?? "";
    let allow = null;
    if (kind === "drift") {
      const from = adviceSwapFrom(driftAdvice?.(f));
      const added = (f.added ?? []).filter(Boolean);
      if (from && added.length) {
        allow = { type: "swaps", value: added.map((to) => `${from} -> ${to}`), label: `It's accurate: allow ${added.map((w) => `"${w}"`).join(", ")} for this line` };
      }
    } else if (kind === "scope" && f.value) {
      allow = { type: "fact", value: String(f.value), label: "It's accurate: allow this wording" };
    }
    rows.push({
      kind,
      line,
      words: kind === "drift" ? (f.added ?? []) : [String(f.value ?? "")],
      source: f.sourceLine ?? null,
      why: (FACT_WHY[kind] ?? (() => `This ${kind} is not in cv.md or article-digest.md.`))(f),
      allow,
    });
  }
  for (const value of facts?.forbidden ?? []) {
    rows.push({ kind: "forbidden", line: lines.find((l) => wordPattern(value).test(l)) ?? "", words: [value], source: null, why: FACT_WHY.forbidden(), allow: null });
  }
  return rows.map((row, i) => ({
    id: `f${i + 1}`,
    ...row,
    editable: Boolean(row.line && findBlock(html, row.line)),
    state: "pending",
  }));
}

/** Compact text of the findings, for the repair worker's prompt. */
export function findingsSummary(rows) {
  return rows
    .filter((r) => r.state === "pending")
    .map((r) => r.kind === "pages"
      ? `- [pages] ${r.why} Shorten the CV to fit: tighten or drop the least relevant bullets and competencies. Never drop a whole role, a title, or dates.`
      : `- [${r.kind}] ${r.line ? `CV line: "${r.line}". ` : ""}${r.why}${r.source ? ` Matching source line: "${r.source}".` : ""}`)
    .join("\n");
}

/**
 * Add the candidate's approval to config/cv-facts.json. Refuses a file that
 * does not parse (writing over it would drop whatever the user had there).
 * @param {string} raw - current file content, or "" when absent
 * @param {{type: "fact" | "swaps", value: string | string[]}} allow
 * @param {string} today
 * @returns {{ok: true, content: string} | {ok: false, error: string}}
 */
export function withAllowance(raw, allow, today) {
  let data = {};
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: "config/cv-facts.json does not parse as JSON, so nothing was added. Fix the file, then try again." };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "config/cv-facts.json is not a JSON object, so nothing was added." };
    }
  }
  const key = allow.type === "swaps" ? "allow_swaps" : "allow_facts";
  const values = Array.isArray(allow.value) ? allow.value : [allow.value];
  const list = Array.isArray(data[key]) ? [...data[key]] : [];
  for (const v of values) if (!list.includes(v)) list.push(v);
  data[key] = list;
  const evidence = data._evidence && typeof data._evidence === "object" ? { ...data._evidence } : {};
  for (const v of values) {
    if (!evidence[v]) evidence[v] = `Allowed by the candidate from the web UI CV review on ${today}.`;
  }
  data._evidence = evidence;
  return { ok: true, content: `${JSON.stringify(data, null, 2)}\n` };
}

/**
 * Set cv.max_pages in config/profile.yml, editing only that line so the
 * user's comments and layout survive (a YAML round trip would drop them).
 * Updates an existing `max_pages:` inside the top-level `cv:` block, adds one
 * under `cv:`, or appends a `cv:` block when there is none.
 * @param {string} raw - profile.yml content ("" when absent)
 * @param {number} pages
 * @returns {{ok: true, content: string} | {ok: false, error: string}}
 */
export function withMaxPages(raw, pages) {
  if (!Number.isInteger(pages) || pages < 1 || pages > 10) return { ok: false, error: "A page limit must be a whole number from 1 to 10." };
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^cv:\s*(#.*)?$/.test(l));
  if (start === -1) {
    if (lines.some((l) => /^cv:/.test(l))) {
      return { ok: false, error: "config/profile.yml writes cv: on one line (flow style), so the page limit was not changed. Add max_pages to it by hand." };
    }
    const body = raw.length && !raw.endsWith("\n") ? `${raw}${eol}` : raw;
    return { ok: true, content: `${body}cv:${eol}  max_pages: ${pages}${eol}` };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !/^#/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i++) {
    const m = /^(\s+)max_pages:\s*[^#\s]*(\s*#.*)?$/.exec(lines[i]);
    if (m) {
      lines[i] = `${m[1]}max_pages: ${pages}${m[2] ?? ""}`;
      return { ok: true, content: lines.join(eol) };
    }
  }
  const indent = lines.slice(start + 1, end).map((l) => /^(\s+)\S/.exec(l)?.[1]).find(Boolean) ?? "  ";
  lines.splice(start + 1, 0, `${indent}max_pages: ${pages}`);
  return { ok: true, content: lines.join(eol) };
}

function run(execPath, args, opts) {
  return new Promise((resolve) => {
    execFile(execPath, args, { ...opts, windowsHide: true, timeout: 60_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err || typeof err.code === "number", stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

/**
 * Run both content gates on the refused HTML and return their findings.
 * The voice check runs first in generate-pdf.mjs and stops the render before
 * the fact gate runs, so reading only the error would hide every fact
 * finding behind a single stock word. Running both here lets one repair
 * (or one visit by the candidate) settle all of them.
 * @param {{coreRoot: string, dataRoot: string, htmlPath: string, html: string, execPath?: string}} args
 * @returns {Promise<object[] | null>} null when neither check could be read.
 */
export async function collectGateFindings({ coreRoot, dataRoot, htmlPath, html, execPath = process.execPath }) {
  const env = { ...process.env, CAREER_OPS_ROOT: dataRoot };
  const voiceUrl = pathToFileURL(path.join(coreRoot, "cv-voice.mjs")).href;
  const factsUrl = pathToFileURL(path.join(coreRoot, "verify-cv-facts.mjs")).href;
  // Same source generate-pdf.mjs gives the voice check: cv.md plus the
  // candidate's own words (voice-dna.md, cv-facts.json allow lists).
  const voiceCode = `
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { voiceIssues, candidateOwnWords } from ${JSON.stringify(voiceUrl)};
const [htmlPath, root] = process.argv.slice(1);
const cv = join(root, "cv.md");
const source = existsSync(cv) ? readFileSync(cv, "utf8") : "";
const issues = voiceIssues(readFileSync(htmlPath, "utf8"), source + "\\n" + candidateOwnWords(root));
console.log(JSON.stringify({ issues }));
`;
  const [voiceRun, factRun] = await Promise.all([
    run(execPath, ["--input-type=module", "-e", voiceCode, htmlPath, dataRoot], { cwd: coreRoot, env }),
    run(execPath, [path.join(coreRoot, "verify-cv-facts.mjs"), htmlPath, "--json"], { cwd: coreRoot, env }),
  ]);
  const parse = (text) => {
    try {
      return JSON.parse(text.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).at(-1) ?? "");
    } catch {
      return null;
    }
  };
  const voice = parse(voiceRun.stdout)?.issues ?? null;
  const facts = parse(factRun.stdout);
  if (!voice && !facts) return null;
  // The gate's own swap advice for each drift finding, so the Allow button
  // adds exactly the swap the gate would accept (its anchor verb comes from
  // the checker's predicate parser, not a guess here).
  const drift = (facts?.unsupportedFacts ?? []).filter((f) => f?.kind === "drift");
  const advice = new Map();
  if (drift.length) {
    const adviceCode = `
import { driftClaimAdvice } from ${JSON.stringify(factsUrl)};
const claims = JSON.parse(process.argv[1]);
console.log(JSON.stringify({ advice: claims.map((c) => driftClaimAdvice(c)) }));
`;
    const claims = drift.map((f) => ({ added: f.added ?? [], sourceLine: f.sourceLine ?? "" }));
    const adviceRun = await run(execPath, ["--input-type=module", "-e", adviceCode, JSON.stringify(claims)], { cwd: coreRoot, env });
    const texts = parse(adviceRun.stdout)?.advice ?? [];
    drift.forEach((f, i) => advice.set(f, texts[i]));
  }
  return buildFindings({ voice: voice ?? [], facts, html, driftAdvice: (f) => advice.get(f) });
}
