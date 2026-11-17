import { readLatestBrief } from "@/lib/nightly-brief-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The newest morning brief (morning-brief.mjs → data/nightly-briefs/). The Today
// page reads it server-side; this is the same data for any other client.
export async function GET() {
  const latest = readLatestBrief();
  return Response.json(latest ?? { brief: null, freshness: null }, { headers: { "Cache-Control": "no-store" } });
}
