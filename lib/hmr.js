/**
 * Schedule timers outside an HMR transaction's async context.
 *
 * `dsh-hmr` refuses a nested `runExclusive` ("HMR transactions cannot be
 * nested") and keeps its transaction marker in an `AsyncLocalStorage`, which
 * Node propagates into every timer created while `apply()` runs inside a
 * reload. A settings write from such a timer would fail even after the reload
 * finished. Creating the timer inside `AsyncLocalStorage.exit` drops the
 * marker; the later `settings.mutate` then queues behind any live transaction
 * instead of nesting in it. The technique comes from
 * https://github.com/m1khal3v/dsh-openrouter-sync-models (MIT).
 *
 * @module dsh-openrouter-guardrails/hmr
 */

/**
 * Run `operation` outside the HMR transaction context, when there is one.
 * @param {{ get(name: string): unknown }} ctx - plugin context, possibly carrying `hmr`.
 * @param {() => void} operation - synchronous timer registration.
 * @returns {boolean} false only when an active transaction could not be escaped.
 */
export function runOutsideHmr(ctx, operation) {
  let executing
  try {
    executing = /** @type {{ executing?: { exit?: Function, getStore?: Function } } | undefined} */ (ctx.get('hmr'))?.executing
  } catch {
    executing = undefined
  }
  if (typeof executing?.exit === 'function') {
    try {
      executing.exit(operation)
      return true
    } catch {
      // Fall through to the conservative path.
    }
  }
  try {
    if (executing?.getStore?.() === true) return false
  } catch {
    // An unreadable scope is treated as not nested.
  }
  operation()
  return true
}
