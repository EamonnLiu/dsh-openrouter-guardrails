/**
 * Plugin configuration for `dsh-openrouter-guardrails`.
 *
 * Every field has a working default, so the bundle patch can insert the
 * plugin with no config at all. The configuration is composition-time data:
 * changing it edits this plugin's profile entry and reloads the plugin.
 *
 * @module dsh-openrouter-guardrails/config
 */

/** Route-key grammar shared by `llm-pi-ai` provider ids and credential keys. */
const ROUTE_ID = /^[a-z][a-z0-9-]*$/

/** Defaults applied to every missing or invalid field. */
export const DEFAULTS = Object.freeze({
  /** `llm-pi-ai` catalog route whose model list follows the key's guardrails. */
  provider: 'openrouter',
  /**
   * Declared route this plugin owns for allowed models the installed catalog
   * does not describe yet. It exists only while there are such models.
   */
  extraProvider: 'openrouter-guardrails',
  /** Display name of that route in the model picker. */
  extraDisplayName: 'OpenRouter (new models)',
  /** Refresh interval in hours. */
  intervalHours: 6,
  /** Timeout of one `/models/user` request in milliseconds. */
  timeoutMs: 30_000,
  /** How long startup waits for `llm-pi-ai` and its settings entry to appear. */
  startupGraceMs: 30_000,
})

/**
 * @typedef {object} ResolvedConfig
 * @property {string} provider
 * @property {string} extraProvider
 * @property {string} extraDisplayName
 * @property {number} intervalHours
 * @property {number} timeoutMs
 * @property {number} startupGraceMs
 */

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** @param {unknown} value @param {number} min */
function numberAtLeast(value, min) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : undefined
}

/**
 * Apply defaults and reject values that could never work.
 * @param {unknown} raw - the composition entry's config, possibly undefined.
 * @returns {ResolvedConfig}
 * @throws {TypeError} when a route id is malformed or both routes share one id.
 */
export function resolveConfig(raw) {
  const input = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {}
  const config = {
    provider: nonEmptyString(input.provider) ?? DEFAULTS.provider,
    extraProvider: nonEmptyString(input.extraProvider) ?? DEFAULTS.extraProvider,
    extraDisplayName: nonEmptyString(input.extraDisplayName) ?? DEFAULTS.extraDisplayName,
    intervalHours: numberAtLeast(input.intervalHours, 0.01) ?? DEFAULTS.intervalHours,
    timeoutMs: numberAtLeast(input.timeoutMs, 1) ?? DEFAULTS.timeoutMs,
    startupGraceMs: numberAtLeast(input.startupGraceMs, 0) ?? DEFAULTS.startupGraceMs,
  }
  for (const field of /** @type {const} */ (['provider', 'extraProvider'])) {
    if (!ROUTE_ID.test(config[field])) {
      throw new TypeError(`openrouter-guardrails: ${field} "${config[field]}" must match ${String(ROUTE_ID)}`)
    }
  }
  if (config.provider === config.extraProvider) {
    throw new TypeError('openrouter-guardrails: extraProvider must differ from provider')
  }
  return config
}
