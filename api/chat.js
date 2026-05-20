// =====================================================================
// 元宝胶囊 - Serverless 后端代理
// ---------------------------------------------------------------------
// 部署在 Vercel Functions 上。前端 POST /api/chat → 这里转发到 OpenAI
// 兼容 LLM 服务（DeepSeek / 通义 / 自建代理 / OpenAI）。Key 放环境变量，
// 永远不会暴露到浏览器。
//
// 必要环境变量（在 Vercel Dashboard → Settings → Environment Variables 配置）：
//   LLM_BASE_URL  例如 https://api.deepseek.com/v1
//   LLM_API_KEY   sk-xxx
//   LLM_MODEL     例如 deepseek-chat
//
// 可选：
//   LLM_TIMEOUT_MS  默认 15000
//   RATE_LIMIT_PER_MIN  默认 30，每个 IP 每分钟最多调用次数（粗暴防滥用）
// =====================================================================

const RATE_LIMIT_BUCKET = new Map(); // ip -> { count, ts }

function rateLimit(req) {
  const limit = parseInt(process.env.RATE_LIMIT_PER_MIN || '30', 10);
  if (!limit || limit <= 0) return true;
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const now = Date.now();
  const bucket = RATE_LIMIT_BUCKET.get(ip) || { count: 0, ts: now };
  if (now - bucket.ts > 60_000) {
    bucket.count = 0;
    bucket.ts = now;
  }
  bucket.count += 1;
  RATE_LIMIT_BUCKET.set(ip, bucket);
  return bucket.count <= limit;
}

module.exports = async (req, res) => {
  // CORS：方便后续从别的域名调试，这里放开。生产可以收紧。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!rateLimit(req)) {
    return res.status(429).json({
      error: 'rate_limited',
      message: '调用太频繁了，稍等一分钟再试。',
    });
  }

  // Vercel Node Runtime 默认会自动解析 JSON body
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      return res.status(400).json({ error: 'invalid_json' });
    }
  }
  if (!body || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: 'missing_messages' });
  }

  const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.LLM_API_KEY;
  const defaultModel = process.env.LLM_MODEL || 'deepseek-chat';
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || '15000', 10);

  if (!baseUrl || !apiKey) {
    return res.status(503).json({
      error: 'backend_not_configured',
      message:
        '后端没配 LLM_BASE_URL / LLM_API_KEY。访客可在「设置」里填自己的 key 体验真模型，否则会走 mock。',
    });
  }

  const payload = {
    model: body.model || defaultModel,
    messages: body.messages,
    temperature: body.temperature ?? 0.2,
    max_tokens: body.max_tokens ?? 800,
    stream: false,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upstream = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.send(text);
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({
      error: 'upstream_failed',
      message: e?.name === 'AbortError' ? '上游 LLM 超时' : (e?.message || '上游调用失败'),
    });
  }
};
