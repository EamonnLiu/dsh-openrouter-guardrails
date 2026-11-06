/**
 * The one OpenRouter request this plugin makes: `GET {baseURL}/models/user`,
 * the model list filtered by the key's provider preferences, privacy
 * settings, and guardrails. It takes the ordinary API key, and a regional
 * base URL (for example `https://eu.openrouter.ai/api/v1`) also applies that
 * region's filtering.
 *
 * @module dsh-openrouter-guardrails/openrouter
 */

/** OpenRouter's API root when the route sets no `baseURL`. */
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/** A failed `/models/user` request; `status` is set when a response arrived. */
export class OpenRouterError extends Error {
  /**
   * @param {string} message - summary that never contains the key.
   * @param {number} [status] - HTTP status, when a response arrived.
   */
  constructor(message, status) {
    super(message)
    this.name = 'OpenRouterError'
    this.status = status
  }
}

/**
 * Flatten a rejection and its causes; Node's `fetch` only says `fetch failed`
 * and keeps the useful code (`ENOTFOUND`, `ECONNRESET`, …) on `cause`.
 * @param {unknown} error
 */
export function describeError(error) {
  const parts = []
  const seen = new Set()
  let current = error
  for (let depth = 0; depth < 4 && current != null && !seen.has(current); depth += 1) {
    seen.add(current)
    if (current instanceof Error) {
      if (current.message) parts.push(current.message)
      const code = /** @type {{ code?: unknown }} */ (current).code
      if (typeof code === 'string' && code.length > 0) parts.push(code)
      current = /** @type {{ cause?: unknown }} */ (current).cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return [...new Set(parts)].join(': ')
}

/**
 * The `/models/user` URL for one route base URL.
 * @param {string | undefined} baseURL
 */
export function modelsUserUrl(baseURL) {
  const root = (typeof baseURL === 'string' && baseURL.trim().length > 0 ? baseURL.trim() : DEFAULT_BASE_URL).replace(/\/+$/, '')
  return `${root}/models/user`
}

/**
 * Fetch the models the key may use.
 * @param {object} options
 * @param {string | undefined} options.baseURL - the route's base URL.
 * @param {string} options.apiKey - the route's resolved key.
 * @param {number} options.timeoutMs - request timeout.
 * @param {AbortSignal} [options.signal] - plugin lifetime.
 * @param {typeof fetch} [options.fetch] - injectable for tests.
 * @returns {Promise<unknown[]>} raw entries in endpoint order.
 * @throws {OpenRouterError}
 */
export async function fetchAllowedModels(options) {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response
  try {
    response = await doFetch(modelsUserUrl(options.baseURL), {
      headers: { accept: 'application/json', authorization: `Bearer ${options.apiKey}` },
      signal,
    })
  } catch (error) {
    throw new OpenRouterError(`models/user request failed: ${describeError(error)}`)
  }
  if (!response.ok) throw new OpenRouterError(`models/user request failed: HTTP ${response.status}`, response.status)
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new OpenRouterError(`models/user response is not JSON: ${describeError(error)}`)
  }
  if (typeof body !== 'object' || body === null || !Array.isArray(body.data)) {
    throw new OpenRouterError('models/user response carries no data array')
  }
  return body.data
}
