/* ================= AI 服务商适配层 =================
   支持三类协议：openai(兼容) / anthropic / gemini
   统一导出：streamChat(...)  纯文本增量回调
            fetchModels(...)  拉取模型列表
*/

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek（深度求索）',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyHint: '在 platform.deepseek.com 创建，形如 sk-xxxx',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  openai: {
    label: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyHint: 'platform.openai.com 创建，形如 sk-...',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  },
  moonshot: {
    label: 'Kimi 月之暗面',
    type: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyHint: 'platform.moonshot.cn 创建',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'],
  },
  zhipu: {
    label: '智谱 GLM',
    type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyHint: 'bigmodel.cn 创建',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
  },
  dashscope: {
    label: '通义千问（百炼）',
    type: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyHint: 'bailian.console.aliyun.com 创建',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    type: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyHint: 'siliconflow.cn 创建',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  },
  openrouter: {
    label: 'OpenRouter（聚合）',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat-v3.1:free',
    keyHint: 'openrouter.ai/keys 创建',
    models: ['deepseek/deepseek-chat-v3.1:free', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'],
  },
  gemini: {
    label: 'Google Gemini',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    keyHint: 'aistudio.google.com/apikey 创建',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  anthropic: {
    label: 'Anthropic Claude',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    keyHint: 'console.anthropic.com 创建，形如 sk-ant-...',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
  },
  ollama: {
    label: '本地 Ollama',
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    keyHint: '本地模型可随便填，例如 ollama',
    models: ['qwen2.5:7b', 'llama3.1:8b'],
  },
  lmstudio: {
    label: '本地 LM Studio',
    type: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    keyHint: '本地模型可随便填',
    models: ['local-model'],
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    type: 'openai',
    baseUrl: '',
    model: '',
    keyHint: '任何兼容 /chat/completions 的服务',
    models: [],
  },
};

export function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/* ---------- 代理 ---------- */
export function viaProxy(url, proxy) {
  const p = String(proxy || '').trim();
  if (!p) return url;
  if (p.includes('{url}')) return p.replace('{url}', encodeURIComponent(url));
  if (/[?=&]$/.test(p)) return p + encodeURIComponent(url);
  return p.replace(/\/+$/, '') + '?url=' + encodeURIComponent(url);
}

/* ---------- 端点与请求体 ---------- */
function buildRequest(cfg) {
  const type = cfg.type || 'openai';
  const base = normalizeBase(cfg.baseUrl);
  const model = String(cfg.model || '').trim();
  const msgs = cfg.messages || [];
  const stream = cfg.stream !== false;

  if (type === 'anthropic') {
    const url = /\/messages$/.test(base) ? base : base + '/messages';
    const body = {
      model,
      max_tokens: cfg.maxTokens || 2048,
      temperature: cfg.temperature ?? 0.9,
      stream,
      messages: msgs.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    };
    if (cfg.system) body.system = cfg.system;
    return {
      url,
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body,
    };
  }

  if (type === 'gemini') {
    const b = normalizeBase(cfg.baseUrl) || 'https://generativelanguage.googleapis.com/v1beta';
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    const url = `${b}/models/${encodeURIComponent(model)}:${method}?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;
    const body = {
      contents: msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: {
        temperature: cfg.temperature ?? 0.9,
        maxOutputTokens: cfg.maxTokens || 2048,
      },
    };
    if (cfg.system) body.systemInstruction = { parts: [{ text: cfg.system }] };
    return { url, headers: { 'content-type': 'application/json' }, body };
  }

  // openai 兼容
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const messages = cfg.system ? [{ role: 'system', content: cfg.system }, ...msgs] : msgs;
  const body = {
    model,
    messages,
    temperature: cfg.temperature ?? 0.9,
    max_tokens: cfg.maxTokens || 2048,
    stream,
  };
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + (cfg.apiKey || ''),
  };
  return { url, headers, body };
}

function friendlyError(err, cfg) {
  const msg = String((err && err.message) || err || '');
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return new Error(
      '网络请求失败：可能是服务商不允许浏览器直连（CORS）、地址填错，或当前网络不可达。' +
      '请在「我的 → 高级选项」里填写 CORS 代理地址后再试。'
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch (_) {}
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.error?.message || j.message || j.error?.type || text;
  } catch (_) {}
  const hints = {
    400: '请求格式或模型名有问题',
    401: 'API Key 无效或未填写',
    402: '账户余额不足',
    403: '无权访问该模型（可能是地区限制）',
    404: '接口地址或模型名不存在',
    413: '上下文太长，去「我的」把上下文字数调小',
    429: '请求太频繁或超出额度，稍后再试',
    500: '服务商内部错误，稍后再试',
    502: '网关错误，稍后再试',
    503: '服务暂时不可用',
    529: '服务过载，稍后再试',
  };
  const hint = hints[res.status] ? `（${hints[res.status]}）` : '';
  return new Error(`[${res.status}] ${String(detail || '').slice(0, 300)}${hint}`);
}

/* ---------- SSE 流解析 ---------- */
async function* sseLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    for (const line of parts) yield line;
  }
  if (buf) yield buf;
}

/* ---------- 主入口：流式对话 ----------
   opts: {type, baseUrl, apiKey, model, system, messages, temperature, maxTokens, stream, proxy, headers}
   onDelta(text) 每次增量；返回完整文本
*/
export async function streamChat(opts, onDelta, signal) {
  const cfg = { ...opts };
  const { url, headers, body } = buildRequest(cfg);
  const finalHeaders = { ...headers };
  if (cfg.headers && typeof cfg.headers === 'object') Object.assign(finalHeaders, cfg.headers);

  const target = viaProxy(url, cfg.proxy);
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: finalHeaders,
      body: JSON.stringify(body),
      signal,
      mode: 'cors',
      cache: 'no-store',
    });
  } catch (e) {
    throw friendlyError(e, cfg);
  }
  if (!res.ok) throw await readError(res);

  const type = cfg.type || 'openai';
  const streaming = cfg.stream !== false && res.body;

  if (!streaming) {
    const json = await res.json();
    let text = '';
    if (type === 'anthropic') text = (json.content || []).map((c) => c.text || '').join('');
    else if (type === 'gemini') text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    else text = json.choices?.[0]?.message?.content || '';
    if (text) onDelta && onDelta(text);
    return text;
  }

  let full = '';
  for await (const line of sseLines(res)) {
    const s = line.trim();
    if (!s || s.startsWith(':')) continue;
    if (!s.startsWith('data:')) continue;
    const data = s.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let json;
    try { json = JSON.parse(data); } catch (_) { continue; }
    let piece = '';
    if (type === 'anthropic') {
      if (json.type === 'content_block_delta') piece = json.delta?.text || '';
      else if (json.type === 'message_delta' || json.type === 'message_stop') piece = '';
    } else if (type === 'gemini') {
      piece = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    } else {
      const d = json.choices?.[0];
      piece = d?.delta?.content ?? d?.message?.content ?? '';
      if (json.error) throw new Error(json.error.message || '服务返回错误');
    }
    if (piece) { full += piece; onDelta && onDelta(piece); }
  }
  return full;
}

/* ---------- 拉取模型列表 ---------- */
export async function fetchModels(cfg) {
  const type = cfg.type || 'openai';
  const base = normalizeBase(cfg.baseUrl);
  let url, headers;
  if (type === 'gemini') {
    url = `${base}/models?key=${encodeURIComponent(cfg.apiKey)}`;
    headers = {};
  } else if (type === 'anthropic') {
    url = base + '/models';
    headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  } else {
    url = base + '/models';
    headers = { authorization: 'Bearer ' + (cfg.apiKey || '') };
  }
  let res;
  try {
    res = await fetch(viaProxy(url, cfg.proxy), { headers, cache: 'no-store' });
  } catch (e) {
    throw friendlyError(e, cfg);
  }
  if (!res.ok) throw await readError(res);
  const json = await res.json();
  const list =
    json.data || json.models || json.body?.data || [];
  return list
    .map((m) => (typeof m === 'string' ? m : m.id || m.name || ''))
    .map((s) => String(s).replace(/^models\//, ''))
    .filter(Boolean);
}

/* ---------- 测试连接 ---------- */
export async function testConnection(cfg) {
  const text = await streamChat(
    {
      ...cfg,
      stream: false,
      maxTokens: 32,
      system: '你是一个测试助手。',
      messages: [{ role: 'user', content: '只回复两个字：正常' }],
    },
    null,
    null
  );
  return String(text).trim().slice(0, 60);
}
