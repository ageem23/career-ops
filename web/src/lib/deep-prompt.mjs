/**
 * deep-prompt.mjs — the "## Deep Research Prompt" section an evaluation embeds
 * when its score clears `deep_prompt_score_threshold` (modes/oferta.md,
 * modes/pipeline.md), and the claude.ai link the report page opens with it.
 *
 * Mirrors extractDeepPrompt in dashboard/internal/ui/screens/viewer_copy.go so
 * the TUI and the web copy the same text. Plain .mjs so tests import it under
 * Node directly.
 */

const HEADING = "deep research prompt";

/**
 * claude.ai truncates `q` at roughly 14,000 characters (Claude support article
 * "Open Claude Desktop with a link"). Past that, open a blank chat and rely on
 * the clipboard instead of sending a silently cut-off prompt.
 */
export const MAX_PREFILL_CHARS = 14000;

/** @param {string} s */
function isFence(s) {
  return s.trimStart().startsWith("```");
}

/**
 * Body of the "## Deep Research Prompt" section, with one wrapping code fence
 * stripped so it pastes as plain text. "" when the report has none (scored
 * below the threshold, or predates the feature). The prompt scaffold itself
 * uses "## " headings, so only a "## " heading OUTSIDE a fence ends it.
 * @param {string | null | undefined} report
 * @returns {string}
 */
export function extractDeepPrompt(report) {
  const lines = String(report ?? "").replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (isFence(t)) inFence = !inFence;
    else if (!inFence && t.startsWith("## ") && t.toLowerCase().includes(HEADING)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";

  /** @type {string[]} */
  const body = [];
  inFence = false;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (isFence(t)) inFence = !inFence;
    else if (!inFence && t.startsWith("## ")) break;
    body.push(lines[i]);
  }
  return stripCodeFence(body.join("\n").trim());
}

/** @param {string} s */
function stripCodeFence(s) {
  const lines = s.split("\n");
  if (lines.length >= 2 && isFence(lines[0]) && lines[lines.length - 1].trim() === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }
  return s;
}

/**
 * `deep_research.claude_url` in config/profile.yml, or "" when unset or not an
 * http(s)/claude:// link.
 * @param {unknown} profile parsed profile.yml
 * @returns {string}
 */
export function deepResearchUrlFromProfile(profile) {
  const raw = /** @type {any} */ (profile)?.deep_research?.claude_url;
  if (typeof raw !== "string") return "";
  const url = raw.trim();
  return /^(https?|claude):\/\//i.test(url) ? url : "";
}

/**
 * The link "Open in Claude" opens. The prompt is always copied to the
 * clipboard first, so every branch here is safe to land on without a prefill.
 *
 * - No configured URL → a new claude.ai chat with the prompt prefilled (`q`).
 * - Configured URL containing `{prompt}` → that placeholder is replaced with
 *   the URL-encoded prompt (e.g. `claude://claude.ai/new?q={prompt}` for the
 *   desktop app).
 * - Any other configured URL (e.g. a claude.ai project) → opened as-is: there
 *   is no documented way to prefill a prompt inside a project, so the user
 *   pastes from the clipboard.
 *
 * A prompt over MAX_PREFILL_CHARS is never put in the URL.
 * @param {string} prompt
 * @param {string} [configured]
 * @returns {{ url: string, prefilled: boolean }}
 */
export function claudeResearchLink(prompt, configured = "") {
  const fits = prompt.length > 0 && prompt.length <= MAX_PREFILL_CHARS;
  const base = configured || "https://claude.ai/new?q={prompt}";
  if (!base.includes("{prompt}")) return { url: base, prefilled: false };
  if (!fits) {
    // Drop the whole query parameter that carried the placeholder.
    const bare = base
      .replace(/([?&])[^?&=#]*=\{prompt\}(&)?/, (_m, sep, amp) => (amp ? sep : ""))
      .replace("{prompt}", "");
    return { url: bare, prefilled: false };
  }
  return { url: base.replace("{prompt}", encodeURIComponent(prompt)), prefilled: true };
}
