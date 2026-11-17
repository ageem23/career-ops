import { readJsonObject } from "@/lib/json-body";
import { localISODate } from "@/lib/followups";
import { applyAllProposals, decideProposal } from "@/lib/research-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The candidate's approve/dismiss on research-review proposals: one by id, or
// every pending one with action "apply-all". Applying goes through
// set-status.mjs / merge-tracker.mjs for the tracker and an atomic write for
// the report; see research-server.ts.
export async function POST(req: Request) {
  const body = await readJsonObject<{ n?: unknown; id?: unknown; action?: unknown }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const n = typeof body.n === "string" || typeof body.n === "number" ? String(body.n).trim() : "";
  if (!/^\d+$/.test(n)) return Response.json({ error: "n required" }, { status: 400 });

  if (body.action === "apply-all") {
    const result = await applyAllProposals(n, localISODate());
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ ok: true, applied: result.applied, failed: result.failed });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const action = body.action === "apply" || body.action === "dismiss" ? body.action : null;
  if (!/^p\d+$/.test(id) || !action) {
    return Response.json({ error: "id and action (apply|dismiss|apply-all) required" }, { status: 400 });
  }
  const result = await decideProposal(n, id, action, localISODate());
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
