# Modo: contacto -- LinkedIn Power Move

1. **Identificar targets** via WebSearch:
   - Hiring manager del equipo
   - Recruiter asignado
   - 2-3 peers del equipo (gente con rol similar)
   - Interviewer (si el candidato ya tiene entrevista programada)

2. **Clasificar tipo de contacto** -- preguntar al candidato o inferir del contexto:
   - **Recruiter** -- persona cuyo rol es talent acquisition, sourcing, o recruiting
   - **Hiring Manager** -- la persona que lidera el equipo que contrata
   - **Peer** -- alguien con un rol similar en el equipo (referral indirecto)
   - **Interviewer** -- alguien que va a entrevistar al candidato (fecha conocida)

3. **Seleccionar target primario**: la persona que mas se beneficiaria de que el candidato estuviera alli

4. **Generar mensaje** con framework de 3 frases adaptado al tipo de contacto:

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

5. **Versiones**:
   - EN (default)
   - ES (si empresa espanola)

6. **Targets alternativos** con justificacion de por que son buenos second choices

7. **Guardar como tareas en el dashboard**: Despues de presentar los mensajes, listar los contactos sugeridos (primario + alternativos) en una tabla numerada:

   ```
   | # | Nombre | Rol | Empresa | LinkedIn |
   ```

   **Antes** de preguntar al candidato si quiere guardar, **buscar el App#** en `data/applications.md`:
   - Si el contacto es para una empresa que ya esta en el tracker (match por columna Company), capturar el numero `#` de la fila mas reciente con status activo (`Applied` / `Responded` / `Interview` / `Evaluated`).
   - Anotar el `App#` junto al contacto. Si no hay match, marcar `App#: -`.

   Esto asegura que la tarea quede vinculada a la aplicacion para que el dashboard pueda abrir el reporte desde la vista de tareas (tecla Enter).

   Preguntar al candidato:
   > "¿Agrego estos contactos como tareas en el dashboard? (todos / ninguno / numeros como `1,3`)"

   Si responde "todos" o numeros especificos, **siempre** presentar un bloque copy-paste con un comando `add-task.mjs` por contacto. Esto es **obligatorio** porque la misma instruccion corre en Claude Code (con shell) y en Claude web (sin shell) -- el bloque copy-paste funciona en ambos contextos sin cambios:

   ```bash
   node add-task.mjs --type contact --app 412 --title "LinkedIn: Jane Doe (Recruiter)" --notes "linkedin.com/in/jane-doe"
   node add-task.mjs --type contact --app 412 --title "LinkedIn: John Smith (Hiring Manager)" --notes "linkedin.com/in/john-smith"
   ```

   Reglas para el bloque:
   - Un comando por linea, sin barras invertidas de continuacion (asi se puede pegar entero).
   - **Siempre** incluir `--app {numero}` cuando exista match en el tracker. `add-task.mjs` auto-rellena `--company` desde `data/applications.md`, asi que no es necesario pasar `--company` cuando hay `--app`.
   - Si no hay match en el tracker, omitir `--app` y pasar `--company "{Empresa}"` explicitamente.
   - `--title` debe usar el patron `LinkedIn: {Nombre} ({Rol})`. `--notes` debe contener la URL de LinkedIn.
   - Citar comillas dobles externas; escapar comillas internas con `\"`.

   Decir al candidato: "Pega esto en una terminal en el directorio del proyecto." Si el agente tiene acceso a Bash (Claude Code), ofrecer adicionalmente ejecutar el bloque al instante.

   `add-task.mjs` es idempotente: re-ejecutar con el mismo tipo, titulo y App# no duplica la tarea. Reportar al candidato cuantas se agregaron y cuantas eran duplicados.

**Reglas del mensaje:**
- Maximo 300 caracteres (LinkedIn connection request limit)
- NO corporate-speak
- NO "I'm passionate about..."
- Algo que haga que quieran responder
- NUNCA compartir telefono
- El tipo de contacto cambia el ENFASIS, no la estructura
