import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { apply, name } from '../lib/index.js'
import { glm, installed, kimi, opus } from './fixtures.js'

/** A cordis-shaped context with the three services the plugin injects. */
function fakeContext() {
  const listeners = new Map()
  const disposers = []
  const emitted = []
  const writes = []
  let user = { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } }
  let revision = 0
  let exitCalls = 0
  const ctx = {
    llm: {
      listConfigurableProviders: () => [{ provider: 'openrouter', displayName: 'openrouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'], declared: false }],
      discoverModels: async () => [...installed].map((id) => ({ id })),
    },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision, value: structuredClone(user), user: structuredClone(user) }],
      async mutate(_ns, ops, expected) {
        assert.equal(expected, revision)
        for (const op of ops) {
          const [root, key, field] = op.path
          user = structuredClone(user)
          const routes = user[root]
          if (field === undefined) {
            if (op.op === 'set') routes[key] = op.value
            else delete routes[key]
          } else if (op.op === 'set') routes[key][field] = op.value
          else delete routes[key][field]
        }
        writes.push(ops)
        revision += 1
      },
    },
    credentials: { resolve: async () => ({ value: 'sk-or-v1-test' }) },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    inject: (_names, callback) => callback(ctx),
    get: (service) => (service === 'hmr' ? { executing: { exit: (fn) => { exitCalls += 1; return fn() }, getStore: () => undefined } } : undefined),
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    emit: (event, payload) => emitted.push([event, payload]),
    effect: (execute) => disposers.push(execute()),
  }
  return { ctx, listeners, disposers, emitted, writes, exitCalls: () => exitCalls, user: () => user }
}

/** Wait until `check` holds or fail after `ms`. */
async function until(check, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('plugin lifecycle', () => {
  let home
  let realFetch
  let calls = 0
  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-openrouter-guardrails-'))
    process.env.DSH_HOME = home
    realFetch = globalThis.fetch
    globalThis.fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ data: [opus, glm, kimi] }), { status: 200 })
    }
  })
  after(async () => {
    globalThis.fetch = realFetch
    delete process.env.DSH_HOME
    await rm(home, { recursive: true, force: true })
  })

  it('syncs at startup, on credential change, and stops on dispose', async () => {
    assert.equal(name, 'openrouter-guardrails')
    const fake = fakeContext()
    apply(fake.ctx, {})

    await until(() => fake.writes.length === 1)
    assert.deepEqual(fake.user().providers.openrouter.models, [{ id: 'anthropic/claude-opus-5.5' }, { id: 'z-ai/glm-5.3' }])
    assert.deepEqual(fake.user().providers['openrouter-guardrails'].models.map((model) => model.id), ['moonshotai/kimi-k3.1-pro'])
    assert.ok(fake.exitCalls() > 0, 'timers are created outside the HMR context')
    await until(() => fake.emitted.length === 1)
    assert.equal(fake.emitted[0][0], 'openrouter-guardrails/synced')
    assert.equal(fake.emitted[0][1].status, 'updated')

    const statusFile = join(home, 'cache', 'openrouter-guardrails.json')
    let status
    const deadline = Date.now() + 5_000
    while (status === undefined && Date.now() < deadline) {
      status = await readFile(statusFile, 'utf8').then(JSON.parse, () => undefined)
      if (status === undefined) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(status?.status, 'updated')
    assert.deepEqual(status.extra, ['moonshotai/kimi-k3.1-pro'])
    assert.ok(!JSON.stringify(status).includes('sk-or-'), 'the status file never contains the key')

    // An unrelated credential is ignored; the route's own one triggers a pass.
    fake.listeners.get('credentials/reference-updated')('OTHER_KEY')
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(calls, 1)
    fake.listeners.get('credentials/reference-updated')('OPENROUTER_API_KEY')
    await until(() => calls === 2)
    await until(() => fake.emitted.length === 2)
    assert.equal(fake.emitted[1][1].status, 'unchanged')
    assert.equal(fake.writes.length, 1)

    for (const dispose of fake.disposers) dispose()
    fake.listeners.get('credentials/reference-updated')?.('OPENROUTER_API_KEY')
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(calls, 2, 'no request after dispose')
  })
})
