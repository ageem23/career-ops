import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TERMINAL_PROMPT_LIMIT,
  askPrompt,
  claudeCodeLinks,
  salaryPrompt,
  sourceEditPrompt,
} from "../../src/lib/claude-code-handoff.mjs";

const CWD = "C:\\Users\\example\\repos\\career-ops";
const APP = {
  n: "7238",
  company: "Example Agency",
  role: "Director of Engineering, Solution Architecture",
  reportFile: "reports/7238-example-agency-2026-11-14.md",
  trackerRow: "7238",
};

test("links open the project folder with the prompt URL-encoded", () => {
  const links = claudeCodeLinks({ cwd: CWD, prompt: "a & b = c?" });
  assert.equal(links.terminal, `claude-cli://open?cwd=${encodeURIComponent(CWD)}&q=${encodeURIComponent("a & b = c?")}`);
  assert.equal(links.desktop, `claude://code/new?folder=${encodeURIComponent(CWD)}&q=${encodeURIComponent("a & b = c?")}`);
  assert.equal(new URL(links.terminal).searchParams.get("cwd"), CWD);
  assert.equal(new URL(links.terminal).searchParams.get("q"), "a & b = c?");
});

test("no prompt opens a bare session", () => {
  assert.equal(claudeCodeLinks({ cwd: CWD }).terminal, `claude-cli://open?cwd=${encodeURIComponent(CWD)}`);
});

test("a prompt over the terminal link's limit is refused, not truncated", () => {
  assert.throws(() => claudeCodeLinks({ cwd: CWD, prompt: "x".repeat(TERMINAL_PROMPT_LIMIT + 1) }), /5000/);
  assert.throws(() => claudeCodeLinks({ cwd: "" }), /project folder/);
});

test("the salary prompt records the answer without moving the status", () => {
  const prompt = salaryPrompt(APP);
  assert.match(prompt, /set-status\.mjs --row 7238 <status> --note/);
  assert.match(prompt, /pass it unchanged/);
  assert.match(prompt, /walk-away minimum private/);
  assert.match(prompt, /reports\/7238-example-agency/);
});

test("the source-edit prompt confirms before writing and keeps to the source files", () => {
  const prompt = sourceEditPrompt({ n: "7238", company: "Example Agency" });
  assert.match(prompt, /cv\.md, article-digest\.md/);
  assert.match(prompt, /wait for my OK before writing/);
  assert.match(prompt, /never add a claim/);
  assert.match(prompt, /modes\/_custom\.md/);
});

test("the ask prompt ends where the user types the question", () => {
  assert.match(askPrompt(APP), /My question: $/);
});

test("every prompt fits the terminal link with long names", () => {
  const long = { ...APP, company: "C".repeat(200), role: "R".repeat(300) };
  for (const prompt of [salaryPrompt(long), sourceEditPrompt(long), askPrompt(long)]) {
    assert.ok(prompt.length < TERMINAL_PROMPT_LIMIT, `${prompt.length} chars`);
    assert.doesNotThrow(() => claudeCodeLinks({ cwd: CWD, prompt }));
  }
});

test("the console prompt carries the page, the conversation and the draft", async () => {
  const { consolePrompt } = await import("../../src/lib/claude-code-handoff.mjs");
  const prompt = consolePrompt({
    page: "Pipeline",
    messages: [{ role: "user", text: "Add a note to #12" }, { role: "assistant", text: "I can't write the tracker." }, { role: "assistant", text: "  " }],
    draft: "Do it in the CLI",
  });
  assert.match(prompt, /Page I was on: Pipeline/);
  assert.match(prompt, /Me: Add a note to #12\nWeb assistant: I can't write the tracker\./);
  assert.match(prompt, /My next message: Do it in the CLI$/);
  assert.doesNotMatch(prompt, /left out/);
});

test("a long console conversation keeps the newest messages and fits the link", async () => {
  const { consolePrompt } = await import("../../src/lib/claude-code-handoff.mjs");
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `message ${i} ${"x".repeat(900)}` }));
  const prompt = consolePrompt({ page: "Today", messages });
  assert.ok(prompt.length <= TERMINAL_PROMPT_LIMIT, `${prompt.length} chars`);
  assert.match(prompt, /message 39 /);
  assert.doesNotMatch(prompt, /message 0 /);
  assert.match(prompt, /older messages left out/);
  assert.match(prompt, /Pick up from there/);
});

test("a failed run's prompt carries its error, steps and output tail, and asks before changing files", async () => {
  const { jobErrorPrompt } = await import("../../src/lib/claude-code-handoff.mjs");
  const prompt = jobErrorPrompt({
    id: "job-1-0",
    kind: "pdf",
    title: "Tailored CV · Example Agency",
    input: "7238",
    page: "/pipeline/7238",
    error: "CV not generated. experience[0] is missing role",
    steps: ["Agent ready", "Using Read"],
    output: "y".repeat(3000) + " END",
    startedAt: Date.UTC(2026, 10, 16, 15, 0),
  });
  assert.match(prompt, /Run id: job-1-0\nKind: pdf/);
  assert.match(prompt, /Error shown: CV not generated\. experience\[0\] is missing role/);
  assert.match(prompt, /- Using Read/);
  assert.match(prompt, /…y+ END/);
  assert.ok(!prompt.includes("y".repeat(1600)), "only the output tail is kept");
  assert.match(prompt, /Don't change any file until I agree/);
  assert.ok(prompt.length <= TERMINAL_PROMPT_LIMIT);
});

test("a failed run with a huge error still fits the link", async () => {
  const { jobErrorPrompt } = await import("../../src/lib/claude-code-handoff.mjs");
  const prompt = jobErrorPrompt({ id: "job-2", title: "x", error: "e".repeat(9000), steps: ["s".repeat(900)] });
  assert.ok(prompt.length <= TERMINAL_PROMPT_LIMIT, `${prompt.length} chars`);
  assert.match(prompt, /Don't change any file until I agree/);
});
