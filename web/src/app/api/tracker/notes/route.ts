import { readApplications } from "@/lib/career-ops";
import { applicationKey } from "@/lib/pipeline-status.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always read fresh local files

// The Pipeline page leaves Notes out of its rows: they are about 40% of the
// tracker's bytes and the table never shows them. The CSV export is the one
// place that needs them, so it fetches them here, on demand. Keyed by
// applicationKey, the same identity the table uses, so a reused tracker
// number cannot pick up another application's notes.
export async function GET() {
  const rows: [string, string][] = [];
  for (const app of readApplications()) {
    if (app.notes) rows.push([applicationKey(app), app.notes]);
  }
  return Response.json({ rows });
}
