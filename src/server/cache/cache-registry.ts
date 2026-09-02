/**
 * Per-(project, component) cache registry with idle-time and LRU eviction.
 */
import { config } from '../config.js';
import type { WeblateApi } from '../weblate/client.js';
import { ComponentCache } from './component-cache.js';

export class CacheRegistry {
  private caches = new Map<string, ComponentCache>();
  private touchedAt = new Map<string, number>();

  constructor(
    private readonly api: WeblateApi,
    private readonly maxComponents: number = config.cacheMaxComponents,
    private readonly idleMs: number = config.cacheIdleMs,
    private readonly now: () => number = () => Date.now(),
  ) {}

  key(project: string, component: string): string {
    return `${project}/${component}`;
  }

  get(project: string, component: string, api?: WeblateApi): ComponentCache {
    const key = this.key(project, component);
    let cache = this.caches.get(key);

    if (cache === undefined) {
      cache = new ComponentCache(project, component, api ?? this.api, this.now);
      this.caches.set(key, cache);
    } else if (api !== undefined) {
      // Follow the most recently active user's session for background loads.
      cache.setApi(api);
    }

    this.touchedAt.set(key, this.now());
    // Re-insert to move to the tail of Map insertion order (LRU position).
    this.caches.delete(key);
    this.caches.set(key, cache);
    this.evictIfNeeded();
    return cache;
  }

  /** The cache a unit id belongs to, if any (used by the edit route). */
  findByUnitId(unitId: number): ComponentCache | null {
    for (const cache of this.caches.values()) {
      if (cache.findCellByUnitId(unitId) !== null) return cache;
    }
    return null;
  }

  /** Existing cache without creating or touching anything (REST API). */
  peek(project: string, component: string): ComponentCache | null {
    return this.caches.get(this.key(project, component)) ?? null;
  }

  stats(): Array<{
    key: string;
    status: string;
    rows: number;
    lastRefreshAt: number;
  }> {
    return [...this.caches.entries()].map(([key, cache]) => ({
      key,
      status: cache.status,
      rows: cache.rows.size,
      lastRefreshAt: cache.lastRefreshAt,
    }));
  }

  private evictIfNeeded(): void {
    const now = this.now();

    // Idle eviction: caches untouched for a while and not mid-load.
    for (const [key, cache] of this.caches) {
      const touched = this.touchedAt.get(key) ?? 0;
      if (
        cache.status !== 'loading' &&
        touched > 0 &&
        now - touched > this.idleMs
      ) {
        this.caches.delete(key);
        this.touchedAt.delete(key);
      }
    }

    // LRU overflow: drop the oldest-touched non-loading caches.
    while (this.caches.size > this.maxComponents) {
      const victim = this.lruVictim();
      if (victim === null) break;
      this.caches.delete(victim);
      this.touchedAt.delete(victim);
    }
  }

  private lruVictim(): string | null {
    for (const [key, cache] of this.caches) {
      if (cache.status !== 'loading') return key;
    }
    return null;
  }
}