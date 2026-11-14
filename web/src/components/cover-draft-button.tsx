"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FileText, Loader2, Mail, RotateCcw, TriangleAlert } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CoverBriefForm, type CoverFormState } from "@/components/cover-brief-form";
import { coverDraftButtonState } from "@/lib/pdf-button-state.mjs";
import { pipelineQuery } from "@/lib/pipeline-navigation.mjs";

// Fires the real career-ops `cover` mode (worker kind "cover") for THIS
// application. cover.md will not draft until the candidate answers its four
// Step 6 prompts, so the button opens those questions first, with options from
// a `cover-suggest` run when one has been made (cover-brief-form.tsx). The draft
// lands in the run log. Rendering it to PDF is still the CLI's Step 9.

export function CoverDraftButton({ n, company }: { n: string; company: string }) {
  const { jobs, startJob } = useJobs();
  const listQuery = pipelineQuery(useSearchParams().toString());
  const jobQuery = listQuery ? `?${listQuery}` : "";
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<CoverFormState | null>(null);
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "cover" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  const state = coverDraftButtonState(job);

  const submit = (brief: Record<string, string>, formState: CoverFormState) => {
    setSaved(formState);
    startJob({ title: `Cover letter · ${company}`, subtitle: "draft for this role", kind: "cover", input: n, page: `/pipeline/${n}`, brief });
    setOpen(false);
  };

  if (state.kind === "running")
    return (
      <Link href={`/jobs/${state.jobId}${jobQuery}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand-text max-sm:min-h-[44px]">
        <Loader2 className="size-3.5 motion-safe:animate-spin" /> Drafting cover letter…
      </Link>
    );

  return (
    <>
      {state.kind === "ready" && job ? (
        <span className="inline-flex items-center gap-1">
          <Link
            href={`/jobs/${job.id}${jobQuery}`}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-800 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400 max-sm:min-h-[44px]"
          >
            <FileText className="size-3.5" /> View cover letter draft
          </Link>
          <button
            onClick={() => setOpen((o) => !o)}
            title="Draft the cover letter again"
            aria-expanded={open}
            className="inline-flex items-center justify-center rounded-full p-1 text-faint transition-colors hover:text-brand-text max-sm:min-h-[44px] max-sm:min-w-[44px]"
          >
            <RotateCcw className="size-3" />
          </button>
        </span>
      ) : (
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand-text max-sm:min-h-[44px]"
          title="Draft a cover letter for this role with your AI CLI"
        >
          <Mail className="size-3.5" /> Draft cover letter
        </button>
      )}
      {state.failure && (
        <Link
          href={`/jobs/${state.failure.jobId}${jobQuery}`}
          role="alert"
          title="Open the run log"
          className="inline-flex max-w-md items-start gap-1 text-xs text-red-700 hover:underline dark:text-red-400"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>Cover letter not drafted. {state.failure.reason}</span>
        </Link>
      )}
      {open && <CoverBriefForm n={n} company={company} initial={saved} onSubmit={submit} onCancel={(formState) => { setSaved(formState); setOpen(false); }} />}
    </>
  );
}
