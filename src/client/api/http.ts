export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions extends RequestInit {
  /** Client-side timeout for this request (default 30s). */
  timeoutMs?: number;
}

export async function api<T>(path: string, init?: ApiOptions): Promise<T> {
  const { timeoutMs = 30_000, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      ...rest,
      // The backend proxies Weblate (upstream timeout 15s there); this is
      // the safety net if the backend itself hangs or dies mid-request.
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(rest.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...rest.headers,
      },
    });
  } catch (err) {
    throw new ApiError(
      0,
      err instanceof DOMException && err.name === 'TimeoutError'
        ? 'Request timed out — Weblate did not answer in time'
        : 'Backend unreachable',
    );
  }

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    // Session expired or not logged in: let the app show the login view.
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('wl-unauthorized'));
    }
    const detail =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string'
        ? body.error
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, detail);
  }

  return body as T;
}