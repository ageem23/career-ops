import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLOSE_MARK,
  OPEN_MARK,
  buildResearchFile,
  createResearchReviewFilter,
  interviewIntelPath,
  isSafeResearchPath,
  parseResearchReview,
  researchFileName,
  reviewSidecarPath,
  withInterviewIntel,
  withReportScore,
  withReportUpdate,
  withReviewSection,
} from "../../src/lib/research-review.mjs";
import { CAPS, KNOWN_KINDS, capabilitiesFor } from "../../src/lib/worker-capabilities.mjs";
import { grantsWriteCapability, toolScopeFor } from "../../src/lib/claude-invocation.mjs";
import { buildPrompt } from "../../src/lib/run-prompts.mjs";

const REPORT = [
  "# Evaluation: Acme — Director of Engineering",
  "",
  "**Date:** 2026-11-01",
  "**Score:** 3.9/5",
  "**URL:** https://example.com/job/1",
  "**PDF:** ❌",
  "",
  "---",
  "",
  "## A) Role Summary",
  "Text.",
  "",
  "## Deep Research Prompt",
  "```",
  "## Deep Research: Acme",
  "```",
  "",
  "## Machine Summary",
  "```yaml",
  "company: Acme",
  "score: 3.9",
  "```",
  "",
].join("\n");

test("research files use the {company}-{role}-research.md naming under interview-prep/", () => {
  assert.equal(researchFileName("Acme, Inc.", "Senior Director, Engineering"), "interview-prep/acme-inc-senior-director-engineering-research.md");
  assert.equal(reviewSidecarPath("interview-prep/acme-x-research.md"), "interview-prep/acme-x-research.review.json");
});

test("isSafeResearchPath refuses anything outside interview-prep/", () => {
  assert.equal(isSafeResearchPath("interview-prep/a.md"), true);
  assert.equal(isSafeResearchPath("interview-prep/../cv.md"), false);
  assert.equal(isSafeResearchPath("cv.md"), false);
  assert.equal(isSafeResearchPath("interview-prep/sub/a.md"), false);
  assert.equal(isSafeResearchPath("/etc/passwd"), false);
});

test("withInterviewIntel adds the header link after the last header field, and interviewIntelPath reads it back", () => {
  const out = withInterviewIntel(REPORT, "interview-prep/acme-director-research.md", "2026-11-11");
  assert.match(out, /\*\*PDF:\*\* ❌\n\*\*Interview Intel:\*\* \[interview-prep\/acme-director-research\.md\]\(\.\.\/interview-prep\/acme-director-research\.md\) \(deep research, filed 2026-11-11\)\n/);
  assert.equal(interviewIntelPath(out), "interview-prep/acme-director-research.md");
  // A second filing replaces the line instead of adding another.
  const again = withInterviewIntel(out, "interview-prep/acme-director-research.md", "2026-11-12");
  assert.equal(again.match(/Interview Intel/g)?.length, 1);
  assert.match(again, /filed 2026-11-12/);
});

test("withInterviewIntel keeps CRLF line endings", () => {
  const out = withInterviewIntel(REPORT.replace(/\n/g, "\r\n"), "interview-prep/a.md", "2026-11-11");
  assert.ok(!/[^\r]\n/.test(out));
});

test("interviewIntelPath reads hand-filed links and refuses unsafe ones", () => {
  assert.equal(interviewIntelPath("# X\n**Interview Intel:** [x](../interview-prep/hopskipdrive-vp-engineering.md) (deep research)\n---\n"), "interview-prep/hopskipdrive-vp-engineering.md");
  assert.equal(interviewIntelPath("# X\n**Interview Intel:** [x](../cv.md)\n---\n"), null);
  assert.equal(interviewIntelPath(REPORT), null);
});

test("buildResearchFile ties the research to its evaluation", () => {
  const md = buildResearchFile({ company: "Acme", role: "Director", reportNum: 42, reportFile: "042-acme-2026-11-01.md", score: "3.9/5", status: "Evaluated", date: "2026-11-11", markdown: "## TL;DR\nThings." });
  assert.match(md, /^# Interview Intel: Acme — Director\n/);
  assert.match(md, /\*\*Evaluation:\*\* \[42\]\(\.\.\/reports\/042-acme-2026-11-01\.md\) — 3\.9\/5, status \*\*Evaluated\*\*/);
  assert.match(md, /---\n\n## TL;DR\nThings\.\n$/);
});

const REVIEW = {
  reportNum: 42,
  changesMarkdown: "| Report said | Research says | So what |\n|---|---|---|\n| a | b | c |",
  bottomLine: "Apply.",
  cvFlags: [{ claim: "Node.js", why: "not in cv.md" }],
  date: "2026-11-11",
};

test("withReviewSection inserts after the header rule and replaces itself on a re-run", () => {
  const research = buildResearchFile({ company: "Acme", role: "Director", reportNum: 42, reportFile: "042-a.md", score: "", status: "", date: "2026-11-11", markdown: "## TL;DR\nThings." });
  const once = withReviewSection(research, REVIEW);
  assert.match(once, /---\n\n<!-- research-review:start -->\n## What this changes vs\. report 42\n/);
  assert.ok(once.indexOf("What this changes") < once.indexOf("## TL;DR"));
  assert.match(once, /### Not in cv\.md — confirm before using\n\n- \*\*Node\.js\*\* — not in cv\.md/);
  const twice = withReviewSection(once, { ...REVIEW, bottomLine: "Skip." });
  assert.equal(twice.match(/What this changes/g)?.length, 1);
  assert.match(twice, /\*\*Bottom line:\*\* Skip\./);
});

function envelope(obj) {
  return `Findings: a few.\n${OPEN_MARK}\n${JSON.stringify(obj)}\n${CLOSE_MARK}\nVERDICT: 5/5 — done`;
}

test("parseResearchReview validates proposals and drops the ones a review may not make", () => {
  const parsed = parseResearchReview(envelope({
    changesMarkdown: REVIEW.changesMarkdown,
    bottomLine: "Apply",
    cvFlags: [{ claim: "Node.js", why: "x" }],
    proposals: [
      { type: "score", to: 4.25, reason: "comp confirmed" },
      { type: "status", to: "Applied", reason: "no" },
      { type: "status", to: "discarded", reason: "posting closed" },
      { type: "note", text: "Research: layoffs | hit eng\nlast year", reason: "r" },
      { type: "report-update", markdown: "## Org\nSmaller than stated.", reason: "r" },
      { type: "edit-cv", reason: "never" },
      { type: "score", to: 9, reason: "bad" },
    ],
  }));
  assert.equal(parsed.ok, true);
  const { proposals } = parsed.review;
  assert.deepEqual(proposals.map((p) => p.type), ["score", "status", "note", "report-update"]);
  assert.deepEqual(proposals.map((p) => p.id), ["p1", "p2", "p3", "p4"]);
  assert.equal(proposals[0].to, 4.3);
  assert.equal(proposals[1].to, "Discarded");
  assert.equal(proposals[2].text, "Research: layoffs hit eng last year");
  assert.equal(proposals[3].markdown, "### Org\nSmaller than stated.");
  assert.ok(proposals.every((p) => p.state === "pending"));
  assert.equal(parsed.warnings.length, 3);
});

test("parseResearchReview fails closed on a missing, doubled or malformed envelope", () => {
  assert.equal(parseResearchReview("no envelope").ok, false);
  assert.equal(parseResearchReview(envelope({ changesMarkdown: "x" }) + `\n${OPEN_MARK}\n{}\n${CLOSE_MARK}`).ok, false);
  assert.equal(parseResearchReview(`${OPEN_MARK}\n{not json}\n${CLOSE_MARK}`).ok, false);
  assert.equal(parseResearchReview(envelope({ changesMarkdown: "" })).ok, false);
  // A fenced JSON body is accepted.
  assert.equal(parseResearchReview(`${OPEN_MARK}\n\`\`\`json\n{"changesMarkdown":"t"}\n\`\`\`\n${CLOSE_MARK}`).ok, true);
});

test("the stream filter hides the envelope from the run log but keeps it for parsing", () => {
  const f = createResearchReviewFilter();
  const text = envelope({ changesMarkdown: "t" });
  let visible = "";
  for (const chunk of text.match(/.{1,7}/gs)) visible += f.push(chunk);
  visible += f.flush();
  assert.ok(visible.includes("Findings: a few."));
  assert.ok(visible.includes("VERDICT: 5/5"));
  assert.ok(!visible.includes("changesMarkdown"));
  assert.equal(parseResearchReview(f.text()).ok, true);
});

test("withReportUpdate lands before the Deep Research Prompt, not inside its fence", () => {
  const out = withReportUpdate(REPORT, "### Org\nSmaller.", "2026-11-11");
  const update = out.indexOf("## Research Update (2026-11-11)");
  assert.ok(update > out.indexOf("## A) Role Summary"));
  assert.ok(update < out.indexOf("## Deep Research Prompt"));
});

test("withReportScore updates the header and the Machine Summary only", () => {
  const out = withReportScore(REPORT + "\nscore: 1.0 outside\n", 4.2);
  assert.match(out, /\*\*Score:\*\* 4\.2\/5/);
  assert.match(out, /```yaml\ncompany: Acme\nscore: 4\.2\n```/);
  assert.match(out, /score: 1\.0 outside/);
});

test("research-review is a known, local, read-only worker", () => {
  assert.ok(KNOWN_KINDS.includes("research-review"));
  assert.equal(capabilitiesFor("research-review"), CAPS.localReadOnly);
  assert.equal(grantsWriteCapability(toolScopeFor("research-review")), false);
});

test("the research-review prompt names both files, the envelope, and the no-write rule", () => {
  const prompt = buildPrompt({
    kind: "research-review",
    input: "17",
    memory: "",
    today: "2026-11-11",
    reportFile: "reports/042-acme-2026-11-01.md",
    researchReview: { researchFile: "interview-prep/acme-director-research.md", status: "Evaluated" },
  });
  assert.match(prompt, /"reports\/042-acme-2026-11-01\.md"/);
  assert.match(prompt, /"interview-prep\/acme-director-research\.md"/);
  assert.match(prompt, /Do NOT save or edit any file/);
  assert.ok(prompt.includes(`\`${OPEN_MARK}\``));
  // Markers are described mid-line, so a CLI that echoes its prompt cannot fake an envelope.
  assert.equal(parseResearchReview(prompt).ok, false);
});
