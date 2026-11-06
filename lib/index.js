/**
 * dsh-openrouter-guardrails: show only the OpenRouter models your API key may
 * use (its guardrails, privacy settings, and provider preferences), from
 * `GET /api/v1/models/user`, instead of the whole bundled catalog.
 *
 * Host-only cordis plugin. It needs `llm`, `settings`, and `credentials`; in
 * a composition without them it loads and does nothing.
 *
 * A pass runs at startup (with short retries while `llm-pi-ai` settles),
 * after the route's credential changes, and every `intervalHours`. Nothing
 * else starts a request, so the plugin's own settings writes cannot loop.
 *
 * @module dsh-openrouter-guardrails
 */

import { resolveConfig } from './config.js'
import { runOutsideHmr } from './hmr.js'
import { writeStatus } from './status.js'
import { routeKeyRef, shouldRetryStartup, synchronize } from './sync.js'

/** Cordis plugin name. */
export const name = 'openrouter-guardrails'

/** Startup attempts, as delays after the previous attempt. */
const STARTUP_RETRY_DELAYS = [0, 1_000, 3_000, 10_000]
/** Poll interval while waiting for the route and its settings entry. */
const READY_POLL_MS = 250
/** Let the loader and network/proxy plugins settle before the first request. */
const STARTUP_SETTLE_MS = 1_000
/** Coalesce the burst of events one credential write can emit. */
const CREDENTIAL_DEBOUNCE_MS = 500

/**
 * Install the plugin.
 * @param {any} ctx - cordis context.
 * @param {unknown} rawConfig - composition entry config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  ctx.inject(['llm', 'settings', 'credentials'], (ctx) => {
    const log = ctx.logger('openrouter-guardrails')
    const lifetime = new AbortController()
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    const timers = new Set()
    let running = false
    let rerun = false
    let attempt = 0
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let periodic
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let debounce

    const deps = { llm: ctx.llm, settings: ctx.settings, credentials: ctx.credentials, log }

    /** setTimeout outside the HMR context, cleared on dispose. */
    const later = (callback, ms) => {
      let handle
      const scheduled = runOutsideHmr(ctx, () => {
        handle = setTimeout(() => {
          timers.delete(handle)
          if (!lifetime.signal.aborted) callback()
        }, ms)
        timers.add(handle)
      })
      if (!scheduled) log.warn('could not leave the HMR transaction scope; a timer was not scheduled')
      return handle
    }
    const cancel = (handle) => {
      if (handle === undefined) return
      clearTimeout(handle)
      timers.delete(handle)
    }
    // Callers of `wait` already run outside the HMR context (they descend from a
    // `later` callback), so a plain tracked timer is enough here.
    const wait = (ms) => new Promise((resolve) => {
      const handle = setTimeout(() => {
        timers.delete(handle)
        resolve(undefined)
      }, ms)
      timers.add(handle)
    })

    const schedulePeriodic = () => {
      cancel(periodic)
      periodic = later(() => {
        periodic = undefined
        void run('interval')
      }, Math.round(config.intervalHours * 3_600_000))
    }

    /** One serialized pass; a credential change during a pass earns one follow-up. */
    const run = async (trigger) => {
      if (lifetime.signal.aborted) return undefined
      if (running) {
        if (trigger === 'credential') rerun = true
        return undefined
      }
      running = true
      let report
      try {
        let next = trigger
        for (;;) {
          attempt += 1
          try {
            report = { ...(await synchronize(deps, config, { trigger: next, signal: lifetime.signal })), attempt }
          } catch (error) {
            log.error('unexpected failure: %s', error instanceof Error ? error.message : String(error))
            report = undefined
          }
          if (report !== undefined && !lifetime.signal.aborted) {
            ctx.emit('openrouter-guardrails/synced', report)
            writeStatus(report).catch((error) => log.warn('could not write the status file: %s', error instanceof Error ? error.message : String(error)))
          }
          if (lifetime.signal.aborted || !rerun) break
          rerun = false
          next = 'credential'
        }
      } finally {
        running = false
        schedulePeriodic()
      }
      return report
    }

    const ready = () => {
      try {
        const provider = ctx.llm.listConfigurableProviders().find((entry) => entry.provider === config.provider)
        return provider !== undefined && ctx.settings.describe().some((entry) => String(entry.ns) === provider.settingsNs)
      } catch {
        return false
      }
    }

    const bootstrap = async () => {
      const deadline = Date.now() + config.startupGraceMs
      while (!ready() && Date.now() < deadline && !lifetime.signal.aborted) await wait(READY_POLL_MS)
      if (lifetime.signal.aborted) return
      await wait(STARTUP_SETTLE_MS)
      for (const delay of STARTUP_RETRY_DELAYS) {
        if (delay > 0) await wait(delay)
        if (lifetime.signal.aborted) return
        const report = await run('startup')
        if (!shouldRetryStartup(report)) return
      }
    }

    later(() => void bootstrap(), 0)

    ctx.on('credentials/reference-updated', (ref) => {
      if (lifetime.signal.aborted) return
      let watched
      try {
        watched = routeKeyRef(deps, config)
      } catch {
        return
      }
      if (watched === undefined || String(ref) !== watched) return
      cancel(debounce)
      debounce = later(() => {
        debounce = undefined
        void run('credential')
      }, CREDENTIAL_DEBOUNCE_MS)
    })

    ctx.effect(() => () => {
      lifetime.abort(new Error('openrouter-guardrails disposed'))
      for (const handle of timers) clearTimeout(handle)
      timers.clear()
    }, 'openrouter-guardrails: stop timers and in-flight requests')
  })
}
