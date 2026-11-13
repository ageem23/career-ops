"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, FileUp, Loader2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useJobs, type Job } from "@/components/jobs/job-store";

const PILL =
  "inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px] disabled:cursor-not-allowed disabled:opacity-60";
const QUIET = `${PILL} border-border text-muted hover:border-brand/40 hover:text-brand-text`;

function useReviewJob(n: string): Job | undefined {
  const { jobs } = useJobs();
  return useMemo(
    () => jobs.filter((j) => j.kind === "research-review" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
}

function startReview(startJob: ReturnType<typeof useJobs>["startJob"], n: string, company: string) {
  return startJob({
    title: `Research review · ${company}`,
    subtitle: "compare the deep research with the evaluation",
    kind: "research-review",
    input: n,
    page: `/pipeline/${n}`,
  });
}

/**
 * Paste (or drop a .md file of) the deep research. Saving files it under
 * interview-prep/, links it from the report, and starts the review run.
 */
export function ResearchPaste({ n, company, replace = false }: { n: string; company: string; replace?: boolean }) {
  const router = useRouter();
  const { startJob } = useJobs();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function readFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
    e.target.value = "";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, markdown: text }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : "Could not save the research.");
        return;
      }
      setText("");
      startReview(startJob, n, company);
      router.refresh();
    } catch {
      setError("Could not save the research.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Deep research" className="mt-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={replace ? 6 : 8}
        placeholder="Paste the research here (in Claude, use the Copy button under the answer), or load the .md file you downloaded."
        className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground focus:border-brand/50 focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!text.trim() || busy}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 disabled:opacity-60 max-sm:min-h-[44px]"
        >
          {busy ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Check className="size-3.5" />}
          {replace ? "Replace and review" : "Save and review"}
        </button>
        <label className={`${QUIET} cursor-pointer`}>
          <FileUp className="size-3.5" /> Load .md file
          <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={readFile} className="sr-only" />
        </label>
        <span className="text-xs text-muted">
          Saved to interview-prep/, then reviewed against this report and cv.md. Changes wait for your approval.
        </span>
      </div>
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>}
    </form>
  );
}

/** Review run state: running link, failure, or a re-run button. Refreshes the page when a run finishes. */
export function ResearchReviewStatus({ n, company, hasReview }: { n: string; company: string; hasReview: boolean }) {
  const router = useRouter();
  const { startJob } = useJobs();
  const job = useReviewJob(n);
  const refreshed = useRef<string | null>(null);

  useEffect(() => {
    if (job?.status === "done" && refreshed.current !== job.id) {
      refreshed.current = job.id;
      router.refresh();
    }
  }, [job, router]);

  if (job?.status === "running") {
    return (
      <Link href={`/jobs/${job.id}`} className={`${PILL} border-brand/40 bg-brand-soft text-brand-text`}>
        <Loader2 className="size-3.5 motion-safe:animate-spin" /> Reviewing research…
      </Link>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => startReview(startJob, n, company)} className={QUIET} title="Compare the research with the evaluation again">
        <RotateCcw className="size-3.5" /> {hasReview ? "Review again" : "Run review"}
      </button>
      {job && (job.status === "error" || job.status === "gated") && (
        <Link href={`/jobs/${job.id}`} role="alert" className="inline-flex items-center gap-1 text-xs text-red-700 hover:underline dark:text-red-400">
          <TriangleAlert className="size-3.5" /> Last review failed. Open the run log.
        </Link>
      )}
    </span>
  );
}

export type ProposalView = {
  id: string;
  type: "score" | "status" | "note" | "report-update";
  label: string;
  detail?: string;
  reason: string;
  state: "pending" | "applied" | "dismissed";
  error?: string;
};

/** One approve/dismiss row per proposed evaluation update. */
export function ResearchProposals({ n, proposals }: { n: string; proposals: ProposalView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [allMessage, setAllMessage] = useState("");
  const pending = proposals.filter((p) => p.state === "pending");
  // A score goes through merge-tracker.mjs, which reads every tracked report.
  const slow = (busy === "all" && pending.some((p) => p.type === "score")) || proposals.some((p) => p.id === busy && p.type === "score");

  async function applyAll() {
    setBusy("all");
    setAllMessage("");
    setErrors({});
    try {
      const res = await fetch("/api/research/proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, action: "apply-all" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) setAllMessage(typeof body?.error === "string" ? body.error : "That did not work.");
      else if (body?.failed > 0) {
        setAllMessage(`${body.applied} applied, ${body.failed} not applied. The reason is shown under each one; you can try it again.`);
      }
      router.refresh();
    } catch {
      setAllMessage("That did not work.");
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, action: "apply" | "dismiss") {
    setBusy(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch("/api/research/proposal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, id, action }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) setErrors((e) => ({ ...e, [id]: typeof body?.error === "string" ? body.error : "That did not work." }));
      router.refresh();
    } catch {
      setErrors((e) => ({ ...e, [id]: "That did not work." }));
    } finally {
      setBusy(null);
    }
  }

  if (proposals.length === 0) {
    return <p className="mt-3 text-sm text-muted">The review proposes no changes to the evaluation.</p>;
  }
  return (
    <div className="mt-3">
      {(pending.length > 1 || slow || allMessage) && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {pending.length > 1 && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={applyAll}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 disabled:opacity-60 max-sm:min-h-[44px]"
            >
              {busy === "all" ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Check className="size-3.5" />}
              Apply all ({pending.length})
            </button>
          )}
          {slow && <span className="text-xs text-muted">Updating the tracker can take up to a minute.</span>}
          {allMessage && !busy && <p role="alert" className="w-full text-xs text-red-700 dark:text-red-400">{allMessage}</p>}
        </div>
      )}
    <ul className="space-y-2">
      {proposals.map((p) => (
        <li key={p.id} className="rounded-xl border border-border bg-background/60 px-4 py-3">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{p.label}</p>
              {p.reason && <p className="mt-0.5 text-xs text-muted">{p.reason}</p>}
              {p.detail && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-brand-text">Show the text</summary>
                  <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-surface p-2 text-xs text-foreground">{p.detail}</pre>
                </details>
              )}
            </div>
            {p.state === "pending" ? (
              <span className="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => decide(p.id, "apply")}
                  className={`${PILL} border-brand/40 bg-brand-soft text-brand-text hover:bg-brand-soft/70`}
                >
                  {busy === p.id || (busy === "all" && p.state === "pending") ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Check className="size-3.5" />} Apply
                </button>
                <button type="button" disabled={busy !== null} onClick={() => decide(p.id, "dismiss")} className={QUIET}>
                  <X className="size-3.5" /> Dismiss
                </button>
              </span>
            ) : (
              <span className={`text-xs ${p.state === "applied" ? "text-emerald-800 dark:text-emerald-400" : "text-faint"}`}>
                {p.state === "applied" ? "Applied" : "Dismissed"}
              </span>
            )}
          </div>
          {(errors[p.id] || p.error) && p.state === "pending" && (
            <p className="mt-1 text-xs text-red-700 dark:text-red-400">{errors[p.id] || p.error}</p>
          )}
        </li>
      ))}
    </ul>
    </div>
  );
}
