# Modo: scan — Portal Scanner (Descubrimiento de Ofertas)

Escanea portales de empleo configurados, filtra por relevancia de título, y añade nuevas ofertas al pipeline para evaluación posterior.

> **Nota (v1.8+):** El escáner por defecto (`scan.mjs` / `npm run scan`) es **zero-token** y cubre parsers locales configurados por empresa más Greenhouse, Ashby, Lever, Apify, LinkedIn (autenticado) y un scraper HTML genérico vía sus plugins en `providers/`. Los niveles con Playwright/WebSearch descritos abajo son el flujo **agente** (ejecutado por Claude/Codex), reservado para empresas que ningún plugin alcanza. **Empieza siempre con `scan.mjs`** — el flujo agente es complementario, no alternativo.
>
> **Regla (v1.8+):** Si el parser local de una empresa termina con éxito en Nivel 0, el agente **no** debe repetir esa empresa en Playwright (Nivel 1) ni en API (Nivel 2). En Nivel 3, las queries generales siguen activas, pero se descartan resultados de empresas ya cubiertas por parser. Ver [Regla: local parser exitoso](#regla-local-parser-exitoso--no-repetir-scraping-caro).

## Ejecución recomendada

Ejecutar como subagente para no consumir contexto del main:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contenido de este archivo + datos específicos]",
    run_in_background=True
)
```

## Salida al usuario (OBLIGATORIO)

`scan.mjs` produce dos clases de información que el usuario debe ver:

1. **Resumen del scan** — métricas, errores por empresa, lista de nuevas ofertas
2. **Sugerencias de refinamiento del filtro** — bloque `📊 Filter refinement suggestions` que aparece al final cuando hay >= 50 títulos clasificados con verdicto. Estas sugerencias permiten al usuario añadir términos a `title_filter.positive`/`negative` en `portals.yml` con datos reales en mano.

**Reglas de relayo:**

- Capturar el stdout completo de `node scan.mjs` (idealmente vía `tee tmp/scan-{date}.log`).
- Incluir SIEMPRE el bloque `📊 Filter refinement suggestions` literal en la respuesta al usuario cuando esté presente — no es ruido auxiliar, es feedback accionable que el usuario perdió la última vez que se omitió.
- Si por alguna razón perdiste el stdout, leer `tmp/last-scan-suggestions.md` (escrito por `scan.mjs` en cada ejecución exitosa con sugerencias) y relayar su contenido.
- Si no hay sugerencias (corpus pequeño o sin señal), no inventar — simplemente omitir esa sección.

## Configuración

Leer `portals.yml` que contiene:
- `search_queries`: Lista de queries WebSearch con `site:` filters por portal (descubrimiento amplio)
- `tracked_companies`: Empresas específicas con `careers_url` para navegación directa
- `tracked_companies[].parser`: Parser local opcional para páginas SSR o HTML estable
- `title_filter`: Keywords positive/negative/seniority_boost para filtrado de títulos

## Estrategia de descubrimiento (4 niveles)

### Nivel 0 — Local parser (MÁS BARATO)

**Para cada empresa en `tracked_companies` con `parser:` configurado:** ejecutar el parser local definido en `portals.yml`. Este nivel es ideal cuando la página de careers usa SSR o HTML estable y ya existe un script JavaScript, Python, o de otro runtime local que extrae los jobs sin ayuda del agente.

Contrato recomendado:

```yaml
- name: Example Company
  careers_url: https://example.com/careers
  scan_method: local_parser
  parser:
    command: node
    script: scripts/parsers/example-company-jobs.js
    format: jobs-json-v1
  enabled: true
```

Normalmente el parser es específico para una empresa y ya conoce la URL, selectores y paginación. `args` es opcional: usarlo como ayude a quien construyó el script, por ejemplo para reutilizarlo entre empresas, pasar `{careers_url}` o `{company}`, activar un flag de depuración, guardar un snapshot JSON, o controlar cualquier comportamiento propio del parser.

El parser debe imprimir JSON a stdout:

Formato array:

```json
[
  { "title": "Senior AI Engineer", "url": "https://example.com/jobs/123", "location": "Remote" }
]
```

Formato objeto con `jobs`:

```json
{
  "jobs": [
    { "title": "Senior AI Engineer", "url": "https://example.com/jobs/123", "location": "Remote" }
  ]
}
```

Formato objeto con `results`:

```json
{
  "results": [
    { "title": "Senior AI Engineer", "url": "https://example.com/jobs/123", "location": "Remote" }
  ]
}
```

`company` es opcional; si no viene, `scan.mjs` usa el nombre de `tracked_companies`.

El escáner no necesita conservar el JSON completo después de leer stdout. Si un parser también genera un artefacto para auditoría o depuración, guardarlo en `data/parser-output/{company}/` y mantenerlo fuera de git (los JSON en `.gitignore`; los `.gitkeep` se mantienen en git para conservar la estructura).

### Regla: local parser exitoso — no repetir scraping caro

El objetivo de `scan_method: local_parser` es **reducir tokens**: evitar que el LLM vuelva a scrapear la misma empresa con Playwright o APIs redundantes.

Durante el scan del agente, mantener en memoria el conjunto **`local_parser_ok`**: nombres de empresas (`tracked_companies[].name`) donde Nivel 0 terminó con éxito:

- `parser.command` + `parser.script` existen y el script se ejecutó sin error fatal
- stdout fue JSON válido (`[]`, `{ jobs: [] }`, o `{ results: [] }`)
- No hubo timeout ni crash del proceso

| Nivel | Si la empresa está en `local_parser_ok` |
|-------|----------------------------------------|
| **1 — Playwright** | **Omitir** — no `browser_navigate` a su `careers_url` (método más caro en tokens) |
| **2 — API** | **Omitir** — no WebFetch de su `api:` (ya cubierta por parser; `scan.mjs` tampoco usa API tras parser exitoso) |
| **3 — WebSearch** | Ejecutar queries **generales** (`site:`, títulos de rol); **descartar** cada hit cuya empresa normalizada coincida con `local_parser_ok` |

**Excepciones:**

- Parser **falló** → la empresa **no** entra en `local_parser_ok`; Niveles 1 y 2 aplican con normalidad (mismo criterio que el fallback de `scan.mjs` cuando el parser falla y existe API ATS).
- Nivel 3: no desactivar queries transversales (`site:jobs.ashbyhq.com`, `site:boards.greenhouse.io`, etc.) — sirven para descubrir empresas **nuevas**. Solo filtrar resultados de empresas ya en `tracked_companies` con parser exitoso.
- No crear queries `search_queries` dedicadas a una empresa con parser local activo (p. ej. `site:jobs.ashbyhq.com/cohere "AI Engineer"`); usar el parser o, si falla, Playwright/API.

**Nivel 0 recomendado:** ejecutar `node scan.mjs` (o `npm run scan`) al inicio del workflow del agente. Eso cubre parsers locales + APIs en un solo paso zero-token y devuelve qué empresas usaron `local-parser` con éxito.

### Nivel 1 — Playwright directo (PRINCIPAL)

**Para cada empresa en `tracked_companies` que no esté en `local_parser_ok`:** Navegar a su `careers_url` con Playwright (`browser_navigate` + `browser_snapshot`), leer TODOS los job listings visibles, y extraer título + URL de cada uno. Este es el método más fiable porque:
- Ve la página en tiempo real (no resultados cacheados de Google)
- Funciona con SPAs (Ashby, Lever, Workday)
- Detecta ofertas nuevas al instante
- No depende de la indexación de Google

**Cada empresa DEBE tener `careers_url` en portals.yml.** Si no la tiene, buscarla una vez, guardarla, y usar en futuros scans.

### Nivel 2 — ATS APIs / Feeds (COMPLEMENTARIO)

Para empresas con API pública o feed estructurado **que no estén en `local_parser_ok`**, usar la respuesta JSON/XML como complemento rápido de Nivel 1. Es más rápido que Playwright y reduce errores de scraping visual.

**Soporte actual (variables entre `{}`):**
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby**: `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR**: lista `https://{company}.bamboohr.com/careers/list`; detalle de una oferta `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever**: `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor**: `https://{company}.teamtailor.com/jobs.rss`
- **Workday**: `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Convención de parsing por provider:**
- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` con `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; construir URL pública si no viene en payload)
- `bamboohr`: lista `result[]` → `jobOpeningName`, `id`; construir URL de detalle `https://{company}.bamboohr.com/careers/{id}/detail`; para leer el JD completo, hacer GET del detalle y usar `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: array raíz `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`
- `workday`: `jobPostings[]`/`jobPostings` (según tenant) → `title`, `externalPath` o URL construida desde el host

### Nivel 3 — WebSearch queries (DESCUBRIMIENTO AMPLIO)

Los `search_queries` con `site:` filters cubren portales de forma transversal (todos los Ashby, todos los Greenhouse, etc.). Útil para descubrir empresas NUEVAS que aún no están en `tracked_companies`, pero los resultados pueden estar desfasados. Tras filtrar hits de empresas en `local_parser_ok`, los resultados restantes se deduplican con Niveles 0–2.

**Prioridad de ejecución:**
1. Nivel 0: Local parser → empresas con `parser:` configurado y script existente; construir `local_parser_ok`
2. Nivel 1: Playwright → `tracked_companies` con `careers_url`, **excepto** `local_parser_ok`
3. Nivel 2: API → `tracked_companies` con `api:`, **excepto** `local_parser_ok`
4. Nivel 3: WebSearch → todos los `search_queries` con `enabled: true`; descartar hits de empresas en `local_parser_ok`

Los niveles son aditivos — se ejecutan en orden, los resultados se mezclan y deduplican. Las empresas en `local_parser_ok` **no** pasan por Niveles 1 ni 2; en Nivel 3 solo aportan descubrimiento transversal (otras empresas en el mismo portal).

## Workflow

1. **Leer configuración**: `portals.yml`
2. **Leer historial**: `data/scan-history.tsv` → URLs ya vistas
3. **Leer dedup sources**: `data/applications.md` + `data/pipeline.md`

3.5. **Nivel 0 — Local parser** (`scan.mjs`, zero-token):
   Inicializar `local_parser_ok = []`.
   Preferir ejecutar `node scan.mjs` una vez para cubrir todos los parsers + APIs zero-token; si se hace manualmente, repetir la lógica siguiente.
   Para cada empresa en `tracked_companies` con `enabled: true`, `parser.command` y script existente:
   a. Ejecutar `parser.command` con `parser.script` + `parser.args` usando ejecución local sin shell
   b. Expandir placeholders `{careers_url}` y `{company}` en argumentos
   c. Leer JSON de stdout (`[]`, `{ jobs: [] }`, o `{ results: [] }`)
   d. Normalizar cada job a `{title, url, company, location}`
   e. Resolver URLs relativas contra `careers_url`
   f. Si el parser falla, registrar error, intentar fallback por API ATS si existe, y continuar con las demás empresas (**no** añadir a `local_parser_ok`)
   g. Si el parser termina con éxito (pasos c–e sin error fatal), añadir `entry.name` a `local_parser_ok` y acumular jobs en candidatos

4. **Nivel 1 — Playwright scan** (paralelo en batches de 3-5):
   Para cada empresa en `tracked_companies` con `enabled: true`, `careers_url` definida, y **nombre no listado en `local_parser_ok`**:
   a. `browser_navigate` a la `careers_url`
   b. `browser_snapshot` para leer todos los job listings
   c. Si la página tiene filtros/departamentos, navegar las secciones relevantes
   d. Para cada job listing extraer: `{title, url, company}`
   e. Si la página pagina resultados, navegar páginas adicionales
   f. Acumular en lista de candidatos
   g. Si `careers_url` falla (404, redirect), intentar `scan_query` como fallback y anotar para actualizar la URL

5. **Nivel 2 — ATS APIs / feeds** (paralelo):
   Para cada empresa en `tracked_companies` con `api:` definida, `enabled: true`, y **nombre no listado en `local_parser_ok`**:
   a. WebFetch de la URL de API/feed
   b. Si `api_provider` está definido, usar su parser; si no está definido, inferir por dominio (`boards-api.greenhouse.io`, `jobs.ashbyhq.com`, `api.lever.co`, `*.bamboohr.com`, `*.teamtailor.com`, `*.myworkdayjobs.com`)
   c. Para **Ashby**, enviar POST con:
      - `operationName: ApiJobBoardWithTeams`
      - `variables.organizationHostedJobsPageName: {company}`
      - query GraphQL de `jobBoardWithTeams` + `jobPostings { id title locationName employmentType compensationTierSummary }`
   d. Para **BambooHR**, la lista solo trae metadatos básicos. Para cada item relevante, leer `id`, hacer GET a `https://{company}.bamboohr.com/careers/{id}/detail`, y extraer el JD completo desde `result.jobOpening`. Usar `jobOpeningShareUrl` como URL pública si viene; si no, usar la URL de detalle.
   e. Para **Workday**, enviar POST JSON con al menos `{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}` y paginar por `offset` hasta agotar resultados
   f. Para cada job extraer y normalizar: `{title, url, company}`
   g. Acumular en lista de candidatos (dedup con Nivel 1)

6. **Nivel 3 — WebSearch queries** (paralelo si posible):
   Para cada query en `search_queries` con `enabled: true` (queries generales por portal/rol — no queries dedicadas a una empresa con parser local activo):
   a. Ejecutar WebSearch con el `query` definido
   b. De cada resultado extraer: `{title, url, company}`
      - **title**: del título del resultado (antes del " @ " o " | ")
      - **url**: URL del resultado
      - **company**: después del " @ " en el título, o extraer del dominio/path
   c. **Omitir** el resultado si `company` (normalizado) coincide con algún nombre en `local_parser_ok`
   d. Acumular el resto en lista de candidatos (dedup con Nivel 0+1+2)

6. **Filtrar por título** usando `title_filter` de `portals.yml`:
   - Al menos 1 keyword de `positive` debe aparecer en el título (case-insensitive)
   - 0 keywords de `negative` deben aparecer
   - `seniority_boost` keywords dan prioridad pero no son obligatorios

6b. **Filtrar por ubicación (opcional)** usando `location_filter` de `portals.yml`:
   - Si el bloque `location_filter` está ausente, todas las ubicaciones pasan (comportamiento por defecto)
   - Ubicación vacía en una oferta → pasa (no penalizar datos faltantes)
   - Cualquier keyword de `block` presente → rechazar (precedencia sobre allow)
   - `allow` vacío → pasa (ya superó block)
   - `allow` no vacío → debe coincidir al menos una keyword
   - Todas las coincidencias son case-insensitive substring
   - La ubicación se persiste como 7ª columna en `scan-history.tsv` para auditoría posterior

7. **Deduplicar** contra 3 fuentes:
   - `scan-history.tsv` → URL exacta ya vista
   - `applications.md` → empresa + rol normalizado ya evaluado
   - `pipeline.md` → URL exacta ya en pendientes o procesadas

7.5. **Verificar liveness de resultados de WebSearch (Nivel 3)** — ANTES de añadir a pipeline:

   Los resultados de WebSearch pueden estar desactualizados (Google cachea resultados durante semanas o meses). Para evitar evaluar ofertas expiradas, verificar con Playwright cada URL nueva que provenga del Nivel 3. Los Niveles 1 y 2 son inherentemente en tiempo real y no requieren esta verificación.

   Para cada URL nueva de Nivel 3 (secuencial — NUNCA Playwright en paralelo):
   a. `browser_navigate` a la URL
   b. `browser_snapshot` para leer el contenido
   c. Clasificar:
      - **Activa**: título del puesto visible + descripción del rol + control visible de Apply/Submit/Solicitar dentro del contenido principal. No contar texto genérico de header/navbar/footer.
      - **Expirada** (cualquiera de estas señales):
        - URL final contiene `?error=true` (Greenhouse redirige así cuando la oferta está cerrada)
        - Página contiene: "job no longer available" / "no longer open" / "position has been filled" / "this job has expired" / "page not found"
        - Solo navbar y footer visibles, sin contenido JD (contenido < ~300 chars)
   d. Si expirada: registrar en `scan-history.tsv` con status `skipped_expired` y descartar
   e. Si activa: continuar al paso 8

   **No interrumpir el scan entero si una URL falla.** Si `browser_navigate` da error (timeout, 403, etc.), marcar como `skipped_expired` y continuar con la siguiente.

8. **Para cada oferta nueva verificada que pase filtros**:
   a. Añadir a `pipeline.md` sección "Pendientes": `- [ ] {url} | {company} | {title}`
   b. Registrar en `scan-history.tsv`: `{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`

9. **Ofertas filtradas por título**: registrar en `scan-history.tsv` con status `skipped_title`
10. **Ofertas duplicadas**: registrar con status `skipped_dup`
11. **Ofertas expiradas (Nivel 3)**: registrar con status `skipped_expired`

## Extracción de título y empresa de WebSearch results

Los resultados de WebSearch vienen en formato: `"Job Title @ Company"` o `"Job Title | Company"` o `"Job Title — Company"`.

Patrones de extracción por portal:
- **Ashby**: `"Senior AI PM (Remote) @ EverAI"` → title: `Senior AI PM`, company: `EverAI`
- **Greenhouse**: `"AI Engineer at Anthropic"` → title: `AI Engineer`, company: `Anthropic`
- **Lever**: `"Product Manager - AI @ Temporal"` → title: `Product Manager - AI`, company: `Temporal`

Regex genérico: `(.+?)(?:\s*[@|—–-]\s*|\s+at\s+)(.+?)$`

## URLs privadas

Si se encuentra una URL no accesible públicamente:
1. Guardar el JD en `jds/{company}-{role-slug}.md`
2. Añadir a pipeline.md como: `- [ ] local:jds/{company}-{role-slug}.md | {company} | {title}`

## Scan History

`data/scan-history.tsv` trackea TODAS las URLs vistas:

```
url	first_seen	portal	title	company	status
https://...	2026-02-10	Ashby — AI PM	PM AI	Acme	added
https://...	2026-02-10	Greenhouse — SA	Junior Dev	BigCo	skipped_title
https://...	2026-02-10	Ashby — AI PM	SA AI	OldCo	skipped_dup
https://...	2026-02-10	WebSearch — AI PM	PM AI	ClosedCo	skipped_expired
```

## Resumen de salida

```
Portal Scan — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Queries ejecutados: N
Ofertas encontradas: N total
Filtradas por título: N relevantes
Duplicadas: N (ya evaluadas o en pipeline)
Expiradas descartadas: N (links muertos, Nivel 3)
Nuevas añadidas a pipeline.md: N

  + {company} | {title} | {query_name}
  ...

→ Ejecuta /career-ops pipeline para evaluar las nuevas ofertas.
```

## Gestión de careers_url

Cada empresa en `tracked_companies` debe tener `careers_url` — la URL directa a su página de ofertas. Esto evita buscarlo cada vez.

**REGLA: Usa siempre la URL corporativa de la empresa; recurre al endpoint ATS solo si no existe página corporativa propia.**

El `careers_url` debe apuntar a la página de empleo propia de la empresa siempre que esté disponible. Muchas empresas usan Workday, Greenhouse o Lever por debajo, pero exponen los IDs de las vacantes solo a través de su dominio corporativo. Usar la URL ATS directa cuando existe una página corporativa puede causar falsos errores 410 porque los IDs de los puestos no coinciden.

| ✅ Correcto (corporativa) | ❌ Incorrecto como primera opción (ATS directo) |
|---|---|
| `https://careers.mastercard.com` | `https://mastercard.wd1.myworkdayjobs.com` |
| `https://openai.com/careers` | `https://job-boards.greenhouse.io/openai` |
| `https://stripe.com/jobs` | `https://jobs.lever.co/stripe` |

Fallback: si solo tienes la URL ATS directa, navega primero al sitio web de la empresa y localiza su página corporativa de empleo. Usa la URL ATS directa únicamente si la empresa no tiene página corporativa propia.

**Patrones conocidos por plataforma:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` o `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** lista `https://{company}.bamboohr.com/careers/list`; detalle `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** La URL propia de la empresa (ej: `https://openai.com/careers`)

**Patrones de API/feed por plataforma:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** lista `https://{company}.bamboohr.com/careers/list`; detalle `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Si `careers_url` no existe** para una empresa:
1. Intentar el patrón de su plataforma conocida
2. Si falla, hacer un WebSearch rápido: `"{company}" careers jobs`
3. Navegar con Playwright para confirmar que funciona
4. **Guardar la URL encontrada en portals.yml** para futuros scans

**Si `careers_url` devuelve 404 o redirect:**
1. Anotar en el resumen de salida
2. Intentar scan_query como fallback
3. Marcar para actualización manual

## Mantenimiento del portals.yml

- **SIEMPRE guardar `careers_url`** cuando se añade una empresa nueva
- Añadir nuevos queries según se descubran portales o roles interesantes
- Desactivar queries con `enabled: false` si generan demasiado ruido
- Ajustar keywords de filtrado según evolucionen los roles target
- Añadir empresas a `tracked_companies` cuando interese seguirlas de cerca
- Verificar `careers_url` periódicamente — las empresas cambian de plataforma ATS
