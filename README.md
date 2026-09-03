# Weblate Friendly UI

A translation-review grid on top of a Weblate instance. Weblate's own UI is
too slow for efficient review work; this app shows **every source string with
all languages side by side**, sortable by created/modified dates, filterable
(not verified, unapproved, failing checks, …), with inline editing.

## Why a backend proxy

Weblate's REST API has no server-side ordering on units and no
all-languages-in-one-request endpoint, so this app's Node backend:

- fetches units per language, joins them into rows by `content_hash`,
- serves **windowed, filtered, sorted** pages from an in-memory cache
  (progressively while loading — the grid fills in as data arrives),
- keeps the Weblate API token server-side (never in the browser),
- refreshes incrementally (`changed:>=…`) when data is stale.

## Setup

```bash
cp .env.example .env   # then fill in WEBLATE_API_KEY
npm install
npm run dev            # server :4000 + vite :5173, open http://localhost:5173
```

Without `WEBLATE_URL`/`WEBLATE_API_KEY` (or with `MOCK_WEBLATE=true`) the app
runs against a deterministic in-memory mock — including editable units — so
everything works offline.

### Environment

| Variable | Meaning |
|---|---|
| `WEBLATE_URL` | Base URL of the Weblate instance |
| `WEBLATE_API_KEY` | Optional API token. If omitted, the app runs in **session mode**: users sign in through the login view with their Weblate account (per-user sessions, held server-side) |
| `WEBLATE_REVIEW_WORKFLOW` | `true` if the instance has reviews enabled (affects the "not approved" filter) |
| `MOCK_WEBLATE` | `true` forces mock mode |
| `WEBLATE_EXPORT_API_KEY` | Optional server-wide Weblate API key. Together with `WEBLATE_EXPORT_ALLOWED_HOSTS` it enables public (key-less) export; also used in mock mode (any key accepted there anyway) |
| `WEBLATE_EXPORT_ALLOWED_HOSTS` | Comma-separated client hosts in CIDR format (e.g. `192.168.56.0/24,::1`) allowed to export without an API key |
| `PORT` | Backend port (default 4000) |
| `OPENAPI_UI` | Opt-in: serves the REST API docs page (`/openapi/`) and the OpenAPI spec (`/api/rest/v1/openapi.json`). Values are matched case- and blank-insensitively: `true`, `on` or `1` enable read-only docs; `try`, `with-try`, `with_try`, `swagger-with-try` or `swagger_with_try` also enable the "Try it out" button. Anything else (or unset) answers 404 |

## Development

```bash
npm test         # vitest: unit (row model) + integration (supertest + mock)
npm run typecheck
npm run lint
npm run build    # tsc --noEmit + vite build -> dist/client
```

## External API: REST and MCP

Besides the UI API (`/api/v1`), the server exposes string management for
external callers — authenticated with a **Weblate API key**
(`Authorization: Token <key>` or `X-API-Key`; permissions follow the key):

- **REST** at `/api/rest/v1`: list projects/components, batch-create strings,
  patch/delete translations by context key, and `POST /export`
  (documented in the Swagger UI, see below).
- **MCP** at `/mcp/v1`: the same operations as MCP tools over streamable
  HTTP (stateless, JSON responses): `list_projects`, `list_components`,
  `create_strings`, `patch_translations`, `delete_translation`.
- **UI** at `/api/v1/export` (same body; session-authenticated) and
  an Export dialog in the grid — or a multi-component export panel before any
  project is selected. The UI route runs the export as a background job: the
  POST answers `{jobId}` immediately, `GET /api/v1/export-jobs/:jobId` reports
  progress, and `GET /api/v1/export-jobs/:jobId/result` delivers the finished
  payload — the dialog shows a progress bar while the job runs.

### API documentation (Swagger UI)

The REST API is documented as an OpenAPI 3 spec with a browsable Swagger UI:

- **Docs page**: `http://<host>:<port>/openapi/`
- **Raw spec**: `http://<host>:<port>/api/rest/v1/openapi.json`

The docs are **opt-in**: set `OPENAPI_UI` to `true`, `on` or `1` (read-only
docs), or `try` / `with-try` / `with_try` / `swagger-with-try` /
`swagger_with_try` to also enable the "Try it out" button
(values are case- and blank-insensitive; anything else, or unset, answers 404
for both the page and the spec). The spec endpoint needs no API key, and
"Try it out" sends whatever key you enter under *Authorize* as
`Authorization: Token <key>`.

The Swagger UI assets (swagger-ui-dist) are vendored in the repo at
`public/openapi/` and served as static files — no CDN or internet access
needed at runtime. The spec itself is hand-written in
`src/server/rest/openapi.ts`; update it when the REST endpoints change.

`POST .../export` body:

```json
{
  "scope": [{ "project": "friendly-suite", "component": "web-ui" }],
  "languages": ["de", "fr"],
  "format": "i18next",
  "fileName": "[language].json",
  "grouping": "per-component",
  "packaging": "zip"
}
```

`languages` omitted/empty = all languages; `format` is `i18next` or `arb`;
`fileName` pattern is `[language].json` (e.g. `en.json`), `i18n.[language]`
(e.g. `i18n.en`) or `i18n.[LANGUAGE]` (uppercased, e.g. `i18n.EN`); `grouping`
is `per-component` (one file per component, at
`<project>/<component>/<file>` in the archive) or `merged` (all components in
one file per language, first component wins on duplicate keys); `packaging`
is `zip` (binary `application/zip`) or `json` (`{files: [{name, contentBase64}]}`).
Untranslated strings export as empty values; plural targets as suffixed keys
(`key_0`, `key_1`, …); strings are keyed by context, falling back to the
source text for key-less components.

**Public (key-less) export**: when both `WEBLATE_EXPORT_API_KEY` (a server-wide
Weblate API key) and `WEBLATE_EXPORT_ALLOWED_HOSTS` (comma-separated client
hosts in CIDR format, e.g. `192.168.56.0/24,::1`) are set, export requests
without an API key are accepted from those hosts and run under the
server-wide key. A bare IP matches that one address only — to allow **any**
host use `0.0.0.0/0,::/0` — IPv4 only (`0.0.0.0/0` alone) rejects IPv6 clients
such as `::1` when a caller resolves `localhost` (the server warns about both
traps at startup). A bare `0.0.0.0` matches nothing. The state is reported at
server start; missing variables or malformed CIDR entries disable public
export; a key rejected by Weblate (at start or later) is reported and answers
503 until it works again.

Both share one implementation (`src/server/rest/operations.ts`). Connect an
MCP client (Claude Code example):

```bash
claude mcp add --transport http wfu http://localhost:4000/mcp/v1 \
  --header "X-API-Key: <weblate-api-key>"
```

States: 0 untranslated (empty target), 10 needs editing, 20 translated,
30 approved. Per-language deletion means *clearing* (Weblate cannot delete
individual target units); deleting the whole string requires the source
language + `all=true`.

## Docker deployment

The Docker files live in `docker/` (`Dockerfile`, `docker-compose.yaml`).
The build is **multi-stage**: a `node:22-alpine` builder stage installs the
dependencies and compiles the app (`npm ci && npm run build`) *inside*
Docker, and the runtime image packages just the `dist/` output — the server
bundle is self-contained (esbuild), so no `node_modules` is needed there.
**Only Docker is required on the host** — no Node, no npm, no build step:
a plain `git clone` is enough.

```bash
git clone <repo> && cd weblate-friendly-bridge
docker compose -f docker/docker-compose.yaml up -d --build
# image only:
docker build -f docker/Dockerfile -t weblate-friendly-bridge:latest .
```

The app is then on http://localhost:4000. Configuration is passed through
compose environment variables (no `.env` file is baked into the image):

```bash
WEBLATE_URL=http://192.168.56.220:2080 \
WEBLATE_API_KEY=... \
docker compose -f docker/docker-compose.yaml up -d --build
```

Notes:

- `WEBLATE_URL` must be reachable **from inside the container**. For a
  Weblate running on the host's loopback, use
  `http://host.docker.internal:<port>` (the compose file already adds the
  `host-gateway` mapping); otherwise use the LAN IP.
- The healthcheck probes `/api/v1/health`.

## Architecture

```
src/shared/   row contract (SourceRow/Cell/RowsPage) + Weblate DTOs
src/server/
  weblate/    LiveWeblateClient (REST, pagination, rate budget) + MockWeblateClient
  cache/      row-model (pure join/filter/sort/window) + ComponentCache + registry
  routes.ts   our API: /projects /components /rows /units/:id /health
src/client/   React + TanStack Query + virtualized grid
```

- `GET /api/v1/rows?project&component&sort&filter&q&offset&limit` — windowed
  rows; `complete:false` + `loadProgress` while the component loads.
- `PATCH /api/v1/units/:id` `{target?, state?}` — edit; patches the cache
  from the Weblate response so the grid re-sorts instantly.
- States: 0 untranslated, 10 needs editing, 20 translated, 30 approved,
  100 read-only. "Not verified" = 0/10 (always) or 20 when review workflow
  is enabled.