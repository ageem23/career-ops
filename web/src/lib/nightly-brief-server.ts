import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { briefFreshness, latestBriefFile, slimBrief } from "@/lib/nightly-brief.mjs";

// Server half of the morning brief card. morning-brief.mjs (repo root) writes
// {DATA_ROOT}/data/nightly-briefs/{date}.json at the end of the 04:00 job; this
// reads the newest one. Read-only: the dashboard never writes a brief.

export type BriefItem = {
  batchId?: string;
  report: string | null;
  reportPath?: string | null;
  score: number | null;
  company: string;
  role: string;
  decision?: string | null;
  legitimacy?: string | null;
  verdict?: string | null;
  trackerRow?: number | null;
  reEvaluated?: { trackerRow: number };
  kind?: "skipped" | "failed" | "stuck";
  reason?: string;
};

export type BriefRun = {
  key: string;
  label: string;
  ran: boolean;
  finished?: boolean;
  finishedAt?: string | null;
  imported?: number | null;
  pendingSeen?: number | null;
  scan?: { added?: number; companies?: number } | null;
};

export type NightlyBrief = {
  date: string;
  generatedAt: string;
  status: "ok" | "attention" | "problem";
  headline: string;
  counts: { evaluated: number; applyWorthy: number; skipped: number; failed: number; pendingLeft: number | null; scanAdded: number | null };
  runs: BriefRun[];
  topPicks: BriefItem[];
  nextBest: BriefItem[];
  notCompleted: BriefItem[];
  issues: { level: "error" | "warn"; text: string }[];
  /** newWarnings is capped (MAX_NEW_WARNINGS); newWarningCount is the real total. */
  health: { ran: boolean; baseline: boolean; newWarnings: string[]; newWarningCount: number; recurringCount: number };
  summary: { text: string | null; error?: string; generatedAt?: string } | null;
};

export type LatestBrief = {
  brief: NightlyBrief;
  freshness: { current: boolean; daysOld: number | null };
};

/** The newest brief, or null when none has been written (or it cannot be read). */
export function readLatestBrief(now: Date = new Date()): LatestBrief | null {
  const dir = path.join(/* turbopackIgnore: true */ careerOpsRoot(), "data", "nightly-briefs");
  let names: string[];
  try {
    names = fs.readdirSync(/* turbopackIgnore: true */ dir);
  } catch {
    return null;
  }
  const file = latestBriefFile(names);
  if (!file) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(dir, file), "utf8"));
  } catch {
    return null;
  }
  const slim = slimBrief(raw) as (NightlyBrief & { evaluated?: unknown }) | null;
  if (!slim) return null;
  // Every evaluation of the night is in the file; the card shows only the top
  // picks and next best, so the full list stays out of the page payload.
  const { evaluated: _all, ...brief } = slim;
  return { brief, freshness: briefFreshness(brief.date, now) };
}
