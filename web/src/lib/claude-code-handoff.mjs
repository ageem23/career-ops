// Hand a task from the web UI to an interactive Claude Code session.
//
// The web workers run with a narrow write scope, so a few jobs (recording a
// salary answer in the tracker notes, editing cv.md or article-digest.md, an
// open-ended question) belong in a normal Claude Code session, which uses the
// user's own permissions. These links open one in the project folder with the
// prompt typed in. Nothing runs until the user presses Enter.
//
// Terminal: claude-cli://open?cwd=&q=  (code.claude.com/docs/en/deep-links)
//   Opens Windows Terminal (else PowerShell, else cmd) running `claude`. The
//   scheme is registered once the user has used interactive `claude` on the
//   machine. q is capped at 5,000 characters.
// Desktop:  claude://code/new?folder=&q=  (Claude Desktop "Open with a link")
//   Opens the Code tab. Desktop asks the user to confirm the folder every time.

/** Terminal deep links reject a prompt longer than this. */
export const TERMINAL_PROMPT_LIMIT = 5000;

/**
 * @param {{ cwd: string, prompt?: string }} args
 * @returns {{ terminal: string, desktop: string }}
 */
export function claudeCodeLinks({ cwd, prompt = "" }) {
  if (!cwd) throw new Error("claudeCodeLinks needs the project folder");
  if (prompt.length > TERMINAL_PROMPT_LIMIT) {
    throw new Error(`Claude Code handoff prompt is ${prompt.length} characters; the terminal link takes ${TERMINAL_PROMPT_LIMIT}`);
  }
  const q = prompt ? `&q=${encodeURIComponent(prompt)}` : "";
  return {
    terminal: `claude-cli://open?cwd=${encodeURIComponent(cwd)}${q}`,
    desktop: `claude://code/new?folder=${encodeURIComponent(cwd)}${q}`,
  };
}

/**
 * The line that names the application, shared by every prompt.
 * @param {{ n: string, company: string, role?: string, reportFile?: string | null, trackerRow?: string | number | null }} app
 */
function appLine({ n, company, role, reportFile, trackerRow }) {
  const parts = [`career-ops, application #${n}: ${company}${role ? ` — ${role}` : ""}.`];
  if (reportFile) parts.push(`Report: ${reportFile}.`);
  if (trackerRow != null && trackerRow !== "") parts.push(`Tracker row #${trackerRow}.`);
  return parts.join(" ");
}

/**
 * The application asks for salary expectations. Needs a tracker row: the answer
 * is recorded in that row's notes.
 * @param {{ n: string, company: string, role?: string, reportFile?: string | null, trackerRow: string | number }} app
 */
export function salaryPrompt(app) {
  return [
    appLine(app),
    "The application asks for my salary expectations.",
    "Read the report's compensation block (D) and any interview-prep research for this role, plus `compensation` in config/profile.yml and the negotiation scripts in modes/_profile.md.",
    "Recommend what to state, with a paste-ready answer and a number-only version for a form field. Keep my walk-away minimum private.",
    `After I tell you what I entered, append it to the tracker row's notes with node set-status.mjs --row ${app.trackerRow} <status> --note "Salary expectation given on <where> <date>: <answer>".`,
    "Read the row's current status right before writing and pass it unchanged, so the note never moves the status.",
  ].join(" ");
}

/**
 * While reviewing a tailored CV, change the source files it is built from.
 * @param {{ n: string, company: string, role?: string, reportFile?: string | null, trackerRow?: string | number | null }} app
 */
export function sourceEditPrompt(app) {
  return [
    appLine(app),
    "I'm reviewing the tailored CV for this application and want to change content that comes from my source files (cv.md, article-digest.md), so every future CV gets it, not only this one.",
    "Ask me what I want changed. Then propose the exact edit and wait for my OK before writing.",
    "Follow the Source-of-Truth rules in AGENTS.md: reword and condense freely, but never add a claim, number or authorship I haven't stated.",
    "If what I want is a standing style rule (length, layout, wording) rather than a fact, it goes in modes/_custom.md instead.",
    "After the edit, tell me whether this CV should be regenerated.",
  ].join(" ");
}

/** Longest single message carried over from the web assistant. */
const CONSOLE_MESSAGE_LIMIT = 800;

/**
 * Continue a web-assistant conversation in Claude Code. Keeps the newest
 * messages that fit (oldest dropped first) so the prompt stays under the
 * terminal link's limit, and ends with the user's unsent draft, if any.
 * @param {{ page: string, messages: { role: "user" | "assistant", text: string }[], draft?: string }} args
 */
export function consolePrompt({ page, messages, draft = "" }) {
  const head = [
    "career-ops: continuing a conversation from the web assistant, where I could not do this (its workers have limited write access).",
    page ? `Page I was on: ${page}` : "",
  ].filter(Boolean).join("\n");
  const ask = draft.trim()
    ? `My next message: ${draft.trim()}`
    : "Pick up from there; I'll tell you what I need next.";
  const clip = (s) => (s.length > CONSOLE_MESSAGE_LIMIT ? `${s.slice(0, CONSOLE_MESSAGE_LIMIT)}…` : s);
  const lines = messages
    .map((m) => ({ role: m.role, text: m.text.trim() }))
    .filter((m) => m.text)
    .map((m) => `${m.role === "user" ? "Me" : "Web assistant"}: ${clip(m.text)}`);
  const budget = TERMINAL_PROMPT_LIMIT - head.length - ask.length - 200;
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length + 1 > budget) break;
    kept.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  const dropped = lines.length - kept.length;
  const convo = kept.length
    ? `Recent conversation${dropped ? ` (${dropped} older message${dropped === 1 ? "" : "s"} left out)` : ""}:\n${kept.join("\n")}`
    : "";
  return [head, convo, ask].filter(Boolean).join("\n\n");
}

/** Most of a failed run's output carried over: its tail, where the error usually is. */
const JOB_OUTPUT_TAIL = 1500;

/**
 * A web run (worker job) ended in an error. Hands the run's identity, error,
 * last steps and output tail to Claude Code to diagnose. Diagnosis first:
 * nothing is changed until the user agrees.
 * @param {{ id: string, kind?: string, title: string, subtitle?: string, input?: string, page?: string, error?: string, steps?: string[], output?: string, startedAt?: number, endedAt?: number }} job
 */
export function jobErrorPrompt(job) {
  const when = (t) => (t ? new Date(t).toISOString() : "");
  const facts = [
    `Run id: ${job.id}`,
    job.kind ? `Kind: ${job.kind}` : "",
    `Title: ${job.title}${job.subtitle ? ` (${job.subtitle})` : ""}`,
    job.input ? `Input: ${job.input}` : "",
    job.page ? `Started from page: ${job.page}` : "",
    job.startedAt ? `Started: ${when(job.startedAt)}${job.endedAt ? `, ended: ${when(job.endedAt)}` : ""}` : "",
    job.error ? `Error shown: ${job.error}` : "",
  ].filter(Boolean);
  const head = [
    "career-ops: a web run failed and I want to work it out here.",
    facts.join("\n"),
  ].join("\n\n");
  const ask = [
    "Find the cause: read the code for this run kind under web/src (the route is web/src/app/api/run/route.ts) and any run log at .career-ops-web/runs/<run id>.md.",
    "Tell me whether it was a one-off (just retry) or a bug, and propose a fix. Don't change any file until I agree.",
    "If the task itself can be done in this session instead, offer that too.",
  ].join(" ");
  const steps = (job.steps ?? []).filter(Boolean).slice(-8);
  let output = (job.output ?? "").trim();
  if (output.length > JOB_OUTPUT_TAIL) output = `…${output.slice(-JOB_OUTPUT_TAIL)}`;
  const parts = [head];
  if (steps.length) parts.push(`Last steps:\n${steps.map((s) => `- ${s}`).join("\n")}`);
  if (output) parts.push(`End of the worker output:\n${output}`);
  parts.push(ask);
  let prompt = parts.join("\n\n");
  // An unusually long error or step label: keep the head and the ask, drop the middle.
  if (prompt.length > TERMINAL_PROMPT_LIMIT) {
    prompt = [head.slice(0, TERMINAL_PROMPT_LIMIT - ask.length - 50), ask].join("\n\n…\n\n");
  }
  return prompt;
}

/**
 * An open question about one application. The user types the question after
 * the prefilled context.
 * @param {{ n: string, company: string, role?: string, reportFile?: string | null, trackerRow?: string | number | null }} app
 */
export function askPrompt(app) {
  return [
    appLine(app),
    "Read the report and the tracker row first, then answer my question. Don't write any file unless I ask.",
    "My question:",
  ].join(" ") + " ";
}
