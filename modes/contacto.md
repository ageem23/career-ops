# Modo: contacto -- LinkedIn Power Move

## Mode selection (CHECK BEFORE EXECUTING)

Two execution modes are supported. The user picks which one is the default in
`modes/_profile.md` → `## Skill Behavior Defaults` (or `config/profile.yml` →
`skill_behavior.contacto.default_mode`). Resolution order:

1. **Per-invocation override** — if the user explicitly says "run inline" /
   "do it yourself" / "execute" → use `inline`. If they say "give me the
   prompt" / "as a prompt" / "for claude.ai" → use `prompt`.
2. **`modes/_profile.md` → "Skill Behavior Defaults"** — read this section
   and honor whatever the user wrote there. This is the authoritative source.
3. **`config/profile.yml` → `skill_behavior.contacto.default_mode`** — if
   `_profile.md` is silent, fall back to this machine-readable value.
4. **No preference set** — default to `prompt` (web Claude with Research mode does the broad LinkedIn lookups + name verification more reliably than Claude Code's WebSearch for this skill).

### Mode A — `prompt`

Output a **single copy-paste-ready prompt** the user pastes into a new
claude.ai web chat (with Research mode enabled) — do NOT execute the LinkedIn
lookups yourself.

The prompt MUST:
- Be a single fenced markdown code block so it's one-click-to-copy.
- Be customized with the specific company + role + Mathieu's relevant context
  (CTO 24 years at a consultancy, agentic AI rollout, etc. — pull from
  `cv.md`, `_profile.md`, `proof-points.md`).
- Embed the **name-verification protocol** below (`Sending to:` lock-in,
  the explicit verification checklist) so the web Claude follows it.
- Specify the 3-sentence message structures by contact type
  (Recruiter / Hiring Manager / Peer / Interviewer) verbatim from the
  "Frameworks per contact type" section below.
- End with a clear `**Deliverable:**` line stating what the web Claude
  should return (verified targets, lock-in lines, custom messages,
  alternates, sequencing recommendation).

After the code block, output the **table of suggested contacts** (companies
the user has applied to, mapped from `data/applications.md`) AND the
**`add-task.mjs` copy-paste block** — these stay even in prompt mode so the
user can still track follow-up tasks.

### Mode B — `inline`

Execute the original workflow below: WebSearch for targets, verify names,
draft messages, output the full deliverable per the contract.

---

## Output contract (inline mode — lee esto antes de empezar)

Toda invocacion de `contacto` en modo `inline` produce, en este orden y sin excepciones:

1. Un mensaje de LinkedIn al **target primario** (frases 1-2-3, ≤300 caracteres).
2. Una **tabla numerada de contactos sugeridos** (primario + alternativos), con la columna `App#` resuelta desde `data/applications.md`.
3. Un **bloque `add-task.mjs` copy-paste** -- siempre, sea cual sea el entorno (Claude Code, Claude web, otro CLI). El bloque va siempre; no es opcional.

Si terminas tu respuesta sin el bloque `add-task.mjs`, no has completado el modo.

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
