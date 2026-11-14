// Tests for the cover-suggest worker's envelope and the answer provenance the
// cover letter form sends with each answer.
//
// Run:  node --test tests/lib/cover-suggest.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_MARK,
  OPEN_MARK,
  SUGGESTION_LIMITS,
  answerSource,
  cardLabel,
  createCoverSuggestFilter,
  joinPicked,
  normalizeSuggestions,
  parseCoverSuggestions,
  unverifiedFigures,
} from "../../src/lib/cover-suggest.mjs";
import { capabilitiesFor, CAPS, KNOWN_KINDS } from "../../src/lib/worker-capabilities.mjs";
import { grantsWriteCapability, toolScopeFor } from "../../src/lib/claude-invocation.mjs";
import { buildPrompt } from "../../src/lib/run-prompts.mjs";

const CV = "Led a team of 12 engineers. Cut deploy time by 40% across 1,200 services since 2019.";
const RAW = {
  research: "Acme is rebuilding its checkout platform after a 2026 outage.",
  why: [
    { text: "Your checkout rebuild is the scale problem I have spent years on.", evidence: "JD: 'rebuild checkout'" },
    "A bare string still counts as an option.",
    { text: "" },
  ],
  problem: [{ text: "Checkout reliability during peak traffic.", evidence: "Research: 2026 outage" }],
  approach: [{ text: "Map the 1200 services that touch checkout in week one, then cut deploy time like I did before (40%)." }],
  tone: { recommended: "Direct", reason: "The JD uses short imperatives." },
  gaps: [{ kind: "domain", question: "The JD is retail; your background is media. Address it?", choices: ["Briefly", "Omit", "a", "b", "c"] }, { question: "" }],
  keywords: { ats: ["Kubernetes"], signals: ["own the roadmap"] },
};

test("normalizeSuggestions: keeps valid cards, drops blanks, lowercases a known tone and caps gap choices", () => {
  const r = normalizeSuggestions(RAW, { allowedText: CV });
  assert.equal(r.ok, true);
  const s = r.suggestions;
  assert.deepEqual(s.why.map((w) => w.text), [RAW.why[0].text, "A bare string still counts as an option."]);
  assert.equal(s.tone.recommended, "direct");
  assert.equal(s.gaps.length, 1);
  assert.equal(s.gaps[0].choices.length, 4);
  assert.deepEqual(s.keywords, { ats: ["Kubernetes"], signals: ["own the roadmap"] });
});

test("normalizeSuggestions: a figure in a card that cv.md does not contain is listed; CV figures are not", () => {
  const r = normalizeSuggestions(
    { ...RAW, why: [{ text: "I grew revenue 300% at a 50-person startup." }] },
    { allowedText: CV },
  );
  assert.deepEqual(r.suggestions.why[0].unverified, ["300", "50"]);
  // 1200 vs "1,200" and 40 vs "40%" both match the CV.
  assert.deepEqual(r.suggestions.approach[0].unverified, []);
});

test("unverifiedFigures: lone digits are ignored unless they are a percentage or multiplier", () => {
  assert.deepEqual(unverifiedFigures("On day 1 I would meet 3 teams", ""), []);
  assert.deepEqual(unverifiedFigures("a 5% lift and a 3x speedup", ""), ["5", "3"]);
});

test("normalizeSuggestions: an unknown tone falls back to Mirror the JD with a warning", () => {
  const r = normalizeSuggestions({ ...RAW, tone: { recommended: "playful" } });
  assert.equal(r.suggestions.tone.recommended, "mirror");
  assert.match(r.warnings.join(" "), /Unknown tone/);
});

test("normalizeSuggestions: caps each question at its limit", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ text: `Angle ${i}` }));
  const r = normalizeSuggestions({ why: many, problem: many, approach: many });
  assert.equal(r.suggestions.why.length, SUGGESTION_LIMITS.why);
  assert.equal(r.suggestions.problem.length, SUGGESTION_LIMITS.problem);
});

test("normalizeSuggestions: nothing usable for any question is a failure, not an empty save", () => {
  const r = normalizeSuggestions({ why: [], problem: [{ text: " " }], approach: "x" });
  assert.equal(r.ok, false);
});

test("parseCoverSuggestions: reads exactly one envelope, fenced JSON included", () => {
  const text = `Found three angles.\n${OPEN_MARK}\n\`\`\`json\n${JSON.stringify(RAW)}\n\`\`\`\n${CLOSE_MARK}\nVERDICT: 5/5 — checkout scale angle`;
  assert.equal(parseCoverSuggestions(text).ok, true);
  assert.equal(parseCoverSuggestions("no envelope").ok, false);
  assert.equal(parseCoverSuggestions(`${OPEN_MARK}\n{}\n${CLOSE_MARK}\n${OPEN_MARK}\n{}\n${CLOSE_MARK}`).ok, false);
  assert.match(parseCoverSuggestions(`${OPEN_MARK}\n{nope\n${CLOSE_MARK}`).error, /not valid JSON/);
});

test("createCoverSuggestFilter: hides the envelope from the log but keeps it for parsing", () => {
  const f = createCoverSuggestFilter();
  const body = JSON.stringify(RAW);
  const visible = f.push(`Summary line\n${OPEN_MARK}\n${body.slice(0, 20)}`) + f.push(`${body.slice(20)}\n${CLOSE_MARK}\nVERDICT: 5/5 — ok\n`) + f.flush();
  assert.ok(visible.includes("Summary line"));
  assert.ok(!visible.includes("checkout rebuild"));
  assert.ok(visible.includes("VERDICT"));
  assert.equal(parseCoverSuggestions(f.text()).ok, true);
});

test("answerSource: picked-as-is, edited, and own words", () => {
  assert.equal(answerSource("Angle A\nAngle B", ["Angle A", "Angle B"]), "suggested");
  assert.equal(answerSource("Angle A, which I saw first-hand", ["Angle A"]), "edited");
  assert.equal(answerSource("My own reason", []), "own");
  assert.equal(joinPicked([" a ", "", "b"]), "a\nb");
});

test("cover-suggest is a known, read-only worker with the same web access as cover", () => {
  assert.ok(KNOWN_KINDS.includes("cover-suggest"));
  assert.equal(capabilitiesFor("cover-suggest"), CAPS.networkReadOnly);
  assert.equal(grantsWriteCapability(toolScopeFor("cover-suggest")), false);
});

test("the cover-suggest prompt names the mode, the envelope, the no-invention rule, and stops before drafting", () => {
  const prompt = buildPrompt({ kind: "cover-suggest", input: "41", memory: "", today: "2026-11-12", codeRoot: "/opt/career-ops", reportFile: "reports/041-acme.md" });
  assert.match(prompt, /"\/opt\/career-ops\/modes\/cover\.md"/);
  assert.match(prompt, /"reports\/041-acme\.md"/);
  assert.ok(prompt.includes(OPEN_MARK) && prompt.includes(CLOSE_MARK));
  assert.match(prompt, /Do NOT draft the letter/);
  assert.match(prompt, /NEVER put a figure, employer, title, tool or past achievement/);
  assert.match(prompt, /Do NOT save or edit any file/);
  assert.match(prompt, /Never submit, send, or contact anyone/);
});

test("the cover prompt carries gap answers, reuses the research, and labels where each answer came from", () => {
  const prompt = buildPrompt({
    kind: "cover",
    input: "41",
    memory: "",
    today: "2026-11-12",
    reportFile: "reports/041-acme.md",
    coverBrief: {
      why: "w", problem: "p", approach: "a", tone: "direct",
      gaps: "Domain gap? -> Briefly", research: "Acme is rebuilding checkout.",
      sources: { why: "suggested", problem: "edited", approach: "own" },
    },
  });
  assert.match(prompt, /Why this role \/ company \(picked verbatim from AI suggestions\)/);
  assert.match(prompt, /Problem to solve \(an AI suggestion the candidate edited\)/);
  assert.match(prompt, /still has to trace to cv\.md or article-digest\.md/);
  assert.match(prompt, /do not search again: "Acme is rebuilding checkout\."/);
  assert.match(prompt, /"Domain gap\? -> Briefly"/);
});

test("the cover prompt without suggestions is unchanged in behaviour: research runs, gaps default to option b", () => {
  const prompt = buildPrompt({ kind: "cover", input: "41", memory: "", today: "2026-11-12", reportFile: "r.md", coverBrief: { why: "w", problem: "p", approach: "a", tone: "mirror" } });
  assert.match(prompt, /Run Steps 3 and 4/);
  assert.match(prompt, /take option b/);
  assert.doesNotMatch(prompt, /AI suggestion/);
});

test("normalizeSuggestions: keeps the worker's short label, and checks its figures too", () => {
  const r = normalizeSuggestions({ why: [{ label: "Scale: 40M daily orders", text: "Your order volume is the scale I want to work at." }] }, { allowedText: CV });
  assert.equal(r.suggestions.why[0].label, "Scale: 40M daily orders");
  assert.deepEqual(r.suggestions.why[0].unverified, []); // 40 is in the CV
  const r2 = normalizeSuggestions({ why: [{ label: "Scale: 75M daily orders", text: "x y" }] }, { allowedText: CV });
  assert.deepEqual(r2.suggestions.why[0].unverified, ["75"]);
});

test("cardLabel: the label when present, else the first clause of the text, shortened at a word", () => {
  assert.equal(cardLabel({ label: " Mission: open banking ", text: "long" }), "Mission: open banking");
  assert.equal(cardLabel({ text: "Your checkout rebuild is the problem I know. I led two of them." }), "Your checkout rebuild is the problem I know");
  assert.equal(cardLabel({ text: "Scale first, then everything else" }), "Scale first");
  const long = cardLabel({ text: "Your platform team is rebuilding the entire checkout and payments estate across every region it serves today" });
  assert.ok(long.endsWith("…") && long.length <= 71, long);
});

test("the cover-suggest prompt asks for a short direction label per option", () => {
  const prompt = buildPrompt({ kind: "cover-suggest", input: "41", memory: "", today: "2026-11-12", reportFile: "r.md" });
  assert.match(prompt, /label: for each option, the direction in 3-8 words/);
  assert.match(prompt, /"label": "\.\.\.", "text": "\.\.\."/);
});
