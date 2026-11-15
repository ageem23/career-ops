import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_NEW_WARNINGS, briefFreshness, latestBriefFile, slimBrief } from "../../src/lib/nightly-brief.mjs";

test("latestBriefFile picks the newest dated brief and ignores other files", () => {
  assert.equal(latestBriefFile(["2026-11-10.json", "2026-11-12.json", "2026-11-11.json", "2026-11-12.md", "x.json"]), "2026-11-12.json");
  assert.equal(latestBriefFile(["2026-11-12.md", "notes.txt"]), null);
  assert.equal(latestBriefFile([]), null);
});

test("briefFreshness: today's brief is current, an older one says how old", () => {
  const now = new Date(2026, 10, 12, 7, 30);
  assert.deepEqual(briefFreshness("2026-11-12", now), { current: true, daysOld: 0 });
  assert.deepEqual(briefFreshness("2026-11-11", now), { current: false, daysOld: 1 });
  assert.deepEqual(briefFreshness("2026-11-09", now), { current: false, daysOld: 3 });
});

test("slimBrief drops the full health list and refuses non-briefs", () => {
  const raw = {
    date: "2026-11-12",
    runs: [],
    issues: [{ level: "warn", text: "x" }],
    health: { ran: true, baseline: false, newWarnings: ["⚠️ a"], recurringCount: 3876, all: new Array(3877).fill("w") },
  };
  const slim = slimBrief(raw);
  assert.equal(slim.health.all, undefined);
  assert.deepEqual(slim.health, { ran: true, baseline: false, newWarnings: ["⚠️ a"], newWarningCount: 1, recurringCount: 3876 });
  assert.deepEqual(slim.topPicks, []);

  // Thousands of new warnings at once (a moved reports/ folder): count kept, list capped.
  const flood = slimBrief({ ...raw, health: { ran: true, newWarnings: new Array(3341).fill("❌ x") } });
  assert.equal(flood.health.newWarnings.length, MAX_NEW_WARNINGS);
  assert.equal(flood.health.newWarningCount, 3341);
  assert.equal(slimBrief({ foo: 1 }), null);
  assert.equal(slimBrief(null), null);
});
