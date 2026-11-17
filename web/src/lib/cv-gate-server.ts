import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { careerOpsRoot, findReportFile } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { resolvePdfPaths } from "@/lib/pdf-paths.mjs";
import { readRepair, renderAndMarkPdf, repairPaths } from "@/lib/pdf-render.mjs";
import { collectGateFindings, replaceBlockText, withAllowance, withMaxPages } from "@/lib/cv-gate.mjs";
import { getProfilePath } from "@/lib/core/profile-path.mjs";

// The review card for a tailored CV the content gates refused (cv-gate.mjs).
// The refused HTML and its findings live in the web scratch folder beside the
// run that produced them (pdf-render.mjs keepForRepair); a successful render
// of the same report deletes them, which is what makes the card go away.

export type GateRow = {
  id: string;
  kind: string;
  line: string;
  words: string[];
  source: string | null;
  why: string;
  allow: { type: "fact" | "swaps" | "pages"; value: string | string[] | number; label: string } | null;
  editable: boolean;
  state: "pending" | "allowed" | "edited";
};

export type CvGateState = {
  reportNum: string;
  error: string;
  rows: GateRow[] | null;
  keptAt: string | null;
};

type KeptRecord = { error: string; format: string; rows: GateRow[] | null; keptAt: string };
type Result<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };

const MAX_EDIT_CHARS = 1200;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function locate(id: string) {
  const resolved = resolvePdfPaths(id, today(), careerOpsRoot(), findReportFile);
  if (!resolved.ok) return null;
  const paths = resolved.paths;
  const scratchDir = path.dirname(paths.html);
  const kept = readRepair(scratchDir, paths.reportNum);
  return { paths, scratchDir, kept };
}

/** The refused CV awaiting the candidate's call for application `id`, or null. */
export function cvGateState(id: string): CvGateState | null {
  const at = locate(id);
  if (!at?.kept) return null;
  const record = at.kept.record as KeptRecord | null;
  return {
    reportNum: at.paths.reportNum,
    error: record?.error ?? at.kept.findings,
    rows: Array.isArray(record?.rows) ? record.rows : null,
    keptAt: record?.keptAt ?? null,
  };
}

function loadRecord(id: string) {
  const at = locate(id);
  if (!at?.kept) return { error: { ok: false as const, status: 404, error: "There is no refused CV waiting for review. Generate the CV again." } };
  const record = at.kept.record as KeptRecord | null;
  if (!record || !Array.isArray(record.rows)) {
    return { error: { ok: false as const, status: 409, error: "This refused CV has no line-by-line findings. Use Reword with Claude, or generate it again." } };
  }
  return { at, record, rows: record.rows };
}

function saveRecord(rowsPath: string, record: KeptRecord) {
  atomicWrite(rowsPath, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * The candidate allows a flagged wording from now on: the stock word or
 * scope wording goes to allow_facts, a changed verb to allow_swaps, in
 * config/cv-facts.json (the user-layer file both gates read). This click is
 * the explicit approval AGENTS.md requires before either list changes.
 */
export function allowFinding(id: string, findingId: string): Result {
  const loaded = loadRecord(id);
  if ("error" in loaded) return loaded.error as Result;
  const { at, record, rows } = loaded;
  const row = rows.find((r) => r.id === findingId);
  if (!row) return { ok: false, status: 404, error: "No such finding." };
  if (!row.allow) return { ok: false, status: 409, error: "This one cannot be allowed: if it is true, add it to cv.md first." };
  if (row.state !== "pending") return { ok: false, status: 409, error: `Already ${row.state}.` };

  // A longer CV is a profile setting, not a phrasing allowance: cv.max_pages
  // is what generate-pdf.mjs reads on every path (web, CLI, batch).
  if (row.allow.type === "pages") {
    const profilePath = getProfilePath(careerOpsRoot());
    let profile = "";
    try {
      profile = fs.readFileSync(/* turbopackIgnore: true */ profilePath, "utf8");
    } catch {
      profile = "";
    }
    const updated = withMaxPages(profile, Number(row.allow.value));
    if (!updated.ok) return { ok: false, status: 422, error: updated.error };
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    atomicWrite(profilePath, updated.content);
    row.state = "allowed";
    saveRecord(at.kept!.rowsPath, record);
    return { ok: true };
  }

  const factsPath = path.join(careerOpsRoot(), "config", "cv-facts.json");
  let raw = "";
  try {
    raw = fs.readFileSync(/* turbopackIgnore: true */ factsPath, "utf8");
  } catch {
    raw = "";
  }
  const next = withAllowance(raw, row.allow as { type: "fact" | "swaps"; value: string | string[] }, today());
  if (!next.ok) return { ok: false, status: 422, error: next.error };
  fs.mkdirSync(path.dirname(factsPath), { recursive: true });
  atomicWrite(factsPath, next.content);
  row.state = "allowed";
  saveRecord(at.kept!.rowsPath, record);
  return { ok: true };
}

/** The candidate rewrites a flagged line themselves; the refused HTML is edited in place. */
export function editFinding(id: string, findingId: string, text: string): Result {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, status: 400, error: "The new wording is empty." };
  if (clean.length > MAX_EDIT_CHARS) return { ok: false, status: 413, error: `Keep the line under ${MAX_EDIT_CHARS} characters.` };
  const loaded = loadRecord(id);
  if ("error" in loaded) return loaded.error as Result;
  const { at, record, rows } = loaded;
  const row = rows.find((r) => r.id === findingId);
  if (!row) return { ok: false, status: 404, error: "No such finding." };
  if (!row.editable) return { ok: false, status: 409, error: "This line can't be edited here. Use Reword with Claude, or edit the CV in CV Studio after it renders." };
  const html = fs.readFileSync(/* turbopackIgnore: true */ at.kept!.html, "utf8");
  const edited = replaceBlockText(html, row.line, clean);
  if (edited == null) return { ok: false, status: 409, error: "That line is no longer in the CV (another edit changed it)." };
  atomicWrite(at.kept!.html, edited);
  // Every row on the same line now points at the new wording.
  const old = row.line;
  for (const r of rows) {
    if (r.line === old) {
      r.line = clean;
      r.state = "edited";
    }
  }
  saveRecord(at.kept!.rowsPath, record);
  return { ok: true };
}

/**
 * Render the refused CV again, with the candidate's allows and edits and no
 * Claude run. Both gates run again inside generate-pdf.mjs; a refusal keeps
 * the CV and refreshes the findings, a pass saves the PDF, marks the tracker
 * and clears the card.
 */
export async function renderKept(id: string): Promise<Result<{ rendered: boolean; warnings: string[] }>> {
  const at = locate(id);
  if (!at?.kept) return { ok: false, status: 404, error: "There is no refused CV waiting for review." };
  const record = at.kept.record as KeptRecord | null;
  const format = record?.format === "a4" ? "a4" : "letter";
  const coreRoot = resolveCodeRoot(process.cwd(), process.env);
  const token = acquireTrackerWrite();
  try {
    fs.copyFileSync(at.kept.html, at.paths.html);
    const result = await renderAndMarkPdf({
      spawnFn: spawn,
      execPath: process.execPath,
      coreRoot,
      dataRoot: careerOpsRoot(),
      pdfPaths: at.paths,
      format,
      reportNum: at.paths.reportNum,
      collectFindings: (htmlPath: string) =>
        collectGateFindings({ coreRoot, dataRoot: careerOpsRoot(), htmlPath, html: fs.readFileSync(/* turbopackIgnore: true */ htmlPath, "utf8") }),
    });
    if (result.kind === "rendered") return { ok: true, rendered: true, warnings: result.warnings };
    // Still refused (wording or page budget): the card shows the fresh findings.
    if (result.factCheck || result.pageBudget) return { ok: true, rendered: false, warnings: [] };
    return { ok: false, status: 500, error: result.error.slice(0, 1500) };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  } finally {
    releaseTrackerWrite(token);
  }
}

/** Drop the refused CV; the card goes away and nothing else changes. */
export function discardKept(id: string): Result {
  const at = locate(id);
  if (!at) return { ok: false, status: 404, error: "No report for this application." };
  const target = repairPaths(at.scratchDir, at.paths.reportNum);
  for (const file of Object.values(target)) fs.rmSync(/* turbopackIgnore: true */ file, { force: true });
  return { ok: true };
}
