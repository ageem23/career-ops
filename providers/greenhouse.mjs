// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

// Hosts an explicit `entry.api` URL is allowed to point at. A loose
// `.includes('greenhouse')` check would happily accept
// `https://evil.com/greenhouse-fake` and exfiltrate the request, so we
// strictly whitelist Greenhouse's documented API hostnames instead.
const GREENHOUSE_API_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards-api.eu.greenhouse.io',
]);

function validateExplicitApi(rawApi) {
  if (typeof rawApi !== 'string' || !rawApi) return null;
  let parsed;
  try { parsed = new URL(rawApi); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (!GREENHOUSE_API_HOSTS.has(parsed.hostname)) return null;
  return parsed.toString();
}

function resolveApiUrl(entry) {
  const explicit = validateExplicitApi(entry.api);
  if (explicit) return explicit;
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

export default {
  id: 'greenhouse',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    const json = await ctx.fetchJson(apiUrl);
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.map(j => ({
      title: j.title || '',
      url: j.absolute_url || '',
      company: entry.name,
      location: j.location?.name || '',
    }));
  },
};
