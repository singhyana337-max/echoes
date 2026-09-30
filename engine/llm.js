const status = { calls: 0, failures: 0, lastError: null, lastLatencyMs: null };

export function llmConfig() {
  const key = process.env.NVIDIA_API_KEY || process.env.LLM_API_KEY || '';
  const explicitBase = process.env.LLM_BASE_URL && !process.env.LLM_BASE_URL.includes('integrate.api.nvidia.com');
  return {
    key,
    base: (process.env.LLM_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
    model: process.env.NEMOTRON_MODEL || 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    timeoutMs: (Number(process.env.LLM_TIMEOUT) || 45) * 1000,
    // A local OpenAI-compatible server (Ollama, vLLM, NIM container) needs no key.
    enabled: !!key || !!explicitBase,
  };
}

export function llmStatus() {
  const cfg = llmConfig();
  return { mode: cfg.enabled ? 'nemotron' : 'offline', model: cfg.enabled ? cfg.model : null, ...status };
}

export async function chatJSON({ system, user, maxTokens = 700, temperature = 0.7 }) {
  const cfg = llmConfig();
  if (!cfg.enabled) throw new Error('LLM not configured');
  // Nemotron reasoning models think by default; for snappy NPC dialogue we turn it off.
  const sys = /nemotron/i.test(cfg.model) ? `/no_think\n${system}` : system;
  const started = Date.now();
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature,
        top_p: 0.95,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const parsed = parseJSON(data.choices?.[0]?.message?.content ?? '');
    status.calls++;
    status.lastLatencyMs = Date.now() - started;
    status.lastError = null;
    return parsed;
  } catch (err) {
    status.failures++;
    status.lastError = String(err.message || err).slice(0, 300);
    throw err;
  }
}

export function parseJSON(text) {
  let s = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in model output');
  s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
  }
}
