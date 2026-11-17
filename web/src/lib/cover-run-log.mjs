/**
 * cover-run-log.mjs — the saved log of a web cover-letter run, as the
 * "Build cover letter" Claude Code handoff reads it.
 *
 * A web cover run is draft-only (run-prompts.mjs, kind "cover"): it stops at
 * Step 8 and renders no PDF. /api/runs/save writes the finished run to
 * .career-ops-web/runs/{id}.md. This module adds the candidate's Step 5/6
 * answers to that log, so an interactive session can pick the letter up from
 * the file instead of a pasted draft, and finds the newest usable draft for
 * one application.
 */
import fs from "node:fs";
import path from "node:path";
import { COVER_TONES } from "./cover-tones.mjs";
import { ANSWER_SOURCES } from "./cover-suggest.mjs";

/** Title prefix job-store gives every cover run (cover-draft-button.tsx). */
const COVER_TITLE = "# Web run · Cover letter · ";
/** Bytes read from each log to see its header. */
const HEAD_BYTES = 2048;
/** Per-field caps: the form's own limits (cover-brief.mjs), with headroom. */
const FIELD_CAP = { why: 1000, problem: 1000, approach: 1000, gaps: 2000, research: 1500 };
const QUESTIONS = [
  ["why", "A. Why this role / company"],
  ["problem", "B. Problem to solve"],
  ["approach", "C. Approach"],
];
const SOURCE_NOTE = { suggested: "picked from the AI suggestions", edited: "an AI suggestion you edited", own: "your own words" };

/** @param {unknown} v @param {number} cap */
function clean(v, cap) {
  return typeof v === "string" ? v.trim().slice(0, cap) : "";
}

/**
 * The "## Your answers" section for a cover run's saved log, or "" when the
 * brief has none of the four answers. The answers are quoted as blockquotes so
 * a line that looks like a heading cannot break the log's structure.
 * @param {unknown} brief the brief the cover form submitted (cover-brief-form.tsx)
 * @returns {string}
 */
export function coverBriefSection(brief) {
  if (!brief || typeof brief !== "object") return "";
  const b = /** @type {Record<string, unknown>} */ (brief);
  const quote = (text) => text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  const parts = [];
  for (const [key, label] of QUESTIONS) {
    const answer = clean(b[key], FIELD_CAP[key]);
    if (!answer) continue;
    const from = typeof b[`${key}From`] === "string" && ANSWER_SOURCES.includes(b[`${key}From`]) ? ` (${SOURCE_NOTE[b[`${key}From`]]})` : "";
    parts.push(`**${label}**${from}\n\n${quote(answer)}`);
  }
  if (parts.length === 0) return "";
  const tone = typeof b.tone === "string" && Object.hasOwn(COVER_TONES, b.tone) ? COVER_TONES[b.tone] : "";
  if (tone) parts.push(`**D. Tone:** ${tone}`);
  const gaps = clean(b.gaps, FIELD_CAP.gaps);
  if (gaps) parts.push(`**Step 5 gap answers**\n\n${quote(gaps)}`);
  const research = clean(b.research, FIELD_CAP.research);
  if (research) parts.push(`**Company research you confirmed (Step 3)**\n\n${quote(research)}`);
  return `## Your answers (cover mode Steps 5 and 6)\n\n${parts.join("\n\n")}\n`;
}

/**
 * True when a saved log's header is a usable cover draft for application `n`.
 * Logs written before the kind line was added are recognised by their title.
 * A run whose verdict is under 2/5 wrote no usable draft (the same rule as
 * coverDraftButtonState).
 * @param {string} head the start of the log
 * @param {string} n application number
 */
export function isCoverDraftLog(head, n) {
  const line = (key) => new RegExp(`^- ${key}: (.*)$`, "m").exec(head)?.[1]?.trim() ?? null;
  const kind = line("kind");
  if (kind ? kind !== "cover" : !head.startsWith(COVER_TITLE)) return false;
  if (line("page") !== `/pipeline/${n}`) return false;
  const status = line("status");
  if (status && status !== "done") return false;
  const score = Number.parseFloat(line("verdict") ?? "");
  return Number.isFinite(score) && score >= 2;
}

/**
 * The newest saved cover draft for application `n`, or null.
 * @param {string} runsDir {data root}/.career-ops-web/runs
 * @param {string} n application number
 * @param {{ readdirSync: typeof fs.readdirSync, statSync: typeof fs.statSync, openSync: typeof fs.openSync, readSync: typeof fs.readSync, closeSync: typeof fs.closeSync }} [fsApi]
 * @returns {{ id: string, file: string } | null} file is absolute
 */
export function findLatestCoverRun(runsDir, n, fsApi = fs) {
  if (!/^\d+$/.test(String(n))) return null;
  let names;
  try {
    names = fsApi.readdirSync(runsDir).filter((name) => /^[a-z0-9_-]+\.md$/i.test(name));
  } catch {
    return null;
  }
  const files = [];
  for (const name of names) {
    const file = path.join(runsDir, name);
    try {
      files.push({ name, file, mtime: fsApi.statSync(file).mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { name, file } of files) {
    let head = "";
    try {
      const fd = fsApi.openSync(file, "r");
      try {
        const buf = Buffer.alloc(HEAD_BYTES);
        head = buf.toString("utf8", 0, fsApi.readSync(fd, buf, 0, HEAD_BYTES, 0));
      } finally {
        fsApi.closeSync(fd);
      }
    } catch {
      continue;
    }
    if (isCoverDraftLog(head, String(n))) return { id: name.slice(0, -3), file };
  }
  return null;
}

/**
 * How a prompt should name a file for a session opened in `cwd`: relative when
 * the file is inside it, absolute otherwise (a data root outside the checkout).
 * @param {string} cwd
 * @param {string} file absolute
 */
export function promptPath(cwd, file) {
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join("/");
}
