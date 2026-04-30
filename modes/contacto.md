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

3.5. **Lock in recipient identity (MANDATORY before drafting):**
   - Capture the verified **full name** exactly as it appears on their LinkedIn profile (or the source you pulled them from). Copy-paste — do NOT retype from memory.
   - Decide the **salutation form** explicitly: first name only (default for LinkedIn), preferred/known-as name if different from legal name, or honorific + last name if the context calls for it.
   - Watch for these failure modes:
     - Pulled the recipient from one tab but drafted the message while looking at a different person/JD.
     - Profile shows "Preferred: X" or a nickname in parentheses — use that, not the legal first name.
     - Compound first names, accented characters, or non-Latin scripts — preserve exactly.
     - Two people with similar names at the same company — re-confirm the URL/profile.
   - Write the locked-in recipient as a single line at the top of the draft block, e.g. `Recipient: Jane Doe (salutation: "Jane") — linkedin.com/in/janedoe`. This is the source of truth for step 4.

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

**Reglas del mensaje:**
- Maximo 300 caracteres (LinkedIn connection request limit)
- NO corporate-speak
- NO "I'm passionate about..."
- Algo que haga que quieran responder
- NUNCA compartir telefono
- El tipo de contacto cambia el ENFASIS, no la estructura

**Name verification gate (MANDATORY — do this BEFORE presenting the message to the user):**

Past incident: a `contacto` message was sent that addressed the right person by the wrong name. The user reviewed it but missed the slip. This gate exists to make that class of error impossible to ship silently.

Before showing the final message, run this checklist out loud in the response:

1. **Exact-match check**: copy the salutation token from the drafted message (e.g. "Hi Sarah,") and compare it character-for-character against the locked-in `Recipient` line from step 3.5. Flag any mismatch — capitalization, accents, missing/extra characters, or wrong name entirely.
2. **No-substitution check**: confirm the name in the message did not get auto-completed or pattern-matched to a more common spelling (Sara vs. Sarah, Stephen vs. Steven, José vs. Jose).
3. **Right-person check**: re-state the LinkedIn URL of the recipient and confirm the message body's hook (company, role, project reference) actually corresponds to THAT person, not a previously-considered target.
4. **Present format**: when you show the final message to the user, lead with a one-line confirmation:
   > **Sending to:** {Full Name} ({linkedin URL}) — addressing them as "{salutation in message}"

   Then the message body. The user should be able to scan the salutation and the "Sending to" line side by side without hunting.

If any check fails or you're unsure, STOP and ask the user to confirm before proceeding. A wrong name in a cold outreach is unrecoverable — better to ask than to send.
