# Modo: pipeline — Inbox de URLs (Second Brain)

Procesa URLs de ofertas acumuladas en `data/pipeline.md`. El usuario agrega URLs cuando quiera y luego ejecuta `/career-ops pipeline` para procesarlas todas.

## Workflow

1. **Leer** `data/pipeline.md` → buscar items `- [ ]` en la sección "Pendientes"
2. **Para cada URL pendiente**:
   a. Calcular siguiente `REPORT_NUM` secuencial (leer `reports/`, tomar el número más alto + 1)
   b. **Extraer JD** usando Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch
   c. Si la URL no es accesible → marcar como `- [!]` con nota y continuar
   d. **Ejecutar auto-pipeline completo**: Evaluación A-F → Report .md → PDF (si score ≥ `auto_pdf_score_threshold`) → Tracker
   e. **Mover de "Pendientes" a "Procesadas"**: `- [x] #NNN | URL | Empresa | Rol | Score/5 | PDF ✅/❌`

   **Sobre el PDF gate (configurable, default-disabled):** Leer `config/profile.yml` → `auto_pdf_score_threshold`. Si la clave no existe, default `5.1` (efectivamente deshabilitado — el max score posible es 5.0). Si el score de la evaluación es menor que el threshold, omitir la generación de PDF: escribir el report normalmente, mostrar en el header `**PDF:** not generated — run /career-ops pdf {company-slug} to create on demand`, y marcar PDF ❌ en el tracker. Si el score es ≥ threshold, generar el PDF como siempre.

   **Por qué default-disabled:** Generar un PDF tailored cuesta ~30–60s por entrada (Playwright launch + HTML render) y produce archivos que casi nunca se usan — la mayoría de roles puntúan en 2.x/3.x y nunca llegan a aplicación. Mejor escribir el report (barato, útil para triaje) y dejar el PDF como acción on-demand vía `/career-ops pdf {slug}` cuando el usuario decide aplicar.

   **Cómo activar auto-PDF:** Editar `config/profile.yml` y añadir `auto_pdf_score_threshold: 4.0` (o el valor preferido). Ambos modos (Path A `/career-ops pipeline` y Path B `batch/batch-runner.sh`) leen la misma clave para que el comportamiento sea consistente.
3. **Si hay 3+ URLs pendientes**, lanzar agentes en paralelo (Agent tool con `run_in_background`) para maximizar velocidad.
4. **Al terminar**, mostrar tabla resumen:

```
| # | Empresa | Rol | Score | PDF | Acción recomendada |
```

## Formato de pipeline.md

```markdown
## Pendientes
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Error: login required

## Procesadas
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Detección inteligente de JD desde URL

1. **Playwright (preferido):** `browser_navigate` + `browser_snapshot`. Funciona con todas las SPAs.
2. **WebFetch (fallback):** Para páginas estáticas o cuando Playwright no está disponible.
3. **WebSearch (último recurso):** Buscar en portales secundarios que indexan el JD.

**Casos especiales:**
- **LinkedIn**: Puede requerir login → marcar `[!]` y pedir al usuario que pegue el texto
- **PDF**: Si la URL apunta a un PDF, leerlo directamente con Read tool
- **`local:` prefix**: Leer el archivo local. Ejemplo: `local:jds/linkedin-pm-ai.md` → leer `jds/linkedin-pm-ai.md`

## Numeración automática

1. Listar todos los archivos en `reports/`
2. Extraer el número del prefijo (e.g., `142-medispend...` → 142)
3. Nuevo número = máximo encontrado + 1

## Sincronización de fuentes

Antes de procesar cualquier URL, verificar sync:
```bash
node cv-sync-check.mjs
```
Si hay desincronización, advertir al usuario antes de continuar.
