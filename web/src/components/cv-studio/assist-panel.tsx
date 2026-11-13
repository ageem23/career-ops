"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, Send, Sparkles } from "lucide-react";
import { readSavedCliId } from "@/lib/saved-cli";
import { MAX_ASSIST_INSTRUCTION } from "@/lib/cv-studio/assist.mjs";
import type { StudioAction, StudioEdits } from "@/lib/cv-studio/studio.mjs";

// The Studio's prompt box: the candidate asks for any change in plain words,
// their AI CLI answers, and the changes that pass the fact and voice checks
// land in the live preview as one undo step (see assist.mjs and its route).

type Turn = {
  instruction: string;
  status: "running" | "done" | "failed";
  reply?: string;
  applied?: string[];
  rejected?: { what: string; why: string }[];
  warning?: string | null;
  error?: string;
};

const EXAMPLES = [
  "Lead with the AI adoption work in the summary",
  "Hide the MBS role's bullets",
  "Make the CTO bullets shorter",
];

export function AssistPanel({ n, edits, onApply }: { n: string; edits: StudioEdits; onApply: (actions: StudioAction[]) => void }) {
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const log = useRef<HTMLDivElement>(null);
  const editsRef = useRef(edits);
  useEffect(() => {
    editsRef.current = edits;
  }, [edits]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const running = turns.some((t) => t.status === "running");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const instruction = text.trim();
    if (!instruction || running) return;
    const cliId = readSavedCliId();
    const history = turns.filter((t) => t.status === "done" && t.reply).map((t) => ({ instruction: t.instruction, reply: t.reply! }));
    const index = turns.length;
    setTurns((ts) => [...ts, { instruction, status: "running" }]);
    setText("");
    const update = (patch: Partial<Turn>) => setTurns((ts) => ts.map((t, i) => (i === index ? { ...t, ...patch } : t)));
    if (!cliId) {
      update({ status: "failed", error: "No AI CLI is set up. Choose one in Config." });
      return;
    }
    try {
      const r = await fetch(`/api/cv-studio/${encodeURIComponent(n)}/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, cliId, edits: editsRef.current, history }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body) {
        update({ status: "failed", error: typeof body?.error === "string" ? body.error : "The request failed." });
        return;
      }
      if (Array.isArray(body.actions) && body.actions.length) onApply(body.actions as StudioAction[]);
      update({ status: "done", reply: body.reply, applied: body.applied ?? [], rejected: body.rejected ?? [], warning: body.warning ?? null });
    } catch {
      update({ status: "failed", error: "The request failed. Is the dashboard still running?" });
    }
  }

  return (
    <section aria-label="Ask for changes" className="rounded-2xl border border-brand/30 bg-brand-soft/30 p-3">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Sparkles className="size-4 text-brand-text" /> Ask for changes
      </h2>
      {turns.length > 0 && (
        <div ref={log} className="mt-2 max-h-72 space-y-3 overflow-y-auto pr-1" aria-live="polite">
          {turns.map((t, i) => (
            <div key={i} className="text-sm">
              <p className="rounded-lg bg-background/80 px-3 py-2 text-foreground">{t.instruction}</p>
              {t.status === "running" && (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                  <Loader2 className="size-3.5 motion-safe:animate-spin" /> Your AI CLI is working on it. This uses tokens and can take a minute or two.
                </p>
              )}
              {t.status === "failed" && <p role="alert" className="mt-1.5 text-xs text-red-700 dark:text-red-400">{t.error}</p>}
              {t.status === "done" && (
                <div className="mt-1.5 space-y-1 px-1">
                  {t.reply && <p className="text-foreground">{t.reply}</p>}
                  {!!t.applied?.length && (
                    <ul className="text-xs text-emerald-800 dark:text-emerald-400">
                      {t.applied.map((a, k) => <li key={k}>✓ {a}</li>)}
                    </ul>
                  )}
                  {!t.applied?.length && <p className="text-xs text-muted">No changes were made.</p>}
                  {!!t.rejected?.length && (
                    <ul className="text-xs text-amber-800 dark:text-amber-400">
                      {t.rejected.map((r, k) => <li key={k}>Not applied: {r.what}. {r.why}</li>)}
                    </ul>
                  )}
                  {t.warning && <p className="text-xs text-muted">{t.warning}</p>}
                  {!!t.applied?.length && <p className="text-xs text-muted">Undo reverses this request in one step.</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="mt-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_ASSIST_INSTRUCTION))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          }}
          rows={3}
          disabled={running}
          aria-label="What should change in the CV?"
          placeholder={`What should change? For example: "${EXAMPLES[0]}"`}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-brand/50 focus:outline-none disabled:opacity-60"
        />
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted">Changes must stay true to cv.md. Ctrl+Enter sends.</span>
          <button
            type="submit"
            disabled={running || !text.trim()}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 disabled:opacity-60 max-sm:min-h-[44px]"
          >
            {running ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Send className="size-3.5" />} Send
          </button>
        </div>
      </form>
    </section>
  );
}
