# dsh-openrouter-guardrails

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that makes the OpenRouter model picker show **only the models your API key may use**, the way Claude Code and pi do.

If an OpenRouter [guardrail](https://openrouter.ai/docs/guides/features/guardrails.md) limits your key to 10 models, DSH still lists the ~400 models of its bundled catalog, and anything outside the allowlist fails with a 403. This plugin asks OpenRouter which models the key may use, [`GET /api/v1/models/user`](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails.md) (filtered by guardrails, privacy settings, and provider preferences), and writes exactly that list into your profile.

Background: [deepseek-harness#12355](https://github.com/deepseek-ai/deepseek-harness/discussions/12355).

## What it changes

| Before | After |
| --- | --- |
| `openrouter` lists the whole bundled catalog (396 chat models in 0.2.2-rc.1) | `openrouter` lists the allowed models the bundled catalog describes |
| Allowed models newer than the bundled catalog are missing | They appear under a second group, **OpenRouter (new models)** |

The plugin writes two things through DSH's settings service, and nothing else:

- `providers.openrouter.models`: the allowed models the bundled catalog already describes, as bare `{ id }` entries. They inherit every catalog fact, **including their own wire protocol**, so OpenRouter's Claude models keep `anthropic-messages`.
- `providers.openrouter-guardrails`: a declared `openai-completions` route, with the same key and base URL, for allowed models the bundled catalog does not describe yet. `llm-pi-ai` lets only a route, not a model, name a protocol, and the OpenRouter catalog mixes two, so these models cannot share the first route without changing the protocol of every model on it. Their context window, output cap, input modalities, reasoning levels, and compatibility switches come from the `/models/user` response. The route is removed when no such model is left.

Your route settings (`apiKeyEnv`, `baseURL`, `api`, headers, …) are never touched. If the route sets its own `api`, every model already uses it, so all allowed models go on that one route and no second route is created.

Every write is validated by `llm-pi-ai` before it is saved; a write it cannot serve is refused as a whole and the profile stays as it was.

## Install

Requirements: DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`, and an OpenRouter route configured with an API key (Settings → Models → OpenRouter), which gives a profile entry like:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
```

Then install the plugin from GitHub:

- **Desktop app**: Plugins page → install from `github:EamonnLiu/dsh-openrouter-guardrails`.
- **CLI / web profiles**: `dsh plugin --profile <profile> add github:EamonnLiu/dsh-openrouter-guardrails`

The first pass runs a few seconds after the plugin loads; the picker updates live.

## When it runs

- at startup, retrying briefly while `llm-pi-ai` finishes loading;
- when the route's credential (`apiKeyEnv`) changes;
- every 6 hours.

Nothing else triggers a request, so its own writes cannot loop. It makes one request per pass, to your route's base URL, so a regional base URL such as `https://eu.openrouter.ai/api/v1` also applies that region's filtering.

## Configuration

All optional, set on the plugin's entry (`id: openrouter-guardrails`) in `cordis.patch.yml`:

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | `openrouter` | The `llm-pi-ai` route to narrow |
| `extraProvider` | `openrouter-guardrails` | Route id this plugin owns for models newer than the catalog |
| `extraDisplayName` | `OpenRouter (new models)` | Picker label of that route |
| `intervalHours` | `6` | Refresh interval |
| `timeoutMs` | `30000` | `/models/user` request timeout |
| `startupGraceMs` | `30000` | How long startup waits for `llm-pi-ai` |

## Status and troubleshooting

Each pass writes `~/.dsh/cache/openrouter-guardrails.json` (or `$DSH_HOME/cache/…`) with the outcome and the ids it wrote; it never contains the key.

| `reason` | Meaning |
| --- | --- |
| `route-missing` | No `providers.openrouter` route is configured |
| `no-key` | The route names no `apiKeyEnv`, or the credential is not set |
| `unauthorized` | OpenRouter refused the key (401/403); nothing was changed |
| `fetch-failed` | Network error or non-2xx response; nothing was changed |
| `empty-result` | The key may use no servable model; nothing was changed |
| `model-overrides-present` | The route uses `modelOverrides`, which `llm-pi-ai` refuses beside a `models` list |
| `extra-route-conflict` | `extraProvider` names a provider the bundled catalog ships |
| `settings-write-failed` | `llm-pi-ai` refused the write; `detail` says why |

Known limitation: if none of the allowed models is in the bundled catalog, the `openrouter` route cannot be narrowed to zero models (an empty `models` list means "the whole catalog" to `llm-pi-ai`); the allowed models still appear under the second route.

Do not run this beside [`dsh-openrouter-sync-models`](https://github.com/m1khal3v/dsh-openrouter-sync-models); both write the same `models` list.

## Uninstall

Remove the plugin, then delete `models` under `providers.openrouter` and the `providers.openrouter-guardrails` route (Settings → Models, or `cordis.patch.yml`). The plugin cannot do this itself, because it cannot tell an uninstall from a reload.

## Development

Plain ESM JavaScript with no dependencies and no build step.

```sh
npm test   # node --test; add --test-isolation=none where child processes are restricted
```

The HMR-context escape in `lib/hmr.js` follows [`dsh-openrouter-sync-models`](https://github.com/m1khal3v/dsh-openrouter-sync-models) (MIT).

## License

MIT
