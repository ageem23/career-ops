import { readApplications } from "@/lib/career-ops";
import { reportNumberFromCell } from "@/lib/apply/cv-selection.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always read the tracker fresh

// The tracker row an evaluation report belongs to. A worker knows only the
// report number it wrote, and tracker # and report # drift apart (merged or
// deleted rows), so the application page link is resolved through the row's
// Report cell rather than assumed to be /pipeline/{report}.
export async function GET(req: Request) {
  const report = Number(new URL(req.url).searchParams.get("report"));
  if (!Number.isInteger(report) || report <= 0) {
    return Response.json({ error: "report must be a positive integer" }, { status: 400 });
  }
  const row = readApplications().find((a) => reportNumberFromCell(a.report) === report);
  return Response.json({ n: row ? String(parseInt(row.n, 10)) : null });
}
