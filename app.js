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

  // 整理模式：固定 auto，由 LLM/mock 自动判断意图
  const FIXED_MODE = 'auto';

  let isRecording = false;

  // ===== 启动检查 =====
  function refreshAsrHint() {
    const engine = ASR_ROUTER.getEngine();
    if (engine === 'whisper') {
      const status = ASR_WHISPER.getStatus();
      if (!ASR_WHISPER.isSupported()) {
        asrHint.innerHTML = '⚠️ 当前浏览器不支持 MediaRecorder，无法用 Whisper 引擎。已自动回退 Web Speech。';
        asrHint.classList.add('warn');
        ASR_ROUTER.setEngine('webspeech');
        return refreshAsrHint();
      }
      if (status.modelLoaded) {
        asrHint.innerHTML = '✓ Whisper-base 已就绪（开源模型，本地推理，离线可用）。';
        asrHint.classList.remove('warn');
      } else {
        asrHint.innerHTML = '🧠 已切到 <b>Whisper-base</b>（开源模型）。首次录音会下载约 145MB 模型，下载后缓存到本地，下次秒开。可点击「⚙️ 设置」中的「预加载模型」按钮提前下载。';
        asrHint.classList.remove('warn');
      }
    } else {
      if (!ASR.isSupported()) {
        asrHint.textContent = '⚠️ 当前浏览器不支持原生语音识别，建议在「⚙️ 设置」切换到 Whisper 引擎，或用「模拟语音」演示。';
        asrHint.classList.add('warn');
      } else {
        const isChrome = /Chrome/.test(navigator.userAgent) && !/Safari\/[0-9.]+ Version/.test(navigator.userAgent);
        if (isChrome) {
          asrHint.innerHTML = '✓ Web Speech 已就绪。<b>提示：</b>Chrome 国内可能报 network 错误，可在「⚙️ 设置」切到 <b>Whisper</b> 离线引擎，或改用 <b>Safari</b>。';
        } else {
          asrHint.textContent = '✓ Web Speech 已就绪。点击麦克风或按 空格键 开始/停止录音。';
        }
        asrHint.classList.remove('warn');
      }
    }
  }
  refreshAsrHint();

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
    ASR_ROUTER.start({
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
      onProgress: (info) => {
        // Whisper 模型下载进度
        if (info && info.status === 'progress') {
          const pct = info.progress != null ? Math.round(info.progress) : 0;
          const file = info.file || '';
          statusText.textContent = `📥 下载模型 ${file} ${pct}%`;
        } else if (info && info.status === 'done') {
          statusText.textContent = '🧠 模型就绪，准备识别…';
        }
      },
    });
  }

  function stopRecord() {
    if (!isRecording) return;
    statusText.textContent = '⏳ 处理中…';
    micBtn.classList.remove('recording');
    micBtn.classList.add('processing');
    ASR_ROUTER.stop();
    isRecording = false;
  }

  function toggleRecord() {
    if (isRecording) stopRecord();
    else startRecord();
  }

  // ===== 处理文本 =====
  async function processText(rawText) {
    try {
      const { text, provider, notice } = await LLM.complete(rawText, FIXED_MODE);
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
    // ASR 引擎
    $('cfg-asr-engine').value = ASR_ROUTER.getEngine();
    // Whisper 状态
    const ws = ASR_WHISPER.getStatus();
    const statusEl = $('whisper-preload-status');
    if (ws.modelLoaded) statusEl.textContent = '✓ 模型已就绪';
    else if (ws.modelLoading) statusEl.textContent = '⏳ 下载中…';
    else statusEl.textContent = '未下载';
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
    // 保存 ASR 引擎
    const newEngine = $('cfg-asr-engine').value;
    const oldEngine = ASR_ROUTER.getEngine();
    ASR_ROUTER.setEngine(newEngine);
    if (newEngine !== oldEngine) refreshAsrHint();
    settingsModal.classList.remove('show');
    const labelMap = {
      auto: '自动（服务器代理优先）',
      byok: '自带 Key 直连',
      mock: 'Mock 本地模拟',
    };
    showToast(`已保存：${labelMap[cfg.provider] || cfg.provider} · ASR=${newEngine}`, 'success');
  });

  // ===== Whisper 预加载按钮 =====
  const whisperPreloadBtn = $('whisper-preload-btn');
  const whisperStatus = $('whisper-preload-status');
  if (whisperPreloadBtn) {
    whisperPreloadBtn.addEventListener('click', async () => {
      whisperPreloadBtn.disabled = true;
      whisperStatus.textContent = '⏳ 准备下载…';
      try {
        await ASR_ROUTER.preloadWhisper((info) => {
          if (info && info.status === 'progress') {
            const pct = info.progress != null ? Math.round(info.progress) : 0;
            const file = info.file || '';
            whisperStatus.textContent = `📥 ${file} ${pct}%`;
          } else if (info && info.status === 'ready') {
            whisperStatus.textContent = '✓ 模型已就绪';
          }
        });
        whisperStatus.textContent = '✓ 模型已就绪（已缓存到本地）';
        showToast('Whisper-base 模型加载完成', 'success');
        refreshAsrHint();
      } catch (e) {
        whisperStatus.textContent = '✗ 加载失败：' + (e.message || e);
        showToast('Whisper 模型加载失败：' + (e.message || e), 'error');
      } finally {
        whisperPreloadBtn.disabled = false;
      }
    });
  }

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
})();
