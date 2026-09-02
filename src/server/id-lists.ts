/**
 * Server-side storage for large ID lists (the 'id-list' filter). Small
 * lists travel in the URL itself; large ones are uploaded once via
 * POST /id-lists and referenced by a short, opaque listId so the URL
 * stays small. In-memory only: lists die with the process and the
 * client re-uploads after a restart (the view then shows 0 rows until
 * the list is applied again).
 */
import { randomUUID } from 'node:crypto';

/** Hard cap per list — tens of thousands are expected; 100k is generous. */
export const MAX_IDS_PER_LIST = 100_000;
/** Bounded memory: drop the oldest lists beyond this many. */
const MAX_LISTS = 100;

export class IdListStore {
  private lists = new Map<string, string[]>();

  /**
   * Stores a list (deduped, order-preserving) and returns its id.
   * Over the cap, the oldest lists are evicted first (Map preserves
   * insertion order).
   */
  create(keys: string[]): { listId: string; count: number } {
    const deduped = [...new Set(keys)];
    if (this.lists.size >= MAX_LISTS) {
      const oldest = this.lists.keys().next().value;
      if (oldest !== undefined) this.lists.delete(oldest);
    }
    const listId = randomUUID();
    this.lists.set(listId, deduped);
    return { listId, count: deduped.length };
  }

  /** Returns the keys, or null for unknown/expired lists. */
  get(listId: string): string[] | null {
    const keys = this.lists.get(listId);
    if (keys === undefined) return null;
    // Touch for LRU-ish behavior: re-insert to mark as recently used.
    this.lists.delete(listId);
    this.lists.set(listId, keys);
    return keys;
  }

  count(): number {
    return this.lists.size;
  }
}