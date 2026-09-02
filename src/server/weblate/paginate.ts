import type { Paginated } from '../../shared/weblate-dto.js';

/**
 * Fetches a Weblate list endpoint page by page and yields every item.
 * Weblate list responses are {count, next, previous, results}; `next`
 * is a full URL that already carries the query string.
 *
 * CAUTION: Weblate builds `next` from its own SITE_URL, which is often
 * an internal hostname (e.g. 172.16.0.6) unreachable from here. All
 * followed URLs are therefore rewritten to the origin of `firstUrl`.
 */
export function iteratePaginated<T>(
  fetchPage: (url: string, signal?: AbortSignal) => Promise<Paginated<T>>,
  firstUrl: string,
  opts: { pageSize: number; signal?: AbortSignal },
): AsyncIterable<T> {
  const first = withPageSize(firstUrl, opts.pageSize);
  const firstOrigin = new URL(first).origin;

  const rewrite = (url: string): string => {
    const u = new URL(url);
    if (u.origin !== firstOrigin) {
      const first = new URL(firstOrigin);
      u.protocol = first.protocol;
      u.host = first.host;
    }
    return u.toString();
  };

  return {
    async *[Symbol.asyncIterator]() {
      let url: string | null = first;
      while (url !== null) {
        const page = await fetchPage(url, opts.signal);
        for (const item of page.results) {
          yield item;
        }
        url = page.next === null ? null : rewrite(page.next);
      }
    },
  };
}

/** Adds/replaces page_size on an absolute URL. */
export function withPageSize(url: string, pageSize: number): string {
  const u = new URL(url);
  u.searchParams.set('page_size', String(pageSize));
  return u.toString();
}

/** Adds or replaces the q search parameter on an absolute URL. */
export function withQ(url: string, q: string): string {
  const u = new URL(url);
  u.searchParams.set('q', q);
  return u.toString();
}