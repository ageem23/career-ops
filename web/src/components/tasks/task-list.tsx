"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, Loader2, SkipForward, Undo2 } from "lucide-react";
import { dueBucket, notesLink, type Task } from "@/lib/tasks.mjs";

const PILL =
  "inline-flex items-center justify-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors max-sm:min-h-[44px] disabled:cursor-not-allowed disabled:opacity-60";

const DUE_TONE: Record<string, string> = {
  overdue: "text-red-700 dark:text-red-400",
  today: "text-amber-800 dark:text-amber-400",
  upcoming: "text-muted",
  undated: "text-faint",
};

function dueLabel(t: Task, today: string): string {
  if (t.status !== "pending") return t.completed ? `${t.status} ${t.completed}` : t.status;
  const b = dueBucket(t, today);
  if (b === "undated") return "no due date";
  if (b === "today") return "due today";
  return b === "overdue" ? `overdue · ${t.due}` : `due ${t.due}`;
}

/**
 * Task rows with Done / Skip (or Reopen once closed). Writes go through
 * /api/tasks, then the server page re-renders.
 */
export function TaskList({ tasks, today, showCompany = false }: { tasks: Task[]; today: string; showCompany?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function setStatus(num: number, status: string) {
    setBusy(num);
    setError("");
    try {
      const res = await fetch("/api/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ num, status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(typeof body?.error === "string" ? body.error : "Could not update the task.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not update the task.");
    } finally {
      setBusy(null);
    }
  }

  if (tasks.length === 0) return null;
  return (
    <>
      <ul className="divide-y divide-border rounded-xl border border-border bg-background/40">
        {tasks.map((t) => {
          const link = notesLink(t.notes);
          const pending = t.status === "pending";
          const bucket = pending ? dueBucket(t, today) : "undated";
          return (
            <li key={t.num} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${pending ? "text-foreground" : "text-muted line-through"}`}>{t.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                  <span className={DUE_TONE[bucket]}>{dueLabel(t, today)}</span>
                  <span className="font-mono text-faint">{t.type}</span>
                  {showCompany && (t.app || t.company) && (
                    t.app ? (
                      <Link href={`/pipeline/${t.app}`} className="text-muted hover:text-brand-text hover:underline">
                        {t.company || `#${t.app}`} <span className="text-faint">#{t.app}</span>
                      </Link>
                    ) : (
                      <span className="text-muted">{t.company}</span>
                    )
                  )}
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                      {t.notes.replace(/^https?:\/\//, "")} <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    t.notes && <span className="text-muted">{t.notes}</span>
                  )}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5">
                {busy === t.num && <Loader2 className="size-3.5 text-faint motion-safe:animate-spin" />}
                {pending ? (
                  <>
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => setStatus(t.num, "done")}
                      className={`${PILL} border-emerald-500/40 text-emerald-800 hover:bg-emerald-500/10 dark:text-emerald-400`}
                    >
                      <Check className="size-3.5" /> Done
                    </button>
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => setStatus(t.num, "skipped")}
                      className={`${PILL} border-border text-muted hover:border-brand/40 hover:text-brand-text`}
                    >
                      <SkipForward className="size-3.5" /> Skip
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={busy != null}
                    onClick={() => setStatus(t.num, "pending")}
                    className={`${PILL} border-border text-muted hover:border-brand/40 hover:text-brand-text`}
                  >
                    <Undo2 className="size-3.5" /> Reopen
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>}
    </>
  );
}
