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
  let asrReady = false;

  // ===== 自动加载 Whisper 模型（无需用户操作）=====
  const bootLoader = $('boot-loader');
  const bootBarFill = $('boot-bar-fill');
  const bootMeta = $('boot-meta');

  function setBoot(percent, label) {
    if (bootBarFill) bootBarFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (bootMeta) bootMeta.textContent = label;
  }

  function hideBoot() {
    if (bootLoader) bootLoader.classList.add('hide');
  }

  function showBootError(msg) {
    if (!bootLoader) return;
    bootLoader.classList.add('error');
    setBoot(0, '✗ ' + msg);
    const tip = bootLoader.querySelector('.boot-tip');
    if (tip) {
      tip.innerHTML = '加载失败。可点击 <a href="javascript:void(0)" id="boot-retry">重试</a>，或刷新页面。';
      const retry = $('boot-retry');
      if (retry) retry.addEventListener('click', () => {
        bootLoader.classList.remove('error');
        bootLoader.querySelector('.boot-tip').innerHTML = '首次访问需下载约 145MB，缓存到本地（IndexedDB），下次秒开。<br/>加载完成后即可使用麦克风录音。';
        autoBootWhisper();
      });
    }
  }

  // 维护进度展示：transformers.js 会对每个文件回调 status=progress {file, progress, loaded, total}
  // 我们把所有正在下载的文件聚合成总进度
  const fileProgress = {}; // file -> { loaded, total }
  function handleProgress(info) {
    if (!info) return;
    if (info.status === 'progress' && info.file) {
      fileProgress[info.file] = {
        loaded: info.loaded || 0,
        total: info.total || 0,
        progress: info.progress || 0,
      };
      let totalLoaded = 0;
      let totalSize = 0;
      Object.values(fileProgress).forEach(f => {
        totalLoaded += f.loaded || 0;
        totalSize += f.total || 0;
      });
      const pct = totalSize > 0 ? (totalLoaded / totalSize) * 100 : 0;
      const mb = (b) => (b / (1024 * 1024)).toFixed(1);
      setBoot(pct, `📥 ${mb(totalLoaded)}MB / ${mb(totalSize)}MB · ${Math.round(pct)}%`);
    } else if (info.status === 'ready' || info.status === 'done') {
      setBoot(100, '✓ 模型就绪');
    } else if (info.status === 'initiate' && info.file) {
      setBoot(0, `准备下载 ${info.file}…`);
    } else if (info.status === 'download' && info.file) {
      setBoot(0, `开始下载 ${info.file}…`);
    }
  }

  async function autoBootWhisper() {
    statusText.textContent = '⏳ 正在加载语音引擎，加载完后即可录音…';
    setBoot(0, '准备中…');
    try {
      // 强制走 whisper 引擎
      ASR_ROUTER.setEngine('whisper');
      if (!ASR_WHISPER.isSupported()) {
        // MediaRecorder 不支持 → 降级 webspeech
        ASR_ROUTER.setEngine('webspeech');
        hideBoot();
        asrReady = true;
        micBtn.disabled = false;
        statusText.textContent = '⚠️ 当前浏览器不支持 MediaRecorder，已自动降级到 Web Speech';
        return;
      }
      await ASR_WHISPER.loadModel(handleProgress);
      asrReady = true;
      micBtn.disabled = false;
      setBoot(100, '✓ 模型已就绪（已缓存到本地，下次秒开）');
      statusText.textContent = '💊 闲置中，点击麦克风开始';
      // 1.2 秒后淡出 boot loader
      setTimeout(() => hideBoot(), 1200);
    } catch (e) {
      console.error('[boot] whisper 加载失败', e);
      const msg = (e && e.message) || String(e);
      showBootError('模型下载失败：' + msg);
      statusText.textContent = '⚠️ 模型加载失败，可在 boot 卡片点重试或刷新';
    }
  }
  // 页面起来就自动加载
  autoBootWhisper();

  // ===== 启动检查（仅 webspeech 兜底场景需要展示提示）=====
  function refreshAsrHint() {
    // 默认隐藏：模型加载完已就绪，不需要额外提示
    asrHint.style.display = 'none';
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
    if (!asrReady) {
      showToast('语音引擎正在加载中，请稍候…', 'warn');
      return;
    }
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
})();
