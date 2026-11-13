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

// Legal-entity suffixes stripped so "Acme, Inc." / "Acme LLC" / "Acme"
// collapse to one company key. Kept deliberately tight — ONLY true corporate
// suffixes, never descriptive words like "group"/"labs"/"systems"/"holdings"
// that are part of the actual name (stripping those merges distinct companies).
// "as" is excluded on purpose: it is the Norwegian suffix but also the English
// word "as", too risky to strip.
export const COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited',
  'corp', 'corporation', 'co', 'company', 'gmbh', 'ag', 'sa', 'sas',
  'bv', 'nv', 'plc', 'pllc', 'pty', 'pte', 'srl', 'spa', 'oy', 'ab', 'kk',
]);

// normalizeCompany builds a stable same-company key. Two hardening steps beyond
// the old lowercase/strip-punctuation behaviour, both motivated by real misses
// where the SAME company+role got evaluated twice:
//   1. Strip corporate suffixes  → "Vizient" === "Vizient, Inc".
//   2. Sort the remaining tokens → parenthetical-alias reorderings collapse,
//      so "FreeWheel (Comcast)" === "Comcast (FreeWheel)".
export function normalizeCompany(name) {
  const tokens = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // drop punctuation incl. parens/commas
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !COMPANY_SUFFIXES.has(t));
  tokens.sort();
  const key = tokens.join(' ');
  // Guard: never return "" when the name was ONLY a suffix (e.g. literally
  // "Inc") — fall back to the bare alphanumerics so distinct such names don't
  // all collapse to the empty key.
  return key || String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizeRole(role) {
  return role.toLowerCase()
    .replace(/[()]/g, ' ')
    // Replace runs of unsupported punctuation with a single space (was
    // dropped entirely, which collapsed "VP,Engineering" → "vpengineering"
    // and produced bogus single-token roles that slipped past dedup).
    .replace(/[^a-z0-9 /]+/g, ' ')
    // Canonicalize slash separators so "AI/ML Engineer" and
    // "AI / ML Engineer" produce identical output.
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
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

// Public API: are two role strings duplicates? Layered as:
//   1. Exact-normalized match — if normalizeRole(a) === normalizeRole(b),
//      they're duplicates, period. Cheap, and catches the short-title
//      cases the fuzzy path can't reach: roles that reduce to <2 content
//      tokens after stopword stripping (e.g. "VP Engineering" → ["vp"]
//      after length-filter + ["engineering" stopword'd] = [], or
//      "CTIO AI Engineering Manager" → ["ctio"]). The fuzzy path
//      requires overlap ≥ 2, so identical short roles slip through it.
//   2. Tokenized fuzzy match (≥2 overlapping content words, ≥60% ratio)
//      for everything else — handles paraphrases, suffix variations, and
//      reformatted titles across boards.
export function roleMatch(a, b) {
  if (normalizeRole(a) === normalizeRole(b)) return true;
  return roleMatchTokens(roleTokens(a), roleTokens(b));
}
