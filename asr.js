// =====================================================================
// 元宝胶囊 - ASR 层
// ---------------------------------------------------------------------
// 优先使用浏览器原生 Web Speech API（Chrome/Edge/Safari 桌面均支持中文）
// 拿到的就是文本，不用走音频上传，演示成本最低。
// 如果浏览器不支持，回退到"模拟语音"——按下按钮后给一段示例文本。
// =====================================================================

const ASR = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let isListening = false;
  let onPartialCb = null;
  let onFinalCb = null;
  let onErrorCb = null;
  let finalBuffer = '';

  function isSupported() {
    return !!SR;
  }

  function init() {
    if (!SR) return false;
    recognition = new SR();
    const lang = (window.CAPSULE_PROMPTS.config && window.CAPSULE_PROMPTS.config.asr && window.CAPSULE_PROMPTS.config.asr.lang) || 'zh-CN';
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          finalBuffer += r[0].transcript;
        } else {
          interim += r[0].transcript;
        }
      }
      if (onPartialCb) onPartialCb(finalBuffer + interim);
    };

    recognition.onerror = (e) => {
      const code = e.error || 'unknown';
      // 把错误码翻译成人话
      const map = {
        'network': '网络错误：Chrome/Edge 的语音识别需联 Google 服务，国内可能不通。建议改用 Safari，或挂代理后重试，或使用下方「直接输入」兜底。',
        'not-allowed': '麦克风权限被拒。请在浏览器地址栏左侧点🔒图标 → 允许麦克风 → 刷新页面。',
        'service-not-allowed': '当前浏览器/系统禁用了语音服务。建议改用 Safari，或检查系统设置 → 隐私 → 麦克风。',
        'no-speech': '没听到声音。请检查麦克风是否在工作，靠近一点再试。',
        'audio-capture': '无法获取麦克风。请检查是否被其他应用占用。',
        'aborted': '识别被中断（一般是手动停止）。',
        'language-not-supported': '当前语言不被支持。',
      };
      const friendly = map[code] || ('未知错误：' + code);
      if (onErrorCb) onErrorCb(friendly + ' [code=' + code + ']');
    };

    recognition.onend = () => {
      isListening = false;
      if (onFinalCb) onFinalCb(finalBuffer.trim());
    };

    return true;
  }

  function start({ onPartial, onFinal, onError }) {
    if (!recognition && !init()) {
      // fallback：模拟模式
      isListening = true;
      onPartialCb = onPartial;
      onFinalCb = onFinal;
      onErrorCb = onError;
      finalBuffer = '';
      // 模拟逐字输出
      const demo = '那个我跟你说一下啊今天那个会改到三点了你那边来得及吗';
      let i = 0;
      const ti = setInterval(() => {
        if (!isListening) { clearInterval(ti); return; }
        i += 2;
        const cur = demo.slice(0, i);
        if (onPartial) onPartial(cur);
        if (i >= demo.length) {
          clearInterval(ti);
          // 等用户手动停止
        }
      }, 80);
      window.__mockTimer = ti;
      return true;
    }
    onPartialCb = onPartial;
    onFinalCb = onFinal;
    onErrorCb = onError;
    finalBuffer = '';
    try {
      recognition.start();
      isListening = true;
      return true;
    } catch (e) {
      if (onError) onError(e.message);
      return false;
    }
  }

  function stop() {
    if (window.__mockTimer) {
      clearInterval(window.__mockTimer);
      window.__mockTimer = null;
    }
    if (recognition && isListening) {
      try { recognition.stop(); } catch (_) {}
    } else if (isListening) {
      // mock 路径：手动触发 final
      isListening = false;
      const demo = '那个我跟你说一下啊今天那个会改到三点了你那边来得及吗';
      finalBuffer = demo;
      if (onFinalCb) onFinalCb(demo);
    }
  }

  function getStatus() {
    return { supported: isSupported(), listening: isListening };
  }

  return { start, stop, isSupported, getStatus };
})();
