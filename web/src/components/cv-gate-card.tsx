"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, FileCheck2, Loader2, Pencil, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";

// A tailored CV the content gates refused, turned into decisions instead of
// an error (see cv-gate.mjs). One row per flagged line; the three ways out are
// Claude rewords it (the default), the candidate allows the wording, or the
// candidate edits the line. Nothing here writes the CV's source facts.

export type GateRowView = {
  id: string;
  kind: string;
  line: string;
  words: string[];
  source: string | null;
  why: string;
  allow: { label: string } | null;
  editable: boolean;
  state: "pending" | "allowed" | "edited";
};

const PILL =
  "inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px] disabled:cursor-not-allowed disabled:opacity-60";
const QUIET = `${PILL} border-border text-muted hover:border-brand/40 hover:text-brand-text`;
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 disabled:opacity-60 max-sm:min-h-[44px]";

/** The line with each flagged word in bold, so the reason is visible at a glance. */
function Marked({ line, words }: { line: string; words: string[] }) {
  const wanted = words.filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!wanted.length) return <>{line}</>;
  const parts = line.split(new RegExp(`(${wanted.join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <strong key={i} className="font-semibold text-foreground underline decoration-amber-500 decoration-2 underline-offset-2">{part}</strong> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}

export function CvGateCard({ n, company, error, rows }: { n: string; company: string; error: string; rows: GateRowView[] | null }) {
  const router = useRouter();
  const { jobs, startJob } = useJobs();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const job = useMemo(
    () => jobs.filter((j) => j.kind === "pdf" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  const running = job?.status === "running";
  // A pdf run that ends (either way) rewrites or clears the kept CV: reload it.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) router.refresh();
    wasRunning.current = running;
  }, [running, router]);

  const pending = rows?.filter((r) => r.state === "pending") ?? [];
  const changed = rows?.some((r) => r.state !== "pending") ?? false;
  const count = rows ? pending.length : null;
  // An over-length CV passed every wording check; only its length is in question.
  const pagesOnly = !!rows?.length && rows.every((r) => r.kind === "pages");

  async function post(action: string, extra: Record<string, string> = {}) {
    setBusy(extra.id ? `${action}:${extra.id}` : action);
    setMessage("");
    try {
      const res = await fetch("/api/cv-gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, action, ...extra }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(typeof body?.error === "string" ? body.error : "That did not work.");
        return false;
      }
      if (action === "render") {
        setMessage(body?.rendered ? "" : "The CV was checked again and some lines still need your call.");
        if (body?.rendered) window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: "pdf", input: n } }));
      }
      router.refresh();
      return true;
    } catch {
      setMessage("That did not work.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  const reword = () =>
    startJob({
      title: `CV PDF · ${company}`,
      subtitle: "repair: rewording the lines the CV checks flagged",
      kind: "pdf",
      input: n,
      page: `/pipeline/${n}`,
      brief: { repair: "fact-check" },
    });

  const disabled = busy !== null || running;

  return (
    <section aria-labelledby={`cv-gate-${n}`} className="mt-4 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
      <h2 id={`cv-gate-${n}`} className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <TriangleAlert className="size-4 text-amber-800 dark:text-amber-400" />
        {count === null
          ? "Your tailored CV wasn't saved: the CV checks flagged its wording"
          : count === 0
            ? "Your changes are ready: render the CV to save it"
            : pagesOnly
              ? "Your tailored CV wasn't saved: it's longer than your page limit"
              : `Your tailored CV wasn't saved: ${count} ${count === 1 ? "line needs" : "lines need"} your call`}
      </h2>
      <p className="mt-1 text-xs text-muted">
        {pagesOnly
          ? "It passed the wording and fact checks. Allow the longer CV, or have Claude trim it to fit."
          : "The checks keep a CV in your own words and facts. Have Claude reword the flagged lines, or decide each one yourself below."}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {running ? (
          <Link href={`/jobs/${job!.id}`} className={`${PILL} border-brand/40 bg-brand-soft text-brand-text`}>
            <Loader2 className="size-3.5 motion-safe:animate-spin" /> {pagesOnly ? "Claude is trimming the CV…" : "Claude is rewording the flagged lines…"}
          </Link>
        ) : pagesOnly ? (
          // Trimming cuts content the candidate chose, so it is not the default.
          <button type="button" onClick={reword} disabled={disabled || pending.length === 0} className={QUIET}>
            <Sparkles className="size-3.5" /> Have Claude trim it to fit
          </button>
        ) : (
          <button type="button" onClick={reword} disabled={disabled || (rows !== null && pending.length === 0)} className={PRIMARY}>
            <Sparkles className="size-3.5" /> Reword with Claude (Recommended)
          </button>
        )}
        {changed && (
          <button type="button" onClick={() => post("render")} disabled={disabled} className={`${PILL} border-brand/40 bg-brand-soft text-brand-text hover:bg-brand-soft/70`}>
            {busy === "render" ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <FileCheck2 className="size-3.5" />}
            Render with my changes
          </button>
        )}
        <button type="button" onClick={() => post("discard")} disabled={disabled} className={QUIET} title="Drop this refused CV">
          <Trash2 className="size-3.5" /> Discard
        </button>
        {busy === "render" && <span className="text-xs text-muted">Checking and rendering, about a minute…</span>}
      </div>
      {message && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{message}</p>}

      {rows === null ? (
        <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-surface p-3 text-xs text-foreground">{error}</pre>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-xl border border-border bg-background/70 px-4 py-3">
              {row.line ? (
                <p className="text-sm text-foreground">
                  “<Marked line={row.line} words={row.words} />”
                </p>
              ) : row.kind === "pages" ? null : (
                <p className="text-sm text-foreground">Flagged: {row.words.map((w) => `“${w}”`).join(", ")}</p>
              )}
              <p className="mt-1 text-xs text-muted">{row.why}</p>
              {row.source && <p className="mt-1 text-xs text-muted">Closest line in your sources: “{row.source}”</p>}
              {!row.allow && row.state === "pending" && row.kind !== "voice" && row.kind !== "pages" && (
                <p className="mt-1 text-xs text-muted">If this is true, add it to cv.md first, then generate the CV again.</p>
              )}

              {editing === row.id ? (
                <div className="mt-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    aria-label="Your wording for this line"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-brand/50 focus:outline-none"
                  />
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={disabled || !draft.trim()}
                      onClick={async () => {
                        if (await post("edit", { id: row.id, text: draft })) setEditing(null);
                      }}
                      className={`${PILL} border-brand/40 bg-brand-soft text-brand-text`}
                    >
                      {busy === `edit:${row.id}` ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Check className="size-3.5" />} Save this line
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className={QUIET}>
                      <X className="size-3.5" /> Cancel
                    </button>
                  </div>
                </div>
              ) : row.state === "pending" ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {row.allow && (
                    <button type="button" disabled={disabled} onClick={() => post("allow", { id: row.id })} className={QUIET}>
                      {busy === `allow:${row.id}` ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Check className="size-3.5" />} {row.allow.label}
                    </button>
                  )}
                  {row.editable && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setEditing(row.id);
                        setDraft(row.line);
                      }}
                      className={QUIET}
                    >
                      <Pencil className="size-3.5" /> Edit the line myself
                    </button>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-xs text-emerald-800 dark:text-emerald-400">
                  {row.state === "edited"
                    ? "Edited. Your wording replaces this line."
                    : row.kind === "pages"
                      ? "Allowed. cv.max_pages is updated in config/profile.yml. Render to save the CV."
                      : "Allowed. Added to config/cv-facts.json."}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
