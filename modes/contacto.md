# Modo: contacto -- LinkedIn Power Move

## Output contract (lee esto antes de empezar)

Toda invocacion de `contacto` produce, en este orden y sin excepciones:

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

```
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
