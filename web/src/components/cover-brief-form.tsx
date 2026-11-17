"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Check, Loader2, Mail, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";
import { COVER_TONES } from "@/lib/cover-tones.mjs";
import { answerSource, cardLabel, joinPicked, type CoverSuggestions, type Suggestion } from "@/lib/cover-suggest.mjs";

// The four Step 6 questions of modes/cover.md, with the options a
// `cover-suggest` run found (cover-suggest.mjs). Every answer stays a plain,
// editable text box: a card only fills it in, so the candidate can pick, edit,
// or ignore the suggestions entirely.

type Field = "why" | "problem" | "approach";
type Answer = { value: string; picked: string[] };
export type CoverFormState = {
  answers: Record<Field, Answer>;
  tone: keyof typeof COVER_TONES;
  toneTouched: boolean;
  gaps: Record<number, { choice: string; own: string }>;
  research: string | null;
};

const QUESTIONS: { name: Field; label: string; hint: string; max: number }[] = [
  { name: "why", label: "Why this role or company?", hint: "Pick one or two angles, or write your own.", max: 2 },
  { name: "problem", label: "What problem would you solve for them?", hint: "Pick the framing that matches what you want to address, then refine it.", max: 1 },
  { name: "approach", label: "How would you approach it on day one?", hint: "One or two sentences. This is the most specific part of the letter, so make it yours.", max: 1 },
];
const OWN = "__own";

const fieldClass =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-brand/50 focus:outline-none";

function emptyState(): CoverFormState {
  const blank = (): Answer => ({ value: "", picked: [] });
  return { answers: { why: blank(), problem: blank(), approach: blank() }, tone: "mirror", toneTouched: false, gaps: {}, research: null };
}

type Loaded = { suggestions: CoverSuggestions | null; stale: boolean; createdAt: string | null };

export function CoverBriefForm({
  n,
  company,
  initial,
  onSubmit,
  onCancel,
}: {
  n: string;
  company: string;
  initial: CoverFormState | null;
  onSubmit: (brief: Record<string, string>, state: CoverFormState) => void;
  onCancel: (state: CoverFormState) => void;
}) {
  const { jobs, startJob } = useJobs();
  const [state, setState] = useState<CoverFormState>(() => initial ?? emptyState());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState(false);

  const suggestJob = useMemo(
    () => jobs.filter((j) => j.kind === "cover-suggest" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cover-suggestions?n=${encodeURIComponent(n)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setLoaded((await res.json()) as Loaded);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [n]);

  useEffect(() => {
    void load();
  }, [load]);

  // A suggestions run that finishes while the form is open refreshes it.
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    const key = suggestJob ? `${suggestJob.id}:${suggestJob.status}` : null;
    if (key && key !== lastSeen.current && suggestJob?.status === "done" && lastSeen.current !== null) void load();
    lastSeen.current = key ?? "";
  }, [suggestJob, load]);

  const suggestions = loaded?.suggestions ?? null;

  // Pre-select the recommended tone and research once, unless the candidate already chose.
  useEffect(() => {
    if (!suggestions) return;
    setState((s) => ({
      ...s,
      tone: s.toneTouched ? s.tone : suggestions.tone.recommended,
      research: s.research ?? (suggestions.research || null),
    }));
  }, [suggestions]);

  const runSuggest = () =>
    startJob({ title: `Cover angles · ${company}`, subtitle: "suggestions for the cover letter questions", kind: "cover-suggest", input: n, page: `/pipeline/${n}` });

  const toggle = (field: Field, text: string, max: number) =>
    setState((s) => {
      const cur = s.answers[field];
      const has = cur.picked.includes(text);
      let picked = has ? cur.picked.filter((p) => p !== text) : [...cur.picked, text];
      if (picked.length > max) picked = picked.slice(picked.length - max);
      // Untouched (or empty) answer: it simply mirrors the picked cards. Once the
      // candidate has typed, a new card is appended and a removed one is left in
      // their text for them to delete, so a click never discards their wording.
      const untouched = !cur.value.trim() || cur.value.trim() === joinPicked(cur.picked);
      const value = untouched ? joinPicked(picked) : has ? cur.value : `${cur.value.trimEnd()}\n${text}`;
      return { ...s, answers: { ...s.answers, [field]: { value, picked } } };
    });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const brief: Record<string, string> = { tone: state.tone };
    for (const q of QUESTIONS) {
      const a = state.answers[q.name];
      brief[q.name] = a.value;
      brief[`${q.name}From`] = answerSource(a.value, a.picked);
    }
    const gapLines = (suggestions?.gaps ?? [])
      .map((g, i) => {
        const pick = state.gaps[i];
        const answer = pick?.choice === OWN ? pick.own.trim() : pick?.choice ?? "";
        return answer ? `${g.question} -> ${answer}` : "";
      })
      .filter(Boolean);
    if (gapLines.length) brief.gaps = gapLines.join("\n");
    if (state.research?.trim()) brief.research = state.research.trim();
    onSubmit(brief, state);
  };

  return (
    <form onSubmit={submit} aria-label="Cover letter questions" className="basis-full rounded-2xl border border-border bg-surface/50 p-4">
      <SuggestStatus loaded={loaded} loadError={loadError} job={suggestJob} onRun={runSuggest} />

      {suggestions && state.research !== null && (
        <label className="mb-4 block text-sm font-medium text-foreground">
          What the research found about {company}
          <span className="block text-xs font-normal text-muted">Correct or add anything. The letter&apos;s problem section builds on this, and the draft run reuses it instead of searching again.</span>
          <textarea
            value={state.research}
            onChange={(e) => setState((s) => ({ ...s, research: e.target.value }))}
            maxLength={1500}
            rows={3}
            className={fieldClass}
          />
        </label>
      )}

      {QUESTIONS.map((q) => {
        const options = suggestions?.[q.name] ?? [];
        const answer = state.answers[q.name];
        const source = answerSource(answer.value, answer.picked);
        return (
          <fieldset key={q.name} className="mb-4">
            <legend className="text-sm font-medium text-foreground">{q.label}</legend>
            <span className="block text-xs text-muted">{q.hint}</span>
            {options.length > 0 && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {options.map((o) => (
                  <SuggestionCard key={o.text} option={o} selected={answer.picked.includes(o.text)} onClick={() => toggle(q.name, o.text, q.max)} />
                ))}
              </div>
            )}
            <textarea
              name={q.name}
              aria-label={options.length ? `${q.label} (your answer)` : q.label}
              placeholder={options.length ? "Pick a suggestion above or write your own" : undefined}
              required
              maxLength={1000}
              rows={2}
              value={answer.value}
              onChange={(e) => setState((s) => ({ ...s, answers: { ...s.answers, [q.name]: { ...s.answers[q.name], value: e.target.value } } }))}
              className={fieldClass}
            />
            {answer.value.trim() && options.length > 0 && (
              <span className="mt-0.5 block text-[11px] text-faint">
                {source === "suggested" ? "Using the suggestion as written" : source === "edited" ? "Suggestion, edited by you" : "Your own words"}
              </span>
            )}
          </fieldset>
        );
      })}

      {(suggestions?.gaps.length ?? 0) > 0 && (
        <fieldset className="mb-4">
          <legend className="text-sm font-medium text-foreground">Gaps between your profile and this posting</legend>
          <span className="block text-xs text-muted">Optional. Anything you leave unanswered stays out of the letter.</span>
          {suggestions!.gaps.map((g, i) => {
            const pick = state.gaps[i] ?? { choice: "", own: "" };
            const setPick = (p: { choice: string; own: string }) => setState((s) => ({ ...s, gaps: { ...s.gaps, [i]: p } }));
            return (
              <div key={i} className="mt-2 rounded-lg border border-border p-3">
                <p className="text-sm text-foreground">{g.question}</p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {[...g.choices, OWN].map((c) => (
                    <label key={c} className="inline-flex items-center gap-1.5 text-xs text-muted">
                      <input type="radio" name={`gap-${i}`} checked={pick.choice === c} onChange={() => setPick({ ...pick, choice: c })} />
                      {c === OWN ? "In my own words" : c}
                    </label>
                  ))}
                </div>
                {pick.choice === OWN && (
                  <textarea value={pick.own} onChange={(e) => setPick({ ...pick, own: e.target.value })} maxLength={400} rows={2} className={fieldClass} aria-label={`Your answer: ${g.question}`} />
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      <label className="mb-4 block text-sm font-medium text-foreground">
        Tone
        {suggestions?.tone.reason && (
          <span className="block text-xs font-normal text-muted">
            Suggested: {COVER_TONES[suggestions.tone.recommended]}. {suggestions.tone.reason}
          </span>
        )}
        <select
          name="tone"
          value={state.tone}
          onChange={(e) => setState((s) => ({ ...s, tone: e.target.value as keyof typeof COVER_TONES, toneTouched: true }))}
          className={fieldClass}
        >
          {Object.entries(COVER_TONES).map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 max-sm:min-h-[44px]">
          <Mail className="size-3.5" /> Draft letter
        </button>
        <CostBadge kind="spend" size="xs" />
        <button type="button" onClick={() => onCancel(state)} className="text-xs text-muted hover:text-brand-text max-sm:min-h-[44px]">
          Cancel
        </button>
      </div>
    </form>
  );
}

function SuggestionCard({ option, selected, onClick }: { option: Suggestion; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={option.text}
      className={`relative rounded-lg border p-2.5 pr-7 text-left text-sm transition-colors ${
        selected ? "border-brand/60 bg-brand-soft text-foreground" : "border-border bg-background text-foreground hover:border-brand/40"
      }`}
    >
      {selected && <Check className="absolute right-2 top-2.5 size-3.5 text-brand-text" aria-hidden />}
      <span className="block font-medium">{cardLabel(option)}</span>
      {option.evidence && <span className="mt-1 block text-[11px] text-muted">{option.evidence}</span>}
      {option.unverified.length > 0 && (
        <span className="mt-1 inline-flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
          Not in your CV: {option.unverified.join(", ")}. Check before using.
        </span>
      )}
    </button>
  );
}

function SuggestStatus({
  loaded,
  loadError,
  job,
  onRun,
}: {
  loaded: Loaded | null;
  loadError: boolean;
  job: { id: string; status: string; steps: { label: string }[] } | undefined;
  onRun: () => void;
}) {
  const box = "mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted";
  if (job?.status === "running")
    return (
      <div className={box} role="status">
        <Loader2 className="size-3.5 motion-safe:animate-spin" />
        Reading the posting and researching the company. Suggestions appear here when it finishes; you can start typing meanwhile.
        <Link href={`/jobs/${job.id}`} className="text-brand-text hover:underline">Open the run log</Link>
      </div>
    );
  if (!loaded && !loadError)
    return (
      <div className={box}>
        <Loader2 className="size-3.5 motion-safe:animate-spin" /> Loading suggestions…
      </div>
    );
  const failed = job?.status === "error" && !loaded?.suggestions;
  if (!loaded?.suggestions)
    return (
      <div className={box}>
        <Sparkles className="size-3.5 text-brand-text" />
        <span className="min-w-0 flex-1">
          Get suggested answers: reads the posting and your CV, researches the company, and offers options for each question, like the CLI does.
          {failed && (
            <Link href={`/jobs/${job!.id}`} className="ml-1 text-red-700 hover:underline dark:text-red-400">
              The last attempt failed; open the log.
            </Link>
          )}
          {loadError && <span className="ml-1 text-red-700 dark:text-red-400">Could not load saved suggestions.</span>}
        </span>
        <button type="button" onClick={onRun} className="inline-flex items-center gap-1 rounded-full border border-brand/40 px-2.5 py-1 font-medium text-brand-text hover:bg-brand-soft max-sm:min-h-[44px]">
          <Sparkles className="size-3" /> Suggest answers
        </button>
        <CostBadge kind="spend" size="xs" />
      </div>
    );
  return (
    <div className={box}>
      {loaded.stale ? (
        <span className="flex-1 text-amber-700 dark:text-amber-400">The report changed after these suggestions were made.</span>
      ) : (
        <span className="flex-1">Suggestions from {loaded.createdAt ? new Date(loaded.createdAt).toLocaleDateString() : "an earlier run"}.</span>
      )}
      <button type="button" onClick={onRun} className="inline-flex items-center gap-1 text-brand-text hover:underline max-sm:min-h-[44px]">
        <RefreshCw className="size-3" /> Suggest again
      </button>
    </div>
  );
}
