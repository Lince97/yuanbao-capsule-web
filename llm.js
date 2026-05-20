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

  // 1) 转写清洗：去口癖 + 压缩空白
  function cleanText(raw) {
    return raw
      .replace(/这个|那个|就是这样|就是说|就是个|嗯+|啊+|呃+|呢|然后说|然后呢|然后我|然后就|你知道吧|你看哈|对吧|我跟你说|我觉得吧|怎么说呢/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 2) 元指令分离：把"对 AI 说的话"剥离出来
  //    返回 { meta: '剥离掉的元指令片段', body: '剩下的真内容' }
  function stripMetaInstructions(raw) {
    const metaPatterns = [
      /帮我尝试一下咱们?新的(结构化的?)?输出/g,
      /帮我尝试一下/g,
      /帮我整理一下/g,
      /帮我看一下/g,
      /帮我看看/g,
      /帮我想想/g,
      /帮我搞一下/g,
      /帮我试试/g,
      /帮我$/g,           // "...帮我"结尾
      /^帮我[，,]?/g,
      /咱们试试/g,
      /咱们来试一下/g,
      /测试一下/g,
      /演示一下/g,
      /用刚才那个模式/g,
      /用新的(结构化)?(模式|输出|功能)/g,
    ];
    let body = raw;
    let meta = [];
    for (const r of metaPatterns) {
      body = body.replace(r, (m) => { meta.push(m); return ''; });
    }
    body = body
      .replace(/^[，,。；;\s]+|[，,。；;\s]+$/g, '')
      .replace(/[，,]{2,}/g, '，')
      .trim();
    return { meta: meta.join(' '), body };
  }

  // 3) 识别"是 X 是 Y 是 Z"这种枚举锚点，剥离锚点后切分
  //    例："是蒜味的小花生，是iPhone 16，是巧克力" → ["蒜味的小花生", "iPhone 16", "巧克力"]
  function splitByShiAnchor(text) {
    const segs = text.split(/[，,。；;]/).map(s => s.trim()).filter(Boolean);
    let shiCount = 0;
    for (const s of segs) if (/^是./.test(s)) shiCount += 1;
    if (shiCount >= 2) {
      const items = [];
      for (const s of segs) {
        if (/^是./.test(s)) {
          const stripped = s.replace(/^是\s*/, '').trim();
          // 如果第一条"是 X"里 X 包含主题信号词（想买X几个东西、几件事等），归到 preface 而非条目
          // 这样可以避免"是我想买几个东西"被当成第一个商品
          if (items.length === 0 && /(想买|要买|买几|几个东西|几件事|几样|几点)/.test(stripped)) {
            items.__preface = (items.__preface ? items.__preface + '，' : '') + stripped;
          } else {
            items.push(stripped);
          }
        } else if (items.length === 0) {
          items.__preface = (items.__preface ? items.__preface + '，' : '') + s;
        } else {
          if (s.length >= 2) items[items.length - 1] += s;
        }
      }
      return items.filter(x => x && x.length >= 1);
    }
    return null;
  }

  // 主题信号识别：是否包含"几个 X / 几件事 / 三点 / 这几样"
  // 返回 { isShoppingLike: true/false, theme: '主题文本' or null }
  function detectThemeSignal(text) {
    // 购物 / 物品类
    const shopMatch = text.match(/(想买|要买|买点|买几样|买几个).{0,15}(东西|玩意|物品|零食|商品)?/);
    if (shopMatch) return { isShoppingLike: true, theme: '购物清单' };
    // 几件事
    const thingsMatch = text.match(/(今天|这周|本周|这次)?有?([一二三四五六七八九十几]+)件事/);
    if (thingsMatch) {
      const prefix = (thingsMatch[1] || '') + thingsMatch[2] + '件事';
      return { isShoppingLike: false, theme: prefix };
    }
    // 几点 / 三点 —— 必须紧跟"总结/要点/想法/事项/思考"才算主题，避免把"十点开会"误判
    const pointsMatch = text.match(/([一二三四五六七八九十几]+)点(总结|要点|想法|事项|思考|原则|结论)/);
    if (pointsMatch) return { isShoppingLike: false, theme: pointsMatch[0] };
    return { isShoppingLike: false, theme: null };
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
        // 尾部清理：去掉残留的标点和"第"字（"第X是"切分后的残骸）
        const seg = text.slice(start, end)
          .replace(/^[，,。；;:：的]+|[，,。；;]+$/g, '')
          .replace(/第$/, '')
          .trim();
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

    // 第 1 步：剥离元指令
    const { body: bodyRaw } = stripMetaInstructions(userText);
    if (!bodyRaw || bodyRaw.length < 2) {
      // 整段都是元指令
      return mode === 'auto' ? '[判定: note]\n[空内容]' : '[空内容]';
    }
    // 第 2 步：去口癖
    const cleaned = cleanText(bodyRaw);

    if (mode === 'msg') {
      // 聊天消息：去口癖 + 自然停顿，但保持单段
      let out = cleaned.replace(/[，,]{2,}/g, '，');
      if (!/[。？！?!]$/.test(out)) out += '。';
      return out;
    }

    if (mode === 'note') {
      // 优先识别"是 X 是 Y 是 Z"枚举锚点
      const shiItems = splitByShiAnchor(cleaned);
      if (shiItems && shiItems.length >= 2) {
        const sig = detectThemeSignal(cleaned + ' ' + (shiItems.__preface || ''));
        // 主题优先用信号词识别的（如"购物清单"），其次才用 preface
        let theme = sig.theme;
        if (!theme && shiItems.__preface) {
          // preface 自带主题信号已经被 detectThemeSignal 识别；如果都没有，用 preface 但去掉"我想 X 几个 Y"这种引导
          theme = shiItems.__preface
            .replace(/(我)?(想|要)?(说|讲|告诉你|跟你说)?/, '')
            .replace(/(几|这几|那几)(个|件|样)(东西|事情|事|玩意)/, '')
            .trim();
          if (!theme) theme = null;
        }
        const useDash = sig.isShoppingLike;
        const lines = [];
        if (theme && theme.length >= 2) { lines.push(theme); lines.push(''); }
        shiItems.forEach((it, i) => {
          // 进一步剥离每条尾部残留的元指令（如最后一条带"帮我"）
          const cleanedItem = it
            .replace(/^(的|了|啊|呢|嗯)+/, '')
            .replace(/(帮我|麻烦你?|拜托)$/, '')
            .trim();
          if (!cleanedItem) return;
          if (useDash) lines.push('- ' + cleanedItem);
          else lines.push(`${i + 1}. ${cleanedItem}`);
        });
        return lines.join('\n');
      }

      // 通用结构化路径
      const segs = splitSegments(cleaned);
      if (segs.length <= 1) {
        // 单段陈述，不硬切；msg 化输出
        let out = cleaned.replace(/[，,]{2,}/g, '，');
        if (!/[。？！?!]$/.test(out)) out += '。';
        return out;
      }

      // 区分"动作类"（待办）和"陈述类"（要点）
      const actions = [];
      const points = [];
      segs.forEach(s => {
        const trimmed = s.replace(/^[，,。；;]+|[，,。；;]+$/g, '').trim();
        if (!trimmed) return;
        if (/(要做|得做|需要|准备|完成|发送|确认|约一下|约见|提醒|记得|跟进|联系|安排|提交|处理|回复|开会|别忘|发个)/.test(trimmed)) {
          actions.push(trimmed);
        } else {
          points.push(trimmed);
        }
      });

      const sig = detectThemeSignal(cleaned);
      const lines = [];
      // 主题作为独立首行
      if (sig.theme) { lines.push(sig.theme); lines.push(''); }
      else if (segs.__preface && segs.__preface.length >= 3 && segs.__preface.length <= 40) {
        lines.push(segs.__preface); lines.push('');
      }
      points.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
      if (actions.length) {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
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
      const items = segs.length <= 1 ? [cleaned] : segs;
      return items.map(s => {
        // 剥离"提醒我 / 别忘了 / 记得"等动作前缀
        let t = s.replace(/^[，,。；;]+|[，,。；;]+$/g, '').trim();
        t = t.replace(/^(提醒我|记得|别忘了|别忘|要|得|需要|帮我|麻烦你?)/, '').trim();
        // 时间识别（更全：明天上午十点 / 周五 / 月底）
        const timeMatch = t.match(/(今天|明天|后天|周[一二三四五六日天]|[0-9]+月[0-9]+[日号]?|[上下]午[一二三四五六七八九十0-9]+点(半|十?[一二三四五]?分)?|[一二三四五六七八九十0-9]+点(半|十?[一二三四五]?分)?|[0-9]+:[0-9]+|周.之前|月底|本周|下周三?|下周.|下个月)/);
        if (timeMatch) {
          const action = t.replace(timeMatch[0], '').replace(/[，,]+/g, '').trim();
          return `- [ ] ${action} (截止: ${timeMatch[0]})`;
        }
        return `- [ ] ${t}`;
      }).join('\n');
    }

    // auto 模式路由
    let chosen = 'note';
    const sig = detectThemeSignal(cleaned);
    const hasShi = !!splitByShiAnchor(cleaned);
    const hasMultiPhase = /(一期|二期|三期).*?(二期|三期|四期)/.test(cleaned)
                       || /(首先|其次|然后|最后).*?(其次|然后|接着|最后|另外)/.test(cleaned);
    const todoSignal = /提醒|记得|别忘|要做|得做|周.之前|截止|安排/.test(cleaned);
    const emailSignal = /(发邮件|抄送|邮件给|回复邮件|email)/.test(cleaned);

    if (sig.theme || hasShi || hasMultiPhase) {
      chosen = 'note';                       // 主题信号 / 枚举锚点 / 多阶段 → note
    } else if (emailSignal) {
      chosen = 'email';
    } else if (todoSignal && cleaned.length <= 40) {
      chosen = 'todo';                       // 短而纯的提醒 → todo
    } else if (cleaned.length <= 25) {
      chosen = 'msg';
    } else {
      chosen = 'note';
    }
    const sub = mockComplete([{ content: bodyRaw }], chosen);
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

    // 3) 默认 auto：
    //    - 如果在纯静态托管（GitHub Pages / *.github.io）上，直接走 mock，避免请求不存在的 /api/chat
    //    - 否则先试 server 端代理；503 就降级 mock；其他错误抛出
    const host = (typeof location !== 'undefined' && location.hostname) || '';
    const isStaticOnlyHost = /\.github\.io$/i.test(host);
    if (isStaticOnlyHost) {
      await new Promise(r => setTimeout(r, 200));
      return {
        text: mockComplete(messages, mode),
        provider: 'mock',
        notice: '当前是静态演示版（mock）。要体验真模型，请点右上角「设置」填入你自己的 LLM key。',
      };
    }
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
