"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { claudeResearchLink } from "@/lib/deep-prompt.mjs";

const PILL =
  "inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]";

/** navigator.clipboard needs a secure context; a LAN-IP visit is not one. */
async function copyText(text: string): Promise<boolean> {
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

/**
 * Copy the report's embedded Deep Research Prompt, or copy it and open Claude
 * in a new tab. claude.ai has no URL switch for Research mode, so the hint
 * after opening tells the user to turn it on before sending.
 */
export function DeepPromptActions({ prompt, claudeUrl = "" }: { prompt: string; claudeUrl?: string }) {
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  if (!prompt) return null;

  async function copy() {
    const ok = await copyText(prompt);
    setCopied(ok);
    setNote(ok ? "Deep research prompt copied." : "Could not copy — select the prompt in the Deep Research Prompt section below.");
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  async function open() {
    // Copy BEFORE opening: the new tab takes focus, and the clipboard API
    // refuses writes from an unfocused document.
    const ok = await copyText(prompt);
    const { url, prefilled } = claudeResearchLink(prompt, claudeUrl);
    window.open(url, "_blank", "noopener,noreferrer");
    setNote(
      prefilled
        ? "Opened Claude with the prompt filled in. Turn on Research, then send."
        : ok
          ? "Opened Claude. Paste the prompt (it's on your clipboard), turn on Research, then send."
          : "Opened Claude. Copy the prompt from the Deep Research Prompt section below, turn on Research, then send.",
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copy}
          title="Copy the Deep Research Prompt embedded in this report"
          className={`${PILL} border-border text-muted hover:border-brand/40 hover:text-brand-text`}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy research prompt"}
        </button>
        <button
          type="button"
          onClick={open}
          title="Copy the prompt and open Claude in a new tab"
          className={`${PILL} border-brand/30 text-brand-text hover:bg-brand-soft/50`}
        >
          <ExternalLink className="size-3.5" /> Research in Claude
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
