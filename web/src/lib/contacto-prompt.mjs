/**
 * contacto-prompt.mjs — the contacto research prompt (modes/contacto.md,
 * MODE A) filled in for one application, and the parser for the
 * `node add-task.mjs …` block that prompt makes Claude emit, so the web can
 * turn Claude's reply into rows in data/tasks.md.
 *
 * The template is read from modes/contacto.md at request time, never copied
 * here, so an update to the mode reaches the web without a code change. Only
 * the placeholders that need local data (the company, role, URL, today's
 * date, the App#, the candidate's headline and LinkedIn) are filled; the rest
 * are instructions for Claude to fill from its research. Pure (no I/O).
 */

import { TASK_TYPES } from "./tasks.mjs";

/** Tracker states after the application went out: the point to start outreach. */
export const OUTREACH_STATUSES = ["applied", "responded", "assessment", "interview"];

/** @param {string | null | undefined} status */
export function outreachEligible(status) {
  const s = String(status ?? "").replace(/\*/g, "").trim().toLowerCase();
  return OUTREACH_STATUSES.includes(s);
}

/**
 * The research prompt template: the one ````markdown fenced block under
 * "## MODE A" in modes/contacto.md. "" when the mode file has none.
 * @param {string | null | undefined} modeMd
 */
export function extractContactoTemplate(modeMd) {
  const lines = String(modeMd ?? "").replace(/\r\n?/g, "\n").split("\n");
  const modeA = lines.findIndex((l) => /^##\s+MODE A\b/i.test(l.trim()));
  if (modeA === -1) return "";
  let open = -1;
  for (let i = modeA + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^##\s+MODE B\b/i.test(t)) return "";
    if (/^````+/.test(t)) {
      open = i;
      break;
    }
  }
  if (open === -1) return "";
  const fence = lines[open].trim().match(/^`+/)[0];
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].trim() === fence) return lines.slice(open + 1, i).join("\n").trim();
  }
  return "";
}

/**
 * One line about the candidate for message tailoring, from config/profile.yml
 * (narrative.headline, then the exit story or superpowers). "" when the
 * profile has neither.
 * @param {unknown} profile parsed profile.yml
 */
export function profileSummary(profile) {
  const n = /** @type {any} */ (profile)?.narrative ?? {};
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const headline = str(n.headline);
  const story = str(n.exit_story);
  const powers = Array.isArray(n.superpowers) ? n.superpowers.map(str).filter(Boolean) : [];
  const second = story || (powers.length ? `Strengths: ${powers.join(", ")}` : "");
  return [headline, second].filter(Boolean).join(" — ");
}

/** @param {unknown} profile */
export function profileLinkedin(profile) {
  const v = /** @type {any} */ (profile)?.candidate?.linkedin;
  return typeof v === "string" ? v.trim() : "";
}

function shellQuote(s) {
  return `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * @param {string} template from extractContactoTemplate
 * @param {{ company: string, role: string, url?: string, today: string, appNum?: number | null,
 *           summary?: string, linkedin?: string, location?: string }} ctx
 * @returns {string} "" when the template is empty
 */
export function buildContactoPrompt(template, ctx) {
  if (!template) return "";
  const company = ctx.company.trim();
  const role = ctx.role.trim() || "(role not recorded)";
  const appArg = ctx.appNum ? `--app ${ctx.appNum}` : `--company ${shellQuote(company)}`;
  const literal = (s) => () => s; // never let a "$&" in the data act as a replacement pattern
  return template
    .split("\n")
    .map((line) => {
      // Section 1's per-priority hints are instructions for the researcher;
      // keep their text and drop the placeholder braces.
      if (/^\*\*Priority \d/.test(line.trim())) {
        line = line.replace(/\{Company\}/g, literal(company)).replace(/\{([^{}]*)\}/g, (_m, inner) => inner);
      }
      return line;
    })
    .join("\n")
    .replace(/\{1-line summary[^}]*\}/g, literal(ctx.summary || "(see my LinkedIn profile)"))
    .replace(/\{linkedin url[^}]*\}/gi, literal(ctx.linkedin || "(not set)"))
    .replace(/\{ — comp\/location notes if known\}/g, literal(ctx.location ? ` — ${ctx.location}` : ""))
    .replace(/\{URL if provided\}/g, literal(ctx.url || "not available"))
    // Only the "Today's date" placeholder: section 5's `--due {YYYY-MM-DD}` is Claude's to fill.
    .replace(/\{YYYY-MM-DD — [^}]*\}/g, literal(ctx.today))
    .replace(/\{APP_OR_COMPANY\}/g, literal(appArg))
    .replace(/\{Company\}/g, literal(company))
    .replace(/\{Role\}/g, literal(role));
}

/**
 * Shell-style words: whitespace splits, "…" (with \" \\ \$ \` escapes) and
 * '…' quote. Never executed — only read for flag values.
 * @param {string} s
 * @returns {string[]}
 */
export function shellWords(s) {
  const out = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      has = true;
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\" && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) i++;
        cur += s[i];
      }
    } else if (c === "'") {
      has = true;
      for (i++; i < s.length && s[i] !== "'"; i++) cur += s[i];
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const FLAGS = new Set(["type", "title", "company", "app", "due", "notes"]);

/**
 * Every `node add-task.mjs …` command in pasted text (Claude's whole reply, or
 * just the bash block), as task inputs. Nothing is run.
 * @param {string} text
 * @returns {{ tasks: { type: string, title: string, app: number | null, company: string, due: string, notes: string, line: string }[],
 *             errors: { line: string, error: string }[] }}
 */
export function parseAddTaskCommands(text) {
  const joined = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\\\n/g, " ");
  const tasks = [];
  const errors = [];
  for (const raw of joined.split("\n")) {
    const at = raw.indexOf("add-task.mjs");
    if (at === -1) continue;
    const line = raw.trim().replace(/^[$>]\s*/, "");
    const words = shellWords(raw.slice(at + "add-task.mjs".length));
    /** @type {Record<string, string>} */
    const f = {};
    let bad = "";
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === "--json") continue;
      if (!w.startsWith("--")) continue;
      const key = w.slice(2);
      const val = words[i + 1];
      if (val === undefined || val.startsWith("--")) {
        bad = `${w} has no value`;
        break;
      }
      if (FLAGS.has(key)) f[key] = val;
      i++;
    }
    if (!bad && !TASK_TYPES.includes(f.type ?? "")) bad = `--type must be one of: ${TASK_TYPES.join(", ")}`;
    if (!bad && !(f.title ?? "").trim()) bad = "--title is missing";
    let app = null;
    if (!bad && f.app !== undefined) {
      app = /^\d+$/.test(f.app) ? Number(f.app) : NaN;
      if (!(app > 0)) bad = "--app must be a positive number";
    }
    if (!bad && f.due && !/^\d{4}-\d{2}-\d{2}$/.test(f.due)) bad = "--due must be YYYY-MM-DD";
    if (bad) {
      errors.push({ line, error: bad });
      continue;
    }
    tasks.push({
      type: f.type,
      title: f.title.trim(),
      app,
      company: (f.company ?? "").trim(),
      due: f.due ?? "",
      notes: (f.notes ?? "").trim(),
      line,
    });
  }
  return { tasks, errors };
}
