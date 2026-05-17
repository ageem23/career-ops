// dedup-utils.mjs — shared fuzzy-match primitives for scan-time dedup
// (scan.mjs) and post-hoc tracker cleanup (dedup-tracker.mjs). Pure
// heuristic, no API calls.
//
// Algorithm:
//   1. normalizeCompany: lowercase, strip parens and non-alphanumerics so
//      "Acme, Inc." and "Acme Inc" collapse to the same key.
//   2. roleTokens: lowercase, drop short words and seniority/location
//      stopwords so "Senior Software Engineer (Remote)" and
//      "Sr. Software Engineer" both reduce to ["software"]. Note "engineer"
//      itself is a stopword — see the design note below.
//   3. roleMatchTokens: ≥2 overlapping content words AND ≥60% overlap
//      ratio (relative to the smaller side).
//
// Design notes:
//   - "engineer"/"engineering" are stopwords because almost every role has
//     them, so they'd dominate the overlap metric. The ≥2-overlap floor
//     keeps single-token false positives (just one shared specialty word)
//     from matching.
//   - Thresholds (0.6 ratio, ≥2 overlap) are tuned on the applications.md
//     corpus dedup-tracker.mjs already processes. Bump them if false
//     positives bite; lower them if cross-board dupes are slipping through.

export function normalizeCompany(name) {
  return name.toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

export function normalizeRole(role) {
  return role.toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 /]/g, '')
    .trim();
}

export const ROLE_STOPWORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief',
  'manager', 'director', 'associate', 'intern', 'contractor',
  'remote', 'hybrid', 'onsite',
  'engineer', 'engineering',
  // Executive seniority modifiers — same category as "senior"/"director"
  // above. Added because exec-level role titles ("VP, Engineering" vs
  // "AVP, Engineering" vs "SVP AI") share these tokens and would
  // otherwise dominate the overlap metric, producing false positives
  // across different actual roles at the same company.
  'vice', 'president', 'vp', 'svp', 'avp', 'evp',
]);

export const LOCATION_STOPWORDS = new Set([
  'tokyo', 'japan', 'london', 'berlin', 'paris', 'singapore',
  'york', 'francisco', 'angeles', 'seattle', 'austin', 'boston',
  'chicago', 'denver', 'toronto', 'amsterdam', 'dublin', 'sydney',
  'remote', 'global', 'emea', 'apac', 'latam',
]);

export function roleTokens(role) {
  return normalizeRole(role)
    .split(/\s+/)
    .filter(w => w.length > 2 && !ROLE_STOPWORDS.has(w) && !LOCATION_STOPWORDS.has(w));
}

// Pre-tokenized comparison — used on scan's hot path so we don't
// re-tokenize every previously-seen entry for every candidate job.
//
// Both sides are reduced to a Set before counting so a token repeated
// on one side (e.g. "Platform Architect, Platform Team" → ["platform",
// "architect", "platform", "team"]) doesn't double-count toward overlap
// and inflate the ratio above threshold.
export function roleMatchTokens(a, b) {
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const w of setA) if (setB.has(w)) overlap++;
  const smaller = Math.min(setA.size, setB.size);
  return overlap >= 2 && (overlap / smaller) >= 0.6;
}

export function roleMatch(a, b) {
  return roleMatchTokens(roleTokens(a), roleTokens(b));
}
