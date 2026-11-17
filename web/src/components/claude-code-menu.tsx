import { ChevronDown, SquareTerminal } from "lucide-react";
import { claudeCodeLinks } from "@/lib/claude-code-handoff.mjs";

export type ClaudeCodeItem = {
  label: string;
  /** One line under the label: what the session will do. */
  hint: string;
  prompt: string;
};

const PILL =
  "inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand-text max-sm:min-h-[44px]";

/**
 * Hands a task to an interactive Claude Code session in the project folder,
 * with the prompt typed in. The main link opens the terminal CLI; "Desktop"
 * opens the Code tab of the Claude desktop app instead. For jobs the web
 * workers cannot do because of their write scope.
 */
export function ClaudeCodeMenu({ cwd, items, label = "Claude Code" }: { cwd: string; items: ClaudeCodeItem[]; label?: string }) {
  if (!cwd || items.length === 0) return null;
  return (
    <details className="group relative print:hidden">
      <summary className={`${PILL} cursor-pointer list-none`} title="Continue in an interactive Claude Code session">
        <SquareTerminal className="size-3.5" /> {label}
        <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-1.5 shadow-lg">
        {items.map((item) => {
          const links = claudeCodeLinks({ cwd, prompt: item.prompt });
          return (
            <div key={item.label} className="flex items-start gap-2 rounded-lg px-2.5 py-2 hover:bg-surface-hover">
              <a href={links.terminal} className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{item.label}</span>
                <span className="block text-xs text-muted">{item.hint}</span>
              </a>
              <a
                href={links.desktop}
                title="Open in the Claude desktop app instead (it asks you to confirm the folder)"
                className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-faint hover:border-brand/40 hover:text-brand-text"
              >
                Desktop
              </a>
            </div>
          );
        })}
        <p className="px-2.5 pb-1 pt-1.5 text-[11px] leading-snug text-faint">
          Opens a terminal with the prompt typed in. Nothing runs until you press Enter.
        </p>
      </div>
    </details>
  );
}
