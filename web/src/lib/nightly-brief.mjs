// The morning brief the 04:00 nightly job writes (morning-brief.mjs at the repo
// root → {DATA_ROOT}/data/nightly-briefs/{YYYY-MM-DD}.json). Pure helpers, so the
// route stays a thin fs wrapper and the choices below are testable.

const BRIEF_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** The newest brief file name, or null. Names sort by date because they are ISO dates. */
export function latestBriefFile(names) {
  const briefs = names.filter((n) => BRIEF_FILE.test(n)).sort();
  return briefs.length ? briefs[briefs.length - 1] : null;
}

/** Local calendar date (YYYY-MM-DD) of a Date. */
export function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Whether the brief is this morning's. A brief from an earlier day means the
 * 04:00 job did not write one today (machine asleep, job failed), and the card
 * says so rather than presenting an old night as last night.
 */
export function briefFreshness(briefDate, now = new Date()) {
  const today = localDate(now);
  if (briefDate === today) return { current: true, daysOld: 0 };
  const [y, m, d] = String(briefDate).split("-").map(Number);
  const then = new Date(y, m - 1, d);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysOld = Number.isFinite(then.getTime()) ? Math.round((midnight - then) / 86_400_000) : null;
  return { current: false, daysOld };
}

/**
 * What the card needs. Drops the full health-check list (thousands of lines on
 * a long-lived tracker, kept in the file only to diff the next morning against)
 * and refuses a file that is not a brief.
 */
export const MAX_NEW_WARNINGS = 20;

export function slimBrief(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.date !== "string" || !Array.isArray(raw.runs)) return null;
  const { health = {}, ...rest } = raw;
  // A mass event (a moved reports/ folder) can make thousands of warnings new
  // at once. The card shows the count and a few examples, never the whole list.
  const newWarnings = Array.isArray(health.newWarnings) ? health.newWarnings : [];
  return {
    ...rest,
    issues: Array.isArray(raw.issues) ? raw.issues : [],
    topPicks: Array.isArray(raw.topPicks) ? raw.topPicks : [],
    nextBest: Array.isArray(raw.nextBest) ? raw.nextBest : [],
    notCompleted: Array.isArray(raw.notCompleted) ? raw.notCompleted : [],
    health: {
      ran: Boolean(health.ran),
      baseline: Boolean(health.baseline),
      newWarnings: newWarnings.slice(0, MAX_NEW_WARNINGS),
      newWarningCount: newWarnings.length,
      recurringCount: Number(health.recurringCount) || 0,
    },
  };
}
