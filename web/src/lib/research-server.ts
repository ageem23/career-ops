import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findApplication, findReportFile, type Application } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { runCoreCli, runSetStatus, type CliResult } from "@/lib/core-cli";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { reportNumberFor } from "@/lib/apply-checklist.mjs";
import { parseCliJson, clientErrorMessage } from "@/lib/status-cli.mjs";
import { trackerTsvLine, formatScore } from "@/lib/report-persist.mjs";
import { parseReport } from "@/lib/format";
import {
  buildResearchFile,
  interviewIntelPath,
  isSafeResearchPath,
  researchFileName,
  reviewSidecarPath,
  withInterviewIntel,
  withReportScore,
  withReportUpdate,
  withReviewSection,
} from "@/lib/research-review.mjs";

// Server half of research filing and review (see research-review.mjs for the
// flow). Every write here lands in the user layer: interview-prep/, reports/,
// and the tracker — the tracker only through set-status.mjs and
// merge-tracker.mjs, never by editing the table.

export const MAX_RESEARCH_BYTES = 400_000;

export type Proposal =
  | { id: string; type: "score"; to: number; reason: string; state: ProposalState; error?: string }
  | { id: string; type: "status"; to: string; reason: string; state: ProposalState; error?: string }
  | { id: string; type: "note"; text: string; reason: string; state: ProposalState; error?: string }
  | { id: string; type: "report-update"; markdown: string; reason: string; state: ProposalState; error?: string };
export type ProposalState = "pending" | "applied" | "dismissed";

export type ReviewSidecar = {
  reportNum: number | null;
  reviewedAt: string;
  changesMarkdown: string;
  bottomLine: string;
  cvFlags: { claim: string; why: string }[];
  proposals: Proposal[];
};

export type ResearchContext = {
  app: Application | null;
  reportPath: string | null;
  reportFile: string | null;
  reportNum: number | null;
  report: string | null;
  /** Data-root-relative research path, when the report links one that exists. */
  researchRel: string | null;
  research: string | null;
  review: ReviewSidecar | null;
};

function abs(rel: string): string {
  return path.join(/* turbopackIgnore: true */ careerOpsRoot(), rel);
}

function readIf(file: string): string | null {
  try {
    return fs.readFileSync(/* turbopackIgnore: true */ file, "utf8");
  } catch {
    return null;
  }
}

export function researchContext(id: string): ResearchContext {
  const app = findApplication(id);
  const reportPath = findReportFile(id);
  const report = reportPath ? readIf(reportPath) : null;
  const reportFile = reportPath ? path.basename(reportPath) : null;
  const reportNum = reportNumberFor(id, app, reportFile);
  const linked = interviewIntelPath(report);
  const research = linked ? readIf(abs(linked)) : null;
  const researchRel = research != null ? linked : null;
  let review: ReviewSidecar | null = null;
  if (researchRel) {
    const raw = readIf(abs(reviewSidecarPath(researchRel)));
    try {
      review = raw ? (JSON.parse(raw) as ReviewSidecar) : null;
    } catch {
      review = null;
    }
  }
  return { app, reportPath, reportFile, reportNum, report, researchRel, research, review };
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };

/**
 * File pasted research for application `id`: write the research file and link
 * it from the report header. A previous review's sidecar is removed, since its
 * proposals described the old research.
 */
export function saveResearch(id: string, markdown: string, today: string): Result<{ researchRel: string }> {
  const ctx = researchContext(id);
  if (!ctx.report || !ctx.reportPath) return { ok: false, status: 404, error: "This application has no evaluation report to attach research to." };
  const body = markdown.trim();
  if (!body) return { ok: false, status: 400, error: "The research is empty." };
  if (Buffer.byteLength(body, "utf8") > MAX_RESEARCH_BYTES) return { ok: false, status: 413, error: "The research is too large (over 400 KB)." };

  const meta = parseReport(ctx.report);
  const field = (label: string) => meta.fields.find((f) => f.label === label)?.value ?? "";
  const company = ctx.app?.company || meta.title || `report-${ctx.reportNum ?? id}`;
  const role = ctx.app?.role || "role";
  // Reuse the file the report already links (a re-paste replaces it); otherwise
  // the {company}-{role}-research.md name earlier research files use.
  const researchRel = interviewIntelPath(ctx.report) ?? researchFileName(company, role);
  if (!isSafeResearchPath(researchRel)) return { ok: false, status: 400, error: "Refusing to write research outside interview-prep/." };

  const content = buildResearchFile({
    company,
    role,
    reportNum: ctx.reportNum,
    reportFile: ctx.reportFile,
    score: ctx.app?.score || field("Score"),
    status: ctx.app?.status ?? "",
    date: today,
    markdown: body,
  });
  try {
    fs.mkdirSync(path.dirname(abs(researchRel)), { recursive: true });
    atomicWrite(abs(researchRel), content);
    atomicWrite(ctx.reportPath, withInterviewIntel(ctx.report, researchRel, today));
    fs.rmSync(abs(reviewSidecarPath(researchRel)), { force: true });
  } catch (e) {
    return { ok: false, status: 500, error: `Could not save the research: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, researchRel };
}

/** File a finished review: its section into the research file, its proposals into the sidecar. */
export function saveReview(
  researchRel: string,
  reportNum: number | null,
  review: Omit<ReviewSidecar, "reportNum" | "reviewedAt">,
  today: string,
): Result {
  if (!isSafeResearchPath(researchRel)) return { ok: false, status: 400, error: "Refusing to write outside interview-prep/." };
  const research = readIf(abs(researchRel));
  if (research == null) return { ok: false, status: 404, error: "The research file disappeared before the review could be saved." };
  try {
    atomicWrite(abs(researchRel), withReviewSection(research, { reportNum, ...review, date: today }));
    const sidecar: ReviewSidecar = { reportNum, reviewedAt: today, ...review };
    atomicWrite(abs(reviewSidecarPath(researchRel)), JSON.stringify(sidecar, null, 2) + "\n");
  } catch (e) {
    return { ok: false, status: 500, error: `Could not save the review: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}

async function setStatusByReport(reportNum: number, status: string, note: string): Promise<Result> {
  const args = ["--report", String(reportNum), status, "--source", "web", "--json"];
  if (note) args.splice(3, 0, "--note", note);
  const r = await runSetStatus(args);
  if (r.spawnFailed) return { ok: false, status: 500, error: "set-status.mjs failed to run." };
  if (r.timedOut) return { ok: false, status: 504, error: "The tracker update timed out; it may or may not have been applied." };
  if (r.code !== 0) {
    const parsed = parseCliJson(r.stdout);
    return { ok: false, status: r.code === 4 ? 503 : 400, error: clientErrorMessage(parsed, r.stderr) };
  }
  return { ok: true };
}

// merge-tracker.mjs reads every tracked row's report, so on a tracker of
// thousands of rows in a synced folder one merge takes tens of seconds. Give it
// room; the request is the user waiting on an Apply click, not a page load.
const MERGE_TIMEOUT_MS = 180_000;

function scoreNumber(cell: string | undefined | null): number | null {
  const m = String(cell ?? "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** The first line of merge-tracker output that says what went wrong. */
function mergeProblem(stdout: string, stderr: string): string {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const flagged = lines.find((l) => /^(❌|⚠️)/.test(l));
  return (flagged ?? lines.at(-1) ?? "").replace(/^(❌|⚠️)\s*/, "").slice(0, 240);
}

/**
 * Plain-language reason a score did not reach the tracker. Every case says
 * the same two things: nothing changed, and what to do.
 */
function mergeFailureMessage(r: CliResult, before: string): string {
  const unchanged = `Nothing was changed; the tracker and report still show ${before || "the old score"}.`;
  if (r.timedOut) {
    return `The tracker update took more than ${MERGE_TIMEOUT_MS / 60_000} minutes and was stopped. ${unchanged} Try Apply again.`;
  }
  if (r.spawnFailed) return `Could not start merge-tracker.mjs. ${unchanged}`;
  const problem = mergeProblem(r.stdout, r.stderr);
  if (/lock timeout/i.test(problem)) {
    return `The tracker is busy with another update (a nightly scan or batch run may be merging). ${unchanged} Try Apply again in a few minutes.`;
  }
  return `merge-tracker.mjs did not update the row${problem ? ` (${problem})` : ""}. ${unchanged}`;
}

/**
 * New score through the same path a re-evaluation uses: a tracker-addition TSV
 * for the same report number, merged by merge-tracker.mjs (which keeps the
 * row's status and adds a `Re-eval {date} (old→new)` note), then the report
 * header and Machine Summary.
 *
 * All or nothing. The report is written only once the tracker row is read back
 * with the new score, and the TSV never outlives this call: a failed merge
 * that left it queued would apply a score the candidate saw fail (and may then
 * dismiss) at the next unrelated merge, such as the nightly batch.
 */
async function applyScore(id: string, ctx: ResearchContext, to: number, reason: string, today: string): Promise<Result> {
  if (!ctx.app || !ctx.reportPath || !ctx.report || !ctx.reportFile || ctx.reportNum == null) {
    return { ok: false, status: 409, error: "A score change needs both the tracker row and its report." };
  }
  const score = formatScore(String(to));
  if (!score) return { ok: false, status: 400, error: "Invalid score." };
  const num = ctx.reportFile.match(/^(\d+)-/)?.[1] ?? String(ctx.reportNum);
  const before = ctx.app.score;
  const via = ctx.app.via && ctx.app.via !== "—" ? ctx.app.via : null;
  const url = /^https?:\/\//i.test(ctx.app.url) ? ctx.app.url : "";
  const tsv = trackerTsvLine({
    num,
    today,
    company: ctx.app.company,
    role: ctx.app.role,
    score,
    reportFile: ctx.reportFile,
    notes: `Deep research: ${reason}`.replace(/[\t\r\n|]+/g, " ").slice(0, 300),
    via,
    url,
  });
  const dir = path.join(careerOpsRoot(), "batch", "tracker-additions");
  fs.mkdirSync(dir, { recursive: true });
  const tsvPath = path.join(dir, `${num}-research-review.tsv`);
  atomicWrite(tsvPath, tsv);
  let merged: CliResult;
  try {
    merged = await runCoreCli("merge-tracker", [], { timeoutMs: MERGE_TIMEOUT_MS });
  } finally {
    // A successful merge already moved it to merged/; this only clears a failure.
    fs.rmSync(tsvPath, { force: true });
  }
  // Judge by the tracker, not the exit code: a merge killed after its write
  // landed the change, and a clean exit can still have skipped the row.
  const now = scoreNumber(findApplication(id)?.score);
  if (now == null || Math.abs(now - to) > 0.001) {
    return { ok: false, status: merged.timedOut ? 504 : 500, error: mergeFailureMessage(merged, before) };
  }
  atomicWrite(ctx.reportPath, withReportScore(ctx.report, to));
  return { ok: true };
}

function writeSidecar(researchRel: string, review: ReviewSidecar) {
  atomicWrite(abs(reviewSidecarPath(researchRel)), JSON.stringify(review, null, 2) + "\n");
}

/** Apply or dismiss one proposal, recording the outcome in the sidecar. */
export async function decideProposal(id: string, proposalId: string, action: "apply" | "dismiss", today: string): Promise<Result> {
  const ctx = researchContext(id);
  if (!ctx.researchRel || !ctx.review) return { ok: false, status: 404, error: "No research review for this application." };
  const proposal = ctx.review.proposals.find((p) => p.id === proposalId);
  if (!proposal) return { ok: false, status: 404, error: "No such proposal." };
  if (proposal.state !== "pending") return { ok: false, status: 409, error: `This proposal was already ${proposal.state}.` };

  if (action === "dismiss") {
    proposal.state = "dismissed";
    writeSidecar(ctx.researchRel, ctx.review);
    return { ok: true };
  }

  const token = acquireTrackerWrite();
  try {
    return await applyPending(id, proposalId, today);
  } finally {
    releaseTrackerWrite(token);
  }
}

// Report edits first (no tracker involved), quick set-status calls next, the
// slow merge-tracker score update last, so one slow or failed step never holds
// up the others.
const APPLY_ORDER: Proposal["type"][] = ["report-update", "note", "status", "score"];

/**
 * Apply every pending proposal, in APPLY_ORDER. Each one is applied and
 * recorded on its own: a failure is kept on that proposal (it stays pending,
 * so it can be retried) and the rest still run.
 */
export async function applyAllProposals(id: string, today: string): Promise<Result<{ applied: number; failed: number }>> {
  const ctx = researchContext(id);
  if (!ctx.researchRel || !ctx.review) return { ok: false, status: 404, error: "No research review for this application." };
  const pending = ctx.review.proposals
    .filter((p) => p.state === "pending")
    .sort((a, b) => APPLY_ORDER.indexOf(a.type) - APPLY_ORDER.indexOf(b.type));
  if (pending.length === 0) return { ok: false, status: 409, error: "Nothing is waiting to be applied." };

  let applied = 0;
  let failed = 0;
  const token = acquireTrackerWrite();
  try {
    for (const p of pending) {
      const r = await applyPending(id, p.id, today);
      if (r.ok) applied++;
      else failed++;
    }
  } finally {
    releaseTrackerWrite(token);
  }
  return { ok: true, applied, failed };
}

/**
 * Apply one pending proposal and record the outcome. Re-reads the report,
 * tracker and sidecar each time, because an earlier proposal in the same
 * Apply all may have just rewritten them. The caller holds the tracker-write
 * token.
 */
async function applyPending(id: string, proposalId: string, today: string): Promise<Result> {
  const ctx = researchContext(id);
  if (!ctx.researchRel || !ctx.review) return { ok: false, status: 404, error: "No research review for this application." };
  const proposal = ctx.review.proposals.find((p) => p.id === proposalId);
  if (!proposal) return { ok: false, status: 404, error: "No such proposal." };
  if (proposal.state !== "pending") return { ok: false, status: 409, error: `This proposal was already ${proposal.state}.` };

  let result: Result;
  try {
    if (proposal.type === "score") {
      result = await applyScore(id, ctx, proposal.to, proposal.reason, today);
    } else if (proposal.type === "status" || proposal.type === "note") {
      if (ctx.reportNum == null || !ctx.app) {
        result = { ok: false, status: 409, error: "This application has no tracker row to update." };
      } else {
        const status = proposal.type === "status" ? proposal.to : ctx.app.status;
        const note = proposal.type === "note" ? proposal.text : `Deep research: ${proposal.reason}`.slice(0, 300);
        result = await setStatusByReport(ctx.reportNum, status, note.replace(/[|\r\n*]+/g, " "));
      }
    } else if (proposal.type === "report-update") {
      if (!ctx.reportPath || !ctx.report) {
        result = { ok: false, status: 409, error: "The report file is missing." };
      } else {
        atomicWrite(ctx.reportPath, withReportUpdate(ctx.report, proposal.markdown, today));
        result = { ok: true };
      }
    } else {
      result = { ok: false, status: 400, error: "Unknown proposal type." };
    }
  } catch (e) {
    result = { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }

  if (result.ok) {
    proposal.state = "applied";
    delete proposal.error;
  } else {
    proposal.error = result.error;
  }
  writeSidecar(ctx.researchRel, ctx.review);
  return result;
}
