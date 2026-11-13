import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFindings,
  findBlock,
  findingsSummary,
  htmlText,
  isContentGateFailure,
  replaceBlockText,
  withAllowance,
  withMaxPages,
} from "../../src/lib/cv-gate.mjs";
import { pageBudgetRow } from "../../src/lib/pdf-render.mjs";

const HTML = `<html><body>
<p>Engineering leader who can leverage agentic coding tools.</p>
<ul>
<li><strong>AI-Assisted Engineering:</strong> Spearheaded adoption of AI, backed by updated code-review practices.</li>
<li>Grew the team &amp; its <em>managers</em>.</li>
</ul></body></html>`;

test("isContentGateFailure: the fact gate and the voice check, nothing else", () => {
  assert.equal(isContentGateFailure("❌ PDF generation failed: Voice check failed for cv-web-7.html: \"leverage\"."), true);
  assert.equal(isContentGateFailure("❌ PDF generation failed: Fact check failed for cv-web-7.html: …"), true);
  assert.equal(isContentGateFailure("CV is 4 pages; the allowed maximum is 3 pages."), false);
});

test("htmlText decodes entities and drops tags", () => {
  assert.equal(htmlText("Grew the team &amp; its <em>managers</em>."), "Grew the team & its managers .");
});

test("findBlock finds the bullet holding a flagged statement, ignoring case and a trailing period", () => {
  const block = findBlock(HTML, "ai-assisted engineering: spearheaded adoption of AI, backed by updated code-review practices");
  assert.ok(block);
  assert.match(block.inner, /^<strong>AI-Assisted Engineering:<\/strong>/);
  assert.equal(findBlock(HTML, "not in the CV at all"), null);
});

test("replaceBlockText keeps a bold label the new wording still starts with", () => {
  const out = replaceBlockText(HTML, "Spearheaded adoption of AI, backed by", "AI-Assisted Engineering: Spearheaded adoption of AI <tools>.");
  assert.match(out, /<li><strong>AI-Assisted Engineering:<\/strong> Spearheaded adoption of AI &lt;tools&gt;\.<\/li>/);
  // Without the label the line becomes plain text.
  const plain = replaceBlockText(HTML, "Spearheaded adoption of AI", "Led AI adoption.");
  assert.match(plain, /<li>Led AI adoption\.<\/li>/);
  assert.equal(replaceBlockText(HTML, "missing line", "x"), null);
});

test("buildFindings: a stock word is allowable and located; an invented metric is not allowable", () => {
  const rows = buildFindings({
    html: HTML,
    voice: [{ kind: "banned-phrase", value: "leverage" }, { kind: "em-dash", value: "em dash" }],
    facts: { invented: ["35%"], unsupportedFacts: [], forbidden: [] },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id), ["f1", "f2"]);
  assert.equal(rows[0].kind, "voice");
  assert.equal(rows[0].line, "Engineering leader who can leverage agentic coding tools.");
  assert.deepEqual(rows[0].allow.value, "leverage");
  assert.equal(rows[0].editable, true);
  assert.equal(rows[1].kind, "metric");
  assert.equal(rows[1].allow, null);
  assert.ok(rows.every((r) => r.state === "pending"));
});

test("buildFindings: drift offers exactly the swaps the gate's advice names", () => {
  const drift = { kind: "drift", value: "x", line: "AI-Assisted Engineering: Spearheaded adoption of AI, backed by updated code-review practices", sourceLine: "Agentic AI: Spearheaded the adoption of AI.", added: ["ai-assisted", "backed"] };
  const rows = buildFindings({
    html: HTML,
    facts: { invented: [], unsupportedFacts: [drift], forbidden: [] },
    driftAdvice: () => 'the CV opens a clause with "ai-assisted", "backed", which its source bullet does not use. … (e.g. "spearheaded -> ai-assisted")',
  });
  assert.deepEqual(rows[0].allow.value, ["spearheaded -> ai-assisted", "spearheaded -> backed"]);
  assert.equal(rows[0].source, "Agentic AI: Spearheaded the adoption of AI.");
  // No advice, no guessed swap.
  const unguessed = buildFindings({ html: HTML, facts: { unsupportedFacts: [drift] } });
  assert.equal(unguessed[0].allow, null);
});

test("findingsSummary lists only pending rows", () => {
  const rows = buildFindings({ html: HTML, voice: [{ kind: "banned-phrase", value: "leverage" }] });
  assert.match(findingsSummary(rows), /\[voice\] CV line: "Engineering leader/);
  rows[0].state = "allowed";
  assert.equal(findingsSummary(rows), "");
});

test("withAllowance adds to the right list once, records evidence, and keeps the user's other keys", () => {
  const raw = JSON.stringify({ _comment: "mine", allow_metrics: ["24 years"], allow_facts: ["leverage"] });
  const fact = withAllowance(raw, { type: "fact", value: "leverage" }, "2026-11-12");
  assert.ok(fact.ok);
  const data = JSON.parse(fact.content);
  assert.deepEqual(data.allow_facts, ["leverage"]);
  assert.equal(data._comment, "mine");
  assert.deepEqual(data.allow_metrics, ["24 years"]);
  const swaps = withAllowance(raw, { type: "swaps", value: ["spearheaded -> backed"] }, "2026-11-12");
  assert.deepEqual(JSON.parse(swaps.content).allow_swaps, ["spearheaded -> backed"]);
  assert.match(JSON.parse(swaps.content)._evidence["spearheaded -> backed"], /2026-11-12/);
  // A missing file starts a new one; an unreadable one is never overwritten.
  assert.deepEqual(JSON.parse(withAllowance("", { type: "fact", value: "x" }, "d").content).allow_facts, ["x"]);
  assert.equal(withAllowance("{ not json", { type: "fact", value: "x" }, "d").ok, false);
  assert.equal(withAllowance("[]", { type: "fact", value: "x" }, "d").ok, false);
});

test("withMaxPages edits only the cv.max_pages line and keeps comments", () => {
  const profile = "candidate:\n  full_name: X\n# house design\ncv:\n  template: personal\n  # three pages is normal\n  max_pages: 2 # was two\n\ncover_letter:\n  template: personal\n";
  const updated = withMaxPages(profile, 3);
  assert.ok(updated.ok);
  assert.equal(updated.content, profile.replace("max_pages: 2 # was two", "max_pages: 3 # was two"));
  // No max_pages yet: added under cv:, with the block's indent.
  const added = withMaxPages("cv:\n    template: personal\nother: 1\n", 3);
  assert.equal(added.content, "cv:\n    max_pages: 3\n    template: personal\nother: 1\n");
  // No cv: block: appended. CRLF files stay CRLF.
  assert.equal(withMaxPages("a: 1", 3).content, "a: 1\ncv:\n  max_pages: 3\n");
  assert.equal(withMaxPages("cv:\r\n  template: x\r\n", 4).content, "cv:\r\n  max_pages: 4\r\n  template: x\r\n");
  // A max_pages under another key is not the CV's.
  assert.match(withMaxPages("cover_letter:\n  max_pages: 1\ncv:\n  template: x\n", 3).content, /cover_letter:\n {2}max_pages: 1\ncv:\n {2}max_pages: 3/);
  assert.equal(withMaxPages("cv: { template: x }\n", 3).ok, false);
  assert.equal(withMaxPages("", 0).ok, false);
});

test("findingsSummary tells a trim repair what it may and may not cut", () => {
  assert.match(findingsSummary([pageBudgetRow({ pages: 4, max: 3 })]), /\[pages\] The CV came out at 4 pages.*Never drop a whole role/);
});
