import { readJsonObject } from "@/lib/json-body";
import { allowFinding, discardKept, editFinding, renderKept } from "@/lib/cv-gate-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The candidate's decisions on a tailored CV the content gates refused: allow
// a flagged wording, edit a flagged line, render again (no Claude run), or
// discard. "Reword with Claude" is a normal pdf job with brief.repair, started
// from the page through /api/run. See cv-gate-server.ts.
export async function POST(req: Request) {
  const body = await readJsonObject<{ n?: unknown; action?: unknown; id?: unknown; text?: unknown }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const n = typeof body.n === "string" || typeof body.n === "number" ? String(body.n).trim() : "";
  if (!/^\d+$/.test(n)) return Response.json({ error: "n required" }, { status: 400 });
  const id = typeof body.id === "string" && /^f\d+$/.test(body.id) ? body.id : "";

  let result;
  switch (body.action) {
    case "allow":
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      result = allowFinding(n, id);
      break;
    case "edit":
      if (!id || typeof body.text !== "string") return Response.json({ error: "id and text required" }, { status: 400 });
      result = editFinding(n, id, body.text);
      break;
    case "render":
      result = await renderKept(n);
      break;
    case "discard":
      result = discardKept(n);
      break;
    default:
      return Response.json({ error: "action must be allow, edit, render or discard" }, { status: 400 });
  }
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result);
}
