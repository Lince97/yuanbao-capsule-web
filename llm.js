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

  // 1) 转写清洗：去口癖 + 自我修正归并 + 重复去除 + 压缩空白
  //    v3：保守清洗，避免误删"这个 PRD"中的 PRD（指代+实词组合一律保留）
  function cleanText(raw) {
    let t = raw;
    // 自我修正：「X 不对 / 不是 / 应该是 Y」→ 留 Y
    t = t.replace(/([^，,。；;]+?)\s*(?:不对|不是|应该是|改成|纠正一下)\s*([^，,。；;]+)/g, '$2');
    // 重复短语去除：同一短语连续出现两次以上压成一次（限 3-12 字短语）
    t = t.replace(/([\u4e00-\u9fa5]{3,12})(?:\s*\1){1,}/g, '$1');
    // 纯口癖：列表内的词一律删
    t = t.replace(/嗯+|啊+|呃+|呢(?=[\s，,。])|你知道吧|你看哈|对吧|我跟你说啊?|我跟你讲|我觉得吧|怎么说呢|就是这样|就是说|就是个/g, '');
    // "这个 / 那个" 仅在做填充时删 —— 仅当后面跟着标点 / 短助词 / 句尾时删；
    // "这个 PRD"、"那个客户" 这种指代搭配保留
    t = t.replace(/(这个|那个)(?=[，,。；;\s]|$)/g, '');
    t = t.replace(/(?<![\u4e00-\u9fa5\w])(这个|那个)(?=就是|可能|应该|大概)/g, '');
    // "然后" 仅在句首/逗号后做填充时删
    t = t.replace(/[，,]\s*然后\s*[，,]?/g, '，');
    t = t.replace(/^然后\s*/g, '');
    return t
      .replace(/\s+/g, ' ')
      .replace(/[，,]{2,}/g, '，')
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
  // v3：扩充锚点到 8 大类，并增加"列举提示词后置切分"（分别是 / 包括 / 涉及）
  function splitSegments(text) {
    // 第 0 步：列举提示词前置识别 —— "X 分别是 / X 包括 / X 主要有 / X 涉及" 形式
    //         这种锚点的特征是：锚点位置在引导句末尾，后面整段都是枚举元素
    //         需要把锚点之后的内容用顿号 / 逗号 / "和" / "还有" 切分成独立条目
    const enumLeads = [
      /([^。！？!?]{0,40})(?:分别是|包括|主要有|主要是|涵盖|涉及到?|涵括)\s*([^。！？!?]+)/,
    ];
    for (const r of enumLeads) {
      const m = text.match(r);
      if (m && m[2]) {
        const preface = (m[1] || '').replace(/[，,。；;\s]+$/g, '').trim();
        const tail = m[2];
        // 用并列连词切分尾部
        const items = tail
          .split(/[、，,]|(?:还有|再加上|以及|和(?=\S{2,}))/)
          .map(s => s.trim())
          .filter(s => s && s.length >= 1);
        if (items.length >= 2) {
          const result = items.slice();
          if (preface) result.__preface = preface;
          return result;
        }
      }
    }

    // 锚点正则：每个匹配处 = 一个新条目的开始（v3 扩充）
    const anchorPatterns = [
      /第[一二三四五六七八九十百0-9]+件事情?[是为，,：:]?/g,        // 第一件事情是 / 第二件事
      /第[一二三四五六七八九十百0-9]+[个件项条点种步阶段]/g,         // 第一个 / 第二步 / 第三阶段
      /[一二三四五六七八九十][是为][^是为，,。]/g,                  // 一是X 二是Y
      /[一二三四五六七八九十]来[，,]?/g,                            // 一来 X 二来 Y
      /其[一二三四五六七八九十]/g,                                  // 其一 / 其二
      /(今天|明天|本周|本月)?事情是/g,                              // 今天事情是 / 事情是
      /(?<![一二三四五六七八九十])[一二三四五六七八九十]期/g,    // 一期/二期/三期（产品分期）
      /(?<![一二三四五六七八九十])[一二三四五六七八九十]月[底初]?/g, // 一月底 / 二月初
      /[1-9][\.、)）]\s*/g,                                         // 1. 1、 1)
      /[①②③④⑤⑥⑦⑧⑨⑩]/g,                                       // 圆圈数字
      /(首先|其次|然后|接着|最后|另外|还有|再就是|再有|再一个|另一个|另一方面|一方面|此外|并且|与此同时)/g,
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
        // 紧急标签
        let tag = '';
        if (/紧急|马上|立刻|赶紧/.test(t)) tag = ' [紧急]';
        else if (/优先|重点|要紧/.test(t)) tag = ' [优先]';
        // 时间识别（更全：明天上午十点 / 周五 / 月底）
        const timeMatch = t.match(/(今天|明天|后天|周[一二三四五六日天]|[0-9]+月[0-9]+[日号]?|[上下]午[一二三四五六七八九十0-9]+点(半|十?[一二三四五]?分)?|[一二三四五六七八九十0-9]+点(半|十?[一二三四五]?分)?|[0-9]+:[0-9]+|周.之前|月底|本周|下周三?|下周.|下个月)/);
        if (timeMatch) {
          const action = t.replace(timeMatch[0], '').replace(/紧急|马上|立刻|赶紧|优先|重点|要紧/g, '').replace(/[，,]+/g, '').trim();
          return `- [ ] ${action} (截止: ${timeMatch[0]})${tag}`;
        }
        const action = t.replace(/紧急|马上|立刻|赶紧|优先|重点|要紧/g, '').trim();
        return `- [ ] ${action}${tag}`;
      }).join('\n');
    }

    // ===== 新增模式的 mock 实现（粗略版本，主要给静态部署兜底，真效果靠 LLM）=====
    if (mode === 'meeting') {
      const sig = detectThemeSignal(cleaned);
      const segs = splitSegments(cleaned);
      const topic = sig.theme || extractTopic(cleaned, segs) || '会议纪要';
      const issues = [], decisions = [], todos = [], risks = [];
      segs.forEach(s => {
        const t = s.replace(/^[，,。；;]+|[，,。；;]+$/g, '').trim();
        if (!t) return;
        if (/(决议|决定|结论|定了|敲定|确定下来)/.test(t)) decisions.push(t);
        else if (/(风险|疑虑|担心|不确定|存疑|可能有问题)/.test(t)) risks.push(t);
        else if (/(我负责|你负责|.负责|要做|需要|完成|提交|出结论|交付|发给)/.test(t)) todos.push(t);
        else issues.push(t);
      });
      const lines = [topic, ''];
      if (issues.length) {
        lines.push('议题');
        issues.forEach((it, i) => lines.push(`${i + 1}. ${it}`));
        lines.push('');
      }
      if (decisions.length) {
        lines.push('决议');
        decisions.forEach(d => lines.push('- ' + d));
        lines.push('');
      }
      if (todos.length) {
        lines.push('待办');
        todos.forEach(d => lines.push('- [ ] ' + d));
        lines.push('');
      }
      if (risks.length) {
        lines.push('风险 / 待跟进');
        risks.forEach(d => lines.push('- ' + d));
      }
      return lines.join('\n').trim();
    }

    if (mode === 'diary') {
      // 自然段：用句号/问号/感叹分段，每 2-3 句合一段
      const sentences = cleaned.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
      if (sentences.length <= 2) return sentences.join('') || cleaned;
      const paras = [];
      const chunkSize = sentences.length >= 6 ? 3 : 2;
      for (let i = 0; i < sentences.length; i += chunkSize) {
        paras.push(sentences.slice(i, i + chunkSize).join(''));
      }
      return paras.join('\n\n');
    }

    if (mode === 'translate') {
      // mock 没法真翻译，只做"剥离指令 + 提示需要真模型"
      const stripped = cleaned
        .replace(/翻译(成|为|到)?(英文|中文|日文|日语|英语|韩语|法语|德语|西班牙文)?/g, '')
        .replace(/translate\s+(this\s+)?(to\s+\w+)?/gi, '')
        .replace(/双语对照?|双语/g, '')
        .trim();
      return `[mock 无法真翻译，请在「⚙️ 设置」配置真模型 LLM]\n\n原文：${stripped || cleaned}`;
    }

    if (mode === 'prompt') {
      // 把口述需求拆成 角色/任务/输入/输出 四块
      return `角色 / Role\n[mock 占位] 资深助理\n\n任务 / Task\n${cleaned.slice(0, 80)}\n\n输入 / Input\n[用户提供的原始内容]\n\n输出要求 / Output\n- 格式：[待补充]\n- 风格：[待补充]\n- 限制：[待补充]\n\n[mock 模式下结构占位，真效果请配置 LLM]`;
    }

    if (mode === 'list') {
      // 优先用"是 X"锚点
      const shi = splitByShiAnchor(cleaned);
      let items = [];
      let theme = null;
      if (shi && shi.length >= 2) {
        items = shi;
        const sig = detectThemeSignal(cleaned + ' ' + (shi.__preface || ''));
        theme = sig.theme;
      } else {
        // 按顿号 / 逗号切
        items = cleaned.split(/[，,、]/).map(s => s.trim()).filter(s => s && s.length >= 1);
        const sig = detectThemeSignal(cleaned);
        theme = sig.theme;
        // 移除可能的引导句作为主题
        if (!theme && items.length >= 2 && /(想买|要买|要带|出差|今年|清单|书单)/.test(items[0])) {
          theme = items.shift();
        }
      }
      const lines = [];
      if (theme) { lines.push(theme); lines.push(''); }
      items.forEach(it => {
        const cleanedItem = it
          .replace(/^(我?(想|要)?(买|带|有|要))/, '')
          .replace(/^(的|了|啊|呢|嗯)+/, '')
          .replace(/(帮我|麻烦你?|拜托)$/, '')
          .trim();
        if (cleanedItem) lines.push('- ' + cleanedItem);
      });
      return lines.join('\n').trim();
    }

    if (mode === 'long') {
      // 长文：按句号切，每 4-5 句一段，第一行做标题
      const sentences = cleaned.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
      if (sentences.length === 0) return cleaned;
      // 标题：第一句去掉口语化前缀，截短
      let title = sentences[0]
        .replace(/^(我想|我来|今天我想|今天)/, '')
        .replace(/[。！？!?]$/, '')
        .trim();
      if (title.length > 25) title = title.slice(0, 25);
      const body = sentences.slice(1).length > 0 ? sentences.slice(1) : sentences;
      const paras = [];
      const chunkSize = 4;
      for (let i = 0; i < body.length; i += chunkSize) {
        paras.push(body.slice(i, i + chunkSize).join(''));
      }
      return [title, '', paras.join('\n\n')].join('\n');
    }

    // auto 模式路由（v2：支持新增的 meeting / diary / translate / prompt / list / long）
    let chosen = 'note';
    const sig = detectThemeSignal(cleaned);
    const hasShi = !!splitByShiAnchor(cleaned);
    const hasMultiPhase = /(一期|二期|三期).*?(二期|三期|四期)/.test(cleaned)
                       || /(首先|其次|然后|最后).*?(其次|然后|接着|最后|另外)/.test(cleaned);
    const todoSignal = /提醒|记得|别忘|要做|得做|周.之前|截止|安排/.test(cleaned);
    const emailSignal = /(发邮件|抄送|邮件给|回复邮件|email|回.*邮件|邮件告诉)/i.test(cleaned);
    const meetingSignal = /(会议|开会|评审|这次会|今天会上|跟.+开了|跟.+对了|复盘|review|sync)/i.test(cleaned);
    const diarySignal = /(今天的感觉|今天感觉|有点累|挺爽|心情|状态不太好|反思一下|复盘一下|我觉得这周)/.test(cleaned);
    const translateSignal = /(翻译|translate|改成英文|改成中文|改成日文)/i.test(cleaned);
    const promptSignal = /(写个prompt|写个提示词|让\s*ai|prompt模板)/i.test(cleaned);
    const listShop = /(想买|要买|买几样|买点|出差.+带|今年.+读|书单|清单)/.test(cleaned);
    const isLong = cleaned.length > 200;

    if (translateSignal) {
      chosen = 'translate';
    } else if (promptSignal) {
      chosen = 'prompt';
    } else if (emailSignal) {
      chosen = 'email';
    } else if (meetingSignal && (hasMultiPhase || (sig.theme && cleaned.length > 80))) {
      chosen = 'meeting';
    } else if (diarySignal) {
      chosen = 'diary';
    } else if (listShop && hasShi) {
      chosen = 'list';
    } else if (todoSignal && cleaned.length <= 40 && !hasMultiPhase && !sig.theme) {
      chosen = 'todo';
    } else if (isLong && !hasShi) {
      chosen = 'long';
    } else if (sig.theme || hasShi || hasMultiPhase) {
      chosen = 'note';
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
