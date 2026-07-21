#!/usr/bin/env node
/**
 * model-registry.mjs — Model Detection & Orchestration
 * 
 * Auto-detects available models (local Ollama + cloud via API keys)
 * Routes tasks: Cloud for orchestration/reasoning, Local for implementation
 * Provides unified interface for all model calls
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// ─── Model Registry ─────────────────────────────────────────────
class ModelRegistry {
  constructor() {
    this.localModels = new Map();
    this.cloudProviders = new Map();
    this.detected = false;
  }

  async detect() {
    if (this.detected) return this;
    
    // Detect local Ollama models
    await this.detectOllama();
    
    // Detect cloud providers from .env
    this.detectCloudProviders();
    
    this.detected = true;
    return this;
  }

  async detectOllama() {
    try {
      const response = await fetch('http://127.0.0.1:11434/api/tags', { 
        signal: AbortSignal.timeout(3000) 
      });
      if (response.ok) {
        const data = await response.json();
        for (const m of data.models || []) {
          this.localModels.set(m.name, {
            name: m.name,
            size: m.size,
            family: m.details?.family,
            params: m.details?.parameter_size,
            quantization: m.details?.quantization_level,
            source: 'ollama',
            capabilities: this.inferCapabilities(m.name),
          });
        }
      }
    } catch {
      // Ollama not available
    }
    return this;
  }

  inferCapabilities(modelName) {
    const name = modelName.toLowerCase();
    const caps = [];
    if (name.includes('code') || name.includes('coder') || name.includes('deepseek')) caps.push('coding');
    if (name.includes('instruct') || name.includes('chat')) caps.push('chat');
    if (name.includes('3.1') || name.includes('3.2') || name.includes('3.3')) caps.push('reasoning');
    if (name.includes('8b') || name.includes('7b')) caps.push('fast');
    if (name.includes('70b') || name.includes('72b') || name.includes('27b')) caps.push('strong');
    if (name.includes('nemotron') || name.includes('ultra')) caps.push('agentic');
    return caps;
  }

  detectCloudProviders() {
    // Load .env
    let env = {};
    try {
      const envPath = join(ROOT, '.env');
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
          const [k, ...v] = line.split('=');
          if (k && v.length) env[k.trim()] = v.join('=').trim();
        }
      }
    } catch {}

    const providers = [];

    if (env.OPENROUTER_API_KEY) {
      // OpenRouter retired its ':free' tier; list working paid/cheap models.
      // NOTE: CLOUD_MODEL is only an *override/priority* hint here — it must
      // NOT filter the list, or a Gemini id (set for the gemini provider) would
      // wipe every OpenRouter model when the user switches providers.
      const orModels = [
        { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', tier: 'paid', capabilities: ['reasoning', 'chat', 'fast'] },
        { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', tier: 'paid', capabilities: ['reasoning', 'strong', 'chat'] },
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'paid', capabilities: ['reasoning', 'fast', 'search'] },
        { id: 'mistralai/mistral-large', name: 'Mistral Large', tier: 'paid', capabilities: ['reasoning', 'strong'] },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', tier: 'paid', capabilities: ['reasoning', 'strong', 'agentic'] },
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', tier: 'cheap', capabilities: ['reasoning', 'fast', 'chat'] },
      ];
      if (env.CLOUD_MODEL && env.CLOUD_MODEL.includes('/')) {
        orModels.sort((a, b) => (b.id === env.CLOUD_MODEL) - (a.id === env.CLOUD_MODEL));
      }
      providers.push({
        name: 'openrouter',
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: 'https://openrouter.ai/api/v1',
        models: orModels,
      });
    }

    if (env.GEMINI_API_KEY) {
      providers.push({
        name: 'gemini',
        apiKey: env.GEMINI_API_KEY,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        models: [
          // 2.5 Pro moved to paid-only in April 2026 — only Flash/Flash-Lite
          // tiers stayed free. 3.5 Flash (May 2026) is the current free default.
          { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', tier: 'free', capabilities: ['reasoning', 'fast', 'search'] },
          { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'free', capabilities: ['reasoning', 'fast', 'search'] },
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'paid', capabilities: ['reasoning', 'strong', 'long-context'] },
        ],
      });
    }

    if (env.OLLAMA_API_KEY) {
      // Ollama Cloud — same account/key as `ollama signin`, hit directly via
      // ollama.com's API rather than proxying through a local instance.
      // https://docs.ollama.com/cloud
      providers.push({
        name: 'ollama-cloud',
        apiKey: env.OLLAMA_API_KEY,
        baseUrl: 'https://ollama.com/api',
        models: [
          { id: 'gpt-oss:120b', name: 'GPT-OSS 120B (Ollama Cloud)', tier: 'paid', capabilities: ['reasoning', 'strong', 'agentic'] },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (Ollama Cloud)', tier: 'paid', capabilities: ['reasoning', 'fast', 'coding'] },
        ],
      });
    }

    if (env.OPENAI_API_KEY) {
      providers.push({
        name: 'openai',
        apiKey: env.OPENAI_API_KEY,
        baseUrl: 'https://api.openai.com/v1',
        models: [
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tier: 'cheap', capabilities: ['reasoning', 'fast', 'chat'] },
          { id: 'gpt-4o', name: 'GPT-4o', tier: 'paid', capabilities: ['reasoning', 'strong', 'agentic', 'vision'] },
        ],
      });
    }

    if (env.ANTHROPIC_API_KEY) {
      providers.push({
        name: 'anthropic',
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: 'https://api.anthropic.com/v1',
        models: [
          { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', tier: 'cheap', capabilities: ['reasoning', 'fast'] },
          { id: 'claude-3.5-sonnet-20241022', name: 'Claude 3.5 Sonnet', tier: 'paid', capabilities: ['reasoning', 'strong', 'agentic'] },
        ],
      });
    }

    for (const p of providers) this.cloudProviders.set(p.name, p);
    
    return this;
  }

  // Get best model for a task type
  getModel(taskType, options = {}) {
    const { preferLocal = false, requireCapabilities = [], maxCost = 'paid' } = options;

    // Build candidate list
    const candidates = [];

    // Local models
    if (preferLocal || this.localModels.size > 0) {
      for (const [name, m] of this.localModels) {
        if (this.matchesCapabilities(m.capabilities, requireCapabilities)) {
          candidates.push({ ...m, provider: 'ollama', cost: 'free', priority: preferLocal ? 10 : 5 });
        }
      }
    }

    // Cloud models
    for (const [name, p] of this.cloudProviders) {
      for (const m of p.models) {
        if (this.matchesCapabilities(m.capabilities, requireCapabilities) && this.tierAllows(m.tier, maxCost)) {
          candidates.push({ ...m, provider: p.name, cost: m.tier, priority: preferLocal ? 1 : 10 });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Sort by priority (higher = better match)
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates[0];
  }

  matchesCapabilities(modelCaps, required) {
    if (!required.length) return true;
    return required.every(c => modelCaps.includes(c));
  }

  tierAllows(modelTier, maxCost) {
    const tiers = { free: 0, cheap: 1, paid: 2 };
    return tiers[modelTier] <= tiers[maxCost];
  }

  // Execute with best available model
  async execute(prompt, options = {}) {
    const { taskType = 'reasoning', model: specificModel, ...opts } = options;
    
    let model;
    if (specificModel) {
      // Find specific model
      for (const [, m] of this.localModels) if (m.name === specificModel) model = m;
      for (const [, p] of this.cloudProviders) for (const m of p.models) if (m.id === specificModel) model = { ...m, provider: p.name };
    } else {
      model = this.getModel(taskType, opts);
    }

    if (!model) throw new Error('No suitable model found');

    return this.callModel(model, prompt, opts);
  }

  async callModel(model, prompt, options = {}) {
    const { temperature = 0.3, maxTokens = 8000, systemPrompt } = options;
    
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    if (model.provider === 'ollama') {
      return this.callOllama(model.name, messages, options);
    } else {
      return this.callCloud(model.provider, model.id, messages, options);
    }
  }

  async callOllama(modelName, messages, options = {}) {
    const { temperature = 0.3, maxTokens = 8000 } = options;
    
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        messages,
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(180000),
    });

    if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.message.content;
  }

  async callCloud(provider, modelId, messages, options = {}) {
    const { temperature = 0.3, maxTokens = 8000 } = options;
    const p = this.cloudProviders.get(provider);
    if (!p) throw new Error(`Provider ${provider} not configured`);

    const headers = { 'Content-Type': 'application/json' };
    let url, body;

    if (provider === 'openrouter') {
      url = `${p.baseUrl}/chat/completions`;
      headers['Authorization'] = `Bearer ${p.apiKey}`;
      headers['HTTP-Referer'] = 'https://github.com/dafe-career-os';
      headers['X-Title'] = 'dafe-career-os';
      body = { model: modelId, messages, temperature, max_tokens: maxTokens };
    } else if (provider === 'openai') {
      url = `${p.baseUrl}/chat/completions`;
      headers['Authorization'] = `Bearer ${p.apiKey}`;
      body = { model: modelId, messages, temperature, max_tokens: maxTokens };
    } else if (provider === 'anthropic') {
      url = `${p.baseUrl}/messages`;
      headers['x-api-key'] = p.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      const system = messages.find(m => m.role === 'system')?.content || '';
      const userMessages = messages.filter(m => m.role !== 'system');
      body = { model: modelId, system, messages: userMessages, temperature, max_tokens: maxTokens };
    } else if (provider === 'gemini') {
      url = `${p.baseUrl}/models/${modelId}:generateContent?key=${p.apiKey}`;
      const text = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
      body = { contents: [{ parts: [{ text }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } };
    } else if (provider === 'ollama-cloud') {
      // Ollama's native chat format, not OpenAI-compatible — ollama.com acts as
      // a remote Ollama host. https://docs.ollama.com/cloud
      url = `${p.baseUrl}/chat`;
      headers['Authorization'] = `Bearer ${p.apiKey}`;
      body = { model: modelId, messages, stream: false };
    }

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`${provider} ${response.status}: ${await response.text()}`);

    const data = await response.json();

    if (provider === 'gemini') return data.candidates[0].content.parts[0].text;
    if (provider === 'anthropic') return data.content[0].text;
    if (provider === 'ollama-cloud') return data.message.content;
    return data.choices[0].message.content;
  }

  // Get status summary
  getStatus() {
    return {
      local: Array.from(this.localModels.values()).map(m => ({ name: m.name, caps: m.capabilities })),
      cloud: Array.from(this.cloudProviders.values()).map(p => ({
        name: p.name,
        models: p.models.map(m => ({ id: m.id, tier: m.tier, caps: m.capabilities })),
      })),
    };
  }
}

// ─── Task Router ────────────────────────────────────────────────
class TaskRouter {
  constructor(registry) {
    this.registry = registry;
  }

  // Orchestration tasks (planning, evaluation, strategy) → Cloud strong models
  async orchestrate(prompt, context = {}) {
    const model = this.registry.getModel('reasoning', { 
      requireCapabilities: ['reasoning', 'strong'], 
      maxCost: 'paid' 
    });
    return this.registry.execute(prompt, { model: model?.id, taskType: 'reasoning' });
  }

  // Fast tasks (extraction, formatting, simple Q&A) → Fast models (local or cloud)
  async quick(prompt, context = {}) {
    const model = this.registry.getModel('extraction', { 
      requireCapabilities: ['fast'], 
      preferLocal: true,
      maxCost: 'free' 
    });
    return this.registry.execute(prompt, { model: model?.id, taskType: 'extraction' });
  }

  // Implementation tasks (code, templates, generation) → Coding-capable models
  async implement(prompt, context = {}) {
    const model = this.registry.getModel('coding', { 
      requireCapabilities: ['coding'], 
      maxCost: 'paid' 
    });
    return this.registry.execute(prompt, { model: model?.id, taskType: 'coding' });
  }

  // Agentic tasks (multi-step, tool use) → Agentic models
  async agent(prompt, context = {}) {
    const model = this.registry.getModel('agentic', { 
      requireCapabilities: ['agentic'], 
      maxCost: 'paid' 
    });
    return this.registry.execute(prompt, { model: model?.id, taskType: 'agentic' });
  }

  // Evaluation tasks → Strong reasoning models
  async evaluate(prompt, context = {}) {
    const model = this.registry.getModel('evaluation', { 
      requireCapabilities: ['reasoning', 'strong'], 
      maxCost: 'paid' 
    });
    return this.registry.execute(prompt, { model: model?.id, taskType: 'evaluation' });
  }

  // Generic routing with custom requirements
  async routeWithModel(prompt, options = {}) {
    const { taskType = 'reasoning', requireCapabilities = [], maxCost = 'paid', preferLocal = false } = options;
    const model = this.registry.getModel(taskType, { requireCapabilities, maxCost, preferLocal });
    return this.registry.execute(prompt, { model: model?.id, taskType, ...options });
  }
}

export { ModelRegistry, TaskRouter };

// CLI for testing
async function main() {
  const { values } = await import('util').then(m => m.parseArgs({
    options: { task: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' }, list: { type: 'boolean' } },
    strict: false
  })).catch(() => ({ values: {} }));

  const registry = new ModelRegistry();
  await registry.detect();

  if (values.list) {
    console.log('=== Available Models ===\n');
    const status = registry.getStatus();
    console.log('Local (Ollama):');
    for (const m of status.local) console.log(`  ${m.name} [${m.caps.join(', ')}]`);
    console.log('\nCloud:');
    for (const p of status.cloud) {
      console.log(`  ${p.name}:`);
      for (const m of p.models) console.log(`    ${m.id} (${m.tier}) [${m.caps.join(', ')}]`);
    }
    return;
  }

  const router = new TaskRouter(registry);
  
  if (values.task && values.prompt) {
    let result;
    switch (values.task) {
      case 'orchestrate': result = await router.orchestrate(values.prompt); break;
      case 'quick': result = await router.quick(values.prompt); break;
      case 'implement': result = await router.implement(values.prompt); break;
      case 'agent': result = await router.agent(values.prompt); break;
      case 'evaluate': result = await router.evaluate(values.prompt); break;
      default: result = await registry.execute(values.prompt, { model: values.model });
    }
    console.log(result);
  } else {
    console.log(`
Model Registry CLI

Usage: node model-registry.mjs [options]

Options:
  --list                    List all available models
  --task <type>             Task type: orchestrate | quick | implement | agent | evaluate
  --prompt <text>           Prompt to execute
  --model <id>              Specific model to use

Examples:
  node model-registry.mjs --list
  node model-registry.mjs --task orchestrate --prompt "Plan a job search strategy"
  node model-registry.mjs --task quick --prompt "Extract skills from this text: ..."
  node model-registry.mjs --task evaluate --prompt "Evaluate this job offer: ..."
`);
  }
}

function isMain() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMain()) main().catch(e => { console.error('Error:', e); process.exit(1); });