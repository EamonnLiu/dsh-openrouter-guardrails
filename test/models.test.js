import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compatOf, planModels, reasoningEffortsOf, toModelProfile } from '../lib/models.js'
import { deepseek, embedder, glm, installed, kimi, opus, terra } from './fixtures.js'

describe('planModels', () => {
  it('keeps catalogued models as bare ids and projects the rest', () => {
    const plan = planModels([opus, kimi, glm, deepseek, terra, embedder, opus], installed)
    assert.deepEqual(plan.catalog, [{ id: 'anthropic/claude-opus-5.5' }, { id: 'z-ai/glm-5.3' }])
    assert.deepEqual(plan.extra.map((model) => model.id), ['deepseek/deepseek-v4.1-flash-1017', 'moonshotai/kimi-k3.1-pro', 'openai/gpt-6.1-terra'])
    assert.deepEqual(plan.skipped, [{ id: 'acme/embed-1', reason: 'no-chat-endpoint' }])
    assert.equal(plan.allowed, 6)
  })

  it('never lists a catalogued model the key may not use', () => {
    const plan = planModels([kimi], installed)
    assert.deepEqual(plan.catalog, [])
    assert.ok(!plan.extra.some((model) => installed.has(model.id)))
  })

  it('drops expired models and ignores malformed entries', () => {
    const expired = { ...terra, id: 'openai/old', expiration_date: '2020-01-01' }
    const plan = planModels([null, 42, { id: '' }, { name: 'no id' }, expired], installed, Date.parse('2026-11-06'))
    assert.deepEqual(plan.extra, [])
    assert.deepEqual(plan.skipped, [{ id: 'openai/old', reason: 'expired' }])
  })
})

describe('toModelProfile', () => {
  it('maps limits, modalities, reasoning and compat', () => {
    assert.deepEqual(toModelProfile(kimi), {
      id: 'moonshotai/kimi-k3.1-pro',
      name: 'MoonshotAI: Kimi K3.1 Pro',
      contextWindow: 1_048_576,
      maxTokens: 943_718,
      input: ['text', 'image'],
      reasoningEfforts: { off: 'none', low: 'low', high: 'high', max: 'max' },
      compat: { thinkingFormat: 'openrouter', supportsStrictMode: true, maxTokensField: 'max_tokens', supportsDeveloperRole: false },
    })
  })

  it('uses the smaller of model and top-provider context', () => {
    const profile = toModelProfile({ ...terra, top_provider: { context_length: 400_000, max_completion_tokens: 128_000 } })
    assert.equal(profile.contextWindow, 400_000)
  })
})

describe('reasoningEffortsOf', () => {
  it('omits off for mandatory reasoning', () => {
    assert.deepEqual(reasoningEffortsOf(opus.reasoning), { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
  })
  it('omits off when none is not accepted', () => {
    assert.deepEqual(reasoningEffortsOf(glm.reasoning), { low: 'low', high: 'high', max: 'max' })
  })
  it('marks a model without reasoning facts as non-reasoning', () => {
    assert.equal(reasoningEffortsOf(undefined), false)
    assert.equal(reasoningEffortsOf(null), false)
  })
  it('offers low/medium/high when no allowlist is advertised', () => {
    assert.deepEqual(reasoningEffortsOf({ mandatory: false, supported_efforts: null }), { off: 'none', low: 'low', medium: 'medium', high: 'high' })
  })
})

describe('compatOf', () => {
  it('sets vendor switches the installed catalog uses', () => {
    assert.equal(compatOf(deepseek).requiresReasoningContentOnAssistantMessages, true)
    assert.equal(compatOf(opus).cacheControlFormat, 'anthropic')
    assert.equal(compatOf(terra).supportsDeveloperRole, undefined)
    assert.equal(compatOf(deepseek).maxTokensField, undefined)
  })
  it('only uses switches llm-pi-ai lets a profile set on openai-completions', () => {
    const offered = new Set(['thinkingFormat', 'supportsStrictMode', 'maxTokensField', 'supportsDeveloperRole', 'cacheControlFormat', 'requiresReasoningContentOnAssistantMessages'])
    for (const model of [opus, glm, kimi, deepseek, terra]) {
      for (const field of Object.keys(compatOf(model))) assert.ok(offered.has(field), `${model.id}: ${field}`)
    }
  })
})
