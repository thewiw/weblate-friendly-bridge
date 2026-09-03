# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A custom translation-review grid on top of a Weblate instance (Weblate's own UI is too slow for review work). One row per source string, one column per target language, with sorting, filtering, on-demand windowed loading, and inline editing. Single TypeScript repo: Vite + React 18 + TanStack Query frontend, Express 5 backend that proxies Weblate and holds all credentials server-side.

## Commands

```bash
npm run dev          # Express :4000 (tsx watch) + Vite :5173 (proxies /api), mock or live per .env
npm test             # vitest (unit + integration, no network needed — uses the mock)
npx vitest run src/test/unit/row-model.test.ts   # single test file
npm run typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run lint         # eslint
npm run build        # typecheck + vite build (dist/client) + esbuild server bundle (dist/server/index.cjs)
npm start            # node dist/server/index.cjs — serves API + built frontend on :4000
```

## Docker deployment

Docker files live in `docker/` (`Dockerfile` + `docker-compose.yaml`). The Dockerfile is **multi-stage**: a node:22-alpine builder stage runs `npm ci && npm run build` inside Docker (so a plain clone builds with only Docker installed — no host Node/npm), and the runtime image packages just `dist/` (the esbuild server bundle is self-contained, no `node_modules` needed); the container runs `node dist/server/index.cjs`, which serves both the API and the built frontend on :4000. Build context is the repo root (see `.dockerignore` — `node_modules`/`dist`/`.git`/`.env` stay out).

```bash
npm run build
docker compose -f docker/docker-compose.yaml up -d --build   # build image + start container
docker build -f docker/Dockerfile -t weblate-friendly-bridge:latest .  # image only
```

Configuration goes through compose environment variables (`WFB_WEBLATE_URL`, `WFB_WEBLATE_API_KEY`, `WFB_WEBLATE_REVIEW_WORKFLOW`, `WFB_MOCK_WEBLATE`, `WFB_WEBLATE_EXPORT_API_KEY` + `WFB_WEBLATE_EXPORT_ALLOWED_HOSTS` for public export, `WFB_OPENAPI` to opt into the REST docs page) — no `.env` file is baked into the image. `WFB_WEBLATE_URL` must be reachable from inside the container: use `http://host.docker.internal:<port>` for a Weblate on the host's loopback (the compose file already adds the `host-gateway` mapping), or the LAN IP otherwise. Healthcheck probes `/api/v1/health` (the router is mounted under `/api/v1`, not `/api`).

Configuration lives in `.env` (see `.env.example`): `WFB_WEBLATE_URL`, optional `WFB_WEBLATE_API_KEY` (omitting it enables session mode: users sign in via the login view, backend holds their Weblate session server-side), `WFB_MOCK_WEBLATE=true` for fully offline dev (deterministic in-memory Weblate, also editable), `WFB_WEBLATE_EXPORT_API_KEY`/`WFB_WEBLATE_EXPORT_ALLOWED_HOSTS` for public (key-less) REST export, and `WFB_OPENAPI=true|on|1` (read-only) or `WFB_OPENAPI=try|with-try|with_try|swagger-with-try|swagger_with_try` (docs + "Try it out"; matching is case- and blank-insensitive) to serve the REST API docs.

## Architecture (the big picture)

`src/shared/` — the contract between server and client: `SourceRow`/`Cell`/`RowsPage` (`rows.ts`) and raw Weblate DTOs (`weblate-dto.ts`).

`src/server/`:
- `weblate/client.ts` — `WeblateApi` interface with two interchangeable implementations: `LiveWeblateClient` (real HTTP; per-request auth either token or a user's session cookie) and `MockWeblateClient` (in-memory, mutable — powers offline dev AND integration tests, including edits).
- `cache/row-model.ts` — pure functions: join units into rows, filter, sort, slice windows. The most-tested module; keep it pure.
- `cache/component-cache.ts` + `cache-registry.ts` — per-(project, component) in-memory row caches: lazy background load with **progressive serving** (`complete: false` until done, frontend polls), stale-while-revalidate delta refresh via `q=changed:>=…`, shadow-map atomic reload, LRU eviction.
- `auth/sessions.ts` — server-side Weblate form login (CSRF scrape → POST → cookie capture) and the per-user session store; the browser only ever holds our own opaque `wfu_sid` cookie.
- `routes.ts` — our API (`/projects`, `/projects/:p/components`, `/rows`, `PATCH /units/:id`, `/auth/*`, `/health`); in session mode every request resolves its own upstream client via `forRequest(req)`.

`src/client/` — React: `App.tsx` wires URL-synced view state (`state/url-state.ts`), TanStack Query hooks (`api/queries.ts`, optimistic edits with rollback), and the virtualized grid (`components/grid/`). Row virtualization is `@tanstack/react-virtual` with fixed 44px rows and CSS sticky columns (`styles/global.css`).

Dev: Vite proxies `/api` → :4000, so frontend and backend never need CORS. In production the Express server serves `dist/client` from the same port.

## Weblate API quirks (verified against the live instance — do not regress)

- **No server-side ordering** on units endpoints and no all-languages endpoint — all sorting/joining happens in our cache.
- **Internal-host URLs**: Weblate advertises `units_list_url` and pagination `next` links on an internal hostname (e.g. 172.16.0.6) that may be unreachable. Always build URLs from the configured `WFB_WEBLATE_URL` base (`client.ts` helpers) and rewrite `next` links to the base origin (`paginate.ts`).
- **`content_hash` is derived from the source text** — it changes when the source string is edited. Rows are keyed by **source unit id** (`rowKeyFor`); never key anything by content_hash.
- **Timestamps** arrive with server-local offsets (+02:00) — normalize with `normIso()` at ingestion or string comparison sorts wrong.
- **PATCH `/api/units/:id` requires both `target` and `state`** (target-only is rejected) and returns a **partial unit** (no `content_hash`/timestamps) — the route re-fetches the full unit before patching the cache.
- Review workflow is detected per-project (`translation_review`); `WFB_WEBLATE_REVIEW_WORKFLOW` is only the fallback. "Not verified" filter = state 0/10, plus 20 (not approved) only when reviews are on.
- Anonymous API access is rejected on this instance; authenticated budget is 5000 req/hour — the client tracks `X-RateLimit-*` headers and suspends background refreshes near the floor.

## Conventions

- TypeScript strict, ESM (`"type": "module"`), `import type` required for type-only imports (verbatimModuleSyntax); use `.js` extensions in server-side relative imports.
- The server bundle is CJS (`dist/server/index.cjs`) because express's `debug` dependency breaks ESM bundles; don't switch the format without testing.
- Row/search semantics: "not verified" = untranslated/needs-editing (always) or translated-not-approved (only when review workflow is on); search orders results by relevance tiers (exact ID → exact context → substring) applied *after* the user's sort, both stable.
- Filters are language-scoped: every filter evaluates only the visible language columns (`hiddenLangs` query param; hiding all falls back to all). The `id-list` filter is the exception — it matches string **context keys** (never unit ids): small lists (≤500) travel inline via the `ids` query param, larger ones are uploaded once to `POST /id-lists` and referenced by `listId` (in-memory `IdListStore`, cap 100k keys / 100 lists). Source edits trigger background re-reads of the row's translation units (1.25s/8s/20s) because Weblate recomputes check flags asynchronously.
- Row selection: client-side `Selection { all, keys }` (keys = exceptions; selected when all=false, deselected when all=true) in `client/state/selection.ts`; cleared when the filtered set changes. Bulk tools (`POST /bulk-state`, polled via `/bulk-state/:jobId`) apply a translation state to every cell of the selected rows in the visible languages, patching Weblate with target+state (required) and updating the cache cell in place.
- Export (`src/server/export/`, `src/shared/export.ts`): turns one or more (project, component) pairs into i18next/ARB files, one per language, delivered as a zip or as base64 entries in a JSON response (`POST /api/v1/export` session-authed, `POST /api/rest/v1/export` API-key authed; UI dialog in `client/components/ExportDialog.tsx`). The session route runs as a **background job** (same pattern as bulk-state): POST returns `{ jobId }`, the client polls `GET /export-jobs/:jobId` for `ExportJobState` progress and downloads from `GET /export-jobs/:jobId/result` (in-memory `ExportJobStore` in `export/export-jobs.ts`, cap 20 / 10-min TTL; REST + MCP stay synchronous). Progress denominators come from the translation DTOs' `total` unit counts (indeterminate UI when absent). Goes straight to Weblate via `listUnits` (no cache dependency); strings joined across languages by `content_hash`; file keys = context (non-empty) else source text; untranslated → empty value; plurals → `key_0`/`key_1`…; `merged` grouping: first component wins on duplicate keys. `GET /api/v1/languages?project&component` feeds the dialog's language choices.
- Public (key-less) REST export (`src/server/rest/public-export.ts` + `rest/cidr.ts`): requires BOTH `WFB_WEBLATE_EXPORT_API_KEY` and `WFB_WEBLATE_EXPORT_ALLOWED_HOSTS` (comma-separated CIDR; client IP from `req.ip` — no trust proxy configured). State reported at start via `reportPublicExportStatus`; request-time: missing/bad config → 403, host outside ranges → 403, configured key rejected → 503 (re-validated per request via the shared `createKeyValidator`, transitions logged). Mock mode allows key-less export (any key accepted there anyway).
- Tests use the mock client end-to-end (supertest → real Express routes); prefer extending those over mocking inside the app.
- External REST API (`src/server/rest/`, mounted at `/api/rest/v1` in `app.ts`, separate from `/api/v1`): Weblate API-key auth per request (`Authorization: Token <key>` / `X-API-Key`, validated against `/api/projects/` with a 5-min cache — `/api/user/` does NOT exist on the live instance; mock mode accepts any key). The business logic lives in `src/server/rest/operations.ts`, shared with the **MCP server** (`src/server/mcp/server.ts`, mounted at `/mcp/v1`: streamable HTTP, stateless, JSON responses; same API-key auth; 5 tools mirroring the REST routes — supertest clients must send `Accept: application/json, text/event-stream`). Endpoints: GET projects/components, POST batch-create strings (source required; other languages → state 10; key-less items get a server-generated `auto-…` context because the live serializer requires an explicit key), PATCH by context (several languages at once), DELETE (per-language "delete" = `clear=true` → state 0 empty target, since live Weblate refuses target-unit deletion; whole string = `language=<source>&all=true`). Unit creation body uses `value` (plural-aware target list) + `source` + `key` — verified live on canopy. **Live quirks**: `q=context:<key>` is a case-insensitive SUBSTRING search (`context:truc` also matches "…INSTRUCTION…") — `findUnitByContext` exact-checks the hit, and the mock emulates the substring behavior; new strings propagate to all translations immediately but the search index can lag, so createStrings retries the lookup when the fallback create collides (upstream 404). Live rules emulated by the mock: content states need non-empty target, untranslated needs empty target. The API is documented by a **hand-written OpenAPI spec** in `rest/openapi.ts`, served unauthenticated at `GET /api/rest/v1/openapi.json` (mounted before the auth middleware) and rendered by the vendored Swagger UI page (`public/openapi/` → served at `/openapi/` via Vite's static copy to `dist/client`). Both are **opt-in via `WFB_OPENAPI`** (values matched case- and blank-insensitively: `true`/`on`/`1` enable them, `try`/`with-try`/`with_try`/`swagger-with-try`/`swagger_with_try` additionally activate the page's "Try it out" button via the spec's `x-try-it-out` extension; anything else 404s — spec gated in the route, page gated by a middleware before `express.static` in `index.ts`). Update `openapi.ts` and re-vendor assets whenever REST endpoints change.