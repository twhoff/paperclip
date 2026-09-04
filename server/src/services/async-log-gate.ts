export interface AsyncLogGate {
  run(operation: () => Promise<void>): Promise<boolean>;
  closeAndDrain(): Promise<void>;
}

/**
 * Serializes asynchronous log writes and creates a hard close boundary before
 * a backing store is finalized. Work accepted before close is drained in
 * order; work submitted afterward is ignored.
 */
export function createAsyncLogGate(): AsyncLogGate {
  let accepting = true;
  let tail: Promise<void> = Promise.resolve();
  let firstError: unknown = null;

  return {
    run(operation) {
      if (!accepting) return Promise.resolve(false);

      const accepted = tail.then(async () => {
        await operation();
        return true;
      });
      tail = accepted.then(
        () => undefined,
        (error) => {
          firstError ??= error;
        },
      );
      return accepted;
    },

    async closeAndDrain() {
      accepting = false;
      await tail;
      if (firstError) throw firstError;
    },
  };
}
