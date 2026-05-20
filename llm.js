// =====================================================================
// 元宝胶囊 - LLM 调用层
// ---------------------------------------------------------------------
// 三种 provider，按优先级：
//   1. byok      : 访客在「设置」里填了自己的 base_url + key + model，直连
//   2. server    : 走同站 /api/chat，由 Vercel Serverless 代理 + 服务器侧 key
//   3. mock      : 本地规则模拟，永远兜底，不需要任何配置
// 默认行为：先试 server，server 没配（503/backend_not_configured）就降级 mock。
// 访客如果填了 byok，就用访客自己的 key（不消耗服务器额度）。
// =====================================================================

const LLM = (() => {
  const STORAGE_KEY = 'capsule_llm_config_v1';

  function getConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { provider: 'auto' };
      return JSON.parse(raw);
    } catch (_) {
      return { provider: 'auto' };
    }
  }

  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  // 构造 messages：system + mode + few-shot + user
  function buildMessages(rawText, mode) {
    const P = window.CAPSULE_PROMPTS;
    const m = P.modes[mode] || P.modes.auto;
    const msgs = [
      { role: 'system', content: P.system + '\n\n' + m.prompt },
    ];
    (m.examples || []).forEach((ex) => {
      msgs.push({ role: 'user', content: ex.in });
      msgs.push({ role: 'assistant', content: ex.out });
    });
    msgs.push({ role: 'user', content: rawText });
    return msgs;
  }

  // ===== mock provider：本地规则模拟，演示用 =====
  // 核心目标：让 mock 也能给出"看起来有结构"的输出，不是简单去口癖。
  function cleanText(raw) {
    return raw
      .replace(/这个|那个|就是这样|就是说|就是个|嗯+|啊+|呃+|呢|然后说|然后呢|然后我|然后就|你知道吧|你看哈|对吧|我跟你说|我觉得吧|怎么说呢|帮我想想|帮我看看|帮我搞一下/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 把一段口语切成"语义片段" —— 关键升级：基于"枚举锚点"切片
  function splitSegments(text) {
    // 锚点正则：每个匹配处 = 一个新条目的开始
    const anchorPatterns = [
      /第[一二三四五六七八九十百0-9]+件事情?[是为，,：:]?/g,        // 第一件事情是 / 第二件事
      /第[一二三四五六七八九十百0-9]+[个件项条点种步阶段]/g,         // 第一个 / 第二步 / 第三阶段
      /[一二三四五六七八九十][是为][^是为，,。]/g,                  // 一是X 二是Y
      /(今天|明天|本周|本月)?事情是/g,                              // 今天事情是 / 事情是
      /(?<![一二三四五六七八九十])[一二三四五六七八九十]期/g,    // 一期/二期/三期（产品分期）
      /(?<![一二三四五六七八九十])[一二三四五六七八九十]月[底初]?/g, // 一月底 / 二月初
      /[1-9][\.、)）]\s*/g,                                         // 1. 1、 1)
      /(首先|其次|然后|接着|最后|另外|还有|再就是|另一个|另一方面|一方面|此外)/g,
    ];

    const positions = [];
    for (const r of anchorPatterns) {
      let m;
      r.lastIndex = 0;
      while ((m = r.exec(text)) !== null) {
        // 过滤掉跟在"几件事情"这种"了/吗"后面的非锚点情形
        const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
        positions.push({ start: m.index, end: m.index + m[0].length, mark: m[0], tail });
      }
    }
    positions.sort((a, b) => a.start - b.start);

    // 去重（重叠的锚点保留靠前的）
    const dedup = [];
    for (const p of positions) {
      if (!dedup.length || p.start >= dedup[dedup.length - 1].end) dedup.push(p);
    }

    if (dedup.length >= 2) {
      const result = [];
      // 锚点前的引导语作为可能的主题保留在 __preface
      const preface = text.slice(0, dedup[0].start).replace(/[，,。；;]+$/g, '').trim();
      for (let i = 0; i < dedup.length; i++) {
        const start = dedup[i].end;
        const end = i + 1 < dedup.length ? dedup[i + 1].start : text.length;
        const seg = text.slice(start, end).replace(/^[，,。；;:：的]+|[，,。；;]+$/g, '').trim();
        if (seg) result.push(seg);
      }
      result.__preface = preface;
      return result;
    }

    // 否则按强分隔符切（句号/分号/感叹/问号）
    const sentences = text.split(/[。！？；;\n]/).map(s => s.trim()).filter(Boolean);
    if (sentences.length >= 2) return sentences;

    // 兜底：按逗号切，但只在子句较长时
    const byComma = text.split(/[，,]/).map(s => s.trim()).filter(s => s.length >= 4);
    return byComma.length >= 2 ? byComma : [text];
  }

  // 尝试提取主题句（第一段或开头到第一个停顿前的内容）
  function extractTopic(text, segs) {
    // 优先用 splitSegments 给出的引导语
    if (segs && segs.__preface) {
      const p = segs.__preface
        .replace(/^(帮我|麻烦|那个|这个)+/g, '')
        .replace(/(几件事情了?|要点|笔记|事项)$/g, '事项')
        .trim();
      if (p && p.length >= 3 && p.length <= 30) return p;
    }
    const m = text.match(/^([^，,。；;]{4,30})[，,。；;]/);
    if (m) return m[1].trim();
    return null;
  }

  function mockComplete(messages, mode) {
    const userText = messages[messages.length - 1].content || '';
    const cleaned = cleanText(userText);

    if (mode === 'msg') {
      // 聊天消息：去口癖 + 自然停顿，但保持单段
      let out = cleaned.replace(/[，,]{2,}/g, '，');
      if (!/[。？！?!]$/.test(out)) out += '。';
      return out;
    }

    if (mode === 'note') {
      // 结构化笔记：尝试主题+要点分组
      const segs = splitSegments(cleaned);
      const topic = extractTopic(cleaned, segs);

      if (segs.length <= 1) {
        return `## 要点\n- ${cleaned}`;
      }

      // 区分"动作类"（待办）和"陈述类"（要点）
      const actions = [];
      const points = [];
      segs.forEach(s => {
        const trimmed = s.replace(/^[，,。；;]+|[，,。；;]+$/g, '').trim();
        if (!trimmed) return;
        if (/(要做|得做|需要|准备|完成|发送|确认|约一下|约见|提醒|记得|跟进|联系|安排|提交|处理|回复|开会)/.test(trimmed)) {
          actions.push(trimmed);
        } else {
          points.push(trimmed);
        }
      });

      const lines = [];
      lines.push(`## ${topic || '要点'}`);
      points.forEach(p => lines.push('- ' + p));
      if (actions.length) {
        if (points.length) lines.push('');
        lines.push('## 待办');
        actions.forEach(a => lines.push('- [ ] ' + a));
      }
      return lines.join('\n');
    }

    if (mode === 'email') {
      const segs = splitSegments(cleaned);
      const topic = extractTopic(cleaned, segs) || cleaned.slice(0, 18);
      const bodyLines = segs.length > 1
        ? segs.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : cleaned;
      return `主题：${topic}\n\n[收件人]：\n\n你好，\n\n${bodyLines}\n\n感谢支持，期待你的反馈。\n\n[我]`;
    }

    if (mode === 'todo') {
      const segs = splitSegments(cleaned);
      if (segs.length <= 1) return '- [ ] ' + cleaned;
      return segs.map(s => {
        const t = s.replace(/^[，,。；;]+|[，,。；;]+$/g, '').trim();
        const timeMatch = t.match(/(今天|明天|后天|周[一二三四五六日天]|[0-9]+月[0-9]+[日号]?|[上下]午|[0-9]+点|[0-9]+:[0-9]+|周.之前|月底|本周|下周)/);
        if (timeMatch) {
          const action = t.replace(timeMatch[0], '').replace(/[，,]+/g, '').trim();
          return `- [ ] ${action} (截止: ${timeMatch[0]})`;
        }
        return `- [ ] ${t}`;
      }).join('\n');
    }

    // auto
    let chosen = 'note';
    if (/提醒|记得|别忘|要做|得做|周.之前|截止|安排|约/.test(cleaned)) chosen = 'todo';
    else if (/邮件|email|发邮件|抄送|发给.*老板|回复.*邮件/.test(cleaned)) chosen = 'email';
    else if (/^(那个)?(嗨|hi|hey|你好)/.test(cleaned) || cleaned.length <= 25) chosen = 'msg';
    else chosen = 'note';
    const sub = mockComplete([{ content: cleaned }], chosen);
    return `[判定: ${chosen}]\n${sub}`;
  }

  // ===== 真实 provider：OpenAI 兼容（访客自带 key 直连）=====
  async function realComplete(messages, cfg) {
    const cfgLLM = (window.CAPSULE_PROMPTS.config && window.CAPSULE_PROMPTS.config.llm) || {};
    const body = {
      model: cfg.model || 'gpt-4o-mini',
      messages,
      temperature: cfgLLM.temperature ?? 0.2,
      max_tokens: cfgLLM.max_tokens ?? 800,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfgLLM.timeout_ms ?? 15000);
    try {
      const resp = await fetch((cfg.base_url || '').replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (cfg.api_key || ''),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 120));
      }
      const data = await resp.json();
      return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // ===== Server provider：走同站 /api/chat，Key 在服务端 =====
  async function serverComplete(messages) {
    const cfgLLM = (window.CAPSULE_PROMPTS.config && window.CAPSULE_PROMPTS.config.llm) || {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfgLLM.timeout_ms ?? 20000);
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          temperature: cfgLLM.temperature ?? 0.2,
          max_tokens: cfgLLM.max_tokens ?? 800,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const txt = await resp.text();
      let data;
      try { data = JSON.parse(txt); } catch (_) { data = null; }
      if (resp.status === 503 && data?.error === 'backend_not_configured') {
        const err = new Error('backend_not_configured');
        err.code = 'backend_not_configured';
        throw err;
      }
      if (!resp.ok) {
        const msg = data?.message || data?.error || ('HTTP ' + resp.status);
        throw new Error(msg);
      }
      return (data?.choices?.[0]?.message?.content) || '';
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  async function complete(rawText, mode) {
    const messages = buildMessages(rawText, mode);
    const cfg = getConfig();
    window.__lastPrompt = {
      time: new Date().toISOString(),
      mode,
      provider: cfg.provider || 'auto',
      messages,
    };

    // 1) 访客明确选了 mock：直接 mock
    if (cfg.provider === 'mock') {
      await new Promise(r => setTimeout(r, 250));
      return { text: mockComplete(messages, mode), provider: 'mock' };
    }

    // 2) 访客自带 key（byok / openai）：直连 OpenAI 兼容服务
    if ((cfg.provider === 'byok' || cfg.provider === 'openai') && cfg.api_key && cfg.base_url) {
      const text = await realComplete(messages, cfg);
      return { text, provider: 'byok' };
    }

    // 3) 默认 auto：先试 server 端代理；503 就降级 mock；其他错误抛出
    try {
      const text = await serverComplete(messages);
      return { text, provider: 'server' };
    } catch (e) {
      if (e.code === 'backend_not_configured') {
        await new Promise(r => setTimeout(r, 200));
        return {
          text: mockComplete(messages, mode),
          provider: 'mock',
          notice: '后端未配置真模型，已使用 mock 演示。要看真模型效果，请在右上角「设置」里填自己的 LLM key。',
        };
      }
      throw e;
    }
  }

  return { complete, buildMessages, getConfig, saveConfig };
})();
