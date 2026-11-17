/**
 * tasks.mjs — read and rewrite data/tasks.md, the task table that
 * add-task.mjs, sync-tasks.mjs and the Go dashboard (dashboard/internal/data/tasks.go)
 * already share:
 *
 *   | # | Created | Due | App# | Company | Type | Title | Status | Completed | Notes |
 *
 * Rows are written in the exact shape add-task.mjs writes, and a row this
 * module did not change is kept byte-for-byte, so the CLI, the TUI and the web
 * can all edit the same file. Pure (no I/O) so tests import it under Node.
 */

export const TASK_TYPES = ["followup", "contact", "interview", "manual"];
export const TASK_STATUSES = ["pending", "done", "skipped"];

export const TASKS_HEADER = `# Tasks

Follow-up tasks generated from cadence rules, contacto suggestions, and manual entries. Managed by \`sync-tasks.mjs\` and the dashboard.

| # | Created | Due | App# | Company | Type | Title | Status | Completed | Notes |
|---|---------|-----|------|---------|------|-------|--------|-----------|-------|`;

/**
 * @typedef {{
 *   num: number, created: string, due: string, app: number | null,
 *   company: string, type: string, title: string, status: string,
 *   completed: string, notes: string,
 * }} Task
 * @typedef {{ type: string, title: string, app?: number | null, company?: string, due?: string, notes?: string }} TaskInput
 */

/** Same rule as add-task.mjs / sync-tasks.mjs: a "|" or newline would break the table. */
export function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "¦").replace(/\r?\n/g, " ").trim();
}

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30). */
export function isRealDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function dash(v) {
  const s = String(v ?? "").trim();
  return s === "-" ? "" : s;
}

/** @param {string} line @returns {Task | null} */
function parseRow(line) {
  const t = line.trim();
  if (!t.startsWith("|") || t.startsWith("|---") || t.startsWith("| #")) return null;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const num = Number.parseInt(cells[0], 10);
  if (!Number.isFinite(num) || String(num) !== cells[0]) return null;
  const app = Number.parseInt(cells[3], 10);
  return {
    num,
    created: dash(cells[1]),
    due: dash(cells[2]),
    app: Number.isFinite(app) && app > 0 ? app : null,
    company: dash(cells[4]),
    type: dash(cells[5]),
    title: dash(cells[6]),
    status: dash(cells[7]).toLowerCase() || "pending",
    completed: dash(cells[8]),
    notes: dash(cells.slice(9).join("|")),
  };
}

/** @param {string | null | undefined} content @returns {Task[]} */
export function parseTasks(content) {
  /** @type {Task[]} */
  const out = [];
  for (const line of String(content ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const row = parseRow(line);
    if (row) out.push(row);
  }
  return out;
}

/** @param {Task} t */
export function formatTaskRow(t) {
  return `| ${t.num} | ${t.created} | ${t.due || "-"} | ${t.app ? String(t.app) : "-"} | ${escapeCell(t.company) || "-"} | ${escapeCell(t.type)} | ${escapeCell(t.title)} | ${t.status} | ${t.completed || "-"} | ${escapeCell(t.notes)} |`;
}

/** @param {TaskInput} input @returns {string | null} an error, or null when the input is valid */
export function validateTaskInput(input) {
  if (!input || typeof input !== "object") return "task must be an object";
  if (!TASK_TYPES.includes(String(input.type))) return `type must be one of: ${TASK_TYPES.join(", ")}`;
  if (typeof input.title !== "string" || !input.title.trim()) return "title is required";
  if (input.title.length > 300) return "title is too long";
  if (input.due && !isRealDate(input.due)) return `due ${input.due} is not a real calendar date (YYYY-MM-DD)`;
  if (input.app != null && !(Number.isInteger(input.app) && input.app > 0)) return "app must be a positive integer";
  if (input.notes != null && typeof input.notes !== "string") return "notes must be text";
  if (typeof input.notes === "string" && input.notes.length > 1000) return "notes are too long";
  return null;
}

/** add-task.mjs's idempotency key: a PENDING task with the same type, title and App#. */
function sameKey(a, b) {
  return a.type === b.type && a.title.trim() === b.title.trim() && (a.app ?? null) === (b.app ?? null);
}

/**
 * Split a tasks.md into its header (everything that is not a data row, trailing
 * blank lines dropped) and its data rows, kept raw.
 */
function split(content) {
  if (content == null || !String(content).trim()) return { header: TASKS_HEADER, rows: [] };
  const header = [];
  const rows = [];
  for (const line of String(content).replace(/\r\n?/g, "\n").split("\n")) {
    if (parseRow(line)) rows.push(line);
    else header.push(line);
  }
  while (header.length && header[header.length - 1].trim() === "") header.pop();
  return { header: header.join("\n"), rows };
}

function join(header, rows) {
  return `${header}\n${rows.length ? `${rows.join("\n")}\n` : ""}`;
}

/**
 * Append tasks, skipping any that match a pending task already in the file or
 * earlier in the same batch (the add-task.mjs rule).
 * @param {string | null} content current tasks.md, or null when it does not exist
 * @param {TaskInput[]} inputs already validated
 * @param {{ today: string, companyFor?: (app: number) => string }} opts
 * @returns {{ content: string, added: Task[], duplicates: TaskInput[] }}
 */
export function addTasks(content, inputs, { today, companyFor = () => "" }) {
  const { header, rows } = split(content);
  const existing = parseTasks(rows.join("\n"));
  let next = existing.reduce((m, t) => Math.max(m, t.num), 0) + 1;
  /** @type {Task[]} */
  const added = [];
  /** @type {TaskInput[]} */
  const duplicates = [];
  for (const input of inputs) {
    const app = input.app ?? null;
    const candidate = { type: input.type, title: input.title.trim(), app };
    const pending = existing.filter((t) => t.status === "pending");
    if (pending.some((t) => sameKey(t, candidate)) || added.some((t) => sameKey(t, candidate))) {
      duplicates.push(input);
      continue;
    }
    const task = {
      num: next++,
      created: today,
      due: input.due || "",
      app,
      company: (input.company || "").trim() || (app ? companyFor(app) : "") || "",
      type: input.type,
      title: candidate.title,
      status: "pending",
      completed: "",
      notes: (input.notes || "").trim(),
    };
    added.push(task);
    rows.push(formatTaskRow(task));
  }
  return { content: join(header, rows), added, duplicates };
}

/**
 * Set one task's status. done/skipped stamp Completed with `today`; pending
 * (reopen) clears it, the same as the Go dashboard's undo.
 * @param {string} content
 * @param {number} num
 * @param {string} status
 * @param {string} today
 * @returns {{ content: string, task: Task }}
 */
export function setTaskStatus(content, num, status, today) {
  if (!TASK_STATUSES.includes(status)) throw new Error(`status must be one of: ${TASK_STATUSES.join(", ")}`);
  const { header, rows } = split(content);
  let found = null;
  const out = rows.map((line) => {
    const t = parseRow(line);
    if (!t || t.num !== num) return line;
    found = { ...t, status, completed: status === "pending" ? "" : today };
    return formatTaskRow(found);
  });
  if (!found) throw new Error(`task #${num} not found`);
  return { content: join(header, out), task: found };
}

/** Sort for display: dated tasks by due date, undated last, then by number. */
export function compareTasks(a, b) {
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  return a.num - b.num;
}

/**
 * "overdue" | "today" | "upcoming" | "undated" for a pending task.
 * @param {Task} t @param {string} today
 */
export function dueBucket(t, today) {
  if (!t.due) return "undated";
  if (t.due < today) return "overdue";
  if (t.due === today) return "today";
  return "upcoming";
}

/**
 * The link a task's notes point at, when they hold one (contacto writes the
 * LinkedIn URL without https://). "" otherwise.
 * @param {string} notes
 */
export function notesLink(notes) {
  const s = String(notes ?? "").trim();
  const m = s.match(/^(https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)$/i);
  if (!m) return "";
  return m[1] ? s : `https://${s}`;
}
