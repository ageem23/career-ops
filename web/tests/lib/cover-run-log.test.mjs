import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coverBriefSection, findLatestCoverRun, isCoverDraftLog, promptPath } from "../../src/lib/cover-run-log.mjs";

const BRIEF = {
  tone: "conversational",
  why: "The in-place upgrade is the work I've done for years.",
  whyFrom: "edited",
  problem: "Moving installed customers to hosted\nwithout losing them.",
  problemFrom: "suggested",
  approach: "Start with the release train.",
  approachFrom: "own",
  gaps: "No transit experience: leave it out.",
  research: "Growing from 6.4 to 26.6.",
};

function log({ title = "Cover letter · Example Co", page = "/pipeline/7390", kind = "cover", status = "done", verdict = "5/5 — Complete draft" } = {}) {
  return `# Web run · ${title}\n\n- id: job-1\n- page: ${page}\n- input: 7390\n${kind ? `- kind: ${kind}\n` : ""}${status ? `- status: ${status}\n` : ""}- verdict: ${verdict}\n\n## Steps\n- Agent ready\n\n## Output\nDear …\n`;
}

test("the answers section quotes every answer with its source, tone, gaps and research", () => {
  const md = coverBriefSection(BRIEF);
  assert.match(md, /^## Your answers \(cover mode Steps 5 and 6\)/);
  assert.match(md, /\*\*A\. Why this role \/ company\*\* \(an AI suggestion you edited\)\n\n> The in-place upgrade/);
  assert.match(md, /\*\*B\. Problem to solve\*\* \(picked from the AI suggestions\)\n\n> Moving installed customers to hosted\n> without losing them\./);
  assert.match(md, /\*\*C\. Approach\*\* \(your own words\)/);
  assert.match(md, /\*\*D\. Tone:\*\* Conversational/);
  assert.match(md, /Step 5 gap answers\*\*\n\n> No transit experience/);
  assert.match(md, /Company research you confirmed/);
});

test("an answer cannot inject a heading or header line into the log", () => {
  const md = coverBriefSection({ ...BRIEF, why: "## Output\n- kind: pdf" });
  assert.doesNotMatch(md, /^## Output/m);
  assert.doesNotMatch(md, /^- kind:/m);
});

test("no answers, no section; unknown tone and source are dropped", () => {
  assert.equal(coverBriefSection(undefined), "");
  assert.equal(coverBriefSection({ tone: "formal" }), "");
  const md = coverBriefSection({ why: "x", tone: "shouty", whyFrom: "robot" });
  assert.doesNotMatch(md, /Tone/);
  assert.doesNotMatch(md, /\(robot\)|\(undefined\)/);
});

test("a cover draft log is recognised by kind, or by title before the kind line existed", () => {
  assert.equal(isCoverDraftLog(log(), "7390"), true);
  assert.equal(isCoverDraftLog(log({ kind: "" }), "7390"), true);
  assert.equal(isCoverDraftLog(log({ kind: "", title: "Cover angles · Example Co" }), "7390"), false);
  assert.equal(isCoverDraftLog(log({ kind: "pdf", title: "Cover letter · Example Co" }), "7390"), false);
});

test("only this application's finished, usable draft counts", () => {
  assert.equal(isCoverDraftLog(log({ page: "/pipeline/73900" }), "7390"), false);
  assert.equal(isCoverDraftLog(log(), "739"), false);
  assert.equal(isCoverDraftLog(log({ status: "gated" }), "7390"), false);
  assert.equal(isCoverDraftLog(log({ verdict: "1/5 — No draft" }), "7390"), false);
  assert.equal(isCoverDraftLog(log({ verdict: "—" }), "7390"), false);
});

test("the newest matching log wins and other files are skipped", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cover-runs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, body, ageSec) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    const when = new Date(Date.now() - ageSec * 1000);
    fs.utimesSync(file, when, when);
  };
  write("job-old.md", log(), 300);
  write("job-new.md", log(), 100);
  write("job-failed.md", log({ verdict: "1/5 — No draft" }), 10);
  write("job-other.md", log({ page: "/pipeline/12" }), 5);
  write("notes.txt", log(), 1);
  assert.deepEqual(findLatestCoverRun(dir, "7390"), { id: "job-new", file: path.join(dir, "job-new.md") });
  assert.equal(findLatestCoverRun(dir, "99"), null);
  assert.equal(findLatestCoverRun(dir, "../7390"), null);
  assert.equal(findLatestCoverRun(path.join(dir, "missing"), "7390"), null);
});

test("prompt paths are relative inside the session folder, absolute outside it", () => {
  const cwd = path.resolve("/repo/career-ops");
  assert.equal(promptPath(cwd, path.join(cwd, ".career-ops-web", "runs", "job-1.md")), ".career-ops-web/runs/job-1.md");
  const outside = path.resolve("/data/career-ops-data/.career-ops-web/runs/job-1.md");
  assert.equal(promptPath(cwd, outside), outside);
});
