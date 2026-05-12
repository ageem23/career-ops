// LinkedIn authenticated job-search provider.
//
// LinkedIn job search requires login. This provider drives a Playwright
// persistent browser context (saved at ~/.career-ops-auth/linkedin/profile)
// so the session survives between runs.
//
// Each tracked_companies entry with `provider: linkedin` represents ONE
// keyword search. The provider runs the search, walks pages of results,
// extracts each card's title/company/JD text, writes a JD file under jds/,
// and returns metadata where the URL uses the `local:` prefix (per the
// scan.md convention for non-public URLs).
//
// Usage in portals.yml:
//
//   tracked_companies:
//     - name: "LinkedIn — AI Engineering Manager"
//       provider: linkedin
//       enabled: true
//       search: "AI Engineering Manager"
//       date_posted: "Week"           # "24" | "Week" | "Month" | omit
//       experience_level: ["Director"] # optional array
//       max_results: 25                # cap per search
//
// Login behavior:
//   - First interactive run of `node scan.mjs` triggers the login flow inline:
//     a visible browser opens, the user logs in, presses Enter, the session
//     is saved at ~/.career-ops-auth/linkedin/profile/, and the scan continues.
//   - Concurrent LinkedIn entries share a single in-flight login (no race).
//   - In non-interactive contexts (cron, CI, /loop, /schedule), a missing
//     session is a hard failure with a hint to run `--login linkedin` from
//     a terminal first.
//   - `node scan.mjs --login linkedin` is still available as a power-user
//     shortcut: re-warm the session before a long unattended run, or verify
//     auth without kicking off any scans.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { createHash } from 'crypto';

// ── Config ──────────────────────────────────────────────────────────

const PROFILE_DIR = join(homedir(), '.career-ops-auth', 'linkedin', 'profile');
const JDS_DIR = 'jds';
const FEED_URL = 'https://www.linkedin.com/feed/';
const LOGIN_URL = 'https://www.linkedin.com/login';

const SELECTORS = {
  // Card listing — `div[data-job-id]` is the canonical wrapper LinkedIn uses
  // for each job card on the search page. The previous "Dismiss button →
  // ancestor div[role='button']" XPath stopped matching when LinkedIn dropped
  // the per-card Dismiss control from the default search list.
  listingCard: 'div[data-job-id]',
  cardJobsViewLink: 'a[href*="/jobs/view/"]',

  // Detail panel selectors. Primary uses dedicated CSS classes shipped with
  // the unified top-card; fallback handles older variants and the bare h1
  // case if LinkedIn renames the wrapper class again.
  panelTitle: '.job-details-jobs-unified-top-card__job-title h1, h1.t-24, h1',
  panelCompany: '.job-details-jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name',
  panelApply: 'a[aria-label*="Apply"]:not([aria-label*="Easy"]):not([aria-label*="continue"])',
  panelJdContent: '#job-details, .jobs-description__container, .jobs-box__html-content',
  panelMoreButton: '.jobs-description__footer-button button, button.jobs-description__footer-button',

  loggedIn: 'a[aria-label*="My Network"]',
  xpathCurrentPage: "//button[@aria-current='true'][starts-with(@aria-label, 'Page')]",
  xpathPageButton: "//button[starts-with(@aria-label, 'Page')]",
};

const NOISE_LABELS = new Set([
  'more', 'show more', 'see more',
  'less', 'show less', 'see less',
  'retry premium',
]);
const MIN_TITLE_LENGTH = 4;
const DEFAULT_DELAY_PAGES = [3000, 8000];
const DEFAULT_DELAY_SEARCHES = [5000, 15000];

// ── Browser singleton ───────────────────────────────────────────────
//
// Persistent contexts can't switch headless mid-life — `headless` is set at
// launch time. So we close-and-relaunch when transitioning between login
// (visible) and scanning (headless). The profile dir on disk persists across
// relaunches; only the live context closes.

let contextPromise = null;

async function getContext({ headless = true } = {}) {
  if (contextPromise) return contextPromise;
  mkdirSync(PROFILE_DIR, { recursive: true });
  contextPromise = (async () => {
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return ctx;
  })();
  contextPromise.catch(() => { contextPromise = null; });
  return contextPromise;
}

async function closeContext() {
  if (!contextPromise) return;
  const p = contextPromise;
  contextPromise = null;
  try { await (await p).close(); } catch {}
}

// ── Session gate ────────────────────────────────────────────────────
//
// ensureSession() is called by fetch() before any scan work. If the persisted
// session is valid, returns immediately. If not, behavior depends on whether
// stdout is a TTY:
//   - TTY: launches the visible-browser login flow inline
//   - non-TTY (cron, /loop, CI): throws fast with a hint to run --login
//
// A singleton loginInProgress promise serializes parallel fetches: the first
// one detects the missing session and triggers login; the rest await the
// same promise and proceed once it resolves.

let loginInProgress = null;

async function ensureSession() {
  // Fast path — current persistent context already has a live session.
  let ctx = await getContext({ headless: true });
  let page = await ctx.newPage();
  try {
    if (await checkSession(page)) return;
  } finally {
    await page.close();
  }

  // Session missing or expired.
  if (!process.stdin.isTTY) {
    throw new Error(
      'LinkedIn: not logged in (or session expired). ' +
      'This is a non-interactive run, so I cannot prompt for login. ' +
      'Run `node scan.mjs --login linkedin` from a terminal first.'
    );
  }

  if (!loginInProgress) {
    loginInProgress = doInteractiveLogin()
      .finally(() => { loginInProgress = null; });
  }
  await loginInProgress;
}

async function doInteractiveLogin() {
  // Close the headless context so we can relaunch as headed (visible).
  await closeContext();

  mkdirSync(PROFILE_DIR, { recursive: true });
  const headedCtx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  await headedCtx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    const page = await headedCtx.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  Log in to LinkedIn in the browser window.       ║');
    console.log('║  Press ENTER here once you are logged in...      ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
    await waitForEnter('');
    if (!await checkSession(page)) {
      throw new Error('LinkedIn: still not logged in after prompt — re-run --login linkedin to retry');
    }
    log('Session saved');
  } finally {
    await headedCtx.close();
  }

  // Profile is persisted on disk. Subsequent getContext() will lazy-launch
  // a fresh headless context using the saved cookies.
}

// ── Session ─────────────────────────────────────────────────────────

async function isLoggedIn(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('/uas/') || url.includes('/checkpoint/')) {
    return false;
  }
  return Boolean(await page.$(SELECTORS.loggedIn));
}

async function checkSession(page) {
  await page.goto(FEED_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  return isLoggedIn(page);
}

// ── Helpers ─────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = ([min, max]) => Math.floor(Math.random() * (max - min) + min);

function log(msg) { console.log(`[linkedin] ${msg}`); }
function warn(msg) { console.warn(`[linkedin] ⚠ ${msg}`); }

function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug) return slug;
  // Non-Latin titles (Japanese, Arabic, Cyrillic, etc.) strip to empty here.
  // Fall back to a stable short hash of the input so each unique title still
  // gets its own jds/<slug>.md file instead of every posting colliding on
  // jds/.md.
  const hash = createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10);
  return `jd-${hash}`;
}

function yamlEscape(str) {
  const s = String(str ?? '').replace(/\n/g, ' ').trim();
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unwrapRedirect(href) {
  const trimmed = (href || '').trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (!u.hostname.includes('linkedin.com')) return trimmed;
    if (!u.pathname.includes('/safety/go')) return trimmed;
    const nested = u.searchParams.get('url');
    if (!nested) return trimmed;
    const decoded = decodeURIComponent(nested);
    const decodedUrl = new URL(decoded);
    // Reject javascript:, file:, data:, and other non-web schemes so they
    // can't end up in the JD frontmatter or the persisted application URL.
    if (decodedUrl.protocol !== 'http:' && decodedUrl.protocol !== 'https:') {
      return '';
    }
    return decoded;
  } catch {
    return trimmed;
  }
}

// ── Search URL construction ─────────────────────────────────────────

// LinkedIn's `f_TPR` parameter is the real time-posted filter — `r86400`
// (past 24h), `r604800` (past week), `r2592000` (past month). The previous
// implementation appended "posted in the past week" into the keyword string,
// which made every search a literal-keyword match against descriptive text
// and returned ~0 results. Path also corrected: `/jobs/search-results/`
// renders a blank shell on direct navigation; `/jobs/search/` is the real
// keyword-search entry point.
const DATE_POSTED_TPR = { '24': 'r86400', '2': 'r172800', 'Week': 'r604800', 'Month': 'r2592000' };

// f_WT filter codes for LinkedIn's Work Mode toggles.
const WORK_MODE_F_WT = { 'On-site': '1', 'Remote': '2', 'Hybrid': '3' };

function buildSearchUrl(entry) {
  const levels = Array.isArray(entry.experience_level) ? entry.experience_level : [];
  // experience_level is still concatenated as a keyword prefix rather than
  // mapped to LinkedIn's f_E filter codes. The keyword form broadens the
  // match (no semantic filter) but is not a real "Director-only" filter.
  // Keeping current behavior here to limit blast radius; a follow-up could
  // map ["Director"] → f_E=5, etc.
  const levelPrefix = levels.length ? `${levels.join(' or ')} ` : '';
  const keywords = `${levelPrefix}${entry.search}`;

  const params = new URLSearchParams({ keywords });
  if (DATE_POSTED_TPR[entry.date_posted]) {
    params.set('f_TPR', DATE_POSTED_TPR[entry.date_posted]);
  }
  if (entry.location) {
    params.set('location', entry.location);
  }
  if (entry.geo_id) {
    params.set('geoId', String(entry.geo_id));
  }
  if (entry.distance !== undefined && entry.distance !== null) {
    params.set('distance', String(entry.distance));
  }
  if (Array.isArray(entry.work_mode) && entry.work_mode.length) {
    const codes = entry.work_mode
      .map(mode => WORK_MODE_F_WT[mode])
      .filter(Boolean);
    if (codes.length) params.set('f_WT', codes.join(','));
  }
  return `https://www.linkedin.com/jobs/search/?${params}`;
}

// ── Page interaction primitives ─────────────────────────────────────

async function scrollToLoadResults(page) {
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, randomDelay([300, 600]));
    await sleep(randomDelay([500, 1200]));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1000);
}

async function getCardCount(page) {
  return page.evaluate(sel => document.querySelectorAll(sel).length, SELECTORS.listingCard);
}

async function clickCard(page, index) {
  return page.evaluate(({ sel, link, idx }) => {
    const cards = document.querySelectorAll(sel);
    const card = cards[idx];
    if (!card) return false;
    // Prefer the inner /jobs/view/ link — clicking the bare wrapper sometimes
    // hits a non-clickable parent on certain LinkedIn variants. The link click
    // still loads the right-pane detail without navigating.
    const a = card.querySelector(link);
    (a || card).click();
    return true;
  }, { sel: SELECTORS.listingCard, link: SELECTORS.cardJobsViewLink, idx: index });
}

async function extractDetailFromPanel(page) {
  // Expand description if collapsed (best-effort; some panels render fully
  // expanded already, in which case the button isn't present).
  await page.evaluate(sel => {
    const btn = document.querySelector(sel);
    if (btn && typeof btn.click === 'function') btn.click();
  }, SELECTORS.panelMoreButton);
  await sleep(500);

  return page.evaluate(({ sel, noiseLabels, minLen }) => {
    const titleEl = document.querySelector(sel.panelTitle);
    let title = titleEl?.textContent?.trim() ?? '';
    if (noiseLabels.includes(title.toLowerCase()) || title.length < minLen) {
      title = '';
    }

    const companyEl = document.querySelector(sel.panelCompany);
    const company = companyEl?.textContent?.trim() ?? '';

    const applyEl = document.querySelector(sel.panelApply);
    const applicationUrl = applyEl?.href?.trim() ?? '';

    const jdEl = document.querySelector(sel.panelJdContent);
    const jdText = jdEl?.innerText?.trim() ?? '';

    return { title, company, applicationUrl, jdText, url: window.location.href };
  }, { sel: SELECTORS, noiseLabels: [...NOISE_LABELS], minLen: MIN_TITLE_LENGTH });
}

async function getCurrentPageNumber(page) {
  return page.evaluate(xpath => {
    const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const btn = r.singleNodeValue;
    if (!btn) return 0;
    const m = (btn.getAttribute('aria-label') || '').match(/Page (\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }, SELECTORS.xpathCurrentPage);
}

async function goToNextPage(page) {
  return page.evaluate(({ xpathCurrent, xpathAll }) => {
    const curR = document.evaluate(xpathCurrent, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const curBtn = curR.singleNodeValue;
    if (!curBtn) return false;
    const curM = (curBtn.getAttribute('aria-label') || '').match(/Page (\d+)/);
    if (!curM) return false;
    const curNum = parseInt(curM[1], 10);

    const allR = document.evaluate(xpathAll, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < allR.snapshotLength; i++) {
      const btn = allR.snapshotItem(i);
      const m = (btn.getAttribute('aria-label') || '').match(/Page (\d+)/);
      if (m && parseInt(m[1], 10) === curNum + 1) {
        btn.click();
        return true;
      }
    }
    return false;
  }, { xpathCurrent: SELECTORS.xpathCurrentPage, xpathAll: SELECTORS.xpathPageButton });
}

// ── JD file writer ──────────────────────────────────────────────────

function saveJd(detail) {
  mkdirSync(JDS_DIR, { recursive: true });
  const slug = slugify(`${detail.company}-${detail.title}`);
  const filename = `${slug}.md`;
  const filepath = join(JDS_DIR, filename);

  // Don't overwrite if already exists (multiple keyword searches may surface
  // the same role; first save wins, scan-history dedups subsequent hits).
  if (existsSync(filepath)) return `${JDS_DIR}/${filename}`;

  const today = new Date().toISOString().slice(0, 10);
  const content = `---
title: ${yamlEscape(detail.title)}
company: ${yamlEscape(detail.company)}
url: ${yamlEscape(detail.url)}
application_url: ${yamlEscape(detail.applicationUrl || '')}
scraped: "${today}"
source: linkedin
---

# ${detail.title} — ${detail.company}

${detail.jdText}
`;
  writeFileSync(filepath, content, 'utf-8');
  return `${JDS_DIR}/${filename}`;
}

// ── Search execution ────────────────────────────────────────────────

async function runSearch(page, entry) {
  const max = entry.max_results || 25;
  const delayPages = entry.delay_pages || DEFAULT_DELAY_PAGES;
  const url = buildSearchUrl(entry);

  log(`Search: ${entry.search}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(randomDelay(delayPages));
  await scrollToLoadResults(page);

  const accepted = [];
  const seenInSearch = new Set();
  let hasNextPage = true;

  while (hasNextPage && accepted.length < max) {
    const currentPage = await getCurrentPageNumber(page);
    log(`Page ${currentPage || 1}`);
    await scrollToLoadResults(page);

    const cardCount = await getCardCount(page);
    log(`Found ${cardCount} cards`);

    for (let i = 0; i < cardCount; i++) {
      if (accepted.length >= max) break;

      if (!await clickCard(page, i)) {
        warn(`  ✗ Could not click card ${i}`);
        continue;
      }
      await sleep(randomDelay(delayPages));

      const detail = await extractDetailFromPanel(page);
      if (!detail.title) {
        warn(`  ✗ No title on card ${i}`);
        continue;
      }
      detail.applicationUrl = unwrapRedirect(detail.applicationUrl);

      // Within-search dedup (same role can appear on multiple pages)
      if (seenInSearch.has(detail.url)) continue;
      seenInSearch.add(detail.url);

      if (!detail.jdText) {
        warn(`  ✗ No JD text: ${detail.title}`);
        continue;
      }

      // Persist JD file and return metadata pointing at it
      const jdFile = saveJd(detail);
      accepted.push({
        title: detail.title,
        url: `local:${jdFile}`,
        company: detail.company || '',
        location: '',
        // Stash original LinkedIn URL for downstream tooling that can use it
        _linkedin_url: detail.url,
        _application_url: detail.applicationUrl,
      });
      log(`  ✓ ${detail.title} — ${detail.company}`);
    }

    if (accepted.length < max) {
      hasNextPage = await goToNextPage(page);
      if (hasNextPage) await sleep(randomDelay(delayPages));
    } else {
      hasNextPage = false;
    }
  }

  return accepted;
}

// ── Login flow ──────────────────────────────────────────────────────

function waitForEnter(promptText) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => { rl.close(); resolve(); });
  });
}

// `--login linkedin` entrypoint. Mostly a power-user shortcut now — fetch()
// will trigger the same flow inline when running interactively. Useful for
// re-warming the session before a long unattended run, or for verifying
// auth without kicking off any scans.
async function login() {
  if (loginInProgress) {
    await loginInProgress;
    return true;
  }
  try {
    loginInProgress = doInteractiveLogin()
      .finally(() => { loginInProgress = null; });
    await loginInProgress;
    return true;
  } catch (err) {
    warn(err.message);
    return false;
  }
}

// ── Provider exports ────────────────────────────────────────────────

export default {
  id: 'linkedin',

  // The user's `search` keyword IS the positive filter — LinkedIn's server
  // already returned only matching results. Re-applying the global
  // title_filter.positive on top would double-filter and silently drop
  // legitimate matches whose titles don't contain the literal keyword
  // (e.g. searching "Director of Engineering" returns "Director, Engineering"
  // — same role, different punctuation, blocked by literal substring match).
  // The negative list still applies — those are hard rejects regardless of
  // how the result was sourced.
  bypassPositiveFilter: true,

  detect() { return null; },

  async fetch(entry, _ctx) {
    if (!entry.search) {
      throw new Error(`linkedin: entry ${entry.name} missing 'search' (the keyword query)`);
    }

    // Block until we have a valid session — this triggers the inline login
    // flow on TTY runs, or fails fast on cron/CI runs. Concurrent LinkedIn
    // fetches share a single in-flight login via the loginInProgress promise.
    await ensureSession();

    const ctx = await getContext({ headless: true });
    const page = await ctx.newPage();
    try {
      return await runSearch(page, entry);
    } finally {
      await page.close();
    }
  },

  async login() {
    try {
      return await login();
    } finally {
      await closeContext();
    }
  },

  async cleanup() {
    await closeContext();
  },
};
