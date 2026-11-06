/**
 * Turn the key's `/models/user` list into `llm-pi-ai` model entries.
 *
 * The split is the whole point of this plugin. A model the installed pi-ai
 * catalog already describes is written as `{ id }` only, so it inherits every
 * catalog fact, including its own wire protocol: OpenRouter's Claude models
 * keep `anthropic-messages`. A model the catalog does not describe yet cannot
 * live on the same route, because `llm-pi-ai` only lets a route (not a model)
 * name a protocol and the OpenRouter catalog mixes two; such models get a full
 * entry projected from the `/models/user` response and go to a separate,
 * declared `openai-completions` route.
 *
 * Everything here is pure, so it is tested without a host.
 *
 * @module dsh-openrouter-guardrails/models
 */

/** Chat endpoint a model must expose to be served over `openai-completions`. */
export const CHAT_ENDPOINT = '/api/v1/chat/completions'

/** Thinking levels `llm-pi-ai` accepts in `reasoningEfforts`, in escalation order. */
const THINKING_LEVELS = /** @type {const} */ (['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * @typedef {Record<string, unknown> & {
 *   id?: unknown, name?: unknown, canonical_slug?: unknown,
 *   context_length?: unknown, top_provider?: Record<string, unknown> | null,
 *   architecture?: Record<string, unknown> | null,
 *   reasoning?: Record<string, unknown> | null,
 *   supported_parameters?: unknown, endpoints?: unknown, expiration_date?: unknown,
 * }} OpenRouterModel
 * One entry of OpenRouter's model listing, untrusted.
 */

/**
 * @typedef {{ id: string, name?: string, contextWindow?: number, maxTokens?: number,
 *   input?: string[], reasoningEfforts?: false | Record<string, string>,
 *   compat?: Record<string, unknown> }} ModelProfile
 * One `llm-pi-ai` `models` entry.
 */

/**
 * @typedef {object} ModelPlan
 * @property {ModelProfile[]} catalog - allowed models the installed catalog describes, as `{ id }`.
 * @property {ModelProfile[]} extra - allowed models it does not describe, as full entries.
 * @property {{ id: string, reason: string }[]} skipped - allowed models that cannot be served.
 * @property {number} allowed - distinct ids the key may use.
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

/**
 * Whether the id or canonical slug belongs to one vendor namespace.
 * @param {OpenRouterModel} model @param {string} vendor
 */
function isVendor(model, vendor) {
  return [model.id, model.canonical_slug].some((value) => typeof value === 'string' && value.startsWith(`${vendor}/`))
}

/**
 * Context the route can actually use: the smaller of the model's and the top
 * provider's, so a request is never sized past what the endpoint serves.
 * @param {OpenRouterModel} model
 */
export function contextWindowOf(model) {
  const own = positiveInteger(model.context_length)
  const top = positiveInteger(model.top_provider?.context_length)
  if (own === undefined) return top
  if (top === undefined) return own
  return Math.min(own, top)
}

/**
 * The input modalities `llm-pi-ai` can carry (text and image).
 * @param {OpenRouterModel} model
 * @returns {string[] | undefined}
 */
export function inputOf(model) {
  const advertised = strings(model.architecture?.input_modalities)
  const text = advertised.includes('text')
  const image = advertised.includes('image')
  if (!text && !image) return undefined
  return [...(text ? ['text'] : []), ...(image ? ['image'] : [])]
}

/**
 * Translate OpenRouter's reasoning facts into `llm-pi-ai` reasoning levels.
 *
 * `supported_efforts` is authoritative; each kept level is sent under its own
 * name. `off` is offered only when OpenRouter accepts effort `none` and the
 * model's reasoning is not mandatory. A model without a `reasoning` object
 * does not reason. A missing allowlist means every effort is accepted, so the
 * conventional low/medium/high set is offered.
 * @param {OpenRouterModel['reasoning']} reasoning
 * @returns {false | Record<string, string>}
 */
export function reasoningEffortsOf(reasoning) {
  if (!isRecord(reasoning)) return false
  const mandatory = reasoning.mandatory === true
  const listed = Array.isArray(reasoning.supported_efforts) ? strings(reasoning.supported_efforts) : undefined
  /** @type {Record<string, string>} */
  const efforts = {}
  const allowsNone = listed === undefined ? !mandatory : listed.includes('none') && !mandatory
  if (allowsNone) efforts.off = 'none'
  const levels = listed === undefined ? ['low', 'medium', 'high'] : THINKING_LEVELS.filter((level) => listed.includes(level))
  for (const level of levels.length > 0 ? levels : ['low', 'medium', 'high']) efforts[level] = level
  return efforts
}

/**
 * Compatibility switches for an `openai-completions` entry behind OpenRouter,
 * mirroring what the installed catalog sets on its own OpenRouter entries.
 * Only switches `llm-pi-ai` lets a profile set appear here; withheld ones such
 * as `sendSessionAffinityHeaders` would make the whole write fail validation.
 * @param {OpenRouterModel} model
 * @returns {Record<string, unknown>}
 */
export function compatOf(model) {
  const parameters = strings(model.supported_parameters)
  /** @type {Record<string, unknown>} */
  const compat = { thinkingFormat: 'openrouter' }
  if (parameters.includes('structured_outputs')) compat.supportsStrictMode = true
  if (parameters.includes('max_tokens') && !parameters.includes('max_completion_tokens')) compat.maxTokensField = 'max_tokens'
  if (!isVendor(model, 'openai')) compat.supportsDeveloperRole = false
  if (isVendor(model, 'anthropic')) compat.cacheControlFormat = 'anthropic'
  if (isVendor(model, 'deepseek')) compat.requiresReasoningContentOnAssistantMessages = true
  return compat
}

/**
 * A full entry for a model the installed catalog does not describe.
 * @param {OpenRouterModel & { id: string }} model
 * @returns {ModelProfile}
 */
export function toModelProfile(model) {
  /** @type {ModelProfile} */
  const profile = { id: model.id }
  if (typeof model.name === 'string' && model.name.length > 0) profile.name = model.name
  const contextWindow = contextWindowOf(model)
  if (contextWindow !== undefined) profile.contextWindow = contextWindow
  const maxTokens = positiveInteger(model.top_provider?.max_completion_tokens)
  if (maxTokens !== undefined) profile.maxTokens = contextWindow === undefined ? maxTokens : Math.min(maxTokens, contextWindow)
  const input = inputOf(model)
  if (input !== undefined) profile.input = input
  profile.reasoningEfforts = reasoningEffortsOf(model.reasoning)
  profile.compat = compatOf(model)
  return profile
}

/**
 * Why an uncatalogued model cannot be served over `openai-completions`, if it cannot.
 * @param {OpenRouterModel} model @param {number} now
 * @returns {string | undefined}
 */
function unservable(model, now) {
  const endpoints = model.endpoints
  if (Array.isArray(endpoints) && !endpoints.includes(CHAT_ENDPOINT)) return 'no-chat-endpoint'
  const output = strings(model.architecture?.output_modalities)
  if (output.length > 0 && !output.includes('text')) return 'no-text-output'
  if (inputOf(model) === undefined && strings(model.architecture?.input_modalities).length > 0) return 'no-text-or-image-input'
  if (typeof model.expiration_date === 'string' && model.expiration_date.length > 0) {
    const at = Date.parse(model.expiration_date)
    if (Number.isFinite(at) && at <= now) return 'expired'
  }
  return undefined
}

/** @param {ModelProfile} left @param {ModelProfile} right */
function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Split the key's allowed models by whether the installed catalog describes them.
 * @param {readonly unknown[]} allowed - raw `/models/user` entries.
 * @param {ReadonlySet<string>} installed - model ids the installed catalog describes for the route.
 * @param {number} [now] - epoch ms for expiration checks.
 * @returns {ModelPlan}
 */
export function planModels(allowed, installed, now = Date.now()) {
  /** @type {ModelPlan} */
  const plan = { catalog: [], extra: [], skipped: [], allowed: 0 }
  const seen = new Set()
  for (const entry of allowed) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0 || seen.has(entry.id)) continue
    seen.add(entry.id)
    const model = /** @type {OpenRouterModel & { id: string }} */ (entry)
    if (installed.has(model.id)) {
      plan.catalog.push({ id: model.id })
      continue
    }
    const reason = unservable(model, now)
    if (reason !== undefined) plan.skipped.push({ id: model.id, reason })
    else plan.extra.push(toModelProfile(model))
  }
  plan.allowed = seen.size
  plan.catalog.sort(byId)
  plan.extra.sort(byId)
  return plan
}
