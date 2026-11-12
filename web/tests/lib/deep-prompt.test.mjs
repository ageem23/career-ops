import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_PREFILL_CHARS,
  claudeResearchLink,
  deepResearchUrlFromProfile,
  extractDeepPrompt,
} from "../../src/lib/deep-prompt.mjs";
import { splitSections } from "../../src/lib/report-sections.mjs";

const REPORT = [
  "# Acme — Director of Engineering",
  "",
  "## Score Global",
  "4.2/5",
  "",
  "## Deep Research Prompt",
  "",
  "```",
  "## Deep Research: Acme — Director of Engineering",
  "",
  "### 1. AI Strategy",
  "- What do they ship?",
  "```",
  "",
  "## Machine Summary",
  "score: 4.2",
].join("\r\n");

test("extractDeepPrompt returns the fenced prompt without the fence, across CRLF", () => {
  assert.equal(
    extractDeepPrompt(REPORT),
    "## Deep Research: Acme — Director of Engineering\n\n### 1. AI Strategy\n- What do they ship?",
  );
});

test("extractDeepPrompt is empty when the report has no prompt section", () => {
  assert.equal(extractDeepPrompt("# X\n\n## Score Global\n3.1/5\n"), "");
  assert.equal(extractDeepPrompt(null), "");
});

test("extractDeepPrompt keeps an unfenced prompt and stops at the next section", () => {
  const md = "## Deep Research Prompt\n\nResearch Acme.\n\n## Machine Summary\nscore: 4\n";
  assert.equal(extractDeepPrompt(md), "Research Acme.");
});

test("extractDeepPrompt ignores the heading when it only appears inside a fence", () => {
  assert.equal(extractDeepPrompt("```\n## Deep Research Prompt\nx\n```\n"), "");
});

test("splitSections does not split on '## ' lines inside a code fence", () => {
  const { sections } = splitSections(REPORT);
  assert.deepEqual(
    sections.map((s) => s.heading),
    ["Score Global", "Deep Research Prompt", "Machine Summary"],
  );
  assert.match(sections[1].content, /## Deep Research: Acme/);
});

test("claudeResearchLink prefills a new claude.ai chat by default", () => {
  const { url, prefilled } = claudeResearchLink("Research Acme & co");
  assert.equal(url, "https://claude.ai/new?q=Research%20Acme%20%26%20co");
  assert.equal(prefilled, true);
});

test("claudeResearchLink opens a configured project URL as-is", () => {
  const project = "https://claude.ai/project/0193abcd-0000-7000-8000-000000000000";
  assert.deepEqual(claudeResearchLink("x", project), { url: project, prefilled: false });
});

test("claudeResearchLink fills a {prompt} placeholder in a configured URL", () => {
  assert.deepEqual(claudeResearchLink("a b", "claude://claude.ai/new?q={prompt}"), {
    url: "claude://claude.ai/new?q=a%20b",
    prefilled: true,
  });
});

test("claudeResearchLink drops the prefill when the prompt would be truncated", () => {
  const long = "x".repeat(MAX_PREFILL_CHARS + 1);
  assert.deepEqual(claudeResearchLink(long), { url: "https://claude.ai/new", prefilled: false });
  assert.deepEqual(claudeResearchLink(long, "https://claude.ai/new?q={prompt}&foo=1"), {
    url: "https://claude.ai/new?foo=1",
    prefilled: false,
  });
});

test("deepResearchUrlFromProfile accepts only http(s) and claude:// links", () => {
  assert.equal(deepResearchUrlFromProfile({ deep_research: { claude_url: " https://claude.ai/project/abc " } }), "https://claude.ai/project/abc");
  assert.equal(deepResearchUrlFromProfile({ deep_research: { claude_url: "javascript:alert(1)" } }), "");
  assert.equal(deepResearchUrlFromProfile({}), "");
  assert.equal(deepResearchUrlFromProfile(null), "");
});
