/**
 * The parts of cv.md the Studio compares a tailored CV against: the summary
 * paragraph and each experience entry's bullets.
 *
 * cv.md's shape knowledge lives in the core's lib/cv-markdown.mjs, which the
 * caller passes in. The web app cannot import core modules statically, and a
 * second copy of the Pandoc rules would drift from the checks that use them.
 *
 * @typedef {{title: string, bullets: string[]}} BaseRole
 * @typedef {{company: string, bullets: string[], roles: BaseRole[]}} BaseEntry
 *   `bullets` is every bullet under the employer; `roles` splits them by the
 *   `####` title headings of a grouped employer (empty when there are none).
 * @typedef {{title: string, bullets: string[]}} BaseList
 * @typedef {{summary: string|null, entries: BaseEntry[], lists: BaseList[]}} BaseCv
 *   `lists`: each `##` section's own top-level bullets (Key Achievements), by title.
 * @typedef {typeof import("../../../../lib/cv-markdown.mjs")} CvMarkdown
 */

const SUMMARY_HEADING = /^(professional\s+)?(summary|profile|about( me)?)$/i;
const BULLET = /^\s*[-*+]\s+(.*)$/;

/**
 * @param {string} md
 * @param {CvMarkdown} cvMarkdown
 * @returns {BaseCv}
 */
export function parseBaseCv(md, cvMarkdown) {
  const { findExperienceSections, parseCompanyHeading, headingText, normalizePandocLine, toPlainText } = cvMarkdown;
  /** @type {BaseEntry[]} */
  const entries = [];
  for (const lines of findExperienceSections(md)) {
    let current = null;
    let role = null;
    for (const line of lines) {
      const heading = parseCompanyHeading(line) ?? (headingText(line, 3) !== null ? { company: toPlainText(headingText(line, 3)) } : null);
      if (heading) {
        current = { company: toPlainText(heading.company), bullets: [], roles: [] };
        role = null;
        entries.push(current);
        continue;
      }
      const roleHeading = headingText(line, 4);
      if (roleHeading !== null && current) {
        role = { title: roleTitle(toPlainText(roleHeading)), bullets: [] };
        current.roles.push(role);
        continue;
      }
      const bullet = BULLET.exec(line);
      if (bullet && current) {
        const text = toPlainText(bullet[1]);
        current.bullets.push(text);
        if (role) role.bullets.push(text);
      }
    }
  }
  return { summary: summaryOf(md, headingText, normalizePandocLine, toPlainText), entries, lists: listsOf(md, headingText, normalizePandocLine, toPlainText) };
}

/** "Chief Technology Officer *(Promoted)*" → "Chief Technology Officer". */
export function roleTitle(text) {
  return String(text).replace(/\s*[*_]*\([^)]*\)[*_]*\s*$/, "").trim();
}

/**
 * Each `##` section's top-level bullets that come before any `###` heading in
 * it: the bullet-only sections (Key Achievements) a tailored CV restates.
 */
function listsOf(md, headingText, normalizePandocLine, toPlainText) {
  const lines = md.replace(/\r\n/g, "\n").split("\n").map(normalizePandocLine);
  const out = [];
  let current = null;
  for (const line of lines) {
    const h2 = headingText(line, 2);
    if (h2 !== null) {
      current = { title: toPlainText(h2).trim(), bullets: [] };
      out.push(current);
      continue;
    }
    if (/^#{3,}\s/.test(line)) {
      current = null;
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet && current) current.bullets.push(toPlainText(bullet[1]));
  }
  return out.filter((l) => l.bullets.length);
}

function summaryOf(md, headingText, normalizePandocLine, toPlainText) {
  const lines = md.replace(/\r\n/g, "\n").split("\n").map(normalizePandocLine);
  const start = lines.findIndex((l) => {
    const h = headingText(l, 2);
    return h !== null && SUMMARY_HEADING.test(toPlainText(h).trim());
  });
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (line.trim()) body.push(line.trim());
    else if (body.length) break;
  }
  return body.length ? toPlainText(body.join(" ")) : null;
}
