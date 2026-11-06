// `/models/user` entries shaped like OpenRouter's real responses (2026-11).

export const opus = {
  id: 'anthropic/claude-opus-5.5',
  name: 'Anthropic: Claude Opus 5.5',
  canonical_slug: 'anthropic/claude-opus-5.5-20260921',
  context_length: 1_000_000,
  top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000, is_moderated: true },
  architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
  reasoning: { mandatory: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' },
  supported_parameters: ['include_reasoning', 'max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'stop', 'structured_outputs', 'tool_choice', 'tools', 'verbosity'],
  endpoints: ['/api/v1/chat/completions', '/api/v1/completions', '/api/v1/messages', '/api/v1/responses'],
  expiration_date: null,
}

export const glm = {
  id: 'z-ai/glm-5.3',
  name: 'Z.ai: GLM 5.3',
  context_length: 1_048_576,
  top_provider: { context_length: 1_048_576, max_completion_tokens: 943_718 },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  reasoning: { mandatory: false, supported_efforts: ['max', 'high', 'low'] },
  supported_parameters: ['max_tokens', 'reasoning', 'structured_outputs', 'tools'],
  endpoints: ['/api/v1/chat/completions'],
}

export const kimi = {
  id: 'moonshotai/kimi-k3.1-pro',
  name: 'MoonshotAI: Kimi K3.1 Pro',
  canonical_slug: 'moonshotai/kimi-k3.1-pro-20261023',
  context_length: 1_048_576,
  top_provider: { context_length: 1_048_576, max_completion_tokens: 943_718, is_moderated: false },
  architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] },
  reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['max', 'high', 'low', 'none'], default_effort: 'max' },
  supported_parameters: ['frequency_penalty', 'include_reasoning', 'max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs', 'temperature', 'tool_choice', 'tools', 'top_p'],
  endpoints: ['/api/v1/chat/completions', '/api/v1/completions', '/api/v1/messages', '/api/v1/responses'],
  expiration_date: null,
}

export const deepseek = {
  id: 'deepseek/deepseek-v4.1-flash-1017',
  name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
  context_length: 1_048_576,
  top_provider: { context_length: 1_048_576, max_completion_tokens: 943_718 },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  reasoning: { mandatory: false, supported_efforts: ['max', 'high', 'low', 'none'] },
  supported_parameters: ['max_completion_tokens', 'max_tokens', 'reasoning', 'structured_outputs', 'tools'],
  endpoints: ['/api/v1/chat/completions', '/api/v1/responses'],
}

export const terra = {
  id: 'openai/gpt-6.1-terra',
  name: 'OpenAI: GPT-6.1 Terra',
  context_length: 1_050_000,
  top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 },
  architecture: { input_modalities: ['file', 'image', 'text'], output_modalities: ['text'] },
  reasoning: { mandatory: false, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'] },
  supported_parameters: ['max_completion_tokens', 'reasoning', 'structured_outputs', 'tools'],
  endpoints: ['/api/v1/chat/completions'],
}

/** An embedding-style model a guardrail might allow but chat cannot use. */
export const embedder = {
  id: 'acme/embed-1',
  name: 'Acme Embed',
  context_length: 8192,
  architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
  endpoints: ['/api/v1/embeddings'],
}

/** Installed catalog ids for the OpenRouter route (subset). */
export const installed = new Set(['anthropic/claude-opus-5.5', 'z-ai/glm-5.3', 'openai/gpt-6.1-sol'])
