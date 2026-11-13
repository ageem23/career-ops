import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOT_TITLE, applicationTabName, applicationTabTitle, workerTabTitle } from "../../src/lib/tab-title.mjs";

test("root title: short app name as default and suffix", () => {
  assert.deepEqual(ROOT_TITLE, { default: "Co", template: "%s · Co" });
});

test("applicationTabName: tracker company wins", () => {
  assert.equal(applicationTabName({ company: " Acme ", reportTitle: "Evaluation: Other — Role" }), "Acme");
});

test("applicationTabName: falls back to the company in the report heading", () => {
  assert.equal(applicationTabName({ reportTitle: "Evaluation: Imbibe — Director of Information Technology" }), "Imbibe");
  assert.equal(applicationTabName({ reportTitle: "Evaluación: Globex – Staff Engineer" }), "Globex");
  assert.equal(applicationTabName({ reportTitle: "Initech - Engineering Manager" }), "Initech");
});

test("applicationTabName: keeps hyphenated company names intact", () => {
  assert.equal(applicationTabName({ reportTitle: "Evaluation: Coca-Cola — Director" }), "Coca-Cola");
});

test("applicationTabName: generic label when nothing identifies the application", () => {
  assert.equal(applicationTabName({}), "Application");
  assert.equal(applicationTabName({ company: "", reportTitle: "  " }), "Application");
});

test("applicationTabTitle: company first, section after", () => {
  assert.equal(applicationTabTitle("Acme"), "Acme");
  assert.equal(applicationTabTitle("Acme", "Apply"), "Acme · Apply");
});

test("workerTabTitle: company leads, then the worker kind", () => {
  assert.equal(workerTabTitle("CV PDF · Acme"), "Acme · CV PDF · Co");
  assert.equal(workerTabTitle("Evaluate · Globex"), "Globex · Evaluate · Co");
});

test("workerTabTitle: other shapes pass through, empty falls back", () => {
  assert.equal(workerTabTitle("Nightly scan"), "Nightly scan · Co");
  assert.equal(workerTabTitle(undefined), "Worker · Co");
});
