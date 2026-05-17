// Ashby provider — hits the public posting-api endpoint.
// Auto-detects from careers_url pattern `https://jobs.ashbyhq.com/<slug>`.

function resolveApiUrl(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.ashbyhq.com/posting-api/job-board/${match[1]}?includeCompensation=true`;
}

export default {
  id: 'ashby',

  detect(entry) {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`ashby: cannot derive API URL for ${entry.name}`);
    const json = await ctx.fetchJson(apiUrl);
    // Guard against malformed upstream payloads — a truthy non-array
    // `json.jobs` (e.g. an object on an error page) would crash `.map()`.
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs.map(j => ({
      title: j.title || '',
      url: j.jobUrl || '',
      company: entry.name,
      location: j.location || '',
    }));
  },
};
