import type {
  Paginated,
  UnitCreateBody,
  UnitPatchBody,
  WeblateComponent,
  WeblateProject,
  WeblateTranslation,
  WeblateUnit,
} from '../../shared/weblate-dto.js';
import { mapUpstreamStatus, UpstreamError } from '../http-errors.js';
import { describeNetworkError } from '../auth/sessions.js';
import { iteratePaginated, withQ } from './paginate.js';
import { config } from '../config.js';
import * as mockModule from './mock/mock-client.js';

export interface RateBudget {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
}

export interface ListUnitsOptions {
  signal?: AbortSignal;
}

/**
 * Everything the app needs from Weblate. Implemented by LiveWeblateClient
 * (real HTTP) and MockWeblateClient (in-memory fixtures) — the swap happens
 * in createWeblateApi() only.
 */
export interface WeblateApi {
  /** Which implementation is behind this instance (for /health). */
  readonly mode: 'live' | 'mock';
  listProjects(): Promise<WeblateProject[]>;
  listComponents(project: string): Promise<WeblateComponent[]>;
  /** Single project — used to detect translation_review. */
  getProject(project: string): Promise<WeblateProject>;
  /** Canonical translations-listing URL of a project/component. */
  translationsUrlFor(project: string, component: string): string;
  /**
   * Canonical units-listing URL of one translation. Built from the
   * configured base URL, NOT from the API-provided units_list_url —
   * instances often advertise internal hostnames there.
   */
  unitsUrlFor(project: string, component: string, language: string): string;
  /** Lists translations (languages) of one component. */
  listTranslations(componentTranslationsUrl: string): Promise<WeblateTranslation[]>;
  /** Yields all units of one translation, page by page. */
  listUnits(
    translationUnitsUrl: string,
    q?: string,
    opts?: ListUnitsOptions,
  ): AsyncIterable<WeblateUnit>;
  getUnit(id: number): Promise<WeblateUnit>;
  patchUnit(id: number, body: UnitPatchBody): Promise<WeblateUnit>;
  /** Creates a new unit in one translation (monolingual formats). */
  createUnit(unitsUrl: string, body: UnitCreateBody): Promise<WeblateUnit>;
  /** Deletes a unit; deleting a source unit removes the whole string. */
  deleteUnit(id: number): Promise<void>;
  getRateBudget(): RateBudget;
}

const REQUEST_TIMEOUT_MS = 15_000;
const GET_RETRIES = 2;

/** How upstream requests authenticate. */
export type WeblateAuth =
  | { kind: 'token'; token: string }
  | { kind: 'session'; cookies: string; csrfToken: string };

export class LiveWeblateClient implements WeblateApi {
  readonly mode = 'live' as const;

  private rateBudget: RateBudget = {
    limit: null,
    remaining: null,
    reset: null,
  };

  constructor(
    private readonly baseUrl: string,
    private readonly auth: WeblateAuth,
    /** Originating client IP, sent as X-Forwarded-For. Instances behind a
     *  reverse proxy (IP_BEHIND_REVERSE_PROXY) cannot obtain a remote IP
     *  without it and then rate-limit every such request in one bucket. */
    private readonly forwardedFor: string = '',
  ) {}

  private authHeaders(): Record<string, string> {
    if (this.auth.kind === 'token') {
      return { Authorization: `Token ${this.auth.token}` };
    }
    return {
      Cookie: this.auth.cookies,
      ...(this.auth.csrfToken !== '' ? { 'X-CSRFToken': this.auth.csrfToken } : {}),
    };
  }

  getRateBudget(): RateBudget {
    return { ...this.rateBudget };
  }

  async listProjects(): Promise<WeblateProject[]> {
    const page = await this.get<Paginated<WeblateProject>>(
      `${this.baseUrl}/api/projects/`,
    );
    return page.results;
  }

  async listComponents(project: string): Promise<WeblateComponent[]> {
    const page = await this.get<Paginated<WeblateComponent>>(
      `${this.baseUrl}/api/projects/${encodeURIComponent(project)}/components/`,
    );
    return page.results;
  }

  async getProject(project: string): Promise<WeblateProject> {
    return this.get<WeblateProject>(
      `${this.baseUrl}/api/projects/${encodeURIComponent(project)}/`,
    );
  }

  translationsUrlFor(project: string, component: string): string {
    return `${this.baseUrl}/api/components/${encodeURIComponent(project)}/${encodeURIComponent(component)}/translations/`;
  }

  unitsUrlFor(project: string, component: string, language: string): string {
    return `${this.baseUrl}/api/translations/${encodeURIComponent(project)}/${encodeURIComponent(component)}/${encodeURIComponent(language)}/units/`;
  }

  async listTranslations(
    componentTranslationsUrl: string,
  ): Promise<WeblateTranslation[]> {
    const page =
      await this.get<Paginated<WeblateTranslation>>(componentTranslationsUrl);
    return page.results;
  }

  listUnits(
    translationUnitsUrl: string,
    q?: string,
    opts?: ListUnitsOptions,
  ): AsyncIterable<WeblateUnit> {
    const url = q ? withQ(translationUnitsUrl, q) : translationUnitsUrl;
    return iteratePaginated<WeblateUnit>(
      (u, signal) => this.get<Paginated<WeblateUnit>>(u, { signal, retries: GET_RETRIES }),
      url,
      { pageSize: config.unitsPageSize, signal: opts?.signal },
    );
  }

  async getUnit(id: number): Promise<WeblateUnit> {
    return this.get<WeblateUnit>(`${this.baseUrl}/api/units/${id}/`, {
      retries: GET_RETRIES,
    });
  }

  /** Never retried: a PATCH may have landed even if the response was lost. */
  async patchUnit(id: number, body: UnitPatchBody): Promise<WeblateUnit> {
    return this.request<WeblateUnit>(
      `${this.baseUrl}/api/units/${id}/`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  }

  async createUnit(unitsUrl: string, body: UnitCreateBody): Promise<WeblateUnit> {
    // Live contract (verified): `value` is the target of the translation
    // being added (plural-aware list), `source` the source text.
    return this.request<WeblateUnit>(unitsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(body.key !== undefined ? { key: body.key } : {}),
        source: body.source,
        value: body.target ?? body.source,
        ...(body.state !== undefined ? { state: body.state } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async deleteUnit(id: number): Promise<void> {
    await this.request<unknown>(
      `${this.baseUrl}/api/units/${id}/`,
      {
        method: 'DELETE',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  }

  private async get<T>(url: string, opts?: { retries?: number; signal?: AbortSignal }): Promise<T> {
    const retries = opts?.retries ?? 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const signals: AbortSignal[] = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
        if (opts?.signal) signals.push(opts.signal);
        return await this.request<T>(url, { method: 'GET', signal: AbortSignal.any(signals) });
      } catch (err) {
        lastError = err;
        // Retry only on network errors / 5xx / timeouts, not on 4xx.
        if (err instanceof UpstreamError && err.status < 500) throw err;
        if (attempt < retries) {
          await sleep(250 * 2 ** attempt);
        }
      }
    }
    throw lastError;
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          ...this.authHeaders(),
          Accept: 'application/json',
          ...(this.forwardedFor !== '' ? { 'X-Forwarded-For': this.forwardedFor } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      throw new UpstreamError(502, describeNetworkError(err));
    }

    this.trackRateBudget(res);

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // keep body null
      }
      throw mapUpstreamStatus(
        res.status,
        body,
        res.headers.get('Retry-After') ?? undefined,
      );
    }

    // DELETE answers 204 with no body; tolerate that (and any empty body).
    const text = await res.text();
    if (text === '') return undefined as T;
    return JSON.parse(text) as T;
  }

  private trackRateBudget(res: Response): void {
    const limit = res.headers.get('X-RateLimit-Limit');
    const remaining = res.headers.get('X-RateLimit-Remaining');
    const reset = res.headers.get('X-RateLimit-Reset');
    if (limit !== null || remaining !== null || reset !== null) {
      this.rateBudget = {
        limit: limit !== null ? Number(limit) : null,
        remaining: remaining !== null ? Number(remaining) : null,
        reset,
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWeblateApi(): WeblateApi {
  if (config.mode === 'mock') {
    const { MockWeblateClient } = mockModule;
    return new MockWeblateClient();
  }
  return new LiveWeblateClient(config.weblateUrl, {
    kind: 'token',
    token: config.weblateApiKey,
  });
}

/** A per-user Weblate client backed by that user's server-side session. */
export function createSessionWeblateApi(
  baseUrl: string,
  cookies: string,
  csrfToken: string,
  /** Originating client IP for X-Forwarded-For (see LiveWeblateClient). */
  forwardedFor: string = '',
): WeblateApi {
  return new LiveWeblateClient(baseUrl, {
    kind: 'session',
    cookies,
    csrfToken,
  }, forwardedFor);
}

/** A client authenticated by a Weblate API key (external REST API). */
export function createTokenWeblateApi(
  baseUrl: string,
  token: string,
  forwardedFor: string = '',
): WeblateApi {
  return new LiveWeblateClient(baseUrl, { kind: 'token', token }, forwardedFor);
}