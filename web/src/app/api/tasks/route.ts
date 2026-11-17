import { readJsonObject } from "@/lib/json-body";
import { appendTasks, readTasks, updateTaskStatus } from "@/lib/tasks-server";
import { TASK_STATUSES, validateTaskInput, type TaskInput } from "@/lib/tasks.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// data/tasks.md from the web: list, add (the tasks parsed from a contacto
// reply, after the candidate confirmed them), and mark done/skipped/reopened.

export async function GET(req: Request) {
  const app = new URL(req.url).searchParams.get("app");
  const tasks = readTasks();
  if (app && /^\d+$/.test(app)) return Response.json({ tasks: tasks.filter((t) => t.app === Number(app)) });
  return Response.json({ tasks });
}

const MAX_BATCH = 50;

export async function POST(req: Request) {
  const body = await readJsonObject<{ tasks?: unknown }>(req);
  if (!body || !Array.isArray(body.tasks)) return Response.json({ error: "tasks must be a list" }, { status: 400 });
  if (body.tasks.length === 0) return Response.json({ error: "no tasks to add" }, { status: 400 });
  if (body.tasks.length > MAX_BATCH) return Response.json({ error: `at most ${MAX_BATCH} tasks at once` }, { status: 400 });
  const inputs: TaskInput[] = [];
  for (const [i, raw] of body.tasks.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const input: TaskInput = {
      type: String(r.type ?? ""),
      title: typeof r.title === "string" ? r.title : "",
      app: r.app == null || r.app === "" ? null : Number(r.app),
      company: typeof r.company === "string" ? r.company.slice(0, 120) : "",
      due: typeof r.due === "string" ? r.due : "",
      notes: typeof r.notes === "string" ? r.notes : "",
    };
    const error = validateTaskInput(input);
    if (error) return Response.json({ error: `task ${i + 1}: ${error}` }, { status: 400 });
    inputs.push(input);
  }
  try {
    const { added, duplicates } = await appendTasks(inputs);
    return Response.json({ ok: true, added, duplicates: duplicates.length });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "could not write data/tasks.md" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const body = await readJsonObject<{ num?: unknown; status?: unknown }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const num = Number(body.num);
  if (!Number.isInteger(num) || num <= 0) return Response.json({ error: "num must be a task number" }, { status: 400 });
  const status = String(body.status ?? "");
  if (!TASK_STATUSES.includes(status)) {
    return Response.json({ error: `status must be one of: ${TASK_STATUSES.join(", ")}` }, { status: 400 });
  }
  try {
    const task = await updateTaskStatus(num, status);
    return Response.json({ ok: true, task });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "could not update the task";
    return Response.json({ error: msg }, { status: /not found/.test(msg) ? 404 : 500 });
  }
}
