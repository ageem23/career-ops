# Mode: deep — Deep Research Prompt

Generate a structured prompt for Perplexity/Claude/ChatGPT with 6 axes:

```text
## Deep Research: [Company] — [Role]

Context: I am evaluating a candidacy for [role] at [company]. I need actionable information for the interview.

**Output format:** Respond in plain, raw Markdown: `##`/`###` headings, `-` lists, and Markdown tables where useful. For each source include the full URL as a Markdown link `[title](https://…)`. Do NOT use artifacts, "internal links", citation widgets, or any element exclusive to the web interface — the result must be copy-pasteable as Markdown text into any editor.

### 1. AI Strategy
- What products/features use AI/ML?
- What is their AI stack? (models, infrastructure, tools)
- Do they have an engineering blog? What do they publish?
- What papers or talks have they presented on AI?

### 2. Recent moves (last 6 months)
- Relevant hires in AI/ML/product?
- Acquisitions or partnerships?
- Product launches or pivots?
- Funding rounds or leadership changes?

### 3. Engineering culture
- How do they ship? (deployment cadence, CI/CD)
- Monorepo or multirepo?
- What languages/frameworks do they use?
- Remote-first or office-first?
- Glassdoor/Blind reviews about engineering culture?

### 4. Likely challenges
- What scaling problems do they have?
- Reliability, cost, latency challenges?
- Are they migrating anything? (infrastructure, models, platforms)
- What pain points do people mention in reviews?

### 5. Competitors and differentiation
- Who are their main competitors?
- What is their moat/differentiator?
- How are they positioned vs competitors?

### 6. Candidate angle
Given my profile (read from cv.md and profile.yml for specific experience):
- What unique value do I bring to this team?
- Which of my projects are most relevant?
- What story should I tell in the interview?
```

Personalize each section with the specific context of the job being evaluated,
in the language resolved in the **Language** section above (NOT always English).
**Always keep the "Output format" instruction (raw Markdown)** when translating
or personalizing — it is what prevents Claude web from returning artifacts or
internal links instead of copy-pasteable Markdown.
