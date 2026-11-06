# dsh-openrouter-guardrails

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：让 OpenRouter 模型选择器**只显示你的 API key 能用的模型**，和 Claude Code、pi 的行为一致。

如果 OpenRouter 的 [guardrail](https://openrouter.ai/docs/guides/features/guardrails.md) 把你的 key 限制在 10 个模型，DSH 仍会列出内置目录里的约 400 个模型，选了白名单以外的就会收到 403。这个插件调用 [`GET /api/v1/models/user`](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails.md)（按 guardrails、隐私设置和供应商偏好过滤），把结果写进你的 profile。

背景：[deepseek-harness#12355](https://github.com/deepseek-ai/deepseek-harness/discussions/12355)。

## 改动内容

插件只通过 DSH 的 settings 服务写入两处配置：

- `providers.openrouter.models`：允许的模型中内置目录里已有的，只写 `{ id }`。它们继承目录里的全部信息，**包括各自的协议**，所以 OpenRouter 上的 Claude 继续走 `anthropic-messages`。
- `providers.openrouter-guardrails`：一个 `openai-completions` 路由，使用同一个 key 和 base URL，放内置目录里还没有的允许模型，在选择器里显示为 **OpenRouter (new models)**。之所以要单独一个路由，是因为 `llm-pi-ai` 只允许在路由上声明协议，而 OpenRouter 的内置目录混用了两种协议。这些模型的上下文长度、输出上限、输入模态、推理等级和 compat 设置都取自 `/models/user` 的返回。没有这类模型时，这个路由会被删除。

你在路由上的其他设置（`apiKeyEnv`、`baseURL`、`api`、headers 等）都不会被改动。如果路由自己声明了 `api`，所有模型本来就走这个协议，插件就把全部允许的模型放在这一个路由里，不再创建第二个。

每次写入前，`llm-pi-ai` 都会校验能否正常提供服务；校验不通过就整体拒绝，profile 保持原样。

## 安装

要求：DeepSeek Harness `>=0.2.2-rc.1 <0.3.0`，并且已经配置了带 API key 的 OpenRouter 路由（设置 → 模型 → OpenRouter）。

- **桌面版**：插件页 → 从 `github:EamonnLiu/dsh-openrouter-guardrails` 安装。
- **CLI / web profile**：`dsh plugin --profile <profile> add github:EamonnLiu/dsh-openrouter-guardrails`

插件加载几秒后会完成第一次同步，选择器实时更新。

## 什么时候运行

启动时（`llm-pi-ai` 还没加载完时会短暂重试）、路由的 key 变化时、以及每 6 小时一次。每次只发一个请求，发往路由的 base URL，所以设置了 `https://eu.openrouter.ai/api/v1` 这类地区地址时，也会按该地区过滤。

## 状态与排错

每次运行都会把结果写到 `~/.dsh/cache/openrouter-guardrails.json`（或 `$DSH_HOME/cache/…`），包括写入了哪些模型 id，不含 key。`reason` 字段的含义见 [README.md](README.md#status-and-troubleshooting)。

不要和 [`dsh-openrouter-sync-models`](https://github.com/m1khal3v/dsh-openrouter-sync-models) 同时使用，两者会写同一个 `models` 列表。

## 卸载

卸载插件后，删除 `providers.openrouter` 下的 `models`，以及 `providers.openrouter-guardrails` 路由（在设置 → 模型里，或直接改 `cordis.patch.yml`）。插件分不清卸载和重载，所以无法自动清理。

## 许可

MIT
