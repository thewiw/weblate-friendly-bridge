import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../../server/app.js';
import { CacheRegistry } from '../../server/cache/cache-registry.js';
import { LiveWeblateClient } from '../../server/weblate/client.js';
import { WeblateSessionStore } from '../../server/auth/sessions.js';

/**
 * A tiny fake Weblate implementing just enough for the login flow:
 * the login form, credential check, session cookie, and API auth.
 */
const VALID = { username: 'translator', password: 'secret123' };
const VALID_TOTP = { username: 'totpuser', password: 'totppass', code: '654321' };
/** session id -> username (fake Weblate session store). */
const SESSIONS = new Map<string, string>();
/** Partially-authenticated sessions (2FA stage 1 passed). */
const PENDING = new Set<string>();
let csrfCounter = 0;

const fakeWeblate = http.createServer((req, res) => {
  const url = req.url ?? '';
  const cookies: Record<string, string> = {};
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  if (req.method === 'GET' && url === '/accounts/login/') {
    const csrf = `csrf${++csrfCounter}`;
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': `csrftoken=${csrf}; Path=/`,
    });
    res.end(
      `<form method="post" action="/accounts/login/">
         <input name="csrfmiddlewaretoken" value="${csrf}">
         <input name="username"><input name="password"><input name="next" value="/">
       </form>`,
    );
    return;
  }

  if (req.method === 'POST' && url === '/accounts/login/') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      // Django CSRF: the form token must match the cookie.
      if (params.get('csrfmiddlewaretoken') !== cookies['csrftoken']) {
        res.writeHead(403).end('CSRF failure');
        return;
      }
      if (
        params.get('username') !== VALID.username &&
        params.get('username') !== VALID_TOTP.username
      ) {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('login page again');
        return;
      }
      const passwordOk =
        params.get('password') === VALID.password ||
        params.get('password') === VALID_TOTP.password;
      if (!passwordOk) {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('login page again');
        return;
      }

      // TOTP user: partial session + second-factor form instead of a session.
      if (params.get('username') === VALID_TOTP.username) {
        const psid = `pend${Math.random()}`;
        PENDING.add(psid);
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': [
            `sessionid=${psid}; Path=/; HttpOnly`,
            `csrftoken=${cookies['csrftoken'] ?? ''}; Path=/`,
          ],
        });
        res.end(
          `<form method="post" action="/accounts/login/twofactor/">
             <input name="csrfmiddlewaretoken" value="${cookies['csrftoken'] ?? ''}">
             <input name="otp_token">
           </form>`,
        );
        return;
      }

      const sid = `sid${Math.random()}`;
      SESSIONS.set(sid, params.get('username') ?? '');
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `sessionid=${sid}; Path=/; HttpOnly`,
      });
      res.end();
    });
    return;
  }

  if (req.method === 'POST' && url === '/accounts/login/twofactor/') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const pending = cookies['sessionid'] !== undefined && PENDING.has(cookies['sessionid']);
      if (!pending || params.get('otp_token') !== VALID_TOTP.code) {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('second factor again');
        return;
      }
      const sid = `sid${Math.random()}`;
      SESSIONS.set(sid, VALID_TOTP.username);
      PENDING.delete(cookies['sessionid']!);
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `sessionid=${sid}; Path=/; HttpOnly`,
      });
      res.end();
    });
    return;
  }

  const sessionUser = SESSIONS.get(cookies['sessionid'] ?? '');
  const authed = sessionUser !== undefined;

  if (req.method === 'GET' && url === '/api/user/') {
    if (!authed) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"detail":"no"}');
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ username: sessionUser }));
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/')) {
    if (!authed) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"detail":"unauthenticated"}');
      return;
    }
    if (url === '/api/projects/') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [{ slug: 'demo', name: 'Demo', web_url: '' }],
        }),
      );
      return;
    }
  }

  res.writeHead(404).end();
});

let baseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) =>
    fakeWeblate.listen(0, '127.0.0.1', () => resolve()),
  );
  baseUrl = `http://127.0.0.1:${(fakeWeblate.address() as AddressInfo).port}`;
});

afterAll(() => {
  fakeWeblate.close();
});

/**
 * A second fake Weblate running like Django's CSRF_USE_SESSIONS: NO
 * csrftoken cookie is ever set (the live instance behaves this way), the
 * token lives in the session, and API writes require X-CSRFToken to
 * match it. Regression context: with only the cookie jar to derive the
 * token from, every PATCH failed with "CSRF Failed: CSRF token missing."
 */
const SESSIONS2 = new Map<string, string>();
/** sessionid -> current CSRF token (rotated on login, as Django does). */
const SESSION_TOKENS = new Map<string, string>();
let counter = 0;

const fakeWeblateSessionCsrf = http.createServer((req, res) => {
  const url = req.url ?? '';
  const cookies: Record<string, string> = {};
  for (const pair of (req.headers.cookie ?? '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const sid = cookies['sessionid'] ?? '';
  const user = SESSIONS2.get(sid);
  const form = (token: string) =>
    `<form><input name="csrfmiddlewaretoken" value="${token}"></form>`;

  if (req.method === 'GET' && url === '/accounts/login/') {
    const anon = `anon${++counter}`;
    SESSION_TOKENS.set(anon, `tok${++counter}`);
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': `sessionid=${anon}; Path=/; HttpOnly`,
    });
    res.end(form(SESSION_TOKENS.get(anon)!));
    return;
  }

  if (req.method === 'POST' && url === '/accounts/login/') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('csrfmiddlewaretoken') !== SESSION_TOKENS.get(sid)) {
        res.writeHead(403).end('CSRF failure');
        return;
      }
      if (params.get('username') !== 'csrfuser' || params.get('password') !== 'pw') {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(form(SESSION_TOKENS.get(sid) ?? ''));
        return;
      }
      const newSid = `sid${++counter}`;
      // Django rotates the CSRF token on login.
      SESSIONS2.set(newSid, 'csrfuser');
      SESSION_TOKENS.set(newSid, `tok${++counter}`);
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `sessionid=${newSid}; Path=/; HttpOnly`,
      });
      res.end();
    });
    return;
  }

  if (req.method === 'GET' && url === '/accounts/profile/') {
    if (user === undefined) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(form(SESSION_TOKENS.get(sid) ?? ''));
    return;
  }

  if (user === undefined) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"detail":"unauthenticated"}');
    return;
  }

  if (req.method === 'GET' && url === '/api/user/') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ username: user }));
    return;
  }

  if (req.method === 'GET' && url === '/api/projects/') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    );
    return;
  }

  if (url === '/api/units/1' || url === '/api/units/1/') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: 1,
          translation: '/demo/app/de/',
          source: ['Hello'],
          target: ['hallo'],
          state: 20,
          content_hash: 1,
          timestamp: '2026-01-01T00:00:00+02:00',
          last_updated: '2026-01-01T00:00:00+02:00',
          has_comment: false,
          has_suggestion: false,
          has_failing_check: false,
          web_url: '',
        }),
      );
      return;
    }
    if (req.method === 'PATCH') {
      // DRF SessionAuthentication: writes demand the session CSRF token.
      if (req.headers['x-csrftoken'] !== SESSION_TOKENS.get(sid)) {
        res.writeHead(403, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ detail: 'CSRF Failed: CSRF token missing.' }),
        );
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const patch = JSON.parse(body || '{}') as { target?: string[]; state?: number };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ target: patch.target ?? [], state: patch.state ?? 0 }),
        );
      });
      return;
    }
  }

  res.writeHead(404).end();
});

let sessionCsrfBaseUrl = '';

beforeAll(async () => {
  await new Promise<void>((resolve) =>
    fakeWeblateSessionCsrf.listen(0, '127.0.0.1', () => resolve()),
  );
  sessionCsrfBaseUrl = `http://127.0.0.1:${(fakeWeblateSessionCsrf.address() as AddressInfo).port}`;
});

afterAll(() => {
  fakeWeblateSessionCsrf.close();
});

function makeApp() {
  const api = new LiveWeblateClient(baseUrl, { kind: 'token', token: 'unused' });
  const registry = new CacheRegistry(api);
  const store = new WeblateSessionStore();
  const app = createApp(api, registry, { auth: { store, baseUrl } });
  return {
    app,
    store,
    agent: () => request.agent(app), // persists cookies across requests
  };
}

describe('session auth', () => {
  it('rejects data endpoints before login', async () => {
    const { app } = makeApp();
    await request(app).get('/api/v1/projects').expect(401);
    await request(app).get('/api/v1/auth/status').expect(200);
  });

  it('rejects wrong credentials', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/api/v1/auth/login')
      .send({ username: VALID.username, password: 'wrong' })
      .expect(401);
  });

  it('logs in, sets our cookie, and serves data with the user session', async () => {
    const agent = makeApp().agent();

    const login = await agent
      .post('/api/v1/auth/login')
      .send({ username: VALID.username, password: VALID.password })
      .expect(200);
    expect(login.body.username).toBe('translator');

    const status = await agent.get('/api/v1/auth/status').expect(200);
    expect(status.body).toMatchObject({
      authMode: 'session',
      authenticated: true,
      username: 'translator',
    });

    const projects = await agent.get('/api/v1/projects').expect(200);
    expect(projects.body.results).toHaveLength(1);
  });

  it('totp user: first phase asks for a code, pending session is not usable', async () => {
    const { agent, store } = makeApp();
    const a = agent();

    const login = await a
      .post('/api/v1/auth/login')
      .send({ username: VALID_TOTP.username, password: VALID_TOTP.password })
      .expect(200);
    expect(login.body).toMatchObject({ status: 'totp_required' });

    // No data access with a pending session.
    await a.get('/api/v1/projects').expect(401);
    const status = await a.get('/api/v1/auth/status').expect(200);
    expect(status.body.authenticated).toBe(false);
    expect(store.count()).toBe(1);
  });

  it('totp user: wrong code rejected, correct code completes login', async () => {
    const agent = makeApp().agent();
    await agent
      .post('/api/v1/auth/login')
      .send({ username: VALID_TOTP.username, password: VALID_TOTP.password })
      .expect(200);

    await agent
      .post('/api/v1/auth/login/totp')
      .send({ token: '000000' })
      .expect(401);

    await agent.post('/api/v1/auth/login/totp').send({ token: VALID_TOTP.code }).expect(200);
    const projects = await agent.get('/api/v1/projects').expect(200);
    expect(projects.body.results).toHaveLength(1);
    const status = await agent.get('/api/v1/auth/status').expect(200);
    expect(status.body).toMatchObject({ authenticated: true, username: 'totpuser' });
  });

  it('logout ends the session', async () => {
    const agent = makeApp().agent();
    await agent
      .post('/api/v1/auth/login')
      .send({ username: VALID.username, password: VALID.password })
      .expect(200);
    await agent.post('/api/v1/auth/logout').expect(200);
    const status = await agent.get('/api/v1/auth/status').expect(200);
    expect(status.body.authenticated).toBe(false);
    await agent.get('/api/v1/projects').expect(401);
  });
});

describe('session auth on instances with CSRF_USE_SESSIONS (no csrftoken cookie)', () => {
  function makeSessionCsrfApp() {
    const api = new LiveWeblateClient(sessionCsrfBaseUrl, { kind: 'token', token: 'unused' });
    const registry = new CacheRegistry(api);
    const store = new WeblateSessionStore();
    const app = createApp(api, registry, { auth: { store, baseUrl: sessionCsrfBaseUrl } });
    return request.agent(app);
  }

  it('login captures the session-bound CSRF token and PATCH sends X-CSRFToken', async () => {
    const agent = makeSessionCsrfApp();
    await agent
      .post('/api/v1/auth/login')
      .send({ username: 'csrfuser', password: 'pw' })
      .expect(200);

    // The saved translation must reach Weblate with a valid X-CSRFToken
    // (previously: 403 "CSRF Failed: CSRF token missing.").
    const res = await agent
      .patch('/api/v1/units/1')
      .send({ target: ['hallo'], state: 20 })
      .expect(200);
    expect(res.body.unit).toMatchObject({ target: ['hallo'], state: 20, language: 'de' });
  });
});