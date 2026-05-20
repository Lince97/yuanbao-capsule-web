// =====================================================================
// 元宝胶囊 - 主交互
// =====================================================================

(() => {
  const $ = (id) => document.getElementById(id);

  // DOM
  const micBtn = $('mic-btn');
  const statusText = $('status-text');
  const partialBox = $('partial-text');
  const rawBox = $('raw-text');
  const resultBox = $('result-text');
  const modeSel = $('mode-select');
  const copyBtn = $('copy-btn');
  const reprocessBtn = $('reprocess-btn');
  const clearBtn = $('clear-btn');
  const settingsBtn = $('settings-btn');
  const settingsModal = $('settings-modal');
  const settingsClose = $('settings-close');
  const settingsSave = $('settings-save');
  const promptModal = $('prompt-modal');
  const promptBtn = $('prompt-btn');
  const promptClose = $('prompt-close');
  const promptContent = $('prompt-content');
  const toast = $('toast');
  const asrHint = $('asr-hint');

  let isRecording = false;

  // ===== 启动检查 =====
  if (!ASR.isSupported()) {
    asrHint.textContent = '⚠️ 当前浏览器不支持原生语音识别，已自动启用「模拟语音」演示模式。建议使用最新版 Chrome/Edge/Safari。';
    asrHint.classList.add('warn');
  } else {
    const isChrome = /Chrome/.test(navigator.userAgent) && !/Safari\/[0-9.]+ Version/.test(navigator.userAgent);
    if (isChrome) {
      asrHint.innerHTML = '✓ 已就绪。<b>提示：</b>Chrome 的语音识别需联 Google 服务，国内可能报 network 错误，建议改用 <b>Safari</b>。';
    } else {
      asrHint.textContent = '✓ 已就绪。点击麦克风或按 空格键 开始/停止录音。';
    }
  }

  // ===== Toast =====
  function showToast(msg, type = 'info') {
    toast.textContent = msg;
    toast.className = 'toast show ' + type;
    setTimeout(() => { toast.className = 'toast'; }, 1800);
  }

  // ===== 录音控制 =====
  function startRecord() {
    if (isRecording) return;
    isRecording = true;
    partialBox.textContent = '';
    rawBox.value = '';
    micBtn.classList.add('recording');
    statusText.textContent = '🔴 录音中…';
    ASR.start({
      onPartial: (txt) => {
        partialBox.textContent = txt;
      },
      onFinal: async (txt) => {
        rawBox.value = txt;
        if (txt && txt.trim()) {
          await processText(txt);
        } else {
          statusText.textContent = '💊 没有听到内容，再试一次。';
          micBtn.classList.remove('recording');
          isRecording = false;
        }
      },
      onError: (err) => {
        showToast('语音识别错误：' + err, 'error');
        statusText.textContent = '⚠️ ' + err;
        micBtn.classList.remove('recording');
        isRecording = false;
      },
    });
  }

  function stopRecord() {
    if (!isRecording) return;
    statusText.textContent = '⏳ 处理中…';
    micBtn.classList.remove('recording');
    micBtn.classList.add('processing');
    ASR.stop();
    isRecording = false;
  }

  function toggleRecord() {
    if (isRecording) stopRecord();
    else startRecord();
  }

  // ===== 处理文本 =====
  async function processText(rawText) {
    const mode = modeSel.value;
    try {
      const { text, provider, notice } = await LLM.complete(rawText, mode);
      resultBox.value = text;
      const tagMap = {
        mock: '（mock · 本地规则）',
        server: '（真模型 · 服务器代理）',
        byok: '（真模型 · 你自己的 Key）',
      };
      const tag = tagMap[provider] || `（${provider}）`;
      statusText.textContent = `✓ 完成 ${tag}`;
      if (notice) showToast(notice, 'warn');
    } catch (e) {
      showToast('LLM 调用失败：' + e.message, 'error');
      statusText.textContent = '⚠️ LLM 失败，已保留原文';
      resultBox.value = rawText;
    } finally {
      micBtn.classList.remove('processing');
    }
  }

  // ===== 按钮事件 =====
  micBtn.addEventListener('click', toggleRecord);

  copyBtn.addEventListener('click', async () => {
    const text = resultBox.value;
    if (!text) {
      showToast('没有内容可复制', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制到剪贴板 ✓', 'success');
    } catch (e) {
      // 兜底
      resultBox.select();
      document.execCommand('copy');
      showToast('已复制（兼容模式）', 'success');
    }
  });

  reprocessBtn.addEventListener('click', async () => {
    const raw = rawBox.value.trim();
    if (!raw) {
      showToast('原始文本为空', 'warn');
      return;
    }
    statusText.textContent = '⏳ 重新处理…';
    await processText(raw);
  });

  clearBtn.addEventListener('click', () => {
    partialBox.textContent = '';
    rawBox.value = '';
    resultBox.value = '';
    statusText.textContent = '💊 已清空';
  });

  modeSel.addEventListener('change', () => {
    updateModeDesc();
    const raw = rawBox.value.trim();
    if (raw) {
      statusText.textContent = '⏳ 模式切换，重新整理…';
      processText(raw);
    }
  });

  // 模式说明
  const MODE_DESC = {
    msg: '💬 一段话，去口癖、加标点，自然口吻。适合发微信/钉钉。',
    note: '📝 结构化提纲，自动提取主题 + 要点列表 + 待办分组。适合开会记录、灵感整理。',
    email: '📧 主题 + 称呼 + 编号正文 + 落款，邮件骨架直接发。',
    todo: '✅ 拆成独立任务清单，自动识别时间作为截止日。',
    auto: '💊 自动判断意图，归到上述四类之一。',
  };
  function updateModeDesc() {
    const desc = MODE_DESC[modeSel.value] || '';
    $('mode-desc').innerHTML = `<b>${desc}</b><br><span style="color:var(--text-mute)">规则在 <code>prompts.js</code>，改完刷新即生效。</span>`;
  }

  // ===== 兜底：模拟一段语音 =====
  $('mock-btn').addEventListener('click', async () => {
    const samples = [
      '那个我跟你说一下啊，今天那个会改到三点了，你那边来得及吗',
      '提醒我明天上午十点开会，然后下午三点要把PRD发给Benson，周五之前给鸡哥准备一下ASR的对比材料',
      '今天跟Liya聊了一下元宝胶囊的方向，她说一期可以先做结构化和翻译，二期加轻问答和通话，三期再说生态联动',
      '跟老板说一下下周的方案我准备做三个版本周五前给到他需要他帮忙拉一下设计资源',
    ];
    const pick = samples[Math.floor(Math.random() * samples.length)];
    rawBox.value = pick;
    partialBox.textContent = pick;
    statusText.textContent = '⏳ 模拟语音输入，整理中…';
    await processText(pick);
  });

  // ===== 兜底：直接文本输入 =====
  $('text-btn').addEventListener('click', () => {
    rawBox.focus();
    rawBox.placeholder = '在这里输入一段口语化的话，然后点右上角「重新整理」';
    showToast('直接在「原始转写」框输入文字 → 重新整理', 'info');
    rawBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ===== 快捷键：空格键长按/单击触发 =====
  let spaceDown = false;
  document.addEventListener('keydown', (e) => {
    // 编辑框里不响应
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return;
    if (e.code === 'Space' && !spaceDown) {
      e.preventDefault();
      spaceDown = true;
      toggleRecord();
    }
    if (e.code === 'Escape' && isRecording) {
      e.preventDefault();
      stopRecord();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceDown = false;
  });

  // ===== 设置弹窗 =====
  function openSettings() {
    const cfg = LLM.getConfig();
    // 兼容老配置：openai → byok
    const provider = cfg.provider === 'openai' ? 'byok' : (cfg.provider || 'auto');
    $('cfg-provider').value = provider;
    $('cfg-base-url').value = cfg.base_url || '';
    $('cfg-api-key').value = cfg.api_key || '';
    $('cfg-model').value = cfg.model || '';
    settingsModal.classList.add('show');
  }
  settingsBtn.addEventListener('click', openSettings);
  settingsClose.addEventListener('click', () => settingsModal.classList.remove('show'));
  settingsSave.addEventListener('click', () => {
    const cfg = {
      provider: $('cfg-provider').value,
      base_url: $('cfg-base-url').value.trim(),
      api_key: $('cfg-api-key').value.trim(),
      model: $('cfg-model').value.trim(),
    };
    LLM.saveConfig(cfg);
    settingsModal.classList.remove('show');
    const labelMap = {
      auto: '自动（服务器代理优先）',
      byok: '自带 Key 直连',
      mock: 'Mock 本地模拟',
    };
    showToast(`已保存：${labelMap[cfg.provider] || cfg.provider}`, 'success');
  });

  // ===== 公网分享横幅关闭（记忆 24h）=====
  const BANNER_KEY = 'capsule_banner_dismissed_at';
  const banner = $('welcome-banner');
  const bannerClose = $('banner-close');
  if (banner && bannerClose) {
    const last = parseInt(localStorage.getItem(BANNER_KEY) || '0', 10);
    if (last && Date.now() - last < 24 * 3600 * 1000) {
      banner.classList.add('hide');
    }
    bannerClose.addEventListener('click', () => {
      banner.classList.add('hide');
      localStorage.setItem(BANNER_KEY, String(Date.now()));
    });
  }

  // ===== Prompt 查看 =====
  promptBtn.addEventListener('click', () => {
    const last = window.__lastPrompt;
    if (!last) {
      promptContent.textContent = '（还没有调用过 LLM，先录一段试试）';
    } else {
      const lines = [];
      lines.push(`时间：${last.time}`);
      lines.push(`模式：${last.mode}`);
      lines.push(`Provider：${last.provider}`);
      lines.push('---');
      last.messages.forEach((m, i) => {
        lines.push(`【${i}】[${m.role}]`);
        lines.push(m.content);
        lines.push('');
      });
      promptContent.textContent = lines.join('\n');
    }
    promptModal.classList.add('show');
  });
  promptClose.addEventListener('click', () => promptModal.classList.remove('show'));

  // 弹窗外点击关闭
  [settingsModal, promptModal].forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('show');
    });
  });

  // ===== 模式列表初始化 =====
  Object.entries(window.CAPSULE_PROMPTS.modes).forEach(([key, m]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${m.icon} ${m.label}`;
    modeSel.appendChild(opt);
  });
  modeSel.value = 'note';  // 默认结构化笔记，效果最明显
  updateModeDesc();
})();
