/**
 * Call every listener in registration order, isolating each call.
 *
 * Listeners are user code. A throwing listener must not skip the remaining
 * listeners or corrupt the caller's lifecycle state, but the exception must not
 * be swallowed either: it is rethrown asynchronously, exactly like an
 * exception thrown from an `EventEmitter` listener that nobody caught.
 */
export function invokeListeners<A extends unknown[]>(
  listeners: Iterable<(...args: A) => void>,
  ...args: A
): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
