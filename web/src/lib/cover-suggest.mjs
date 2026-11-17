/**
 * cover-suggest.mjs — the `cover-suggest` worker's output channel.
 *
 * modes/cover.md Step 6 offers the candidate menus to pick from (angles for
 * "why this role", a research synthesis for the problem, tone choices). A web
 * run cannot pause to ask, so a read-only `cover-suggest` worker runs Steps 2-6
 * up front and returns the options in a `<<cover-suggest>>` JSON envelope. The
 * backend validates and caches them; the report page renders them as cards the
 * candidate picks from or overrides before the real `cover` run drafts.
 *
 * Suggestions are AI-written. A candidate who picks one verbatim has chosen an
 * angle, not authored a claim, so each suggestion also carries the figures in it
 * that cv.md / article-digest.md do not contain. The page shows those so a
 * number the model wrote never passes as the candidate's own.
 *
 * Plain .mjs so tests import it under Node directly. No fs here.
 */
import { COVER_TONES } from "./cover-tones.mjs";

export const OPEN_MARK = "<<cover-suggest>>";
export const CLOSE_MARK = "<</cover-suggest>>";
const OPENER = /^<<cover-suggest>>[ \t]*$/gm;
const CLOSER = /^<<\/cover-suggest>>[ \t]*$/gm;

/** Per-question caps: the CLI offers up to five angles for A, fewer elsewhere. */
export const SUGGESTION_LIMITS = Object.freeze({ why: 5, problem: 3, approach: 3 });
export const GAP_KINDS = Object.freeze(["domain", "start", "language", "title", "other"]);
const MAX_GAPS = 5;
const MAX_CHOICES = 4;
const MAX_TEXT = 600;
const MAX_LABEL = 70;

/** @param {unknown} v @param {number} max */
function oneLine(v, max) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Figure-like tokens in `text` (counts, money, percentages, multipliers) that
 * do not appear in `allowed`. Years written as four digits count too: "since
 * 2019" is a career claim the CV has to back. Compared digits-only, so "1,200"
 * in a suggestion matches "1200" in the CV.
 * @param {string} text
 * @param {string} allowed
 * @returns {string[]}
 */
export function unverifiedFigures(text, allowed) {
  const FIGURE = /\d[\d,.]*\d|\d/g;
  const pool = new Set([...String(allowed ?? "").matchAll(FIGURE)].map((m) => m[0].replace(/[,.]/g, "")));
  const out = [];
  for (const m of String(text ?? "").matchAll(FIGURE)) {
    const t = m[0];
    const key = t.replace(/[,.]/g, "");
    // A lone digit ("day 1", "2 teams") carries no claim worth checking,
    // unless it is a percentage or a multiplier ("5%", "3x").
    const next = m.input.charAt((m.index ?? 0) + t.length);
    if (key.length < 2 && !/[%x×]/i.test(next)) continue;
    if (!pool.has(key) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * @typedef {{label: string, text: string, evidence: string, unverified: string[]}} Suggestion
 * @typedef {{kind: string, question: string, choices: string[]}} Gap
 * @typedef {{
 *   research: string,
 *   why: Suggestion[], problem: Suggestion[], approach: Suggestion[],
 *   tone: {recommended: keyof typeof COVER_TONES, reason: string},
 *   gaps: Gap[],
 *   keywords: {ats: string[], signals: string[]},
 * }} CoverSuggestions
 */

/**
 * Validate the worker's JSON. Malformed entries are dropped with a warning
 * rather than failing the whole run: three good angles beat none.
 * @param {unknown} raw
 * @param {{allowedText?: string}} [opts] cv.md + article-digest.md text, for the figure check
 * @returns {{ok: true, suggestions: CoverSuggestions, warnings: string[]} | {ok: false, error: string}}
 */
export function normalizeSuggestions(raw, { allowedText = "" } = {}) {
  const r = /** @type {any} */ (raw);
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: "The suggestions envelope is not a JSON object." };
  const warnings = [];
  /** @param {unknown} list @param {keyof typeof SUGGESTION_LIMITS} field */
  const cards = (list, field) => {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (out.length >= SUGGESTION_LIMITS[field]) break;
      const text = oneLine(typeof item === "string" ? item : item?.text, MAX_TEXT);
      if (!text || out.some((s) => s.text === text)) continue;
      const label = oneLine(item?.label, MAX_LABEL);
      out.push({ label, text, evidence: oneLine(item?.evidence, 300), unverified: unverifiedFigures(`${label} ${text}`, allowedText) });
    }
    return out;
  };
  const why = cards(r.why, "why");
  const problem = cards(r.problem, "problem");
  const approach = cards(r.approach, "approach");
  if (!why.length && !problem.length && !approach.length) {
    return { ok: false, error: "The suggestions had no usable options for any question, so nothing was saved." };
  }
  for (const [name, list] of /** @type {const} */ ([["why", why], ["problem", problem], ["approach", approach]])) {
    if (!list.length) warnings.push(`No usable suggestions for "${name}"; that question is free text only.`);
  }

  const toneId = String(r.tone?.recommended ?? "").trim().toLowerCase();
  const recommended = /** @type {keyof typeof COVER_TONES} */ (Object.hasOwn(COVER_TONES, toneId) ? toneId : "mirror");
  if (toneId && recommended !== toneId) warnings.push(`Unknown tone "${oneLine(toneId, 30)}"; defaulted to Mirror the JD.`);

  const gaps = [];
  for (const g of Array.isArray(r.gaps) ? r.gaps : []) {
    if (gaps.length >= MAX_GAPS) break;
    const question = oneLine(g?.question, 400);
    if (!question) continue;
    const kind = GAP_KINDS.includes(g?.kind) ? g.kind : "other";
    const choices = (Array.isArray(g?.choices) ? g.choices : []).map((c) => oneLine(c, 200)).filter(Boolean).slice(0, MAX_CHOICES);
    gaps.push({ kind, question, choices });
  }

  const words = (list) => (Array.isArray(list) ? list : []).map((k) => oneLine(k, 80)).filter(Boolean).slice(0, 12);
  return {
    ok: true,
    suggestions: {
      research: oneLine(r.research, 1500),
      why,
      problem,
      approach,
      tone: { recommended, reason: oneLine(r.tone?.reason, 300) },
      gaps,
      keywords: { ats: words(r.keywords?.ats), signals: words(r.keywords?.signals) },
    },
    warnings,
  };
}

/**
 * Extract and validate the suggestions from the agent's full output. Fail-closed
 * like research-review.mjs: markers count only on a line of their own, and
 * exactly one of each.
 * @param {string} text
 * @param {{allowedText?: string}} [opts]
 * @returns {ReturnType<typeof normalizeSuggestions> | {ok: false, error: string}}
 */
export function parseCoverSuggestions(text, opts) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const openers = [...normalized.matchAll(OPENER)];
  const closers = [...normalized.matchAll(CLOSER)];
  if (openers.length === 0) return { ok: false, error: "The run finished without a cover-suggest envelope, so no suggestions were saved." };
  if (openers.length > 1 || closers.length !== 1) return { ok: false, error: "The run emitted more than one suggestions envelope (or none closed), so nothing was saved." };
  const start = (openers[0].index ?? 0) + openers[0][0].length;
  const end = closers[0].index ?? -1;
  if (end < start) return { ok: false, error: "The suggestions envelope closes before it opens, so nothing was saved." };
  const body = normalized.slice(start, end).trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```\s*$/, "");
  let raw;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `The suggestions envelope is not valid JSON (${e instanceof Error ? e.message : String(e)}), so nothing was saved.` };
  }
  return normalizeSuggestions(raw, opts);
}

/**
 * Streaming filter: passes agent text to the run log but holds back the
 * envelope body, and keeps the full text for parsing.
 */
export function createCoverSuggestFilter() {
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
        if (!inside && t === OPEN_MARK) { inside = true; out += "_(suggestions hidden from the log; they appear in the cover letter form)_\n"; continue; }
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
 * The short direction a card shows ("Scale: 40M daily orders"), like the CLI's
 * menu lines. The full sentence is what a click puts in the answer box.
 * Suggestions cached before labels existed fall back to their first clause.
 * @param {{label?: string, text: string}} s
 */
export function cardLabel(s) {
  if (s.label?.trim()) return s.label.trim();
  const text = String(s.text ?? "").trim();
  const clause = text.split(/(?<=[.;:!?])\s|,\s|\s[-–]\s/)[0];
  if (clause.length <= MAX_LABEL) return clause.replace(/[.;:!?,]$/, "");
  const cut = clause.slice(0, MAX_LABEL);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : MAX_LABEL).trimEnd()}…`;
}

/** Where an answer came from, so the drafting run knows what the candidate wrote. */
export const ANSWER_SOURCES = Object.freeze(["suggested", "edited", "own"]);

/**
 * @param {string} value the answer as submitted
 * @param {string[]} picked suggestion texts the candidate clicked, in order
 * @returns {"suggested" | "edited" | "own"}
 */
export function answerSource(value, picked) {
  const v = String(value ?? "").trim();
  if (!picked.length) return "own";
  return v === joinPicked(picked) ? "suggested" : "edited";
}

/** How picked suggestions become one answer: one per line. */
export function joinPicked(picked) {
  return picked.map((p) => p.trim()).filter(Boolean).join("\n");
}
