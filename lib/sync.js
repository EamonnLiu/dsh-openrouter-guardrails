/**
 * One synchronization pass.
 *
 * 1. Find the OpenRouter route in the `llm-pi-ai` settings entry.
 * 2. Resolve the route's own credential reference and fetch `/models/user`.
 * 3. Ask `llm-pi-ai` (offline) which ids its installed catalog describes.
 * 4. Write `providers.<provider>.models` as `{ id }` entries for the catalogued
 *    models, and the declared `providers.<extraProvider>` route for the rest.
 *
 * Writes go through `ctx.settings.mutate`, which owns the profile patch, the
 * revision check, atomic replacement, live reload, and `llm-pi-ai`'s strict
 * validation: a write `llm-pi-ai` could not serve is refused as a whole and
 * the profile stays as it was. Nothing here knows a file path.
 *
 * @module dsh-openrouter-guardrails/sync
 */

import { isRecord, planModels } from './models.js'
import { fetchAllowedModels, OpenRouterError } from './openrouter.js'

/** Protocol of the declared route for uncatalogued models. */
export const EXTRA_API = 'openai-completions'

/** Delays before each write attempt; later attempts follow a reload race. */
const WRITE_RETRY_DELAYS = [0, 250, 1_000]

/**
 * @typedef {'startup' | 'interval' | 'credential'} SyncTrigger
 *
 * @typedef {object} SyncReport
 * @property {string} at
 * @property {SyncTrigger} trigger
 * @property {string} provider
 * @property {'updated' | 'unchanged' | 'skipped' | 'failed'} status
 * @property {string} [reason]
 * @property {string} [detail]
 * @property {number} [allowed] - ids `/models/user` returned.
 * @property {string[]} [catalog] - ids written to the catalog route.
 * @property {string[]} [extra] - ids written to the extra route.
 * @property {{ id: string, reason: string }[]} [skipped] - allowed ids that cannot be served.
 * @property {number} [attempt]
 *
 * @typedef {object} SyncDeps
 * @property {{ listConfigurableProviders(): any[], discoverModels(ns: string, request: object, signal?: AbortSignal): Promise<any[]> }} llm
 * @property {{ describe(): any[], mutate(ns: string, ops: object[], expectedRevision?: number): Promise<void> }} settings
 * @property {{ resolve(ref: string): Promise<{ value: string } | undefined> }} credentials
 * @property {{ debug: Function, info: Function, warn: Function, error: Function }} log
 * @property {typeof fetch} [fetch]
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/** @param {unknown} value @param {readonly string[]} path */
function readPath(value, path) {
  let node = value
  for (const key of path) {
    if (!isRecord(node)) return undefined
    node = node[key]
  }
  return node
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Drop absent and empty values so a value written by this plugin compares
 * equal to its stored projection even when the schema materializes `[]`/`{}`.
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (!isRecord(value)) return value
  /** @type {Record<string, unknown>} */
  const result = {}
  for (const key of Object.keys(value).sort()) {
    const child = normalize(value[key])
    if (child === undefined || child === null) continue
    if (Array.isArray(child) && child.length === 0) continue
    if (isRecord(child) && Object.keys(child).length === 0) continue
    result[key] = child
  }
  return result
}

/** @param {unknown} left @param {unknown} right */
function sameValue(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

/**
 * Locate the route and its settings entry.
 * @param {SyncDeps} deps @param {import('./config.js').ResolvedConfig} config
 */
function locate(deps, config) {
  const directory = deps.llm.listConfigurableProviders()
  const provider = directory.find((entry) => entry.provider === config.provider)
  if (provider === undefined) return { reason: 'provider-missing' }
  const conflict = directory.find((entry) => entry.provider === config.extraProvider && entry.declared === false)
  if (conflict !== undefined) return { provider, reason: 'extra-route-conflict' }
  const descriptor = deps.settings.describe().find((entry) => String(entry.ns) === provider.settingsNs)
  if (descriptor === undefined) return { provider, reason: 'settings-missing' }
  const route = readPath(descriptor.value, provider.settingsPath)
  if (!isRecord(route)) return { provider, descriptor, reason: 'route-missing' }
  return { provider, descriptor, route }
}

/** Whether a startup outcome is worth another attempt shortly. @param {SyncReport | undefined} report */
export function shouldRetryStartup(report) {
  if (report === undefined) return false
  if (report.status === 'failed') return report.reason === 'fetch-failed' || report.reason === 'settings-write-failed' || report.reason === 'catalog-unavailable'
  if (report.status !== 'skipped') return false
  return report.reason === 'provider-missing' || report.reason === 'settings-missing' || report.reason === 'route-missing'
}

/**
 * The credential reference the route uses, for matching credential updates.
 * @param {SyncDeps} deps @param {import('./config.js').ResolvedConfig} config
 */
export function routeKeyRef(deps, config) {
  const located = locate(deps, config)
  const ref = located.route?.apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/**
 * Whether a settings rejection is a reload race worth retrying with a fresh read.
 * @param {unknown} error
 */
function isTransientWriteError(error) {
  if (isRecord(error) && error.code === 'SETTINGS_CONFLICT') return true
  return /SETTINGS_CONFLICT|changed since it was read|No configurable plugin entry|no longer configurable|cannot be nested/i.test(messageOf(error))
}

/**
 * Run one pass. Operational failures are reported, never thrown.
 * @param {SyncDeps} deps
 * @param {import('./config.js').ResolvedConfig} config
 * @param {{ trigger?: SyncTrigger, signal?: AbortSignal }} [options]
 * @returns {Promise<SyncReport>}
 */
export async function synchronize(deps, config, options = {}) {
  const now = deps.now?.() ?? Date.now()
  /** @type {Pick<SyncReport, 'at' | 'trigger' | 'provider'>} */
  const base = { at: new Date(now).toISOString(), trigger: options.trigger ?? 'interval', provider: config.provider }
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  const located = locate(deps, config)
  if (located.route === undefined) {
    deps.log.warn('route "%s" is not ready: %s', config.provider, located.reason)
    return { ...base, status: 'skipped', reason: located.reason }
  }
  const { provider, route } = located

  const overrides = route.modelOverrides
  if (isRecord(overrides) && Object.keys(overrides).length > 0) {
    deps.log.warn('route "%s" uses modelOverrides, which llm-pi-ai refuses beside a models list; skipping', config.provider)
    return { ...base, status: 'skipped', reason: 'model-overrides-present' }
  }

  const keyRef = typeof route.apiKeyEnv === 'string' && route.apiKeyEnv.length > 0 ? route.apiKeyEnv : undefined
  if (keyRef === undefined) {
    deps.log.warn('route "%s" names no apiKeyEnv; nothing to filter by', config.provider)
    return { ...base, status: 'skipped', reason: 'no-key' }
  }
  let apiKey
  try {
    apiKey = (await deps.credentials.resolve(keyRef))?.value
  } catch (error) {
    return { ...base, status: 'failed', reason: 'credential-error', detail: messageOf(error) }
  }
  if (apiKey === undefined || apiKey.length === 0) {
    deps.log.warn('credential "%s" is not set; skipping', keyRef)
    return { ...base, status: 'skipped', reason: 'no-key' }
  }

  const baseURL = typeof route.baseURL === 'string' && route.baseURL.length > 0
    ? route.baseURL
    : typeof provider.defaultBaseURL === 'string' && provider.defaultBaseURL.length > 0 ? provider.defaultBaseURL : undefined

  let allowed
  try {
    allowed = await fetchAllowedModels({
      baseURL, apiKey, timeoutMs: config.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    })
  } catch (error) {
    const status = error instanceof OpenRouterError ? error.status : undefined
    const reason = status === 401 || status === 403 ? 'unauthorized' : 'fetch-failed'
    deps.log.error('models/user request failed: %s', messageOf(error))
    return { ...base, status: 'failed', reason, detail: messageOf(error) }
  }

  let installed
  try {
    const listed = await deps.llm.discoverModels(provider.settingsNs, { provider: provider.provider }, options.signal)
    installed = new Set(listed.map((model) => model.id))
  } catch (error) {
    deps.log.error('could not read the installed catalog for "%s": %s', config.provider, messageOf(error))
    return { ...base, status: 'failed', reason: 'catalog-unavailable', detail: messageOf(error) }
  }

  // A route that names its own protocol already sends every model over it, so
  // nothing needs a second route: uncatalogued entries join the same list.
  const ownProtocol = typeof route.api === 'string' && route.api.length > 0
  const plan = planModels(allowed, installed, now)
  const counts = { allowed: plan.allowed, skipped: plan.skipped }
  if (plan.catalog.length + plan.extra.length === 0) {
    deps.log.warn('the key may use no servable model (%d returned); leaving the profile untouched', plan.allowed)
    return { ...base, ...counts, status: 'skipped', reason: 'empty-result' }
  }
  if (!ownProtocol && plan.catalog.length === 0) {
    // An empty `models` list means "the whole installed catalog" to llm-pi-ai.
    deps.log.warn('no allowed model is in the installed catalog; the catalog route cannot be narrowed to zero models')
  }

  const mainModels = ownProtocol ? [...plan.catalog, ...plan.extra].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : plan.catalog
  const extraModels = ownProtocol ? [] : plan.extra
  const mainPath = [...provider.settingsPath, 'models']
  const extraPath = [...provider.settingsPath.slice(0, -1), config.extraProvider]
  const extraRoute = extraModels.length === 0 ? undefined : {
    displayName: config.extraDisplayName,
    api: EXTRA_API,
    ...(baseURL === undefined ? {} : { baseURL }),
    apiKeyEnv: keyRef,
    models: extraModels,
  }
  const result = { ...counts, catalog: mainModels.map((model) => model.id), extra: extraModels.map((model) => model.id) }

  for (const [attempt, delay] of WRITE_RETRY_DELAYS.entries()) {
    if (delay > 0) await sleep(delay)
    if (options.signal?.aborted) return { ...base, ...result, status: 'skipped', reason: 'aborted' }
    const fresh = locate(deps, config)
    if (fresh.route === undefined) {
      if (attempt < WRITE_RETRY_DELAYS.length - 1) continue
      return { ...base, ...result, status: 'skipped', reason: fresh.reason }
    }
    // Compare against the user layer, which is what this plugin writes.
    const stored = fresh.descriptor.user ?? fresh.descriptor.value
    const ops = []
    const currentMain = readPath(stored, mainPath)
    const desiredMain = mainModels.length === 0 ? undefined : mainModels
    if (!sameValue(currentMain, desiredMain)) {
      ops.push(desiredMain === undefined ? { op: 'unset', path: mainPath } : { op: 'set', path: mainPath, value: desiredMain })
    }
    const currentExtra = readPath(stored, extraPath)
    if (!sameValue(currentExtra, extraRoute)) {
      ops.push(extraRoute === undefined ? { op: 'unset', path: extraPath } : { op: 'set', path: extraPath, value: extraRoute })
    }
    if (ops.length === 0) return { ...base, ...result, status: 'unchanged' }
    try {
      await deps.settings.mutate(fresh.provider.settingsNs, ops, fresh.descriptor.revision)
      deps.log.info('route "%s": %d catalog models, %d in "%s"', config.provider, mainModels.length, extraModels.length, config.extraProvider)
      return { ...base, ...result, status: 'updated' }
    } catch (error) {
      if (attempt < WRITE_RETRY_DELAYS.length - 1 && isTransientWriteError(error)) {
        deps.log.warn('settings write raced with a reload; retrying: %s', messageOf(error))
        continue
      }
      deps.log.error('could not write the model lists: %s', messageOf(error))
      return { ...base, ...result, status: 'failed', reason: 'settings-write-failed', detail: messageOf(error) }
    }
  }
  return { ...base, ...result, status: 'failed', reason: 'settings-write-failed' }
}
