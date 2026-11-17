import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/json-body";
import { keywordsInText, loadStudio, missingDataFolderMessage, unsupportedRewriteClaims } from "@/lib/cv-studio/server";
import { runRewrite } from "@/lib/cv-studio/rewrite-run";
import { buildAssistPrompt, MAX_ASSIST_INSTRUCTION, parseAssist, planAssist } from "@/lib/cv-studio/assist.mjs";
import { parseEdits } from "@/lib/cv-studio/studio.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ n: string }> };

// A whole-CV request reads every bullet and may change several, so it gets
// longer than the one-bullet rewrite's 120 s.
const ASSIST_KILL_MS = 240_000;

const MESSAGES = {
  "no-cli": "No AI CLI is set up. Choose one in Config.",
  unfenced: "This AI CLI cannot be limited to read-only access, so the request did not run. Choose Claude, Codex or Grok in Config.",
  refused: "The AI CLI could not be started with read-only access, so nothing ran.",
  failed: "The AI CLI did not finish. Check that it is signed in, then try again.",
  "no-answer": "The AI CLI replied, but not in a form the Studio can use. Try rephrasing the request.",
} as const;

/**
 * The CV Studio's prompt box (assist.mjs). Returns the agent's reply and the
 * Studio actions for the changes that passed every check; the page applies
 * them as one undo step. Nothing is written here: the page's autosave stores
 * the edits like any other.
 */
export async function POST(req: Request, { params }: RouteContext) {
  const n = (await params).n;
  const body = await readJsonObject<{ instruction?: unknown; cliId?: unknown; edits?: unknown; history?: unknown }>(req);
  if (!body || typeof body.instruction !== "string" || typeof body.cliId !== "string") {
    return NextResponse.json({ error: "instruction and cliId required" }, { status: 400 });
  }
  const instruction = body.instruction.trim().slice(0, MAX_ASSIST_INSTRUCTION);
  if (!instruction) return NextResponse.json({ error: "Say what you want changed." }, { status: 400 });
  const missing = missingDataFolderMessage();
  if (missing) return NextResponse.json({ error: missing }, { status: 400 });

  const load = await loadStudio(n);
  if (!load.ok) return NextResponse.json({ error: load.reason }, { status: 404 });
  // The page's current edits, so the agent sees the CV as it is on screen.
  // Validated the same way stored edits are; edits for another version of the
  // CV are dropped (stale) rather than misapplied.
  const parsed = parseEdits(body.edits, load.doc.sourceHash);
  if (!parsed || parsed.stale) return NextResponse.json({ error: "This CV changed since the Studio opened. Reload the page." }, { status: 409 });
  const edits = parsed.edits;
  const history = Array.isArray(body.history)
    ? body.history
        .filter((t): t is { instruction: string; reply: string } => !!t && typeof t === "object" && typeof (t as Record<string, unknown>).instruction === "string" && typeof (t as Record<string, unknown>).reply === "string")
        .map((t) => ({ instruction: t.instruction.slice(0, 500), reply: t.reply.slice(0, 500) }))
    : [];

  const run = await runRewrite(body.cliId, buildAssistPrompt({ instruction, doc: load.doc, edits, history }), { killMs: ASSIST_KILL_MS });
  if (!run.ok) {
    if (run.detail) console.error(`cv-studio assist ${run.reason}: ${run.detail}`);
    return NextResponse.json({ error: MESSAGES[run.reason] }, { status: 502 });
  }
  const answer = parseAssist(run.reply);
  if (!answer) return NextResponse.json({ error: MESSAGES["no-answer"] }, { status: 422 });

  const plan = planAssist(load.doc, edits, answer.changes);
  const actions: object[] = [...plan.actions];
  const applied = [...plan.applied];
  const rejected = [...plan.rejected];
  const warnings = new Set<string>();
  // Each new wording passes the same gates the PDF render runs, against this
  // bullet's own cv.md original and tailored text (the one-bullet rewrite's check).
  for (const r of plan.rewrites) {
    const check = await unsupportedRewriteClaims(r.text, [r.base, r.tailored].filter((t) => t !== null).join("\n"));
    if (check.warning) warnings.add(check.warning);
    if (check.claims.length) {
      rejected.push({ what: `Reword ${r.where}: "${r.text}"`, why: `Not used, because it adds wording your CV does not support: ${check.claims.join(", ")}.` });
      continue;
    }
    actions.push({ type: "use", id: r.id, use: { kind: "custom", text: r.text, keywords: (await keywordsInText(n, r.text)) ?? [] } });
    applied.push(`Reworded ${r.where}`);
  }
  if (run.warning) warnings.add(run.warning);
  return NextResponse.json({ reply: answer.reply, actions, applied, rejected, warning: [...warnings].join(" ") || null });
}
