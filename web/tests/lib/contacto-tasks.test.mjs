import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildContactoPrompt,
  extractContactoTemplate,
  outreachEligible,
  parseAddTaskCommands,
  profileSummary,
  shellWords,
} from "../../src/lib/contacto-prompt.mjs";
import { addTasks, formatTaskRow, notesLink, parseTasks, setTaskStatus, validateTaskInput } from "../../src/lib/tasks.mjs";

const MODE = readFileSync(fileURLToPath(new URL("../../../modes/contacto.md", import.meta.url)), "utf8");

test("the MODE A template is found in the real modes/contacto.md", () => {
  const t = extractContactoTemplate(MODE);
  assert.match(t, /^## Contacto Research: \{Company\} — \{Role\}/);
  assert.match(t, /\{APP_OR_COMPANY\}/);
  assert.match(t, /\*\*Deliverable:\*\*/);
  assert.doesNotMatch(t, /MODE B/);
});

test("buildContactoPrompt fills the local placeholders and leaves Claude's", () => {
  const p = buildContactoPrompt(extractContactoTemplate(MODE), {
    company: "Acme $& Co",
    role: "VP Engineering",
    url: "https://jobs.example.com/1",
    today: "2026-11-12",
    appNum: 412,
    summary: "CTO — 24 years",
    linkedin: "linkedin.com/in/someone",
    location: "Remote (US)",
  });
  assert.match(p, /^## Contacto Research: Acme \$& Co — VP Engineering/);
  assert.match(p, /\*\*Today's date:\*\* 2026-11-12\./);
  assert.match(p, /VP Engineering at Acme \$& Co — Remote \(US\)\. Job URL: https:\/\/jobs\.example\.com\/1\./);
  assert.match(p, /- CTO — 24 years/);
  assert.match(p, /- LinkedIn: linkedin\.com\/in\/someone/);
  assert.match(p, /node add-task\.mjs --type contact --app 412 --title/);
  assert.match(p, /"People at Acme \$& Co" filtered/);
  // Placeholders the researcher fills stay intact.
  assert.match(p, /--due \{YYYY-MM-DD\}/);
  assert.match(p, /\{Full Name\}/);
  for (const gone of ["{Company}", "{Role}", "{APP_OR_COMPANY}", "{URL if provided}", "{1-line summary", "{linkedin url"]) {
    assert.ok(!p.includes(gone), `left ${gone}`);
  }
  assert.doesNotMatch(p, /^\*\*Priority \d.*[{}]/m);
});

test("buildContactoPrompt falls back to --company when there is no App#", () => {
  const p = buildContactoPrompt(extractContactoTemplate(MODE), { company: 'Say "Hi"', role: "", today: "2026-11-12" });
  assert.match(p, /--type contact --company "Say \\"Hi\\"" --title/);
});

test("outreachEligible covers the post-apply states only", () => {
  assert.equal(outreachEligible("Applied"), true);
  assert.equal(outreachEligible("**Interview**"), true);
  assert.equal(outreachEligible("Evaluated"), false);
  assert.equal(outreachEligible("Rejected"), false);
});

test("profileSummary joins headline and exit story", () => {
  assert.equal(profileSummary({ narrative: { headline: "CTO", exit_story: "Built things." } }), "CTO — Built things.");
  assert.equal(profileSummary({ narrative: { superpowers: ["A", "B"] } }), "Strengths: A, B");
  assert.equal(profileSummary(null), "");
});

test("shellWords handles quotes and escapes", () => {
  assert.deepEqual(shellWords(`--title "LinkedIn: Jo \\"JJ\\" Doe (Peer)" --notes 'a b' x\\ y`), [
    "--title",
    'LinkedIn: Jo "JJ" Doe (Peer)',
    "--notes",
    "a b",
    "x y",
  ]);
});

test("parseAddTaskCommands reads Claude's block and reports bad lines", () => {
  const reply = [
    "Here are your tasks:",
    "```bash",
    'node add-task.mjs --type contact --app 412 --title "LinkedIn: Jane Doe (Recruiter)" --notes "linkedin.com/in/jane-doe" --due 2026-11-14',
    '$ node add-task.mjs --type contact --company "Acme" --title "LinkedIn: John Smith (Hiring Manager)" \\',
    '    --notes "linkedin.com/in/john-smith"',
    'node add-task.mjs --type outreach --title "x"',
    'node add-task.mjs --type contact --app 412 --title',
    "```",
  ].join("\r\n");
  const { tasks, errors } = parseAddTaskCommands(reply);
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    { ...tasks[0], line: undefined },
    { type: "contact", title: "LinkedIn: Jane Doe (Recruiter)", app: 412, company: "", due: "2026-11-14", notes: "linkedin.com/in/jane-doe", line: undefined },
  );
  assert.equal(tasks[1].company, "Acme");
  assert.equal(tasks[1].app, null);
  assert.equal(tasks[1].notes, "linkedin.com/in/john-smith");
  assert.equal(errors.length, 2);
  assert.match(errors[0].error, /--type/);
  assert.match(errors[1].error, /no value/);
});

const FILE = `# Tasks

Intro.

| # | Created | Due | App# | Company | Type | Title | Status | Completed | Notes |
|---|---------|-----|------|---------|------|-------|--------|-----------|-------|
| 1 | 2026-05-13 | 2026-05-13 | 324 | Adyen | followup | Follow up #1 — EM | done | 2026-05-19 | overdue |
| 2 | 2026-05-13 | - | 412 | Acme | contact | LinkedIn: Jane Doe (Recruiter) | pending | - | linkedin.com/in/jane-doe |
`;

test("parseTasks reads the shared table", () => {
  const t = parseTasks(FILE);
  assert.equal(t.length, 2);
  assert.deepEqual(t[1], {
    num: 2, created: "2026-05-13", due: "", app: 412, company: "Acme", type: "contact",
    title: "LinkedIn: Jane Doe (Recruiter)", status: "pending", completed: "", notes: "linkedin.com/in/jane-doe",
  });
});

test("addTasks appends in add-task.mjs's row shape, skipping pending duplicates", () => {
  const { content, added, duplicates } = addTasks(
    FILE,
    [
      { type: "contact", title: "LinkedIn: Jane Doe (Recruiter)", app: 412 },
      { type: "contact", title: "LinkedIn: John | Smith (HM)", app: 412, due: "2026-11-14", notes: "linkedin.com/in/js" },
      { type: "contact", title: "LinkedIn: John | Smith (HM)", app: 412 },
    ],
    { today: "2026-11-12", companyFor: (n) => (n === 412 ? "Acme" : "") },
  );
  assert.equal(added.length, 1);
  assert.equal(duplicates.length, 2);
  const lines = content.trimEnd().split("\n");
  assert.equal(lines.at(-1), "| 3 | 2026-11-12 | 2026-11-14 | 412 | Acme | contact | LinkedIn: John ¦ Smith (HM) | pending | - | linkedin.com/in/js |");
  // Untouched rows and the header are kept byte-for-byte.
  assert.ok(content.startsWith(FILE.trimEnd()));
});

test("addTasks creates the file with the canonical header", () => {
  const { content } = addTasks(null, [{ type: "manual", title: "Prep" }], { today: "2026-11-12" });
  assert.match(content, /^# Tasks\n/);
  assert.match(content, /\| 1 \| 2026-11-12 \| - \| - \| - \| manual \| Prep \| pending \| - \|  \|\n$/);
});

test("setTaskStatus stamps and clears Completed", () => {
  const done = setTaskStatus(FILE, 2, "done", "2026-11-12");
  assert.equal(done.task.completed, "2026-11-12");
  assert.match(done.content, /\| 2 \| 2026-05-13 \| - \| 412 \| Acme \| contact \| LinkedIn: Jane Doe \(Recruiter\) \| done \| 2026-11-12 \|/);
  const reopened = setTaskStatus(done.content, 2, "pending", "2026-11-13");
  assert.equal(reopened.content, FILE);
  assert.throws(() => setTaskStatus(FILE, 9, "done", "2026-11-12"), /not found/);
  assert.throws(() => setTaskStatus(FILE, 2, "archived", "2026-11-12"), /status/);
});

test("formatTaskRow round-trips through parseTasks", () => {
  const t = { num: 7, created: "2026-11-12", due: "", app: null, company: "", type: "manual", title: "T", status: "pending", completed: "", notes: "" };
  assert.deepEqual(parseTasks(formatTaskRow(t))[0], t);
});

test("validateTaskInput and notesLink", () => {
  assert.equal(validateTaskInput({ type: "contact", title: "x", due: "2026-02-30" }), "due 2026-02-30 is not a real calendar date (YYYY-MM-DD)");
  assert.equal(validateTaskInput({ type: "contact", title: "x", app: 3 }), null);
  assert.equal(notesLink("linkedin.com/in/jane-doe"), "https://linkedin.com/in/jane-doe");
  assert.equal(notesLink("https://x.io/a"), "https://x.io/a");
  assert.equal(notesLink("overdue"), "");
});
