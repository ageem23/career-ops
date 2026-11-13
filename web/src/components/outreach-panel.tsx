"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ListPlus, Loader2, TriangleAlert, Users } from "lucide-react";
import { DeepPromptActions, type PromptActionLabels } from "@/components/deep-prompt-actions";
import { TaskList } from "@/components/tasks/task-list";
import { parseAddTaskCommands } from "@/lib/contacto-prompt.mjs";
import { compareTasks, type Task } from "@/lib/tasks.mjs";

const CONTACTO_LABELS: PromptActionLabels = {
  copy: "Copy contacto prompt",
  copyTitle: "Copy the contacto research prompt for this application",
  open: "Find contacts in Claude",
  noun: "Contacto prompt",
  fallback: "“Show the prompt” in the Outreach card",
};

/** Opens the Claude desktop app on a new chat with the prompt prefilled. */
const CLAUDE_DESKTOP_URL = "claude://claude.ai/new?q={prompt}";

/**
 * Paste Claude's contacto reply (or only its `node add-task.mjs` block). The
 * commands are parsed here and never run: the candidate sees each task and
 * picks which to add to data/tasks.md.
 */
function TaskPaste({ n }: { n: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const parsed = useMemo(() => parseAddTaskCommands(text), [text]);
  const appNum = Number(n);
  // A command with neither --app nor --company belongs to this application.
  const tasks = parsed.tasks.map((t) => (t.app == null && !t.company ? { ...t, app: appNum } : t));
  const chosen = tasks.filter((_, i) => !skip.has(i));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosen.length || busy) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: chosen.map(({ line: _line, ...t }) => t) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : "Could not add the tasks.");
        return;
      }
      const added = Array.isArray(body?.added) ? body.added.length : 0;
      const dupes = Number(body?.duplicates) || 0;
      setDone(`Added ${added} task${added === 1 ? "" : "s"}${dupes ? ` · ${dupes} already tracked` : ""}.`);
      setText("");
      setSkip(new Set());
      router.refresh();
    } catch {
      setError("Could not add the tasks.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add tasks from Claude's reply" className="mt-2">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSkip(new Set());
          setDone("");
        }}
        rows={6}
        placeholder="Paste Claude's whole reply, or just its node add-task.mjs block. Nothing is run; each command becomes a task you can review first."
        className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground focus:border-brand/50 focus:outline-none"
      />
      {text.trim() && tasks.length === 0 && parsed.errors.length === 0 && (
        <p className="mt-1 text-xs text-muted">No add-task.mjs commands found in the pasted text.</p>
      )}
      {tasks.length > 0 && (
        <ul className="mt-2 space-y-1">
          {tasks.map((t, i) => (
            <li key={i}>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={!skip.has(i)}
                  onChange={() =>
                    setSkip((s) => {
                      const next = new Set(s);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
                <span>
                  <span className="text-foreground">{t.title}</span>
                  <span className="ml-2 text-xs text-muted">
                    {t.due ? `due ${t.due}` : "no due date"}
                    {t.notes && ` · ${t.notes}`}
                    {t.app != null && t.app !== appNum && (
                      <span className="text-amber-800 dark:text-amber-400"> · for application #{t.app}</span>
                    )}
                    {t.app == null && t.company && ` · ${t.company}`}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {parsed.errors.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <p className="inline-flex items-center gap-1 font-medium text-amber-800 dark:text-amber-400">
            <TriangleAlert className="size-3.5" /> {parsed.errors.length} command{parsed.errors.length === 1 ? "" : "s"} skipped
          </p>
          <ul className="mt-1 space-y-0.5 text-muted">
            {parsed.errors.map((e, i) => (
              <li key={i} className="break-all">
                {e.error}: <span className="font-mono">{e.line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!chosen.length || busy}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 disabled:opacity-60 max-sm:min-h-[44px]"
        >
          {busy ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <ListPlus className="size-3.5" />}
          {chosen.length ? `Add ${chosen.length} task${chosen.length === 1 ? "" : "s"}` : "Add tasks"}
        </button>
        {done && (
          <span role="status" className="text-xs text-muted">
            {done}{" "}
            <Link href="/tasks" className="text-brand-text hover:underline">
              All tasks
            </Link>
          </span>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>}
    </form>
  );
}

/**
 * The application page's outreach card: the contacto research prompt (once the
 * application has gone out), the tasks its reply produced, and the paste box
 * that adds them.
 */
export function OutreachPanel({
  n,
  prompt,
  claudeUrl = CLAUDE_DESKTOP_URL,
  tasks,
  today,
}: {
  n: string;
  prompt: string;
  claudeUrl?: string;
  tasks: Task[];
  today: string;
}) {
  const open = tasks.filter((t) => t.status === "pending").sort(compareTasks);
  const closed = tasks.filter((t) => t.status !== "pending").sort((a, b) => b.num - a.num);
  return (
    <section className="mt-6 rounded-2xl border border-border bg-surface/40 px-5 py-4 print:hidden" aria-labelledby="outreach-heading">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="size-4 text-brand-text" />
        <h2 id="outreach-heading" className="text-sm font-medium text-foreground">Outreach</h2>
        {open.length > 0 && <span className="text-xs text-muted">{open.length} open task{open.length === 1 ? "" : "s"}</span>}
      </div>

      {prompt && (
        <>
          <p className="mt-2 text-sm text-muted">
            Have Claude find the hiring manager, recruiter and peers for this role and draft connection messages. Its reply ends
            with an add-task block; paste it below to track each contact.
          </p>
          <div className="mt-3">
            <DeepPromptActions prompt={prompt} claudeUrl={claudeUrl} labels={CONTACTO_LABELS} />
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-brand-text">Show the prompt</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background/60 p-3 font-mono text-xs text-foreground">
              {prompt}
            </pre>
          </details>
        </>
      )}

      {open.length > 0 && (
        <div className="mt-4">
          <TaskList tasks={open} today={today} />
        </div>
      )}
      {closed.length > 0 && (
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-brand-text">
            Closed tasks ({closed.length})
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2">
            <TaskList tasks={closed} today={today} />
          </div>
        </details>
      )}

      <details className="group mt-4" open={tasks.length === 0 && !!prompt}>
        <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-foreground hover:text-brand-text">
          Add tasks from Claude&apos;s reply
          <ChevronDown className="size-4 text-faint transition-transform group-open:rotate-180" />
        </summary>
        <TaskPaste n={n} />
      </details>
    </section>
  );
}
