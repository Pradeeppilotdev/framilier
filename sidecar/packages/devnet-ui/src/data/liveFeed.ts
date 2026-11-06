import type { LifecycleEventData } from "../protocol/schemas";

/**
 * Remembers which transactions just changed, so a row can be highlighted for a
 * moment after a live event. External-store shaped for `useSyncExternalStore`.
 */
export class LiveFeed {
  private readonly arrivals = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly ttlMs = 2500,
    private readonly setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  ) {}

  push(event: LifecycleEventData): void {
    this.arrivals.set(event.txHash.toLowerCase(), this.clock());
    this.bump();
    // Re-render once the highlight has expired.
    this.setTimer(() => this.bump(), this.ttlMs + 20);
  }

  isFresh(txHash: string): boolean {
    const at = this.arrivals.get(txHash.toLowerCase());
    return at !== undefined && this.clock() - at < this.ttlMs;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
