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

**Verificación de nombre OBLIGATORIA (hacer ANTES de presentar el mensaje al usuario):**

Incidente previo: se envió un `contacto` que se dirigía a la persona correcta con el nombre incorrecto. El usuario lo revisó pero no detectó el error. Esta verificación existe para que ese tipo de error sea imposible de pasar por alto.

Antes de mostrar el mensaje final, ejecutar esta lista de verificación de manera explícita en la respuesta:

1. **Comprobación literal**: copiar el saludo del mensaje redactado (p. ej. "Hi Sarah,") y compararlo carácter por carácter con la línea `Recipient` confirmada en el paso 3.5. Marcar cualquier discrepancia — mayúsculas, acentos, caracteres faltantes/extra, o nombre completamente distinto.
2. **Sin sustituciones**: confirmar que el nombre en el mensaje no se completó automáticamente con una variante más común (Sara vs. Sarah, Stephen vs. Steven, José vs. Jose).
3. **Persona correcta**: reafirmar la URL de LinkedIn del destinatario y confirmar que el gancho del mensaje (empresa, rol, referencia a proyecto) corresponde a ESA persona, no a un objetivo considerado anteriormente.
4. **Formato de presentación**: al mostrar el mensaje final al usuario, encabezar con una línea de confirmación:
   > **Sending to:** {Nombre completo} ({LinkedIn URL}) — dirigido como "{saludo del mensaje}"

   Luego el cuerpo del mensaje. La línea **Sending to:** es metadata de verificación previa al envío — **no** debe incluirse en el mensaje saliente ni contarse contra el límite de 300 caracteres de InMail. El usuario debe poder escanear el saludo y la línea "Sending to:" en paralelo sin tener que buscar.

Si alguna verificación falla o tienes dudas, DETENERSE y pedir al usuario que confirme antes de continuar. Un nombre incorrecto en un mensaje en frío es irrecuperable — mejor preguntar que enviar.
