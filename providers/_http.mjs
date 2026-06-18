// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';

// String-only check — no DNS resolution. The scanner runs against public job
// boards on the user's own machine; we cover the obvious SSRF abuses
// (loopback, link-local, RFC1918, ULA) and accept that a sophisticated
// DNS-rebinding attack is out of scope.
function isPrivateOrLocalHost(host) {
  if (!host) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  const m4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m4) {
    const [a, b] = m4.slice(1).map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^fe[89ab][0-9a-f]:/i.test(h)) return true;
  return false;
}

// Validate before any outbound request — empty/missing URL, unsupported
// scheme, or loopback/private host all reject with a clear error.
export function assertSafeHttpUrl(rawUrl) {
  if (!rawUrl) throw new Error('Missing URL');
  let u;
  try { u = new URL(rawUrl); } catch {
    throw new Error(`Unparseable URL: ${String(rawUrl).slice(0, 80)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${u.protocol}`);
  }
  if (isPrivateOrLocalHost(u.hostname)) {
    throw new Error(`Blocked URL host (loopback/private): ${u.hostname}`);
  }
}

async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'follow' } = {}) {
  assertSafeHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      body,
      redirect,
      signal: controller.signal,
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      const snippet = responseText.replace(/\s+/g, ' ').trim().slice(0, 300);
      const err = new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
      err.status = res.status;
      err.body = responseText;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.json();
}

export async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.text();
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
  };
}
