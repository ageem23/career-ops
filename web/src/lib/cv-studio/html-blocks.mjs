/**
 * Read a tailored CV's HTML as a tree of addressable blocks, and write it back
 * with blocks hidden, reordered, or retexted.
 *
 * The tailored HTML is the artifact the pdf flow renders, so the Studio edits
 * it in place instead of rebuilding it from a payload: the header, the template
 * CSS, and every block the user leaves alone come out byte for byte. The class
 * names are build-cv-html.mjs's markup contract, which the web pdf prompt also
 * fills.
 *
 * @typedef {{id: string, start: number, end: number, inner: [number, number], text: string}} Bullet
 * @typedef {{id: string, kind: "entry"|"role"|"tag"|"text", label: string, start: number, end: number, bullets: Bullet[], company?: string, role?: string}} Item
 *   A "role" is one title inside a grouped employer entry (several role-header
 *   blocks under one job-header): it is hideable, its bullets move within it,
 *   but it never moves, because the employer markup around it is not its own.
 * @typedef {{id: string, title: string, kind: SectionKind, start: number, end: number, items: Item[]}} Section
 * @typedef {"summary"|"competencies"|"experience"|"projects"|"education"|"skills"|"highlights"|"other"} SectionKind
 *   "highlights" is a section that is only a bullet list (Key Achievements).
 * @typedef {{html: string, sections: Section[]}} BlockTree
 */

const ENTRY_CLASSES = ["job", "project", "edu-item", "cert-item", "award-item", "skill-item"];
const ENTRY_LABEL_CLASS = { job: "job-company", project: "project-title", "edu-item": "edu-title", "cert-item": "cert-title", "award-item": "award-title", "skill-item": "skill-category" };

const KIND_BY_CLASS = [
  ["summary-text", "summary"],
  ["competency-tag", "competencies"],
  ["job", "experience"],
  ["project", "projects"],
  ["edu-item", "education"],
  ["skill-item", "skills"],
];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** @param {string} html */
export function htmlText(html) {
  let text = String(html);
  // Tags whose insides cannot hold another "<". Repeat until stable so a nested
  // scrape like <scr<script>ipt> collapses; then drop any leftover angle brackets.
  for (let prev = null; text !== prev; ) {
    prev = text;
    text = text.replace(/<\/?[a-zA-Z!][^<>]*>/g, "");
  }
  text = text.replace(/[<>]/g, " ");
  return text
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (ENTITIES[e]) return ENTITIES[e];
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} text */
export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function closeOf(html, start, tag) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

function elementsWithClass(html, from, to, tag, cls) {
  const re = new RegExp(`<${tag}\\b[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>`, "gi");
  re.lastIndex = from;
  const out = [];
  for (let m = re.exec(html); m && m.index < to; m = re.exec(html)) {
    const end = closeOf(html, m.index, tag);
    if (end < 0 || end > to) break;
    out.push({ start: m.index, open: m.index + m[0].length, end });
    re.lastIndex = end;
  }
  return out;
}

function innerOf(el, tag) {
  return [el.open, el.end - `</${tag}>`.length];
}

function bulletsIn(html, from, to, prefix) {
  const out = [];
  const re = /<li\b[^>]*>/gi;
  re.lastIndex = from;
  for (let m = re.exec(html); m && m.index < to; m = re.exec(html)) {
    const close = html.indexOf("</li>", m.index);
    if (close < 0 || close > to) break;
    const inner = [m.index + m[0].length, close];
    out.push({ id: `${prefix}b${out.length}`, start: m.index, end: close + 5, inner, text: htmlText(html.slice(...inner)) });
    re.lastIndex = close + 5;
  }
  return out;
}

function sectionKind(body) {
  for (const [cls, kind] of KIND_BY_CLASS) if (new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s|")`).test(body)) return kind;
  return "other";
}

/** Visible text of an element up to its first child tag: "Adage Technologies <span>…" → "Adage Technologies". */
function leadText(html, el, tag) {
  return htmlText(html.slice(el.open, innerOf(el, tag)[1]).split("<")[0]);
}

/**
 * Items for one job entry. A job with role-header blocks (a grouped employer:
 * one company, several titles) becomes one "role" item per title, each running
 * from its role-header to the end of its bullet list. Bullets keep the ids the
 * whole job would give them (numbered across the job), so edits saved before
 * roles were split still point at the same bullets.
 */
function jobItems(html, e, id, k, labelOf) {
  const bullets = bulletsIn(html, e.open, e.end, `${id}i${k}`);
  const roles = elementsWithClass(html, e.open, e.end, "div", "role-header");
  if (!roles.length) return [{ id: `${id}i${k}`, kind: "entry", label: labelOf(e), start: e.start, end: e.end, bullets }];
  const headerEl = elementsWithClass(html, e.open, e.end, "div", "job-header")[0];
  const companyEl = elementsWithClass(html, e.open, e.end, "span", "job-company")[0];
  const company = companyEl ? leadText(html, companyEl, "span") : headerEl ? leadText(html, headerEl, "div") : labelOf(e);
  return roles.map((r, j) => {
    const next = roles[j + 1]?.start ?? e.end;
    const ulStart = html.slice(r.end, next).search(/<ul\b/i);
    const ulEnd = ulStart < 0 ? -1 : closeOf(html, r.end + ulStart, "ul");
    const end = ulEnd > 0 && ulEnd <= next ? ulEnd : next;
    const role = leadText(html, r, "div");
    return {
      id: `${id}i${k}r${j}`,
      kind: "role",
      label: `${company} · ${role}`.slice(0, 80),
      company,
      role,
      start: r.start,
      end,
      bullets: bullets.filter((b) => b.start >= r.start && b.end <= end),
    };
  });
}

/**
 * A summary paragraph some templates place outside any section (the house
 * layout puts it straight under the header). Addressed as its own section
 * with a fixed id, so it never renumbers the sections around it.
 */
function looseSummaries(html, sections) {
  return elementsWithClass(html, 0, html.length, "div", "summary-text")
    .filter((t) => !sections.some((s) => t.start >= s.start && t.end <= s.end))
    .slice(0, 1)
    .map((t) => {
      const inner = innerOf(t, "div");
      const title = "Professional Summary";
      return {
        id: "sum",
        title,
        kind: /** @type {SectionKind} */ ("summary"),
        start: t.start,
        end: t.end,
        items: [{ id: "sumi0", kind: /** @type {const} */ ("text"), label: title, start: t.start, end: t.end, bullets: [{ id: "sumi0b0", start: t.start, end: t.end, inner, text: htmlText(html.slice(...inner)) }] }],
      };
    });
}

/**
 * @param {string} html
 * @returns {BlockTree}
 */
export function parseBlocks(html) {
  const sections = elementsWithClass(html, 0, html.length, "div", "section").map((el, si) => {
    const id = `s${si}`;
    const titleEl = elementsWithClass(html, el.open, el.end, "div", "section-title")[0];
    const title = titleEl ? htmlText(html.slice(...innerOf(titleEl, "div"))) : "";
    const body = html.slice(el.open, el.end);
    let kind = sectionKind(body);
    /** @type {Item[]} */
    let items = [];
    if (kind === "other") {
      // A section that is just a bullet list (Key Achievements): one item
      // holding its bullets, so they can be reworded, hidden and moved.
      const list = elementsWithClass(html, el.open, el.end, "ul", "bullet-list")[0]
        ?? (() => {
          const at = body.search(/<ul\b/i);
          if (at < 0) return undefined;
          const start = el.open + at;
          const end = closeOf(html, start, "ul");
          return end > 0 ? { start, open: html.indexOf(">", start) + 1, end } : undefined;
        })();
      const bullets = list ? bulletsIn(html, list.open, list.end, `${id}i0`) : [];
      if (list && bullets.length) {
        kind = "highlights";
        items = [{ id: `${id}i0`, kind: "entry", label: title || "Highlights", start: list.start, end: list.end, bullets }];
      }
    } else if (kind === "summary") {
      const t = elementsWithClass(html, el.open, el.end, "div", "summary-text")[0];
      if (t) {
        const inner = innerOf(t, "div");
        items = [{ id: `${id}i0`, kind: "text", label: title, start: t.start, end: t.end, bullets: [{ id: `${id}i0b0`, start: t.start, end: t.end, inner, text: htmlText(html.slice(...inner)) }] }];
      }
    } else if (kind === "competencies") {
      items = elementsWithClass(html, el.open, el.end, "span", "competency-tag").map((t, k) => ({ id: `${id}i${k}`, kind: "tag", label: htmlText(html.slice(t.open, t.end)), start: t.start, end: t.end, bullets: [] }));
    } else {
      const cls = ENTRY_CLASSES.find((c) => new RegExp(`class="${c}"`).test(body));
      if (cls) {
        const labelOf = (e) => {
          const labelMatch = new RegExp(`class="${ENTRY_LABEL_CLASS[cls]}"[^>]*>([\\s\\S]*?)</`).exec(html.slice(e.open, e.end));
          // No label element (a grouped job's header holds the name as bare text):
          // the job-header's own leading text, not the whole entry.
          const header = labelMatch ? null : elementsWithClass(html, e.open, e.end, "div", "job-header")[0];
          const text = labelMatch ? htmlText(labelMatch[1].split("<")[0]) : header ? leadText(html, header, "div") : htmlText(html.slice(e.open, e.end));
          return text.slice(0, 80).replace(/:$/, "");
        };
        items = elementsWithClass(html, el.open, el.end, "div", cls).flatMap((e, k) =>
          cls === "job" ? jobItems(html, e, id, k, labelOf) : [{ id: `${id}i${k}`, kind: "entry", label: labelOf(e), start: e.start, end: e.end, bullets: bulletsIn(html, e.open, e.end, `${id}i${k}`) }],
        );
      }
    }
    return { id, title, kind, start: el.start, end: el.end, items };
  });
  const all = [...sections, ...looseSummaries(html, sections)].sort((a, b) => a.start - b.start);
  return { html, sections: all };
}

/** True when a section's items cannot be reordered: a grouped employer's roles share its markup. */
export function itemsFixed(section) {
  return section.items.some((i) => i.kind === "role");
}

/**
 * The visible state of each block. Absent ids keep their source order and text.
 *
 * @typedef {{hidden: Set<string>, order: Record<string, string[]>, text: Record<string, string>}} BlockView
 */

/** @template {{id: string}} T @param {T[]} children @param {string[] | undefined} order @returns {T[]} */
export function arrange(children, order) {
  if (!order) return children;
  const byId = new Map(children.map((c) => [c.id, c]));
  const picked = order.map((id) => byId.get(id)).filter(Boolean);
  return [...picked, ...children.filter((c) => !order.includes(c.id))];
}

function renderRange(html, start, end, children, ordered, hidden, renderChild) {
  const slots = [...children].sort((a, b) => a.start - b.start);
  if (!slots.length) return html.slice(start, end);
  const gaps = slots.slice(1).map((s, k) => html.slice(slots[k].end, s.start));
  let out = html.slice(start, slots[0].start);
  // When the markup between children is not all alike (a grouped employer's
  // roles, where one gap closes the employer's <div>), every child keeps its
  // own slot and a hidden one leaves its slot empty. Collapsing would pull the
  // next child across that markup: hiding a role put the following employer
  // inside the grouped one.
  if (gaps.some((g) => g !== gaps[0])) {
    ordered.forEach((c, k) => {
      if (k > 0) out += gaps[k - 1] ?? "";
      if (!hidden.has(c.id)) out += renderChild(c);
    });
    return out + html.slice(slots[slots.length - 1].end, end);
  }
  const visible = ordered.filter((c) => !hidden.has(c.id));
  visible.forEach((c, k) => {
    out += renderChild(c);
    if (k < visible.length - 1) out += gaps[Math.min(k, gaps.length - 1)] ?? "";
  });
  return out + html.slice(slots[slots.length - 1].end, end);
}

/**
 * New text for a block whose original opened with a bold label
 * ("<strong>Label:</strong> …"): the label stays bold when the new text still
 * starts with it, as it does whenever a rewrite keeps the label.
 */
function withLabel(originalInner, text) {
  const label = /^\s*(<(strong|b)\b[^>]*>)([\s\S]*?)<\/\2>/i.exec(originalInner);
  const plain = label ? htmlText(label[3]) : "";
  if (!label || !plain || !text.startsWith(plain)) return escapeHtml(text);
  return `${label[1]}${escapeHtml(plain)}</${label[2]}> ${escapeHtml(text.slice(plain.length).trim())}`;
}

/**
 * @param {BlockTree} tree
 * @param {BlockView} view
 * @param {{added?: Record<string, string[]>}} [extra] new bullets appended to an entry, by item id
 * @returns {string}
 */
export function renderBlocks(tree, view, extra = {}) {
  const { html } = tree;
  const renderBullet = (b) => {
    const text = view.text[b.id];
    if (text === undefined) return html.slice(b.start, b.end);
    return html.slice(b.start, b.inner[0]) + withLabel(html.slice(...b.inner), text) + html.slice(b.inner[1], b.end);
  };
  const renderItem = (item) => {
    const added = (extra.added?.[item.id] ?? []).filter((t) => t.trim());
    if (!item.bullets.length) return html.slice(item.start, item.end);
    let out = renderRange(html, item.start, item.end, item.bullets, arrange(item.bullets, view.order[item.id]), view.hidden, renderBullet);
    if (added.length && (item.kind === "entry" || item.kind === "role")) {
      const first = item.bullets[0];
      const li = html.slice(first.start, first.inner[0]);
      // A restored cv.md bullet ("Label: text") takes the list's bold label style.
      const labelled = /^\s*<(strong|b)\b/i.test(html.slice(...first.inner));
      const render = (t) => {
        const m = labelled ? /^([^:]{2,60}):\s+(.*)$/.exec(t) : null;
        return m ? withLabel(`<strong>${escapeHtml(m[1])}:</strong>`, t) : escapeHtml(t);
      };
      const extraLis = added.map((t) => `${li}${render(t)}</li>`).join("\n    ");
      out = out.replace(/(\s*)<\/ul>/, (m, ws) => `\n    ${extraLis}${ws}</ul>`);
    }
    return out;
  };
  const renderSection = (s) => {
    if (s.items.length && s.items.every((i) => view.hidden.has(i.id))) return "";
    return renderRange(html, s.start, s.end, s.items, arrange(s.items, view.order[s.id]), view.hidden, renderItem);
  };
  return renderRange(html, 0, html.length, tree.sections, arrange(tree.sections, view.order.root), view.hidden, renderSection);
}
