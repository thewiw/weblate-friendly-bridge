import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { CacheRegistry } from './cache/cache-registry.js';
import { createWeblateApi } from './weblate/client.js';
import { WeblateSessionStore } from './auth/sessions.js';
import { createApp } from './app.js';
import { reportPublicExportStatus } from './rest/public-export.js';
import { logInfo } from './log.js';

const api = createWeblateApi();
const registry = new CacheRegistry(api);

// Session mode (no WEBLATE_API_KEY): users authenticate through the login
// view; each browser session gets its own server-side Weblate session.
const opts =
  config.mode === 'live' && config.authMode === 'session'
    ? {
        auth: {
          store: new WeblateSessionStore(),
          baseUrl: config.weblateUrl,
        },
      }
    : {};

const app = createApp(api, registry, opts);

// Report the public (key-less) REST export state — disabled/misconfigured
// or enabled, with the configured key validated against Weblate (live).
void reportPublicExportStatus({
  mode: config.mode,
  weblateUrl: config.weblateUrl,
  apiKey: config.weblateExportApiKey,
  allowedHosts: config.weblateExportAllowedHosts,
});

// Production: serve the built frontend from the same port, with an SPA
// fallback so deep links (URL search params) always load the app.
// Resolved from the working directory (the app is started from the
// project root, in dev and production alike).
const clientDir = path.resolve(process.cwd(), 'dist/client');
if (existsSync(clientDir)) {
  // The docs page is static in dist/client (public/openapi/) — hide it
  // (and its assets) when OPENAPI_UI is not enabled. Registered before
  // express.static so it takes precedence.
  if (!config.openapiUi) {
    app.use('/openapi', (_req, res) => {
      res.status(404).json({ error: 'Swagger UI disabled — set OPENAPI_UI=true to enable' });
    });
  }
  app.use(express.static(clientDir));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

app.listen(config.port, () => {

  logInfo(
    `weblate-friendly-bridge server on :${config.port} (mode: ${config.mode}, auth: ${config.authMode}, weblate: ${config.weblateUrl})`,
  );
});