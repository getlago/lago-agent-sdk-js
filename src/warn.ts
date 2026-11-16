/** `console.warn` that cannot itself break the caller.
 *
 * The queue logged directly, on paths with no `try` around them — `sendIndividually`,
 * the drain's failure branch, the exit drain. `LagoSDK.reportError` did the same thing
 * at the end of the path the wrappers call from their own catch. A `console` that
 * throws is not exotic: a structured-logger shim can, and a test runner's console
 * throws by design once the test that owns it has finished ("Cannot log after tests
 * are done"). Any of those turned a reported failure into a rejection of the
 * customer's own call, or a retryable network blip into a rejected background loop. */
export function warn(...args: unknown[]): void {
  try {
    console.warn(...args);
  } catch {
    /* a logger that fails must not cost billing */
  }
}
