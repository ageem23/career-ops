"use client";

import { useMemo, useState } from "react";
import { TaskList } from "@/components/tasks/task-list";
import { compareTasks, dueBucket, TASK_TYPES, type Task } from "@/lib/tasks.mjs";

const CHIP = "rounded-full border px-3 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]";
const ON = `${CHIP} border-brand/40 bg-brand-soft text-brand-text`;
const OFF = `${CHIP} border-border text-muted hover:border-brand/40 hover:text-brand-text`;

const GROUPS = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "undated", label: "No due date" },
] as const;

/** Every task in data/tasks.md: open ones grouped by due date, closed ones newest first. */
export function TasksView({ tasks, today }: { tasks: Task[]; today: string }) {
  const [type, setType] = useState<string>("all");
  const [tab, setTab] = useState<"open" | "closed">("open");
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const t of tasks) {
      if (t.status !== "pending") continue;
      c.all++;
      c[t.type] = (c[t.type] ?? 0) + 1;
    }
    return c;
  }, [tasks]);
  const ofType = tasks.filter((t) => type === "all" || t.type === type);
  const open = ofType.filter((t) => t.status === "pending").sort(compareTasks);
  const closed = ofType
    .filter((t) => t.status !== "pending")
    .sort((a, b) => (b.completed || "").localeCompare(a.completed || "") || b.num - a.num)
    .slice(0, 100);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">Tasks</h1>
      <p className="mt-1 text-sm text-muted">
        From <span className="font-mono">data/tasks.md</span>: contacts from contacto, cadence follow-ups, and anything added with{" "}
        <span className="font-mono">add-task.mjs</span>. The terminal dashboard reads the same file.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {["all", ...TASK_TYPES].map((k) => (
          <button key={k} type="button" onClick={() => setType(k)} className={type === k ? ON : OFF}>
            {k === "all" ? "All" : k} <span className="tabular-nums text-faint">{counts[k] ?? 0}</span>
          </button>
        ))}
        <span className="ml-auto inline-flex gap-2">
          <button type="button" onClick={() => setTab("open")} className={tab === "open" ? ON : OFF}>
            Open
          </button>
          <button type="button" onClick={() => setTab("closed")} className={tab === "closed" ? ON : OFF}>
            Closed
          </button>
        </span>
      </div>

      {tab === "open" ? (
        open.length === 0 ? (
          <p className="mt-8 rounded-2xl border border-dashed border-border bg-surface/30 p-5 text-sm text-muted">
            No open tasks. On an applied application, use “Find contacts in Claude” in the Outreach card, then paste the reply
            back to add its contacts here.
          </p>
        ) : (
          GROUPS.map(({ key, label }) => {
            const rows = open.filter((t) => dueBucket(t, today) === key);
            if (!rows.length) return null;
            return (
              <section key={key} className="mt-6">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
                  {label} <span className="tabular-nums text-faint">{rows.length}</span>
                </h2>
                <TaskList tasks={rows} today={today} showCompany />
              </section>
            );
          })
        )
      ) : closed.length === 0 ? (
        <p className="mt-8 text-sm text-muted">No closed tasks.</p>
      ) : (
        <section className="mt-6">
          <TaskList tasks={closed} today={today} showCompany />
        </section>
      )}
    </div>
  );
}
