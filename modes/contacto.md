# Modo: contacto -- LinkedIn Power Move

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
3. After the code block: the contacts table + `add-task.mjs` copy-paste block (per **Paso 5** and **Paso 6** in MODE B below — those still emit in prompt mode so the user can track follow-ups even without doing the lookups themselves).

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

After the code block, emit the contacts table and the `add-task.mjs` block per **Paso 5** and **Paso 6** in MODE B.

**END OF MODE A. Do not proceed into MODE B.**

---

## MODE B — Inline workflow (when resolved mode = `inline`)

⚠️ Only execute everything below if you resolved mode = `inline` in the routing step above.

### Output contract (lee esto antes de empezar)

Toda invocacion de `contacto` en modo `inline` produce, en este orden y sin excepciones:

1. Un mensaje de LinkedIn al **target primario** (frases 1-2-3, ≤300 caracteres), **precedido de la linea `Sending to:`** definida en el Paso 3.5 y la Verificación de nombre obligatoria al pie de este archivo.
2. Una **tabla numerada de contactos sugeridos** (primario + alternativos), con la columna `App#` resuelta desde `data/applications.md`.
3. Un **bloque `add-task.mjs` copy-paste** -- siempre, sea cual sea el entorno (Claude Code, Claude web, otro CLI). El bloque va siempre; no es opcional.

Si terminas tu respuesta sin la linea `Sending to:` o sin el bloque `add-task.mjs`, no has completado el modo.

---

## Paso 1 -- Identificar targets

Via WebSearch:
- Hiring manager del equipo
- Recruiter asignado
- 2-3 peers del equipo (gente con rol similar)
- Interviewer (si el candidato ya tiene entrevista programada)

## Paso 2 -- Clasificar tipo

Preguntar al candidato o inferir del contexto:
- **Recruiter** -- persona cuyo rol es talent acquisition, sourcing, o recruiting
- **Hiring Manager** -- la persona que lidera el equipo que contrata
- **Peer** -- alguien con un rol similar en el equipo (referral indirecto)
- **Interviewer** -- alguien que va a entrevistar al candidato (fecha conocida)

## Paso 3 -- Seleccionar target primario

La persona que mas se beneficiaria de que el candidato estuviera alli.

## Paso 3.5 -- Lock in recipient identity (MANDATORY before drafting)

- Capture the verified **full name** exactly as it appears on their LinkedIn profile (or the source you pulled them from). Copy-paste — do NOT retype from memory.
- Decide the **salutation form** explicitly: first name only (default for LinkedIn), preferred/known-as name if different from legal name, or honorific + last name if the context calls for it.
- Watch for these failure modes:
  - Pulled the recipient from one tab but drafted the message while looking at a different person/JD.
  - Profile shows "Preferred: X" or a nickname in parentheses — use that, not the legal first name.
  - Compound first names, accented characters, or non-Latin scripts — preserve exactly.
  - Two people with similar names at the same company — re-confirm the URL/profile.
- Write the locked-in recipient as a single line at the top of the draft block, e.g. `Recipient: Jane Doe (salutation: "Jane") — linkedin.com/in/janedoe`. This is the source of truth for the message in Paso 4 and for the **Verificación de nombre obligatoria** at the bottom of this file.

## Paso 4 -- Generar mensaje (3 frases, ≤300 caracteres)

Adaptar el framework al tipo de contacto:

### Recruiter
- **Frase 1 (Fit)**: Criterios de match directo -- rol, experiencia relevante, disponibilidad o ubicacion
- **Frase 2 (Prueba)**: Dato que responda sus preguntas de screening antes de que las hagan (ej: "5 years building ML pipelines, currently in Berlin, available immediately")
- **Frase 3 (CTA)**: "Happy to share my CV if this aligns with what you're looking for"

### Hiring Manager
- **Frase 1 (Gancho)**: Reto especifico que enfrenta su equipo (extraido del JD, company blog, o noticias)
- **Frase 2 (Prueba)**: Mayor logro cuantificable del candidato que demuestre que ha resuelto problemas similares
- **Frase 3 (CTA)**: "Would love to hear how your team is approaching [reto especifico]"

### Peer (referral)
- **Frase 1 (Interes)**: Referencia genuina a su trabajo -- blog post, charla, proyecto open source, o publicacion
- **Frase 2 (Conexion)**: Algo que el candidato esta haciendo en el mismo espacio (NO un pitch de empleo)
- **Frase 3 (CTA)**: "I've been working on similar problems at [empresa], would love to hear your take on [tema]"
- **Nota**: NO pedir empleo. La referral ocurre naturalmente si la conversacion fluye.

### Interviewer (pre-entrevista)
- **Frase 1 (Research)**: Referencia a algo especifico de su trabajo o trayectoria
- **Frase 2 (Contexto)**: Conexion ligera con la experiencia del candidato en ese tema
- **Frase 3 (CTA)**: "Looking forward to our conversation on [fecha]"
- **Nota**: Tono ligero, no desesperado. El objetivo es que sepan que te preparaste.

**Idiomas**: EN (default). ES si la empresa es espanola.

## Paso 5 -- Tabla de contactos + App# lookup (OBLIGATORIO)

Listar el primario y los alternativos en una tabla. Antes de mostrarla, buscar el `App#` para cada uno:

- Abrir `data/applications.md`.
- Buscar la fila mas reciente con `Company` == empresa del contacto y status activo (`Applied` / `Responded` / `Interview` / `Evaluated`).
- Si hay match, escribir el numero de la columna `#` en la columna `App#` de la tabla. Si no hay match, escribir `-`.

```markdown
| # | Nombre | Rol | Empresa | App# | LinkedIn |
|---|--------|-----|---------|------|----------|
| 1 | Jane Doe | Recruiter | Acme | 412 | linkedin.com/in/jane-doe |
| 2 | John Smith | Hiring Manager | Acme | 412 | linkedin.com/in/john-smith |
```

## Paso 6 -- Bloque add-task.mjs (OBLIGATORIO -- siempre)

Inmediatamente despues de la tabla, **siempre** emitir un bloque bash listo para pegar. Una linea por contacto, sin pedir confirmacion previa (la idempotencia de `add-task.mjs` hace seguro que el usuario lo ejecute selectivamente o entero):

```bash
node add-task.mjs --type contact --app 412 --title "LinkedIn: Jane Doe (Recruiter)" --notes "linkedin.com/in/jane-doe"
node add-task.mjs --type contact --app 412 --title "LinkedIn: John Smith (Hiring Manager)" --notes "linkedin.com/in/john-smith"
```

Reglas del bloque (no negociables):
- Un comando por linea, sin barras invertidas de continuacion -- el usuario debe poder pegar el bloque entero.
- Incluir `--app {numero}` cuando exista match en el tracker. `add-task.mjs` auto-rellena `--company` desde `data/applications.md`, asi que se omite `--company` cuando hay `--app`.
- Si no hay match, omitir `--app` y pasar `--company "{Empresa}"` explicitamente.
- `--title` debe usar el patron exacto `LinkedIn: {Nombre} ({Rol})`. `--notes` debe contener la URL de LinkedIn (sin `https://`).
- Citar comillas dobles externas; escapar comillas internas con `\"`.

Cerrar el bloque con la frase: **"Pega esto en una terminal en el directorio del proyecto."**

Si el agente tiene acceso a Bash (Claude Code), ofrecer adicionalmente ejecutar el bloque al instante. En Claude web el usuario lo copia y pega.

`add-task.mjs` es idempotente: re-ejecutar con el mismo tipo, titulo y App# no duplica la tarea.

---

## Reglas del mensaje

- Maximo 300 caracteres (LinkedIn connection request limit)
- NO corporate-speak
- NO "I'm passionate about..."
- Algo que haga que quieran responder
- NUNCA compartir telefono
- El tipo de contacto cambia el ENFASIS, no la estructura

## Verificación de nombre OBLIGATORIA (hacer ANTES de presentar el mensaje al usuario)

Incidente previo: se envió un `contacto` que se dirigía a la persona correcta con el nombre incorrecto. El usuario lo revisó pero no detectó el error. Esta verificación existe para que ese tipo de error sea imposible de pasar por alto.

Antes de mostrar el mensaje final, ejecutar esta lista de verificación de manera explícita en la respuesta:

1. **Comprobación literal**: copiar el saludo del mensaje redactado (p. ej. "Hi Sarah,") y compararlo carácter por carácter con la línea `Recipient` confirmada en el paso 3.5. Marcar cualquier discrepancia — mayúsculas, acentos, caracteres faltantes/extra, o nombre completamente distinto.
2. **Sin sustituciones**: confirmar que el nombre en el mensaje no se completó automáticamente con una variante más común (Sara vs. Sarah, Stephen vs. Steven, José vs. Jose).
3. **Persona correcta**: reafirmar la URL de LinkedIn del destinatario y confirmar que el gancho del mensaje (empresa, rol, referencia a proyecto) corresponde a ESA persona, no a un objetivo considerado anteriormente.
4. **Formato de presentación**: al mostrar el mensaje final al usuario, encabezar con una línea de confirmación:
   > **Sending to:** {Nombre completo} ({LinkedIn URL}) — dirigido como "{saludo del mensaje}"

   Luego el cuerpo del mensaje. La línea **Sending to:** es metadata de verificación previa al envío — **no** debe incluirse en el mensaje saliente ni contarse contra el límite de 300 caracteres de InMail. El usuario debe poder escanear el saludo y la línea "Sending to:" en paralelo sin tener que buscar.

Si alguna verificación falla o tienes dudas, DETENERSE y pedir al usuario que confirme antes de continuar. Un nombre incorrecto en un mensaje en frío es irrecuperable — mejor preguntar que enviar.
