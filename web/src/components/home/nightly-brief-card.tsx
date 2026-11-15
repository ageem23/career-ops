import Link from "next/link";
import { CircleAlert, CircleCheck, Moon, TriangleAlert } from "lucide-react";
import AssistantMarkdown from "@/components/assistant-markdown";
import type { BriefItem, LatestBrief } from "@/lib/nightly-brief-server";

// "Check last night's batch run", answered on the Today page. The 04:00 nightly
// job writes the brief (morning-brief.mjs): facts from the run logs, batch state,
// reports and tracker, plus a short Claude summary of them. This only renders it.

const STATUS = {
  ok: { Icon: CircleCheck, label: "Clean run", tone: "text-emerald-700 dark:text-emerald-400" },
  attention: { Icon: TriangleAlert, label: "Check", tone: "text-amber-700 dark:text-amber-400" },
  problem: { Icon: CircleAlert, label: "Needs you", tone: "text-red-700 dark:text-red-400" },
} as const;

const plain = (s: string | null | undefined) => (s ?? "").replace(/\*\*/g, "").trim();

function itemHref(r: BriefItem): string | null {
  const n = r.trackerRow ?? (r.report ? Number(r.report) : null);
  return n ? `/pipeline/${n}` : null;
}

function ItemRow({ r }: { r: BriefItem }) {
  const href = itemHref(r);
  const who = (
    <>
      <span className="font-medium text-foreground">{r.company || "?"}</span>
      {r.role && <span className="text-muted"> · {r.role}</span>}
    </>
  );
  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span className="w-8 shrink-0 font-mono text-xs tabular-nums text-brand-text">{r.score != null ? r.score.toFixed(1) : "—"}</span>
      <span className="min-w-0 flex-1">
        {href ? <Link href={href} className="hover:underline">{who}</Link> : who}
        {r.reEvaluated && <span className="text-xs text-faint"> · re-evaluation of #{r.reEvaluated.trackerRow}</span>}
        {r.verdict && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{plain(r.verdict)}</span>}
      </span>
    </li>
  );
}

export function NightlyBriefCard({ latest }: { latest: LatestBrief }) {
  const { brief, freshness } = latest;
  const s = STATUS[brief.status] ?? STATUS.attention;
  const errors = brief.issues.filter((i) => i.level === "error");
  const warns = brief.issues.filter((i) => i.level === "warn");
  const dateLabel = new Date(`${brief.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <section aria-labelledby="nightly-brief-title" className="mt-6 rounded-2xl border border-border bg-surface/40 px-5 py-5 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <Moon className="size-4 text-brand-text" />
        <h2 id="nightly-brief-title" className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">Last night&apos;s batch</h2>
        <span className="text-xs text-faint">· {dateLabel}</span>
        <span className={`ml-auto inline-flex items-center gap-1 text-xs font-medium ${s.tone}`}>
          <s.Icon className="size-3.5" /> {s.label}
        </span>
      </div>

      {!freshness.current && (
        <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          No brief was written this morning; this is the latest one
          {freshness.daysOld ? `, from ${freshness.daysOld} day${freshness.daysOld === 1 ? "" : "s"} ago` : ""}. The 04:00 job may not have run or finished.
        </p>
      )}

      <p className="mt-2 text-base font-medium text-foreground">{brief.headline}</p>

      {brief.summary?.text ? (
        <div className="report-prose mt-3 text-sm text-muted [&_*]:my-1.5 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
          <AssistantMarkdown text={brief.summary.text} />
        </div>
      ) : brief.summary?.error ? (
        <p className="mt-2 text-xs text-faint">The written summary failed ({brief.summary.error.slice(0, 160)}); the facts below are complete.</p>
      ) : null}

      {errors.length > 0 && (
        <ul className="mt-4 grid gap-1.5">
          {errors.slice(0, 5).map((i, k) => (
            <li key={k} className="flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> <span className="min-w-0 break-words">{i.text}</span>
            </li>
          ))}
          {errors.length > 5 && <li className="text-xs text-faint">+{errors.length - 5} more under Details</li>}
        </ul>
      )}

      <div className="mt-4">
        <h3 className="mb-2 text-xs font-medium text-faint">Worth a look (4.0+)</h3>
        {brief.topPicks.length ? (
          <ul className="grid gap-2">{brief.topPicks.map((r) => <ItemRow key={r.report ?? r.batchId} r={r} />)}</ul>
        ) : (
          <p className="text-sm text-muted">Nothing scored 4.0 or higher last night.</p>
        )}
      </div>

      <details className="group mt-4">
        <summary className="cursor-pointer text-xs font-medium text-muted hover:text-brand-text max-sm:min-h-[44px]">Details</summary>
        <div className="mt-3 grid gap-4">
          {brief.nextBest.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-medium text-faint">Next best</h3>
              <ul className="grid gap-2">{brief.nextBest.map((r) => <ItemRow key={r.report ?? r.batchId} r={r} />)}</ul>
            </div>
          )}
          {(errors.length > 5 || warns.length > 0) && (
            <div>
              <h3 className="mb-2 text-xs font-medium text-faint">Other things to check</h3>
              <ul className="grid gap-1.5 text-sm text-muted">
                {[...errors.slice(5), ...warns].map((i, k) => (
                  <li key={k} className="flex items-start gap-1.5">
                    {i.level === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-red-700 dark:text-red-400" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-400" />}
                    <span className="min-w-0 break-words">{i.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {brief.notCompleted.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-medium text-faint">Did not complete</h3>
              <ul className="grid gap-1.5 text-sm text-muted">
                {brief.notCompleted.map((r) => (
                  <li key={r.batchId ?? r.report} className="break-words">
                    <span className="text-foreground">{r.company || "?"}</span>
                    {r.role && <> · {r.role}</>} — {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className="mb-2 text-xs font-medium text-faint">Runs</h3>
            <ul className="grid gap-1 text-sm text-muted">
              {brief.runs.map((r) => (
                <li key={r.key}>
                  {r.ran ? (r.finished ? "✅" : "❌") : "❌"} {r.label}:{" "}
                  {!r.ran
                    ? "did not run"
                    : [
                        r.finished ? `finished ${r.finishedAt}` : "did not finish",
                        r.scan?.added != null ? `${r.scan.added} new offers found` : null,
                        r.imported != null ? `imported ${r.imported} of ${r.pendingSeen} pending` : null,
                      ].filter(Boolean).join(", ")}
                </li>
              ))}
            </ul>
            {brief.counts.pendingLeft ? <p className="mt-1 text-xs text-faint">{brief.counts.pendingLeft} offer(s) still waiting in the pipeline.</p> : null}
          </div>
          {brief.health.ran && (
            <p className="text-xs text-faint">
              Tracker health check:{" "}
              {brief.health.baseline
                ? "baseline recorded; later briefs list only new warnings."
                : brief.health.newWarningCount
                  ? `${brief.health.newWarningCount} new warning(s), ${brief.health.recurringCount} recurring.`
                  : `no new warnings (${brief.health.recurringCount} recurring).`}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
