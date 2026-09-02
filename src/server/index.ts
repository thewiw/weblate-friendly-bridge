import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { CacheRegistry } from './cache/cache-registry.js';
import { createWeblateApi } from './weblate/client.js';
import { WeblateSessionStore } from './auth/sessions.js';
import { createApp } from './app.js';
import { reportPublicExportStatus } from './rest/public-export.js';

const api = createWeblateApi();
const registry = new CacheRegistry(api);

// Session mode (no WEBLATE_TOKEN): users authenticate through the login
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
  apiKey: config.weblateApiKey,
  allowedHosts: config.weblateApiAllowedHosts,
});

// Production: serve the built frontend from the same port, with an SPA
// fallback so deep links (URL search params) always load the app.
// Resolved from the working directory (the app is started from the
// project root, in dev and production alike).
const clientDir = path.resolve(process.cwd(), 'dist/client');
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `weblate-friendly-bridge server on :${config.port} (mode: ${config.mode}, auth: ${config.authMode}, weblate: ${config.weblateUrl})`,
  );
});