/**
 * research-review.mjs — filing external deep research against an evaluation,
 * and the review worker's output channel.
 *
 * Flow: the candidate pastes the research they ran in claude.ai (the report's
 * Deep Research Prompt) on the report page. The backend files it under
 * interview-prep/ and links it from the report header (`**Interview Intel:**`,
 * the convention earlier hand-filed research already uses). A read-only
 * `research-review` worker then compares the research with the report and
 * cv.md and returns a `<<research-review>>` JSON envelope. The backend writes
 * the "What this changes vs. report N" section into the research file and
 * stores the proposed evaluation updates in a sidecar, where the candidate
 * approves or dismisses each one. Nothing the worker proposes is applied
 * without that click, and nothing ever touches cv.md.
 *
 * Plain .mjs so tests import it under Node directly. No fs here.
 */
import { slugify } from "./pdf-paths.mjs";

export const OPEN_MARK = "<<research-review>>";
export const CLOSE_MARK = "<</research-review>>";
const OPENER = /^<<research-review>>[ \t]*$/gm;
const CLOSER = /^<<\/research-review>>[ \t]*$/gm;

const SECTION_START = "<!-- research-review:start -->";
const SECTION_END = "<!-- research-review:end -->";

export const PROPOSAL_TYPES = Object.freeze(["score", "status", "note", "report-update"]);
/** Statuses a review may propose. Applied/Interview/Offer… are the candidate's own actions. */
export const REVIEW_STATUSES = Object.freeze(["Evaluated", "Discarded", "SKIP"]);
const MAX_PROPOSALS = 8;
const MAX_FLAGS = 12;

/**
 * interview-prep/{company}-{role}-research.md — the naming earlier research
 * files already use.
 * @param {string} company
 * @param {string} role
 */
export function researchFileName(company, role) {
  const c = slugify(String(company ?? "")) || "company";
  const r = slugify(String(role ?? "")).slice(0, 60).replace(/-+$/, "") || "role";
  return `interview-prep/${c}-${r}-research.md`;
}

/** Sidecar holding the review's proposals and their approve/dismiss state. */
export function reviewSidecarPath(researchRel) {
  return researchRel.replace(/\.md$/i, "") + ".review.json";
}

/**
 * A data-root-relative path is safe when it stays under interview-prep/ and is
 * a markdown file. Anything else (absolute, `..`, another folder) is refused.
 * @param {string} rel
 */
export function isSafeResearchPath(rel) {
  const p = String(rel ?? "").replace(/\\/g, "/");
  return /^interview-prep\/[^/]+\.md$/i.test(p) && !p.includes("..");
}

/** End of the report header: the first `---` rule or `## ` heading. */
function headerEnd(text) {
  const m = text.match(/^(?:---[ \t]*|##\s.*)$/m);
  return m?.index ?? text.length;
}

const INTEL_RE = /^\*\*Interview Intel:\*\*.*$/m;

/**
 * The research file a report's header links to, as a data-root-relative path,
 * or null. Reads the `**Interview Intel:** [..](../interview-prep/x.md)` line.
 * @param {string | null | undefined} report
 * @returns {string | null}
 */
export function interviewIntelPath(report) {
  const text = String(report ?? "").replace(/\r\n?/g, "\n");
  const header = text.slice(0, headerEnd(text));
  const line = header.match(INTEL_RE)?.[0];
  const href = line?.match(/\]\(([^)\s]+)\)/)?.[1];
  if (!href) return null;
  const rel = decodeURI(href).replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
  return isSafeResearchPath(rel) ? rel : null;
}

/**
 * The report with its header linking the research file. An existing
 * Interview Intel line is replaced; otherwise the line goes after the last
 * `**Label:**` header line. Line endings are preserved.
 * @param {string} report
 * @param {string} researchRel data-root-relative, e.g. interview-prep/x.md
 * @param {string} date YYYY-MM-DD
 */
export function withInterviewIntel(report, researchRel, date) {
  const eol = report.includes("\r\n") ? "\r\n" : "\n";
  const text = report.replace(/\r\n?/g, "\n");
  const line = `**Interview Intel:** [${researchRel}](../${researchRel}) (deep research, filed ${date})`;
  const end = headerEnd(text);
  const header = text.slice(0, end);
  let next;
  if (INTEL_RE.test(header)) {
    next = header.replace(INTEL_RE, line) + text.slice(end);
  } else {
    const labels = [...header.matchAll(/^\*\*[^*\n]+:\*\*.*$/gm)];
    const last = labels[labels.length - 1];
    const at = last ? (last.index ?? 0) + last[0].length : header.replace(/\s+$/, "").length;
    next = text.slice(0, at) + "\n" + line + text.slice(at);
  }
  return next.replace(/\n/g, eol);
}

/**
 * New research file: a header tying it to the evaluation, then the pasted
 * research verbatim.
 * @param {{company: string, role: string, reportNum: number | null, reportFile: string | null, score: string, status: string, date: string, markdown: string}} o
 */
export function buildResearchFile(o) {
  const evaluation = o.reportNum != null && o.reportFile
    ? `[${o.reportNum}](../reports/${o.reportFile})${o.score ? ` — ${o.score}` : ""}${o.status ? `, status **${o.status}**` : ""}`
    : "—";
  return [
    `# Interview Intel: ${o.company} — ${o.role}`,
    "",
    `**Company:** ${o.company}`,
    `**Role:** ${o.role}`,
    `**Evaluation:** ${evaluation}`,
    `**Source:** Deep research (external), filed ${o.date}`,
    "",
    "---",
    "",
    String(o.markdown ?? "").replace(/\r\n?/g, "\n").trim(),
    "",
  ].join("\n");
}

/**
 * The research text with the review's "What this changes" section in place:
 * replaced when a previous review wrote one, otherwise inserted after the
 * file header's `---` rule (or at the top when there is none).
 * @param {string} research
 * @param {{reportNum: number | null, changesMarkdown: string, bottomLine: string, cvFlags: {claim: string, why: string}[], date: string}} review
 */
export function withReviewSection(research, review) {
  const text = String(research ?? "").replace(/\r\n?/g, "\n");
  const title = review.reportNum != null ? `## What this changes vs. report ${review.reportNum}` : "## What this changes vs. the evaluation";
  const parts = [SECTION_START, title, "", `*Reviewed ${review.date} by career-ops.*`, "", review.changesMarkdown.trim()];
  if (review.bottomLine.trim()) parts.push("", `**Bottom line:** ${review.bottomLine.trim()}`);
  if (review.cvFlags.length) {
    parts.push("", "### Not in cv.md — confirm before using", "");
    for (const f of review.cvFlags) parts.push(`- **${f.claim}** — ${f.why}`);
  }
  parts.push(SECTION_END);
  const section = parts.join("\n");

  const start = text.indexOf(SECTION_START);
  const end = text.indexOf(SECTION_END);
  if (start !== -1 && end > start) {
    return text.slice(0, start) + section + text.slice(end + SECTION_END.length);
  }
  const rule = text.match(/^---[ \t]*$/m);
  if (rule?.index != null && rule.index < headerEnd(text) + 1) {
    const at = rule.index + rule[0].length;
    return `${text.slice(0, at)}\n\n${section}\n${text.slice(at)}`;
  }
  return `${section}\n\n${text}`;
}

/** One line, no table/TSV breakers. */
function oneLine(s, max) {
  return String(s ?? "").replace(/[|\t\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Validate the worker's JSON. Unknown or malformed proposals are dropped with
 * a warning rather than failing the review: the comparison table is still
 * worth keeping.
 * @param {unknown} raw
 * @returns {{ok: true, review: {changesMarkdown: string, bottomLine: string, cvFlags: {claim: string, why: string}[], proposals: any[]}, warnings: string[]} | {ok: false, error: string}}
 */
export function normalizeReview(raw) {
  const r = /** @type {any} */ (raw);
  if (!r || typeof r !== "object") return { ok: false, error: "The review envelope is not a JSON object." };
  const changesMarkdown = typeof r.changesMarkdown === "string" ? r.changesMarkdown.trim() : "";
  if (!changesMarkdown) return { ok: false, error: "The review has no comparison (changesMarkdown is empty)." };
  const warnings = [];
  const cvFlags = (Array.isArray(r.cvFlags) ? r.cvFlags : [])
    .map((f) => ({ claim: oneLine(f?.claim, 160), why: oneLine(f?.why, 300) }))
    .filter((f) => f.claim)
    .slice(0, MAX_FLAGS);

  const proposals = [];
  for (const p of Array.isArray(r.proposals) ? r.proposals : []) {
    if (proposals.length >= MAX_PROPOSALS) break;
    const reason = oneLine(p?.reason, 400);
    const base = { id: `p${proposals.length + 1}`, state: "pending", reason };
    if (p?.type === "score") {
      const to = Number(p.to);
      if (!Number.isFinite(to) || to < 0 || to > 5) { warnings.push(`Dropped a score proposal with an invalid score (${JSON.stringify(p.to)}).`); continue; }
      proposals.push({ ...base, type: "score", to: Math.round(to * 10) / 10 });
    } else if (p?.type === "status") {
      const to = REVIEW_STATUSES.find((s) => s.toLowerCase() === String(p.to ?? "").trim().toLowerCase());
      if (!to) { warnings.push(`Dropped a status proposal to "${oneLine(p.to, 40)}" (a review may only propose ${REVIEW_STATUSES.join(", ")}).`); continue; }
      proposals.push({ ...base, type: "status", to });
    } else if (p?.type === "note") {
      const text = oneLine(p.text, 300);
      if (!text) continue;
      proposals.push({ ...base, type: "note", text });
    } else if (p?.type === "report-update") {
      const markdown = String(p.markdown ?? "").replace(/\r\n?/g, "\n").replace(/^#{1,2}\s.*$/gm, (h) => `###${h.replace(/^#+/, "")}`).trim();
      if (!markdown) continue;
      proposals.push({ ...base, type: "report-update", markdown: markdown.slice(0, 8000) });
    } else {
      warnings.push(`Dropped a proposal of unknown type "${oneLine(p?.type, 40)}".`);
    }
  }
  return { ok: true, review: { changesMarkdown, bottomLine: oneLine(r.bottomLine, 600), cvFlags, proposals }, warnings };
}

/**
 * Extract and validate the review from the agent's full output. Fail-closed
 * like report-envelope.mjs: markers count only on a line of their own, and
 * exactly one of each.
 * @param {string} text
 * @returns {ReturnType<typeof normalizeReview> | {ok: false, error: string}}
 */
export function parseResearchReview(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const openers = [...normalized.matchAll(OPENER)];
  const closers = [...normalized.matchAll(CLOSER)];
  if (openers.length === 0) return { ok: false, error: "The review finished without a research-review envelope, so nothing was saved." };
  if (openers.length > 1 || closers.length !== 1) return { ok: false, error: "The review emitted more than one envelope (or none closed), so nothing was saved." };
  const start = (openers[0].index ?? 0) + openers[0][0].length;
  const end = closers[0].index ?? -1;
  if (end < start) return { ok: false, error: "The review envelope closes before it opens, so nothing was saved." };
  const body = normalized.slice(start, end).trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```\s*$/, "");
  let raw;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `The review envelope is not valid JSON (${e instanceof Error ? e.message : String(e)}), so nothing was saved.` };
  }
  return normalizeReview(raw);
}

/**
 * Streaming filter: passes agent text through to the run log but holds back
 * everything between the markers, and keeps the full text for parsing.
 */
export function createResearchReviewFilter() {
  let all = "";
  let pending = "";
  let inside = false;
  return {
    /** @param {string} chunk @returns {string} visible text */
    push(chunk) {
      all += chunk;
      pending += chunk;
      let out = "";
      let nl;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl + 1);
        pending = pending.slice(nl + 1);
        const t = line.trim();
        if (!inside && t === OPEN_MARK) { inside = true; out += "_(review details hidden from the log; they are saved with the research)_\n"; continue; }
        if (inside && t === CLOSE_MARK) { inside = false; continue; }
        if (!inside) out += line;
      }
      return out;
    },
    flush() {
      const rest = inside ? "" : pending;
      pending = "";
      return rest;
    },
    text() {
      return all;
    },
  };
}

/**
 * The report with a research update section added: before the trailing
 * machine/reference sections (Deep Research Prompt, Machine Summary, archived
 * JD) when present, otherwise at the end.
 * @param {string} report
 * @param {string} markdown
 * @param {string} date
 */
export function withReportUpdate(report, markdown, date) {
  const eol = report.includes("\r\n") ? "\r\n" : "\n";
  const lines = report.replace(/\r\n?/g, "\n").split("\n");
  const section = ["", `## Research Update (${date})`, "", markdown.trim(), ""];
  let inFence = false;
  let at = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("```")) inFence = !inFence;
    else if (!inFence && /^##\s+(deep research prompt|machine summary|job description)/i.test(t)) { at = i; break; }
  }
  lines.splice(at, 0, ...section);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n/g, eol);
}

/**
 * The report with a new score in its header `**Score:**` line and its
 * Machine Summary `score:` key, so report and tracker agree.
 * @param {string} report
 * @param {number} score
 */
export function withReportScore(report, score) {
  const s = score.toFixed(1);
  const withHeader = report.replace(/^(\*\*Score:\*\*\s*)\d+(?:\.\d+)?(\/5)?/m, (_m, p, five) => `${p}${s}${five ?? "/5"}`);
  const ms = withHeader.search(/^##\s+Machine Summary/im);
  if (ms === -1) return withHeader;
  const tail = withHeader.slice(ms).replace(/^([ \t]*score:[ \t]*)["']?\d+(?:\.\d+)?(?:\/5)?["']?[ \t]*$/m, (_m, p) => `${p}${s}`);
  return withHeader.slice(0, ms) + tail;
}
