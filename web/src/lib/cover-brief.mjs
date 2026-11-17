/**
 * cover-brief.mjs — the cover letter request a web user sends from the report page.
 *
 * modes/cover.md Step 6 refuses to draft until the candidate has answered four
 * prompts. A headless run cannot ask them, so the report page collects them up
 * front and this module checks the request at the route boundary.
 */
import path from "node:path";
import { COVER_TONES } from "./cover-tones.mjs";
import { ANSWER_SOURCES } from "./cover-suggest.mjs";

export { COVER_TONES };

const MAX_ANSWER = 1000;
const ANSWER_FIELDS = ["why", "problem", "approach"];
/** Optional context the suggestions step adds: Step 5 gap answers and the Step 3 research it already ran. */
const MAX_GAPS = 2000;
const MAX_RESEARCH = 1500;

/**
 * @typedef {"suggested" | "edited" | "own"} AnswerSource
 * @typedef {{
 *   why: string, problem: string, approach: string, tone: keyof typeof COVER_TONES,
 *   gaps?: string, research?: string,
 *   sources?: {why: AnswerSource, problem: AnswerSource, approach: AnswerSource},
 * }} CoverBrief
 */

/**
 * The application number a cover run is for, resolved to its report.
 * @param {{input: unknown, root: string, findReportFile: (n: string) => string | null}} args
 * @returns {{ok: true, reportFile: string} | {ok: false, error: string}}
 */
export function resolveCoverReport({ input, root, findReportFile }) {
  if (typeof input !== "string") {
    return { ok: false, error: "Invalid report selector: expected a report number string." };
  }
  if (!/^\d+$/.test(input)) return { ok: false, error: `Invalid report selector: "${input}"` };
  const reportFile = findReportFile(input);
  if (!reportFile) return { ok: false, error: `No report #${input} found. Evaluate this posting first.` };
  return { ok: true, reportFile: path.relative(root, reportFile).split(path.sep).join("/") };
}

/**
 * @param {{input: string, brief: unknown, root: string, findReportFile: (n: string) => string | null}} args
 * @returns {{ok: true, reportFile: string, brief: CoverBrief} | {ok: false, error: string}}
 */
export function parseCoverRequest({ input, brief, root, findReportFile }) {
  if (typeof input !== "string") {
    return { ok: false, error: "Invalid report selector: expected a report number string." };
  }
  if (!/^\d+$/.test(input)) return { ok: false, error: `Invalid report selector: "${input}"` };

  const incomplete = { ok: false, error: "Answer all four cover letter questions first." };
  if (brief === null || typeof brief !== "object") return incomplete;
  const answers = ANSWER_FIELDS.map((field) => (typeof brief[field] === "string" ? brief[field].trim() : ""));
  if (answers.some((a) => !a) || typeof brief.tone !== "string" || !Object.hasOwn(COVER_TONES, brief.tone)) {
    return incomplete;
  }
  if (answers.some((a) => a.length > MAX_ANSWER)) return { ok: false, error: `Keep each answer to ${MAX_ANSWER} characters or fewer.` };
  const gaps = typeof brief.gaps === "string" ? brief.gaps.trim() : "";
  const research = typeof brief.research === "string" ? brief.research.trim() : "";
  if (gaps.length > MAX_GAPS || research.length > MAX_RESEARCH) {
    return { ok: false, error: "The gap answers or research summary are too long. Shorten them and draft again." };
  }

  const resolved = resolveCoverReport({ input, root, findReportFile });
  if (!resolved.ok) return resolved;

  const [why, problem, approach] = answers;
  /** @type {CoverBrief} */
  const out = { why, problem, approach, tone: brief.tone };
  if (gaps) out.gaps = gaps;
  if (research) out.research = research;
  // Provenance is advisory, so an unknown value reads as the candidate's own
  // words rather than refusing the request.
  const src = (k) => (ANSWER_SOURCES.includes(brief[`${k}From`]) ? brief[`${k}From`] : "own");
  if (ANSWER_FIELDS.some((k) => brief[`${k}From`] !== undefined)) {
    out.sources = { why: src("why"), problem: src("problem"), approach: src("approach") };
  }
  return { ok: true, reportFile: resolved.reportFile, brief: out };
}
