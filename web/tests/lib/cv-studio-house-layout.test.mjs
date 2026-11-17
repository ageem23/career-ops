// The house CV layout (cv.template: personal) differs from the stock template
// in three ways the Studio has to read: a summary outside any section, a
// bullet-only Key Achievements section, and one employer with several roles.

import test from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, renderBlocks } from "../../src/lib/cv-studio/html-blocks.mjs";
import { parseBaseCv } from "../../src/lib/cv-studio/base-cv.mjs";
import * as cvMarkdown from "../../../lib/cv-markdown.mjs";
import { buildStudioDoc, emptyEdits, resolveStudio, studioReducer } from "../../src/lib/cv-studio/studio.mjs";
import { planAssist } from "../../src/lib/cv-studio/assist.mjs";

const HTML = `<html><body><div class="page">
  <div class="header"><div class="header-name">Sam Lee</div></div>
  <!-- SUMMARY -->
  <div class="summary-text">CTO who grew engineering and shipped platforms.</div>
  <div class="section" style="page-break-after: always;">
    <div class="section-title">Key Achievements</div>
    <ul class="bullet-list">
      <li><strong>Team Scaling:</strong> Grew the team to 40 engineers</li>
      <li><strong>Platform Delivery:</strong> Directed four legacy platforms into one</li>
    </ul>
  </div>
  <div class="section">
    <div class="section-title">Professional Experience</div>
    <div class="job">
    <div class="job-header">Acme Corp <span class="employer-period">Chicago | 2010 - 2024</span></div>
    <div class="role-header">Chief Technology Officer <span class="role-dates"><span class="job-period">2019 - 2024</span></span></div>
    <ul class="bullet-list">
        <li><strong>AI:</strong> Led AI adoption</li>
        <li><strong>Security:</strong> Owned PCI compliance</li>
    </ul>
    <div class="role-header">Director <span class="role-dates"><span class="job-period">2010 - 2019</span></span></div>
    <ul class="bullet-list">
        <li>Ran war rooms for on-sales</li>
    </ul>
    </div>
    <div class="job">
  <div class="job-header"><span class="job-company">Beta Inc.</span><span class="job-period">2008 - 2010</span></div>
  <ul><li>Built integrations</li></ul>
</div>
  </div>
</div></body></html>`;

const CV_MD = `# Sam Lee

## Summary

CTO who grew engineering teams and delivered platforms.

## Key Achievements

* **Team Scaling:** Grew the team to 40 engineers
* **Platform Delivery:** Directed four legacy platforms into one unified system
* **Talent Development:** Designed career-focused training programs

## Professional Experience

### Acme Corp
**Chicago | 2010 - 2024**

#### Chief Technology Officer *(Promoted)*

* **AI:** Led AI adoption across the company
* **Security:** Owned PCI compliance

#### Director *(Initial Role)*

* Ran war rooms for major on-sales

### Beta Inc.

* Built integrations
`;

function studio() {
  const tree = parseBlocks(HTML);
  const base = parseBaseCv(CV_MD, cvMarkdown);
  const doc = buildStudioDoc({ tree, base, keywords: [], sourceHash: "h", keywordsIn: () => [], itemText: () => "", fixedText: "" });
  return { tree, doc, base };
}
const bullets = (doc) => doc.sections.flatMap((s) => s.items.flatMap((i) => i.bullets));

test("reads the loose summary, the Key Achievements list, and one item per role", () => {
  const { tree } = studio();
  assert.deepEqual(tree.sections.map((s) => [s.id, s.kind]), [["sum", "summary"], ["s0", "highlights"], ["s1", "experience"]]);
  const exp = tree.sections[2].items;
  assert.deepEqual(exp.map((i) => [i.id, i.kind, i.label]), [
    ["s1i0r0", "role", "Acme Corp · Chief Technology Officer"],
    ["s1i0r1", "role", "Acme Corp · Director"],
    ["s1i1", "entry", "Beta Inc."],
  ]);
  // Bullets keep the ids the whole job gave them before roles were split.
  assert.deepEqual(exp.flatMap((i) => i.bullets.map((b) => b.id)), ["s1i0b0", "s1i0b1", "s1i0b2", "s1i1b0"]);
});

test("matches the summary, Key Achievements and each role to their own cv.md text", () => {
  const { doc, base } = studio();
  assert.deepEqual(base.entries[0].roles.map((r) => r.title), ["Chief Technology Officer", "Director"]);
  const byId = Object.fromEntries(bullets(doc).map((b) => [b.id, b]));
  assert.equal(byId.sumi0b0.base, "CTO who grew engineering teams and delivered platforms.");
  assert.match(byId.s0i0b1.base, /unified system/);
  assert.equal(byId.s1i0b2.base, "Ran war rooms for major on-sales");
  const ka = doc.sections.find((s) => s.kind === "highlights").items[0];
  assert.deepEqual(ka.restorable.map((r) => r.text), ["Talent Development: Designed career-focused training programs"]);
});

test("hiding a role keeps the next employer outside the grouped one", () => {
  const { tree, doc } = studio();
  const edits = studioReducer(emptyEdits("h"), { type: "toggle", id: "s1i0r1" }, doc);
  const html = renderBlocks(tree, resolveStudio(doc, edits).view);
  assert.doesNotMatch(html, /Director <span/);
  assert.match(html, /Owned PCI compliance<\/li>\s*<\/ul>\s*\n\s*<\/div>\s*<div class="job">\s*<div class="job-header"><span class="job-company">Beta Inc\./);
  const again = parseBlocks(html).sections[2].items.map((i) => i.label);
  assert.deepEqual(again, ["Acme Corp · Chief Technology Officer", "Beta Inc."]);
});

test("a reworded or restored labelled bullet keeps its bold label", () => {
  const { tree, doc } = studio();
  let edits = studioReducer(emptyEdits("h"), { type: "use", id: "s0i0b0", use: { kind: "custom", text: "Team Scaling: Grew engineering to 40", keywords: [] } }, doc);
  edits = studioReducer(edits, { type: "restore", item: "s0i0", index: 0 }, doc);
  const r = resolveStudio(doc, edits);
  const html = renderBlocks(tree, r.view, { added: r.added });
  assert.match(html, /<li><strong>Team Scaling:<\/strong> Grew engineering to 40<\/li>/);
  assert.match(html, /<li><strong>Talent Development:<\/strong> Designed career-focused training programs<\/li>/);
});

test("the prompt planner moves bullets within a role but never moves roles", () => {
  const { doc } = studio();
  const plan = planAssist(doc, emptyEdits("h"), [
    { op: "move", id: "s1i0b1", position: 0 },
    { op: "move", id: "s1i1", position: 0 },
  ]);
  assert.deepEqual(plan.actions.map((a) => [a.type, a.parent]), [["move", "s1i0r0"]]);
  assert.match(plan.rejected[0].why, /date order/);
});
