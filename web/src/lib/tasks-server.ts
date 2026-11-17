import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findApplication } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";
import { localISODate } from "@/lib/followups";
import { addTasks, parseTasks, setTaskStatus, type Task, type TaskInput } from "@/lib/tasks.mjs";

export type { Task, TaskInput };

// data/tasks.md — the task table add-task.mjs, sync-tasks.mjs and the Go
// dashboard share (user layer). The web only appends rows and flips a row's
// status, in the same row shape those writers use.

export function tasksPath(): string {
  return path.join(/* turbopackIgnore: true */ careerOpsRoot(), "data", "tasks.md");
}

function readContent(): string | null {
  try {
    return fs.readFileSync(/* turbopackIgnore: true */ tasksPath(), "utf8");
  } catch {
    return null;
  }
}

export function readTasks(): Task[] {
  return parseTasks(readContent());
}

export function tasksForApp(n: string | number): Task[] {
  const app = Number(n);
  return readTasks().filter((t) => t.app === app);
}

// One web process serializes its own read-modify-writes. add-task.mjs and the
// TUI take no lock either; their writes are single short rewrites, the same as
// these, and atomicWrite keeps a reader from ever seeing half a file.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => T): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function appendTasks(inputs: TaskInput[]): Promise<{ added: Task[]; duplicates: TaskInput[] }> {
  return serialized(() => {
    const file = tasksPath();
    const result = addTasks(readContent(), inputs, {
      today: localISODate(),
      companyFor: (app: number) => findApplication(String(app))?.company ?? "",
    });
    if (result.added.length) {
      fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
      atomicWrite(file, result.content);
    }
    return { added: result.added, duplicates: result.duplicates };
  });
}

export function updateTaskStatus(num: number, status: string): Promise<Task> {
  return serialized(() => {
    const content = readContent();
    if (content == null) throw new Error(`task #${num} not found`);
    const result = setTaskStatus(content, num, status, localISODate());
    atomicWrite(tasksPath(), result.content);
    return result.task;
  });
}
