// A PDF run the CV fact gate refused starts one automatic repair run. The
// refused run used to stay a red "Failed" card after its repair wrote the PDF,
// with nothing linking the two, so a finished CV read as a failure.
//
// Run: npm test -- tests/lib/job-repair.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { repairState, settleInterruptedRepair, withRepairFinished, withRepairStarted } from "../../src/lib/job-repair.mjs";
import { jobStateLabel } from "../../src/lib/job-gate.mjs";
import { restoreStoredJobs } from "../../src/lib/jobs-persist.mjs";
import { workerBatchSummary } from "../../src/lib/worker-feedback.mjs";

const refused = () => ({
  id: "job-1",
  kind: "pdf",
  status: "error",
  steps: [{ kind: "status", label: "The CV checks refused some lines; started one automatic repair run.", ts: 1 }],
});

test("a failed run with no repair has no repair state", () => {
  assert.equal(repairState(refused()), null);
  assert.equal(jobStateLabel(refused()), "Failed");
});

test("a repair in progress, then finished, is read from the refused run", () => {
  const started = withRepairStarted(refused(), "job-2");
  assert.deepEqual(started.repair, { id: "job-2", status: "running" });
  assert.equal(repairState(started), "running");
  assert.equal(jobStateLabel(started), "Failed, repair running");

  const fixed = withRepairFinished(started, "job-2", "done", 5);
  assert.equal(repairState(fixed), "repaired");
  assert.equal(jobStateLabel(fixed), "Fixed by repair run");
  assert.equal(fixed.status, "error", "the refused run keeps its own outcome");
  assert.match(fixed.steps.at(-1).label, /repair finished/i);
});

test("a repair that fails or stops for review leaves the refused run failed", () => {
  for (const status of ["error", "gated"]) {
    const job = withRepairFinished(withRepairStarted(refused(), "job-2"), "job-2", status, 5);
    assert.equal(repairState(job), "failed");
    assert.equal(jobStateLabel(job), "Failed");
  }
});

test("only the linked repair run, once, can settle the refused run", () => {
  const started = withRepairStarted(refused(), "job-2");
  assert.equal(withRepairFinished(started, "job-9", "done", 5), started, "another run's result is ignored");
  const fixed = withRepairFinished(started, "job-2", "done", 5);
  assert.equal(withRepairFinished(fixed, "job-2", "error", 6), fixed, "a settled repair is not settled again");
  assert.equal(withRepairFinished(refused(), "job-2", "done", 5).repair, undefined);
});

test("a successful run never reads as repaired", () => {
  assert.equal(repairState({ status: "done", repair: { id: "job-2", status: "done" } }), null);
});

test("a reload that interrupts the repair settles the link as failed", () => {
  const started = withRepairStarted(refused(), "job-2");
  assert.equal(repairState(settleInterruptedRepair(started)), "failed");
  const repairJob = { id: "job-2", kind: "pdf", status: "running", repairOf: "job-1", steps: [] };
  const [restoredRepair, restoredRefused] = restoreStoredJobs([repairJob, started], 10);
  assert.equal(restoredRepair.status, "error");
  assert.equal(repairState(restoredRefused), "failed");
});

test("the batch summary does not count a repaired run as failed", () => {
  const fixed = withRepairFinished(withRepairStarted(refused(), "job-2"), "job-2", "done", 5);
  const repairJob = { id: "job-2", title: "CV PDF", status: "done", steps: [] };
  assert.equal(workerBatchSummary([repairJob, fixed]), "1 completed");
  assert.equal(workerBatchSummary([refused()]), "1 failed");
});
