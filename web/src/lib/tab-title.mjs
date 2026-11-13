// Browser-tab titles. With many tabs open, the tab strip shows only the first
// few characters of each title, so the distinguishing part (the company, or the
// page type) comes first and the app name is a short suffix.

export const APP_TAB_SUFFIX = "Co";

/** Root-layout title config: pages set `title: "Pipeline"` → "Pipeline · Co". */
export const ROOT_TITLE = { default: APP_TAB_SUFFIX, template: `%s · ${APP_TAB_SUFFIX}` };

/**
 * The name an application's tabs lead with: the tracker's company cell, else
 * the company from the report heading ("# Evaluation: Acme — Senior EM"),
 * else a generic label.
 * @param {{ company?: string | null, reportTitle?: string | null }} src
 */
export function applicationTabName({ company, reportTitle } = {}) {
  const fromTracker = String(company ?? "").trim();
  if (fromTracker) return fromTracker;
  const fromReport = String(reportTitle ?? "")
    .replace(/^#+\s*/, "")
    .replace(/^[^:—–]{1,30}:\s*/, "") // "Evaluation:" / "Evaluación:" prefix
    .split(/\s+[—–-]\s+/)[0]
    .trim();
  return fromReport || "Application";
}

/** "Acme" for the report page, "Acme · Apply" for a sub-page. */
export function applicationTabTitle(name, section) {
  return section ? `${name} · ${section}` : name;
}

/**
 * Full document title for a worker page. Worker titles read "CV PDF · Acme";
 * the tab leads with the company: "Acme · CV PDF · Co".
 * @param {string | null | undefined} jobTitle
 */
export function workerTabTitle(jobTitle) {
  const parts = String(jobTitle ?? "").split(" · ").map((p) => p.trim()).filter(Boolean);
  const lead = parts.length === 2 ? `${parts[1]} · ${parts[0]}` : parts.join(" · ");
  return `${lead || "Worker"} · ${APP_TAB_SUFFIX}`;
}
