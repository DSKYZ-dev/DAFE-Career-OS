#!/usr/bin/env node
/**
 * llm-helper.mjs — Provider-agnostic LLM call.
 *
 * Routes through model-registry.mjs, which auto-detects whichever API keys the
 * user has configured in .env (OpenRouter / OpenAI / Anthropic / Gemini / Ollama).
 * The user picks their provider at install time (node install.mjs) — nothing is
 * hardcoded here, and no single vendor is forced.
 */
import { ModelRegistry, TaskRouter } from './model-registry.mjs';

let _router = null;

async function router() {
  if (!_router) {
    const registry = await new ModelRegistry().detect();
    _router = new TaskRouter(registry);
  }
  return _router;
}

export async function callLLM(prompt, opts = {}) {
  const {
    taskType = 'reasoning',
    requireCapabilities = ['reasoning'],
    maxCost = 'paid',
    systemPrompt,
    temperature = 0.3,
    maxTokens = 8000,
  } = opts;

  const r = await router();
  const model = r.registry.getModel(taskType, { requireCapabilities, maxCost });
  if (!model) {
    throw new Error(
      'No LLM provider configured. Set one of GEMINI_API_KEY / OPENAI_API_KEY / ' +
      'ANTHROPIC_API_KEY / OPENROUTER_API_KEY in .env (run: node install.mjs)'
    );
  }
  return r.registry.execute(prompt, { model: model.id, taskType, systemPrompt, temperature, maxTokens });
}
