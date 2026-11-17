import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findReportFile } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import type { CoverSuggestions } from "@/lib/cover-suggest.mjs";

// Server half of cover-letter suggestions (see cover-suggest.mjs). One cache
// file per application under data/cover-suggestions/ (user layer). It records
// which report it was built from and that report's mtime, so a re-evaluated
// report marks the suggestions stale instead of silently serving old angles.

export type CoverSuggestionsFile = {
  n: string;
  reportFile: string;
  reportMtimeMs: number;
  createdAt: string;
  suggestions: CoverSuggestions;
};

function cachePath(n: string): string {
  return path.join(/* turbopackIgnore: true */ careerOpsRoot(), "data", "cover-suggestions", `${Number(n)}.json`);
}

function reportStamp(n: string): { reportFile: string; reportMtimeMs: number } | null {
  const file = findReportFile(n);
  if (!file) return null;
  try {
    return { reportFile: path.basename(file), reportMtimeMs: fs.statSync(/* turbopackIgnore: true */ file).mtimeMs };
  } catch {
    return null;
  }
}

/** cv.md + article-digest.md, the text a suggested figure has to appear in. */
export function allowedFactText(): string {
  const root = careerOpsRoot();
  return ["cv.md", "article-digest.md"]
    .map((f) => {
      try {
        return fs.readFileSync(/* turbopackIgnore: true */ path.join(root, f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

export function saveCoverSuggestions(n: string, suggestions: CoverSuggestions, now: Date = new Date()): { ok: true } | { ok: false; error: string } {
  if (!/^\d+$/.test(n)) return { ok: false, error: `Invalid application number "${n}".` };
  const stamp = reportStamp(n);
  if (!stamp) return { ok: false, error: `No report found for #${n}, so the suggestions were not saved.` };
  const record: CoverSuggestionsFile = { n: String(Number(n)), ...stamp, createdAt: now.toISOString(), suggestions };
  try {
    atomicWrite(cachePath(n), JSON.stringify(record, null, 2) + "\n");
  } catch (e) {
    return { ok: false, error: `Could not save the suggestions: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}

export function readCoverSuggestions(n: string): { record: CoverSuggestionsFile | null; stale: boolean } {
  if (!/^\d+$/.test(n)) return { record: null, stale: false };
  let record: CoverSuggestionsFile | null = null;
  try {
    record = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ cachePath(n), "utf8")) as CoverSuggestionsFile;
  } catch {
    return { record: null, stale: false };
  }
  const stamp = reportStamp(n);
  const stale = !stamp || stamp.reportFile !== record.reportFile || Math.abs(stamp.reportMtimeMs - record.reportMtimeMs) > 1;
  return { record, stale };
}
