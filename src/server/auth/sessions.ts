/**
 * Server-side per-user Weblate sessions. The browser only ever holds our
 * own opaque session cookie; the Weblate session cookie (and the user's
 * credentials at login time) never leave the server.
 */
import { randomUUID } from 'node:crypto';
import { logWarn } from '../log.js';

export interface WeblateSession {
  /** Cookie header to send with every upstream request, e.g.
   *  "sessionid=…; csrftoken=…". */
  cookies: string;
  /** CSRF token for session-authenticated writes (X-CSRFToken). */
  csrfToken: string;
  username: string;
  createdAt: number;
  /**
   * 'pending': password accepted, waiting for the TOTP second factor.
   * 'active': fully logged in.
   */
  state: 'pending' | 'active';
  /** Second-factor form action (only while pending). */
  twofactorUrl?: string;
}

/** Merges Set-Cookie pairs into a single Cookie request header. */
export function mergeCookies(
  current: Record<string, string>,
  setCookies: string[],
): Record<string, string> {
  const jar = { ...current };
  for (const sc of setCookies) {
    const pair = sc.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === '' || value === '') continue;
    jar[name] = value;
  }
  return jar;
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** Extracts the CSRF hidden-field value from the login page HTML. */
export function parseCsrfToken(html: string): string | null {
  const m =
    /name="csrfmiddlewaretoken"[^>]*value="([^"]+)"/.exec(html) ??
    /value="([^"]*)"[^>]*name="csrfmiddlewaretoken"/.exec(html);
  return m?.[1] ?? null;
}

/**
 * Reads a fresh, session-bound CSRF token by scraping a page that renders
 * a form. Instances running Django with CSRF_USE_SESSIONS keep the token
 * in the session and never set a `csrftoken` cookie, so the token needed
 * for API writes (X-CSRFToken) can only come from rendered HTML.
 * Non-fatal: on failure the caller falls back to the cookie-derived token.
 */
async function scrapeCsrfToken(
  fetchImpl: LoginFetch,
  baseUrl: string,
  cookies: Record<string, string>,
  forwardedFor: string = '',
): Promise<{ token: string; cookies: Record<string, string> }> {
  let jar = cookies;
  try {
    const res = await loginFetch(fetchImpl, `${baseUrl}/accounts/profile/`, {
      method: 'GET',
      headers: withForwardedFor(forwardedFor, { Cookie: cookieHeader(jar), Accept: 'text/html' }),
    });
    jar = mergeCookies(jar, res.headers.getSetCookie());
    if (res.status === 200) {
      const token = parseCsrfToken(await res.text());
      if (token !== null) return { token, cookies: jar };
    }
  } catch {
    // Unreachable profile page: fall back to the cookie-derived token.
  }
  return { token: '', cookies: jar };
}

/**
 * Pulls human-readable error messages out of the re-rendered login page
 * (wrong password, rate-limited account, inactive user…).
 */
export function parseLoginErrors(html: string): string | null {
  const texts: string[] = [];
  for (const m of html.matchAll(
    /<(?:li|p|div)[^>]*class="[^"]*(?:errorlist|alert-danger|invalid-feedback)[^"]*"[^>]*>([\s\S]*?)<\/(?:li|p|div)>/g,
  )) {
    const text = m[1]!
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text !== '') texts.push(text);
  }
  if (texts.length === 0) return null;
  return [...new Set(texts)].join(' | ').slice(0, 300);
}

export interface SecondFactorForm {
  /** Absolute URL to POST the second factor to. */
  action: string;
  csrfToken: string;
  hasOtpField: boolean;
}

/**
 * Detects the second-factor form on a page (django-otp renders an
 * `otp_token` input; WebAuthn-only pages have none we can use).
 * `pageUrl` is the URL the page was fetched from — an empty form `action`
 * means "post to the current URL" and must resolve against it.
 */
export function parseSecondFactor(
  html: string,
  baseUrl: string,
  pageUrl: string,
): SecondFactorForm | null {
  if (!/name="otp_token"/.test(html)) return null;
  const formMatch = /<form[^>]*>([\s\S]*?)<\/form>/.exec(
    html.slice(Math.max(0, html.indexOf('otp_token') - 600), html.indexOf('otp_token') + 600),
  );
  const actionMatch =
    formMatch !== null ? /action="([^"]*)"/.exec(formMatch[0] ?? '') : null;
  const csrf = parseCsrfToken(html);
  const action = actionMatch?.[1] ?? '';
  return {
    action: new URL(action, pageUrl !== '' ? pageUrl : baseUrl).toString(),
    csrfToken: csrf ?? '',
    hasOtpField: true,
  };
}

export class WeblateSessionStore {
  private sessions = new Map<string, WeblateSession>();

  /**
   * `csrfToken` comes from the login flow (scraped from HTML and/or the
   * cookie jar); instances with CSRF_USE_SESSIONS have no csrftoken cookie
   * at all, so it must be passed explicitly.
   */
  createActive(username: string, cookies: Record<string, string>, csrfToken?: string): string {
    const uiSessionId = randomUUID();
    this.sessions.set(uiSessionId, {
      cookies: cookieHeader(cookies),
      csrfToken: csrfToken || cookies['csrftoken'] || cookies['csrfmiddlewaretoken'] || '',
      username,
      createdAt: Date.now(),
      state: 'active',
    });
    return uiSessionId;
  }

  createPending(
    username: string,
    cookies: Record<string, string>,
    twofactorUrl: string,
    csrfToken: string,
  ): string {
    const uiSessionId = randomUUID();
    this.sessions.set(uiSessionId, {
      cookies: cookieHeader(cookies),
      csrfToken,
      username,
      createdAt: Date.now(),
      state: 'pending',
      twofactorUrl,
    });
    return uiSessionId;
  }

  /** Completes a pending session after a successful second factor. */
  activate(
    uiSessionId: string,
    cookies: Record<string, string>,
    username: string,
    csrfToken?: string,
  ): void {
    const session = this.sessions.get(uiSessionId);
    if (session === undefined) return;
    this.sessions.set(uiSessionId, {
      ...session,
      cookies: cookieHeader(cookies),
      csrfToken: csrfToken || cookies['csrftoken'] || cookies['csrfmiddlewaretoken'] || session.csrfToken,
      username,
      state: 'active',
      twofactorUrl: undefined,
    });
  }

  get(uiSessionId: string | undefined): WeblateSession | null {
    if (uiSessionId === undefined || uiSessionId === '') return null;
    return this.sessions.get(uiSessionId) ?? null;
  }

  /** Only fully authenticated sessions may use the data endpoints. */
  getActive(uiSessionId: string | undefined): WeblateSession | null {
    const session = this.get(uiSessionId);
    return session !== null && session.state === 'active' ? session : null;
  }

  remove(uiSessionId: string): void {
    this.sessions.delete(uiSessionId);
  }

  count(): number {
    return this.sessions.size;
  }
}

export class LoginError extends Error {
  constructor(
    message: string,
    public invalidCredentials = false,
  ) {
    super(message);
    this.name = 'LoginError';
  }
}

interface LoginFetch {
  (url: string, init: RequestInit): Promise<Response>;
}

const LOGIN_TIMEOUT_MS = 15_000;

/** fetch with timeout + network errors mapped to actionable LoginErrors. */
async function loginFetch(
  fetchImpl: LoginFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LoginError(describeNetworkError(err));
  }
}

/**
 * Node's fetch throws bare "TypeError: fetch failed"; the interesting
 * reason (ECONNREFUSED, ETIMEDOUT, ENOTFOUND…) hides in `err.cause`.
 */
export function describeNetworkError(err: unknown): string {
  const cause =
    err instanceof Error && 'cause' in err && err.cause !== undefined
      ? ` (${String(err.cause)})`
      : '';
  return `Weblate is unreachable: ${String(err)}${cause}`;
}

/**
 * Performs Weblate's form login server-side:
 * GET the login page (CSRF token), POST credentials, then verify by
 * calling the API. Redirects are followed manually so cookies set on
 * intermediate 302 responses are not lost.
 *
 * When the account has TOTP (or backup codes) enabled, Weblate answers
 * with a second-factor form instead of a session; the outcome is
 * 'totp_required' and the login completes via weblateLoginTotp().
 */

/** Adds the originating client IP as X-Forwarded-For when known — instances
 *  behind a reverse proxy cannot obtain a remote IP without it and then
 *  rate-limit every such request into one shared bucket (HTTP 429). */
const withForwardedFor = (
  forwardedFor: string,
  headers: Record<string, string> = {},
): Record<string, string> =>
  forwardedFor === '' ? headers : { ...headers, 'X-Forwarded-For': forwardedFor };

export type LoginOutcome =
  | { status: 'ok'; cookies: Record<string, string>; csrfToken: string; username: string }
  | {
      status: 'totp_required';
      cookies: Record<string, string>;
      twofactorUrl: string;
      csrfToken: string;
      username: string;
    };

export async function weblateLogin(
  baseUrl: string,
  username: string,
  password: string,
  /** Originating client IP, forwarded to Weblate (X-Forwarded-For). */
  forwardedFor: string = '',
  fetchImpl: LoginFetch = fetch,
): Promise<LoginOutcome> {
  let cookies: Record<string, string> = {};

  // 1. Fetch the login page and its CSRF token.
  const page = await loginFetch(fetchImpl, `${baseUrl}/accounts/login/`, {
    method: 'GET',
    headers: withForwardedFor(forwardedFor, { Accept: 'text/html' }),
  });
  if (page.status !== 200) {
    throw new LoginError(`Weblate login page returned HTTP ${page.status}`);
  }
  cookies = mergeCookies(cookies, page.headers.getSetCookie());
  const html = await page.text();
  const csrf = parseCsrfToken(html);
  if (csrf === null) {
    throw new LoginError('Could not find the CSRF token on the Weblate login page.');
  }

  // 2. POST the credentials (form-encoded), following redirects manually
  //    to keep every Set-Cookie along the way.
  const body = new URLSearchParams({
    username,
    password,
    csrfmiddlewaretoken: csrf,
    next: '/',
  });
  let res = await loginFetch(fetchImpl, `${baseUrl}/accounts/login/`, {
    method: 'POST',
    redirect: 'manual',
    headers: withForwardedFor(forwardedFor, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(cookies),
      Referer: `${baseUrl}/accounts/login/`,
    }),
    body: body.toString(),
  });
  cookies = mergeCookies(cookies, res.headers.getSetCookie());

  // Follow the redirect chain manually (Django answers 302 on success),
  // stopping if a second-factor form appears (TOTP-enabled accounts).
  let pageUrl = `${baseUrl}/accounts/login/`;
  for (let hops = 0; hops < 6; hops++) {
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('Location');
      if (location === null) break;
      pageUrl = new URL(location, baseUrl).toString();
      res = await loginFetch(fetchImpl, pageUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: withForwardedFor(forwardedFor, { Cookie: cookieHeader(cookies) }),
      });
      cookies = mergeCookies(cookies, res.headers.getSetCookie());
      continue;
    }
    if (res.status === 200) {
      const pageHtml = await res.text();
      const secondFactor = parseSecondFactor(pageHtml, baseUrl, pageUrl);
      if (secondFactor !== null) {
        return {
          status: 'totp_required',
          cookies,
          twofactorUrl: secondFactor.action,
          csrfToken: secondFactor.csrfToken,
          username,
        };
      }
      // A 200 immediately after the POST is a re-rendered login page
      // (wrong password, rate-limited, inactive account...). A 200 after
      // a redirect hop is the normal post-login landing page.
      if (hops === 0) {
        const detail = parseLoginErrors(pageHtml);
        throw new LoginError(
          detail !== null
            ? `Weblate rejected the login: ${detail}`
            : 'Invalid username or password.',
          true,
        );
      }
      break;
    }
    if (res.status === 400) {
      throw new LoginError(
        'Weblate rejected the login request (CSRF validation). Please try again.',
      );
    }
    break;
  }

  return finishLogin(fetchImpl, baseUrl, cookies, username, forwardedFor);
}

/** Shared completion: API probe + best-effort username resolution. */
async function finishLogin(
  fetchImpl: LoginFetch,
  baseUrl: string,
  cookies: Record<string, string>,
  username: string,
  forwardedFor: string = '',
): Promise<
  | { status: 'ok'; cookies: Record<string, string>; csrfToken: string; username: string }
  | { status: 'totp_required'; cookies: Record<string, string>; twofactorUrl: string; csrfToken: string; username: string }
> {
  // Verify the session actually authenticates against the API.
  // /api/projects/ is used as the probe: it requires authentication on
  // instances with REQUIRE_LOGIN and exists on every Weblate version
  // (unlike /api/user/, which is not universal).
  const probe = await loginFetch(fetchImpl, `${baseUrl}/api/projects/`, {
    method: 'GET',
    headers: withForwardedFor(forwardedFor, { Cookie: cookieHeader(cookies), Accept: 'application/json' }),
  });
  if (probe.status !== 200) {
    if (probe.status === 403 || probe.status === 401) {
      // Session not fully authenticated -> a second factor may still be pending.
      const page = await loginFetch(fetchImpl, `${baseUrl}/accounts/login/`, {
        method: 'GET',
        headers: withForwardedFor(forwardedFor, { Accept: 'text/html' }),
      });
      cookies = mergeCookies(cookies, page.headers.getSetCookie());
      const form = parseSecondFactor(
        await page.text(),
        baseUrl,
        `${baseUrl}/accounts/login/`,
      );
      if (form !== null) {
        return {
          status: 'totp_required',
          cookies,
          twofactorUrl: form.action,
          csrfToken: form.csrfToken,
          username,
        };
      }
    }
    if (probe.status === 429) {
      // Weblate throttles/locks repeated sign-in attempts from one address
      // (django-axes lockout or the API rate limit).
      const retryAfter = probe.headers.get('Retry-After');
      throw new LoginError(
        'Too many sign-in attempts — Weblate is rate-limiting this address (HTTP 429). ' +
          `Wait for the cooldown${retryAfter !== null ? ` (Retry-After: ${retryAfter}s)` : ' (usually about an hour)'}, ` +
          'sign in from another IP, or clear the block in Weblate (manage.py axes_reset).',
      );
    }
    throw new LoginError(
      `Sign-in appeared to succeed, but Weblate did not accept the session (HTTP ${probe.status}).`,
    );
  }
  cookies = mergeCookies(cookies, probe.headers.getSetCookie());

  // Resolve the CSRF token for later API writes. Prefer one scraped from
  // rendered HTML: instances with CSRF_USE_SESSIONS never set a csrftoken
  // cookie, and even on cookie-based instances Django rotates the token on
  // login, so a fresh scrape is always the safest source.
  const scraped = await scrapeCsrfToken(fetchImpl, baseUrl, cookies, forwardedFor);
  cookies = scraped.cookies;
  const csrfToken =
    scraped.token || cookies['csrftoken'] || cookies['csrfmiddlewaretoken'] || '';

  // Best effort: resolve the real username (endpoint is not universal).
  let resolved = username;
  const profile = await fetchImpl(`${baseUrl}/api/user/`, {
    method: 'GET',
    headers: withForwardedFor(forwardedFor, { Cookie: cookieHeader(cookies), Accept: 'application/json' }),
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  }).catch(() => null);
  if (profile !== null && profile.status === 200) {
    const profileBody = (await profile.json().catch(() => ({}))) as { username?: string };
    if (profileBody.username !== undefined && profileBody.username !== '') {
      resolved = profileBody.username;
    }
  }

  return { status: 'ok', cookies, csrfToken, username: resolved };
}

/**
 * Second factor phase: submits the TOTP code (or a backup code) to the
 * second-factor form captured during weblateLogin().
 */
export async function weblateLoginTotp(
  baseUrl: string,
  cookies: Record<string, string>,
  twofactorUrl: string,
  csrfToken: string,
  token: string,
  /** Username from the first phase — the resolved identity when the API
   *  cannot tell us (no /api/user/ on every instance). */
  username: string = 'totp',
  /** Originating client IP, forwarded to Weblate (X-Forwarded-For). */
  forwardedFor: string = '',
  fetchImpl: LoginFetch = fetch,
): Promise<{ status: 'ok'; cookies: Record<string, string>; csrfToken: string; username: string }> {
  const body = new URLSearchParams({
    otp_token: token.trim(),
    csrfmiddlewaretoken: csrfToken,
  });
  const res = await loginFetch(fetchImpl, twofactorUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: withForwardedFor(forwardedFor, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader(cookies),
      Referer: twofactorUrl,
    }),
    body: body.toString(),
  });
  let jar = mergeCookies(cookies, res.headers.getSetCookie());

  // 405 on GET earlier showed the view is POST-only; a 200 here means the
  // code was wrong (form re-rendered).
  if (res.status === 200) {
    const detail = parseLoginErrors(await res.text());
    throw new LoginError(
      detail !== null
        ? `Weblate rejected the second factor: ${detail}`
        : 'Invalid or expired authentication code.',
      true,
    );
  }
  if (res.status === 400) {
    throw new LoginError('Weblate rejected the second-factor request (CSRF). Please restart the login.');
  }

  // Follow the post-2FA redirect chain, then verify via the API.
  let last = res;
  for (let hops = 0; last.status >= 300 && last.status < 400 && hops < 5; hops++) {
    const location = last.headers.get('Location');
    if (location === null) break;
    last = await loginFetch(fetchImpl, new URL(location, baseUrl).toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: withForwardedFor(forwardedFor, { Cookie: cookieHeader(jar) }),
    });
    jar = mergeCookies(jar, last.headers.getSetCookie());
    logWarn(
      `[auth] second factor: hop ${hops} -> HTTP ${last.status} ${new URL(last.url ?? '', baseUrl).pathname}` +
        ` (cookies now: ${Object.keys(jar).join(', ') || 'none'})`,
    );
  }

  // A landing page that still shows the second-factor form means the code
  // was not accepted (some flows re-render via redirect instead of 200).
  if (last.status === 200 && /name="otp_token"/.test(await last.clone().text())) {
    throw new LoginError('Invalid or expired authentication code.', true);
  }

  const outcome = await finishLogin(fetchImpl, baseUrl, jar, username, forwardedFor);
  if (outcome.status !== 'ok') {
    logWarn('[auth] second factor: session still pending a second factor after submit');
    throw new LoginError(
      'Weblate still asks for a second factor after the code was submitted.',
    );
  }
  return outcome;
}