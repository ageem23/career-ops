# Mode: contacto -- LinkedIn Power Move

## 🚦 STOP — RESOLVE ACTIVE MODE FIRST (before reading anything else)

This skill has **two execution modes**. You MUST decide which one is active **before** reading any other section of this file. Both modes are mutually exclusive — running both is a bug.

**Resolution procedure (do this now):**

1. **Per-invocation override beats everything.** Scan the user's current message + the immediately preceding turn:
   - "run inline" / "do it yourself" / "execute" / "search LinkedIn" → mode = `inline`
   - "give me the prompt" / "as a prompt" / "for claude.ai" / "research prompt" → mode = `prompt`
2. **Read `modes/_profile.md`.** Look for `## Skill Behavior Defaults`. If a row for `contacto` exists, use its value.
3. **Fallback to `config/profile.yml`** → `skill_behavior.contacto.default_mode`.
4. **No preference anywhere** → default to **`prompt`** (web Claude with Research mode handles the LinkedIn lookups + name verification more reliably than Claude Code's WebSearch).

**ROUTING — pick exactly one:**

| Resolved mode | What to do |
|---------------|------------|
| `prompt` | Go to **"## MODE A — Prompt output"** below. **DO NOT** read or execute MODE B. Stop at the end of Mode A. |
| `inline` | Skip MODE A entirely. Execute **"## MODE B — Inline workflow"**. |

If you find yourself drafting a `Sending to:` line, opening WebSearch tabs, or composing a LinkedIn message body — and you have NOT confirmed mode = `inline` — you are in the wrong mode. Stop, re-read this section, and resolve.

---

## MODE A — Prompt output (when resolved mode = `prompt`)

Your job is to emit a **single copy-paste-ready research prompt** that the user pastes into a new claude.ai web chat with **Research mode** enabled. You do NOT perform LinkedIn lookups, name verification, or message drafting yourself in this mode — the web Claude does all of that with better tooling.

**Output structure (in this exact order):**

1. A short one-line intro: `Paste this into claude.ai with Research mode enabled:`
2. **One single fenced markdown code block** containing the full research prompt (template below). The entire prompt MUST be inside one code block so it's one-click-to-copy.
3. After the code block: the contacts table + `add-task.mjs` copy-paste block (per **Step 5** and **Step 6** in MODE B below — those still emit in prompt mode so the user can track follow-ups even without doing the lookups themselves).

**Prompt template — customize the placeholders before emitting:**

````markdown
## Contacto Research: {Company} — {Role}

**My profile (for message tailoring):**
- {1-line summary from cv.md headline + key proof points from _profile.md narrative}
- LinkedIn: {linkedin url from config/profile.yml}

**Target role:** {Role} at {Company}{ — comp/location notes if known}. Job URL: {URL if provided}.

---

### 1. Identify Targets (find 4–6 real people, in priority order)

**Priority 1 — Hiring Manager** for this role. {Likely titles, where to look — engineering blog, "People at {Company}" filtered by senior eng, podcast/talk appearances.}
**Priority 2 — Engineering Managers / Directors** in the relevant org. {Where to cross-reference: company eng blog authors, GitHub org, conference talks.}
**Priority 3 — Technical recruiter** assigned to roles at this level/company. {LinkedIn "Talent Acquisition" + this company.}
**Priority 4 — One or two peer ICs** on the relevant team. {Staff/Principal/Senior eng on the same org.}

For each target, return: verified full name (copy-paste from LinkedIn), LinkedIn URL, current title, one-sentence reason they're the right target, and one unique hook from their public footprint (recent talk, blog post, GitHub repo, podcast, post, tenure milestone).

### 2. Name Verification Protocol (MANDATORY before drafting)

Past incident: a contact message went out with the right LinkedIn URL but the wrong first name. To make that impossible, for each target you'll draft to:
1. Quote the full name verbatim from their LinkedIn profile (do not retype from memory).
2. State the exact salutation form you'll use (first name, preferred/known-as name in parentheses if any, or honorific + last name).
3. Flag any failure modes: nickname in parentheses, compound first names, accented characters, two same-company employees with similar names.
4. State the lock-in line: `Recipient: {Full Name} (salutation: "{First Name}") — {LinkedIn URL}`

If you can't confidently verify, mark "name unverified — DO NOT SEND" and skip drafting for that target.

### 3. Draft a 3-Sentence Connection Message (per target, ≤ 300 characters)

Each message MUST start with the verification metadata line (NOT counted against 300 limit, NOT sent in the actual message):

> **Sending to:** {Full Name} ({LinkedIn URL}) — addressed as "{salutation in message}"

Then the message body, using these per-contact-type structures:

**Hiring Manager:** Hook (specific challenge their team faces) → Proof (one quantifiable accomplishment) → CTA ("Would love to hear how your team is approaching {challenge}").
**Recruiter:** Fit (role + experience + location match) → Screening pre-empt (answer their obvious questions) → CTA ("Happy to share my CV if it aligns").
**Peer:** Genuine interest (reference to their specific public work) → Parallel (something I'm doing in the same space, NOT a job pitch) → CTA ("Would love to hear your take on {their topic}"). **Hard rule:** NEVER ask for a referral or hint at hiring.
**Interviewer:** Research (reference their work/trajectory) → Light connection (my adjacent experience) → CTA ("Looking forward to our conversation on {date}").

No corporate-speak. No "I'm passionate about." ≤ 300 chars hard limit.

### 4. Alternative Targets
For each primary, one alternate at the same level with a one-sentence reason — a defensible second choice if the primary doesn't respond within a week.

---

**Deliverable:** Up to 6 verified targets, lock-in lines per target, custom 3-sentence messages per target, alternates, and a 1-sentence sequencing recommendation (who to message first, who to wait on).
````

After the code block, emit the contacts table and the `add-task.mjs` block per **Step 5** and **Step 6** in MODE B.

**END OF MODE A. Do not proceed into MODE B.**

---

## MODE B — Inline workflow (when resolved mode = `inline`)

⚠️ Only execute everything below if you resolved mode = `inline` in the routing step above.

### Output contract (read this before starting)

Every `contacto` invocation in `inline` mode produces, in this order and without exceptions:

1. A LinkedIn message for the **primary target** (sentences 1-2-3, ≤300 characters), **preceded by the `Sending to:` line** defined in Step 3.5 and the mandatory name verification at the bottom of this file.
2. A **numbered table of suggested contacts** (primary + alternates), with the `App#` column resolved from `data/applications.md`.
3. An **`add-task.mjs` copy-paste block** — always, regardless of environment (Claude Code, Claude web, other CLI). The block is always emitted; it is not optional.

If you end your response without the `Sending to:` line or without the `add-task.mjs` block, you have not completed the mode.

---

## Step 1 — Identify targets

Via WebSearch:
- Hiring manager of the team
- Assigned recruiter
- 2-3 team peers (people with similar roles)
- Interviewer (if the candidate already has a scheduled interview)

## Step 2 — Classify contact type

Ask the candidate or infer from context:
- **Recruiter** — person whose role is talent acquisition, sourcing, or recruiting
- **Hiring Manager** — the person who leads the hiring team
- **Peer** — someone with a similar role in the team (indirect referral)
- **Interviewer** — someone who will interview the candidate (known date)

## Step 3 — Select primary target

The person who would benefit most from the candidate being there.

## Step 3.5 — Lock in recipient identity (MANDATORY before drafting)

- Capture the verified **full name** exactly as it appears on their LinkedIn profile (or the source you pulled them from). Copy-paste — do NOT retype from memory.
- Decide the **salutation form** explicitly: first name only (default for LinkedIn), preferred/known-as name if different from legal name, or honorific + last name if the context calls for it.
- Watch for these failure modes:
  - Pulled the recipient from one tab but drafted the message while looking at a different person/JD.
  - Profile shows "Preferred: X" or a nickname in parentheses — use that, not the legal first name.
  - Compound first names, accented characters, or non-Latin scripts — preserve exactly.
  - Two people with similar names at the same company — re-confirm the URL/profile.
- Write the locked-in recipient as a single line at the top of the draft block, e.g. `Recipient: Jane Doe (salutation: "Jane") — linkedin.com/in/janedoe`. This is the source of truth for the message in Step 4 and for the **mandatory name verification** at the bottom of this file.

## Step 4 — Generate message (3 sentences, ≤300 characters)

Adapt the framework to the contact type:

### Recruiter
- **Sentence 1 (Fit)**: Direct match criteria — role, relevant experience, availability, or location
- **Sentence 2 (Proof)**: Data that answers their screening questions before they ask them (e.g., "5 years building ML pipelines, currently in Berlin, available immediately")
- **Sentence 3 (CTA)**: "Happy to share my CV if this aligns with what you're looking for"

### Hiring Manager
- **Sentence 1 (Hook)**: Specific challenge their team is facing (extracted from the JD, company blog, or news)
- **Sentence 2 (Proof)**: Candidate's greatest quantifiable achievement showing they have solved similar problems
- **Sentence 3 (CTA)**: "Would love to hear how your team is approaching [specific challenge]"

### Peer (referral)
- **Sentence 1 (Interest)**: Genuine reference to their work — blog post, talk, open-source project, or publication
- **Sentence 2 (Connection)**: Something the candidate is doing in the same space (NOT a job pitch)
- **Sentence 3 (CTA)**: "I've been working on similar problems at [company], would love to hear your take on [topic]"
- **Note**: DO NOT ask for a job. The referral happens naturally if the conversation flows.

### Interviewer (pre-interview)
- **Sentence 1 (Research)**: Reference to something specific from their work or trajectory
- **Sentence 2 (Context)**: Light connection to the candidate's experience in that area
- **Sentence 3 (CTA)**: "Looking forward to our conversation on [date]"
- **Note**: Light tone, not desperate. The goal is to show that you prepared.

**Languages**: EN (default). ES if the company is Spanish.

## Step 5 — Contacts table + App# lookup (MANDATORY)

List the primary and the alternates in a table. Before showing it, look up the `App#` for each:

- Open `data/applications.md`.
- Find the most recent row where `Company` == the contact's company and status is active (`Applied` / `Responded` / `Interview` / `Evaluated`).
- If there is a match, write the number from the `#` column into the `App#` column of the table. If no match, write `-`.

```markdown
| # | Name | Role | Company | App# | LinkedIn |
|---|------|------|---------|------|----------|
| 1 | Jane Doe | Recruiter | Acme | 412 | linkedin.com/in/jane-doe |
| 2 | John Smith | Hiring Manager | Acme | 412 | linkedin.com/in/john-smith |
```

## Step 6 — add-task.mjs block (MANDATORY — always)

Immediately after the table, **always** emit a paste-ready bash block. One line per contact, no prior confirmation needed (the idempotency of `add-task.mjs` makes it safe for the user to run selectively or in full):

```bash
node add-task.mjs --type contact --app 412 --title "LinkedIn: Jane Doe (Recruiter)" --notes "linkedin.com/in/jane-doe"
node add-task.mjs --type contact --app 412 --title "LinkedIn: John Smith (Hiring Manager)" --notes "linkedin.com/in/john-smith"
```

Block rules (non-negotiable):
- One command per line, no backslash line continuations — the user must be able to paste the entire block.
- Include `--app {number}` when there is a match in the tracker. `add-task.mjs` auto-fills `--company` from `data/applications.md`, so `--company` is omitted when `--app` is present.
- If there is no match, omit `--app` and pass `--company "{Company}"` explicitly.
- `--title` must use the exact pattern `LinkedIn: {Name} ({Role})`. `--notes` must contain the LinkedIn URL (without `https://`).
- Quote outer double quotes; escape inner quotes with `\"`.

Close the block with the line: **"Paste this into a terminal in the project directory."**

If the agent has Bash access (Claude Code), additionally offer to run the block immediately. In Claude web the user copies and pastes.

`add-task.mjs` is idempotent: re-running with the same type, title, and App# does not duplicate the task.

---

## Message rules

- Maximum 300 characters (LinkedIn connection request limit)
- NO corporate-speak
- NO "I'm passionate about..."
- Something that makes them want to respond
- NEVER share phone number
- The contact type changes the EMPHASIS, not the structure

## MANDATORY name verification (do this BEFORE presenting the message to the user)

Past incident: a `contacto` went out addressed to the right person but with the wrong first name. The user reviewed it but did not catch the error. This verification exists so that kind of mistake becomes impossible to miss.

Before showing the final message, run this checklist explicitly in your response:

1. **Literal check**: copy the salutation from the drafted message (e.g. "Hi Sarah,") and compare it character-by-character against the `Recipient` line confirmed in Step 3.5. Flag any discrepancy — capitalization, accents, missing/extra characters, or an entirely different name.
2. **No substitutions**: confirm the name in the message did not autocomplete to a more common variant (Sara vs. Sarah, Stephen vs. Steven, José vs. Jose).
3. **Right person**: re-confirm the recipient's LinkedIn URL and that the message hook (company, role, project reference) belongs to THAT person, not a target you considered earlier.
4. **Presentation format**: when showing the final message to the user, lead with a confirmation line:
   > **Sending to:** {Full name} ({LinkedIn URL}) — addressed as "{salutation in the message}"

   Then the message body. The **Sending to:** line is pre-send verification metadata — it is **not** part of the outgoing message and does not count against the 300-character InMail limit. The user should be able to scan the salutation and the "Sending to:" line side-by-side without having to search.

If any check fails or you have any doubt, STOP and ask the user to confirm before continuing. A wrong name in a cold message is unrecoverable — better to ask than to send.
