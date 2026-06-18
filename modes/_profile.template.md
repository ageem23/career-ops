# User Profile Context -- career-ops

<!-- ============================================================
     THIS FILE IS YOURS. It will NEVER be auto-updated.
     
     Customize everything here: your archetypes, narrative,
     proof points, negotiation scripts, location policy.
     
     The system reads _shared.md (updatable) first, then this
     file (your overrides). Your customizations always win.
     ============================================================ -->

## Your Target Roles

<!-- Replace these with YOUR target roles. Examples:
     - Senior Backend Engineer / Staff Platform Engineer
     - AI Product Manager / Technical PM
     - Data Engineer / ML Engineer
     - DevOps / SRE / Platform
     Whatever you're optimizing for. -->

| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **AI Platform / LLMOps Engineer** | Evaluation, observability, reliability, pipelines | Someone who puts AI in production with metrics |
| **Agentic Workflows / Automation** | HITL, tooling, orchestration, multi-agent | Someone who builds reliable agent systems |
| **Technical AI Product Manager** | GenAI/Agents, PRDs, discovery, delivery | Someone who translates business to AI product |
| **AI Solutions Architect** | Hyperautomation, enterprise, integrations | Someone who designs end-to-end AI architectures |
| **AI Forward Deployed Engineer** | Client-facing, fast delivery, prototyping | Someone who delivers AI solutions to clients fast |
| **AI Transformation Lead** | Change management, adoption, org enablement | Someone who leads AI transformation in an org |

## Your Adaptive Framing

<!-- Map YOUR projects to each archetype. Example:
     | Platform / LLMOps | My monitoring dashboard project | article-digest.md |
     | Agentic | My chatbot with HITL escalation | cv.md section 3 | -->

| If the role is... | Emphasize about you... | Proof point sources |
|-------------------|------------------------|---------------------|
| Platform / LLMOps | Production systems builder, observability, evals | article-digest.md + cv.md |
| Agentic / Automation | Multi-agent orchestration, HITL, reliability | article-digest.md + cv.md |
| Technical AI PM | Product discovery, PRDs, metrics | cv.md + article-digest.md |
| Solutions Architect | System design, integrations, enterprise-ready | article-digest.md + cv.md |
| Forward Deployed Engineer | Fast delivery, client-facing, prototype to prod | cv.md + article-digest.md |
| AI Transformation Lead | Change management, team enablement, adoption | cv.md + article-digest.md |

## Evaluation Early-Exit (batch efficiency)

<!-- ============================================================
     OPTIONAL — speeds up batch runs by short-circuiting offers
     that are clearly disqualified, instead of running the full
     A–G evaluation on every one.

     It is candidate-agnostic: every specific is read at runtime
     from config/profile.yml (your archetypes) and cv.md (your
     background + credentials) — nothing here is tied to a person.
     Keep it as-is, tune the triggers, or delete the section to
     always run the full evaluation.
     ============================================================ -->

A process override in the rules layer — applies to **all A–G evaluations** (batch workers and interactive). It is **candidate-agnostic**: every specific (target archetypes, level range, the candidate's background and credentials) is read at evaluation time from `config/profile.yml` and `cv.md`. Nothing about a particular candidate is hardcoded here.

**Rule:** Run **Block A** (archetype) and **Block B** (CV match + hard blockers) first. If the offer hits a **clear disqualifier evident from the JD text alone**, stop there — write an abbreviated report, score it, mark status `SKIP`, and **skip Blocks C–F** (no comp research, no interview plan). Otherwise run the full A–G as normal.

**Early-exit triggers** — fire only when one is unambiguous:
1. **Archetype mismatch** — the role's domain or function falls entirely outside *every* archetype defined in `config/profile.yml`, with no plausible bridge.
2. **Hard credential blocker** — the JD *requires* a credential, license, or clearance that `cv.md` shows the candidate does not hold and could not realistically acquire in time.
3. **Level mismatch** — the role's level sits clearly outside the range covered by the archetypes in `config/profile.yml` (e.g. a pure individual-contributor role with no leadership scope when every archetype is a people-leadership role).

**Do NOT early-exit — run the full A–G — when:**
- The role plausibly matches any archetype in `config/profile.yml`, even if seniority, comp, or tech stack look weak.
- It is likely to land in the mid-band (roughly 2.5–4.0 on the 1–5 scale). Early-exit is only for offers clearly heading to the bottom of the scale.
- There is any genuine doubt. A wrongly-skipped good role costs an opportunity; a fully-evaluated weak role only costs ~5 minutes. **When in doubt, evaluate fully.**

**Abbreviated report format (when early-exit fires):** standard header (Date, Archetype, Score, Legitimacy, URL, Verification, PDF, Batch ID) + full **Block A** + **Block B** (name the disqualifier and which trigger it hit) + one line for **Blocks C–F** (`Skipped — early-exit: {trigger}`) + a 1–2 line **Block G** (no web research) + **Score Global** table (low score, status `SKIP`) + **Keywords extracted**. The tracker TSV is written normally with status `SKIP`.

## Your Exit Narrative

<!-- Replace with YOUR story. This frames everything. -->

Use the candidate's exit story from `config/profile.yml` to frame ALL content:
- **In PDF Summaries:** Bridge from past to future
- **In STAR stories:** Reference proof points from article-digest.md
- **In Draft Answers:** The transition narrative appears in the first response

## Your Cross-cutting Advantage

<!-- What's your "signature move"? What do you do that others can't? -->

Frame profile as **"Technical builder with real-world proof"** that adapts framing to the role.

## Your Portfolio / Demo

<!-- If you have a live demo, dashboard, or public project:
     url: https://yoursite.dev/demo
     password: demo-2026
     when_to_share: "LLMOps, AI Platform roles" -->

If you have a live demo/dashboard (check profile.yml), offer access in applications for relevant roles.

## Your Comp Targets

<!-- Research comp ranges for YOUR target roles -->

**General guidance:**
- Use WebSearch for current market data (Glassdoor, Levels.fyi, Blind)
- Frame by role title, not by skills
- Contractor rates are typically 30-50% higher than employee base

## Your Negotiation Scripts

<!-- Adapt to YOUR situation, currency, location -->

**Salary expectations:**
> "Based on market data for this role, I'm targeting [RANGE from profile.yml]. I'm flexible on structure -- what matters is the total package and the opportunity."

**Geographic discount pushback:**
> "The roles I'm competitive for are output-based, not location-based. My track record doesn't change based on postal code."

**When offered below target:**
> "I'm comparing with opportunities in the [higher range]. I'm drawn to [company] because of [reason]. Can we explore [target]?"

## Your Location Policy

<!-- Adapt to YOUR situation -->

**In forms:**
- Follow your actual availability from profile.yml
- Specify timezone overlap in free-text fields

**In evaluations (scoring):**
- Remote dimension for hybrid outside your country: score **3.0** (not 1.0)
- Only score 1.0 if JD says "must be on-site 4-5 days/week, no exceptions"

## Skill Behavior Defaults

<!-- ============================================================
     OPTIONAL — controls whether `contacto` (and any other skill
     that supports it) runs INLINE in your CLI or emits a
     copy-paste PROMPT for claude.ai web (with Research mode).

     Set a row to "prompt" if you find the web Claude consistently
     gives better results for that skill — common for skills that
     need broad web search and LinkedIn lookups.

     Per-invocation, you can override by saying "run inline" or
     "give me the prompt" in your message.

     The matching machine-readable block lives in
     config/profile.yml -> skill_behavior.
     ============================================================ -->

| Skill | Default mode | Notes |
|-------|--------------|-------|
| `contacto` | `prompt` | Emit a copy-paste prompt for claude.ai web (Research mode) — better LinkedIn lookups + name verification than CLI WebSearch. Set to `inline` to run the workflow in your CLI instead |
| `deep` | `prompt` | `deep` is already prompt-generating by design — leave as `prompt` unless you want the CLI to also do the research run itself |

**Override path per invocation:**
- "run inline" / "do it yourself" → forces `inline`
- "give me the prompt" / "as a prompt" → forces `prompt`
