import { ChevronDown, FlaskConical } from "lucide-react";
import { ReportMarkdown } from "@/components/report-markdown";
import { ResearchPaste, ResearchProposals, ResearchReviewStatus, type ProposalView } from "@/components/research-controls";
import type { Proposal, ReviewSidecar } from "@/lib/research-server";

function proposalView(p: Proposal, currentScore: string): ProposalView {
  const base = { id: p.id, type: p.type, reason: p.reason, state: p.state, error: p.error };
  if (p.type === "score") {
    return { ...base, label: `Change the score${currentScore ? ` from ${currentScore}` : ""} to ${p.to.toFixed(1)}/5` };
  }
  if (p.type === "status") return { ...base, label: `Set the status to ${p.to}` };
  if (p.type === "note") return { ...base, label: `Add a tracker note: “${p.text}”` };
  return { ...base, label: "Add a Research Update section to the report", detail: p.markdown };
}

/**
 * The report page's deep-research card: a paste box until research is filed,
 * then the review's comparison, CV-claim flags and proposed updates, with the
 * full research collapsed below.
 */
export function ResearchPanel({
  n,
  company,
  currentScore,
  researchRel,
  research,
  review,
}: {
  n: string;
  company: string;
  currentScore: string;
  researchRel: string | null;
  research: string | null;
  review: ReviewSidecar | null;
}) {
  return (
    <section className="mt-6 rounded-2xl border border-border bg-surface/40 px-5 py-4 print:hidden" aria-labelledby="deep-research-heading">
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="size-4 text-brand-text" />
        <h2 id="deep-research-heading" className="text-sm font-medium text-foreground">Deep research</h2>
        {researchRel && <span className="truncate font-mono text-xs text-faint">{researchRel}</span>}
        {research != null && (
          <span className="ml-auto">
            <ResearchReviewStatus n={n} company={company} hasReview={review != null} />
          </span>
        )}
      </div>

      {research == null ? (
        <ResearchPaste n={n} company={company} />
      ) : (
        <>
          {review ? (
            <>
              {review.bottomLine && <p className="mt-3 text-[15px] leading-relaxed text-foreground">{review.bottomLine}</p>}
              <div className="report-prose mt-3">
                <ReportMarkdown>{review.changesMarkdown}</ReportMarkdown>
              </div>
              {review.cvFlags.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-400">Not in cv.md — confirm before using</p>
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                    {review.cvFlags.map((f, i) => (
                      <li key={i}>
                        <span className="font-medium text-foreground">{f.claim}</span> — {f.why}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <h3 className="mt-4 text-xs font-medium uppercase tracking-[0.14em] text-faint">Proposed updates · reviewed {review.reviewedAt}</h3>
              <ResearchProposals n={n} proposals={review.proposals.map((p) => proposalView(p, currentScore))} />
            </>
          ) : (
            <p className="mt-3 text-sm text-muted">
              Research filed. The review compares it with this report and cv.md, then lists proposed updates here for you to approve.
            </p>
          )}

          <details className="group mt-4 overflow-hidden rounded-xl border border-border bg-background/40">
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-surface-hover">
              Full research
              <ChevronDown className="ml-auto size-4 text-faint transition-transform group-open:rotate-180" />
            </summary>
            <div className="report-prose border-t border-border px-4 py-3">
              <ReportMarkdown>{research}</ReportMarkdown>
            </div>
          </details>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted hover:text-brand-text">Replace the research</summary>
            <ResearchPaste n={n} company={company} replace />
          </details>
        </>
      )}
    </section>
  );
}
