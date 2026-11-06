import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { modelsUserUrl } from '../lib/openrouter.js'
import { normalize, shouldRetryStartup, synchronize } from '../lib/sync.js'
import { deepseek, embedder, glm, installed, kimi, opus, terra } from './fixtures.js'

const KEY = 'sk-or-v1-test'

/** A settings service that applies set/unset path ops and checks revisions like dsh-settings. */
function fakeSettings(user) {
  const state = { user: structuredClone(user), revision: 3, writes: [], failNext: undefined }
  const apply = (root, op) => {
    const next = structuredClone(root)
    let node = next
    for (const key of op.path.slice(0, -1)) node = node[key] ??= {}
    const leaf = op.path.at(-1)
    if (op.op === 'set') node[leaf] = structuredClone(op.value)
    else delete node[leaf]
    return next
  }
  return {
    state,
    describe: () => [{ ns: 'llm-pi-ai', revision: state.revision, value: structuredClone(state.user), user: structuredClone(state.user) }],
    async mutate(ns, ops, expected) {
      if (state.failNext) {
        const error = state.failNext
        state.failNext = undefined
        throw error
      }
      assert.equal(ns, 'llm-pi-ai')
      if (expected !== state.revision) throw Object.assign(new Error('changed since it was read'), { code: 'SETTINGS_CONFLICT' })
      state.writes.push(ops)
      state.user = ops.reduce(apply, state.user)
      state.revision += 1
    },
  }
}

function deps({ user = { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } }, allowed = [opus, glm, kimi, deepseek, terra, embedder], status = 200, extraDeclared } = {}) {
  const settings = fakeSettings(user)
  const requests = []
  const directory = [{ provider: 'openrouter', displayName: 'openrouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'], declared: false, defaultBaseURL: 'https://openrouter.ai/api/v1' }]
  if (extraDeclared !== undefined) directory.push({ provider: 'openrouter-guardrails', displayName: 'x', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter-guardrails'], declared: extraDeclared })
  return {
    settings,
    requests,
    llm: {
      listConfigurableProviders: () => directory,
      discoverModels: async (ns, request) => {
        assert.deepEqual([ns, request], ['llm-pi-ai', { provider: 'openrouter' }])
        return [...installed].map((id) => ({ id }))
      },
    },
    credentials: { resolve: async (ref) => (ref === 'OPENROUTER_API_KEY' ? { value: KEY } : undefined) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: async (url, init) => {
      requests.push({ url, auth: init.headers.authorization })
      return new Response(JSON.stringify({ data: allowed, total_count: allowed.length }), { status })
    },
    sleep: async () => {},
    now: () => Date.parse('2026-11-06T00:00:00Z'),
  }
}

const config = resolveConfig({})

describe('synchronize', () => {
  it('narrows the catalog route and declares the extra route', async () => {
    const d = deps()
    const report = await synchronize(d, config, { trigger: 'startup' })
    assert.equal(report.status, 'updated')
    assert.deepEqual(report.catalog, ['anthropic/claude-opus-5.5', 'z-ai/glm-5.3'])
    assert.deepEqual(report.extra, ['deepseek/deepseek-v4.1-flash-1017', 'moonshotai/kimi-k3.1-pro', 'openai/gpt-6.1-terra'])
    assert.deepEqual(d.requests, [{ url: 'https://openrouter.ai/api/v1/models/user', auth: `Bearer ${KEY}` }])

    const routes = d.settings.state.user.providers
    assert.deepEqual(routes.openrouter, { apiKeyEnv: 'OPENROUTER_API_KEY', models: [{ id: 'anthropic/claude-opus-5.5' }, { id: 'z-ai/glm-5.3' }] })
    assert.equal(routes.openrouter.api, undefined, 'the catalog route keeps per-model protocols')
    const extra = routes['openrouter-guardrails']
    assert.equal(extra.api, 'openai-completions')
    assert.equal(extra.apiKeyEnv, 'OPENROUTER_API_KEY')
    assert.equal(extra.baseURL, 'https://openrouter.ai/api/v1')
    assert.equal(extra.displayName, 'OpenRouter (new models)')
    assert.equal(extra.models.length, 3)
  })

  it('is idempotent', async () => {
    const d = deps()
    await synchronize(d, config)
    const second = await synchronize(d, config)
    assert.equal(second.status, 'unchanged')
    assert.equal(d.settings.state.writes.length, 1)
  })

  it('removes the extra route once the catalog covers every allowed model', async () => {
    const d = deps()
    await synchronize(d, config)
    d.fetch = async () => new Response(JSON.stringify({ data: [opus, glm] }), { status: 200 })
    const report = await synchronize(d, config)
    assert.equal(report.status, 'updated')
    assert.equal(d.settings.state.user.providers['openrouter-guardrails'], undefined)
    assert.deepEqual(d.settings.state.writes[1], [
      { op: 'unset', path: ['providers', 'openrouter-guardrails'] },
    ])
  })

  it('keeps everything on one route when the route names its own protocol', async () => {
    const d = deps({ user: { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY', api: 'openai-completions' } } } })
    const report = await synchronize(d, config)
    assert.equal(report.status, 'updated')
    assert.deepEqual(report.extra, [])
    const models = d.settings.state.user.providers.openrouter.models
    assert.deepEqual(models.map((model) => model.id), ['anthropic/claude-opus-5.5', 'deepseek/deepseek-v4.1-flash-1017', 'moonshotai/kimi-k3.1-pro', 'openai/gpt-6.1-terra', 'z-ai/glm-5.3'])
    assert.deepEqual(models[0], { id: 'anthropic/claude-opus-5.5' })
    assert.equal(d.settings.state.user.providers['openrouter-guardrails'], undefined)
  })

  it('uses the route baseURL for regional filtering', async () => {
    const d = deps({ user: { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://eu.openrouter.ai/api/v1/' } } } })
    await synchronize(d, config)
    assert.equal(d.requests[0].url, 'https://eu.openrouter.ai/api/v1/models/user')
    assert.equal(d.settings.state.user.providers['openrouter-guardrails'].baseURL, 'https://eu.openrouter.ai/api/v1/')
  })

  it('leaves the profile untouched when the key is refused', async () => {
    const d = deps({ status: 401 })
    const report = await synchronize(d, config)
    assert.deepEqual([report.status, report.reason], ['failed', 'unauthorized'])
    assert.equal(d.settings.state.writes.length, 0)
  })

  it('leaves the profile untouched when nothing is servable', async () => {
    const d = deps({ allowed: [embedder] })
    const report = await synchronize(d, config)
    assert.deepEqual([report.status, report.reason], ['skipped', 'empty-result'])
    assert.equal(d.settings.state.writes.length, 0)
  })

  it('skips routes it must not touch', async () => {
    const cases = [
      [{ providers: {} }, 'route-missing'],
      [{ providers: { openrouter: {} } }, 'no-key'],
      [{ providers: { openrouter: { apiKeyEnv: 'UNSET_KEY' } } }, 'no-key'],
      [{ providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY', modelOverrides: { 'z-ai/glm-5.3': { maxTokens: 1 } } } } }, 'model-overrides-present'],
    ]
    for (const [user, reason] of cases) {
      const d = deps({ user })
      const report = await synchronize(d, config)
      assert.equal(report.reason, reason)
      assert.equal(d.settings.state.writes.length, 0)
      assert.equal(d.requests.length, 0, `${reason}: no request without a usable route`)
    }
  })

  it('refuses an extra route id that names a catalog provider', async () => {
    const d = deps({ extraDeclared: false })
    const report = await synchronize(d, config)
    assert.equal(report.reason, 'extra-route-conflict')
    assert.equal(d.settings.state.writes.length, 0)
  })

  it('retries a write that raced with a reload', async () => {
    const d = deps()
    d.settings.state.failNext = Object.assign(new Error('settings namespace "llm-pi-ai" changed since it was read'), { code: 'SETTINGS_CONFLICT' })
    const report = await synchronize(d, config)
    assert.equal(report.status, 'updated')
    assert.equal(d.settings.state.writes.length, 1)
  })

  it('reports a write llm-pi-ai refuses', async () => {
    const d = deps()
    d.settings.state.failNext = new Error('llm-pi-ai: provider "openrouter-guardrails" model "x" needs an api')
    const report = await synchronize(d, config)
    assert.deepEqual([report.status, report.reason], ['failed', 'settings-write-failed'])
  })
})

describe('helpers', () => {
  it('normalize ignores materialized empties and key order', () => {
    assert.deepEqual(normalize({ b: [], a: { id: 'x', input: [], compat: {} } }), { a: { id: 'x' } })
  })
  it('modelsUserUrl defaults and trims', () => {
    assert.equal(modelsUserUrl(undefined), 'https://openrouter.ai/api/v1/models/user')
    assert.equal(modelsUserUrl('https://us.openrouter.ai/api/v1//'), 'https://us.openrouter.ai/api/v1/models/user')
  })
  it('retries only transient startup outcomes', () => {
    assert.equal(shouldRetryStartup({ status: 'skipped', reason: 'settings-missing' }), true)
    assert.equal(shouldRetryStartup({ status: 'failed', reason: 'fetch-failed' }), true)
    assert.equal(shouldRetryStartup({ status: 'failed', reason: 'unauthorized' }), false)
    assert.equal(shouldRetryStartup({ status: 'skipped', reason: 'no-key' }), false)
    assert.equal(shouldRetryStartup({ status: 'updated' }), false)
    assert.equal(shouldRetryStartup(undefined), false)
  })
  it('resolveConfig rejects unusable route ids', () => {
    assert.throws(() => resolveConfig({ extraProvider: 'Open Router' }), /must match/)
    assert.throws(() => resolveConfig({ extraProvider: 'openrouter' }), /must differ/)
    assert.equal(resolveConfig({ intervalHours: -1 }).intervalHours, 6)
  })
})
