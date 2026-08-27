/**
 * Process-local FIFO queue keyed by an arbitrary routing key.
 *
 * Tasks sharing a key run strictly one at a time. A rejected task does not block
 * later work, while callers still receive the original rejection. Different keys
 * remain independent and may run concurrently.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  has(key: string): boolean {
    return this.tails.has(key);
  }

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);

    let tail!: Promise<void>;
    const result = run.finally(() => {
      // A newer task may already have replaced this tail. Only the newest chain
      // is allowed to remove the key, otherwise an older finally creates a race.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(key, tail);
    return result;
  }
}
