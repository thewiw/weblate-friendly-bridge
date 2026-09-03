/**
 * Maps upstream (Weblate) failures to errors our own API surfaces,
 * with actionable messages for translators.
 */
export class UpstreamError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * Extracts a human-readable message from a Weblate error body. Two shapes
 * exist: classic DRF `{detail: "…"}` and the newer
 * `{type: "validation_error", errors: [{code, detail, attr}]}`.
 */
function extractDetail(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  if ('detail' in body && typeof body.detail === 'string') {
    return body.detail;
  }
  if ('errors' in body && Array.isArray(body.errors)) {
    const parts = body.errors
      .map((e) =>
        typeof e === 'object' && e !== null && 'detail' in e
          ? String(e.detail)
          : '',
      )
      .filter(Boolean);
    if (parts.length > 0) return [...new Set(parts)].join('; ');
  }
  return undefined;
}

export function mapUpstreamStatus(
  status: number,
  body: unknown,
  retryAfter?: string,
): UpstreamError {
  const detail = extractDetail(body);

  switch (status) {
    case 400:
      return new UpstreamError(400, detail || 'Weblate rejected the request.');
    case 401:
      return new UpstreamError(
        502,
        'Weblate rejected our API token (unauthorized). Check WFB_WEBLATE_API_KEY.',
      );
    case 403:
      return new UpstreamError(
        403,
        detail || 'Weblate rejected the action (missing permission?).',
      );
    case 404:
      return new UpstreamError(404, detail || 'Not found in Weblate.');
    case 429:
      return new UpstreamError(
        503,
        'Weblate rate limit reached. Try again shortly.',
        retryAfter !== undefined ? Number(retryAfter) : undefined,
      );
    default:
      return new UpstreamError(
        502,
        `Weblate error (${status}): ${detail || 'no details'}`,
      );
  }
}