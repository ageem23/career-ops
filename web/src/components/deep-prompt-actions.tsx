"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { claudeResearchLink } from "@/lib/deep-prompt.mjs";

const PILL =
  "inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]";

/** navigator.clipboard needs a secure context; a LAN-IP visit is not one. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export type PromptActionLabels = {
  copy: string;
  copyTitle: string;
  open: string;
  /** What the prompt is, for the status line ("Deep research prompt copied."). */
  noun: string;
  /** Where to select the prompt by hand when the clipboard refuses. */
  fallback: string;
};

const RESEARCH_LABELS: PromptActionLabels = {
  copy: "Copy research prompt",
  copyTitle: "Copy the Deep Research Prompt embedded in this report",
  open: "Research in Claude",
  noun: "Deep research prompt",
  fallback: "the Deep Research Prompt section below",
};

/**
 * Copy a prompt, or copy it and open Claude in a new tab. claude.ai has no URL
 * switch for Research mode, so the hint after opening tells the user to turn
 * it on before sending. Defaults to the report's Deep Research Prompt.
 */
export function DeepPromptActions({
  prompt,
  claudeUrl = "",
  labels = RESEARCH_LABELS,
  showCopy = true,
}: {
  prompt: string;
  claudeUrl?: string;
  labels?: PromptActionLabels;
  /** false drops the separate copy button; "open" still copies first. */
  showCopy?: boolean;
}) {
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  if (!prompt) return null;

  async function copy() {
    const ok = await copyText(prompt);
    setCopied(ok);
    setNote(ok ? `${labels.noun} copied.` : `Could not copy — select the prompt in ${labels.fallback}.`);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  async function open() {
    // Copy BEFORE opening: the new tab takes focus, and the clipboard API
    // refuses writes from an unfocused document.
    const ok = await copyText(prompt);
    const { url, prefilled } = claudeResearchLink(prompt, claudeUrl);
    // An app link (claude://) opens the desktop app; window.open would leave
    // an empty browser tab behind it.
    if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    else window.location.href = url;
    setNote(
      prefilled
        ? "Opened Claude with the prompt filled in. Turn on Research, then send."
        : ok
          ? "Opened Claude. Paste the prompt (it's on your clipboard), turn on Research, then send."
          : `Opened Claude. Copy the prompt from ${labels.fallback}, turn on Research, then send.`,
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="inline-flex flex-wrap items-center gap-2">
        {showCopy && (
          <button
            type="button"
            onClick={copy}
            title={labels.copyTitle}
            className={`${PILL} border-border text-muted hover:border-brand/40 hover:text-brand-text`}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : labels.copy}
          </button>
        )}
        <button
          type="button"
          onClick={open}
          title={/^https?:/i.test(claudeUrl || "https:") ? "Copy the prompt and open Claude in a new tab" : "Copy the prompt and open it in the Claude desktop app"}
          className={`${PILL} border-brand/30 text-brand-text hover:bg-brand-soft/50`}
        >
          <ExternalLink className="size-3.5" /> {labels.open}
        </button>
      </span>
      {note && (
        <span role="status" className="text-xs text-muted">
          {note}
        </span>
      )}
    </span>
  );
}
