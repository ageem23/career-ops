import { readCoverSuggestions } from "@/lib/cover-suggest-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The cached Step 6 options for one application's cover letter form
// (cover-brief-form.tsx). A `cover-suggest` run started through /api/run writes
// them; this only reads. No cache yet is a normal state, not an error: the form
// then offers to run the suggestions.
export async function GET(req: Request) {
  const n = (new URL(req.url).searchParams.get("n") ?? "").trim();
  if (!/^\d+$/.test(n)) return Response.json({ error: "n must be an application number" }, { status: 400 });
  const { record, stale } = readCoverSuggestions(n);
  return Response.json(
    { suggestions: record?.suggestions ?? null, stale: record ? stale : false, createdAt: record?.createdAt ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
