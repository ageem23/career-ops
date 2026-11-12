import { readJsonObject } from "@/lib/json-body";
import { localISODate } from "@/lib/followups";
import { saveResearch } from "@/lib/research-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Files deep research the candidate pasted on a report page (research-review.mjs).
// The review run that follows is started by the page through /api/run.
export async function POST(req: Request) {
  const body = await readJsonObject<{ n?: unknown; markdown?: unknown }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const n = typeof body.n === "string" || typeof body.n === "number" ? String(body.n).trim() : "";
  if (!/^\d+$/.test(n)) return Response.json({ error: "n must be an application number" }, { status: 400 });
  if (typeof body.markdown !== "string") return Response.json({ error: "markdown required" }, { status: 400 });
  const result = saveResearch(n, body.markdown, localISODate());
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true, file: result.researchRel });
}
