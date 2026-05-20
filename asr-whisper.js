// =====================================================================
// 元宝胶囊 - ASR Whisper 引擎（开源模型，浏览器端推理）
// ---------------------------------------------------------------------
// 模型：Xenova/whisper-base（量化 onnx，约 145MB）
// 推理：transformers.js v3，自动选择 WebGPU / WASM
// 模型缓存：浏览器 IndexedDB，首次下载后离线可用
// 适用场景：国内 Chrome 用 Web Speech 报 network 时切到这里
// =====================================================================

const ASR_WHISPER = (() => {
  // transformers.js 通过 ESM 引入；用 dynamic import 懒加载（仅在用户切到 whisper 时下载）
  // 用 esm.sh 自动转 ESM，避免 jsdelivr 默认 UMD 构建在浏览器 import 报错
  const TRANSFORMERS_CDN = 'https://esm.sh/@huggingface/transformers@3.0.2';
  const MODEL_ID = 'Xenova/whisper-base';

  let pipelinePromise = null;
  let pipelineInst = null;
  let mediaStream = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let audioContext = null;
  let isListening = false;
  let isLoading = false;

  let onPartialCb = null;
  let onFinalCb = null;
  let onErrorCb = null;
  let onProgressCb = null;

  function isSupported() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function getStatus() {
    return {
      supported: isSupported(),
      listening: isListening,
      modelLoaded: !!pipelineInst,
      modelLoading: isLoading,
    };
  }

  // 加载模型（幂等）
  async function loadModel(onProgress) {
    if (pipelineInst) return pipelineInst;
    if (pipelinePromise) return pipelinePromise;
    isLoading = true;
    pipelinePromise = (async () => {
      try {
        const mod = await import(TRANSFORMERS_CDN);
        const { pipeline, env } = mod;
        // 关闭本地模型查找，只走 HF CDN
        env.allowLocalModels = false;
        // 使用 IndexedDB 缓存（默认行为）
        env.useBrowserCache = true;

        const p = await pipeline('automatic-speech-recognition', MODEL_ID, {
          // 量化版，体积小，速度快
          dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
          device: 'webgpu', // 优先 WebGPU；不支持自动降到 wasm
          progress_callback: (info) => {
            if (onProgress) onProgress(info);
          },
        }).catch(async (err) => {
          // WebGPU 失败时降级到 wasm
          console.warn('[whisper] webgpu 失败，降级 wasm:', err);
          return await pipeline('automatic-speech-recognition', MODEL_ID, {
            dtype: 'q8',
            device: 'wasm',
            progress_callback: (info) => {
              if (onProgress) onProgress(info);
            },
          });
        });

        pipelineInst = p;
        return p;
      } finally {
        isLoading = false;
      }
    })();
    return pipelinePromise;
  }

  // 简单线性插值降采样到 16k
  function resampleTo16k(samples, fromRate) {
    if (fromRate === 16000) return samples;
    const ratio = fromRate / 16000;
    const newLength = Math.floor(samples.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const i0 = Math.floor(srcIndex);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      const frac = srcIndex - i0;
      result[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
    }
    return result;
  }

  async function start({ onPartial, onFinal, onError, onProgress }) {
    onPartialCb = onPartial;
    onFinalCb = onFinal;
    onErrorCb = onError;
    onProgressCb = onProgress;

    if (!isSupported()) {
      if (onError) onError('当前浏览器不支持 MediaRecorder，无法使用 Whisper 引擎');
      return false;
    }

    try {
      // 1) 确保模型已加载（首次会下载）
      if (!pipelineInst) {
        if (onPartial) onPartial('⏳ 首次使用：正在下载 Whisper-base 模型（约 145MB，下载后缓存，下次秒开）…');
        await loadModel(onProgress);
        if (onPartial) onPartial('✓ 模型就绪，请开始说话…');
      } else {
        if (onPartial) onPartial('🎙 录音中（Whisper-base · 停止后整体识别）…');
      }

      // 2) 开录
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000 },
      });
      audioChunks = [];
      // 优先用 webm/opus，兼容 mp4
      const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''];
      let mime = '';
      for (const m of mimeCandidates) {
        if (!m || (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m))) {
          mime = m; break;
        }
      }
      mediaRecorder = mime
        ? new MediaRecorder(mediaStream, { mimeType: mime })
        : new MediaRecorder(mediaStream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        try {
          if (onPartialCb) onPartialCb('🧠 识别中…（Whisper-base 本地推理）');
          const blob = new Blob(audioChunks, { type: mime || 'audio/webm' });
          if (blob.size < 1000) {
            // 太短没声音
            if (onFinalCb) onFinalCb('');
            return;
          }
          const arrayBuffer = await blob.arrayBuffer();
          if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
          }
          const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
          let audio = decoded.getChannelData(0);
          if (decoded.numberOfChannels > 1) {
            // 多声道混单声道
            const ch1 = decoded.getChannelData(1);
            const mixed = new Float32Array(audio.length);
            for (let i = 0; i < audio.length; i++) {
              mixed[i] = (audio[i] + ch1[i]) / 2;
            }
            audio = mixed;
          }
          if (decoded.sampleRate !== 16000) {
            audio = resampleTo16k(audio, decoded.sampleRate);
          }

          const t0 = performance.now();
          const result = await pipelineInst(audio, {
            language: 'chinese',
            task: 'transcribe',
            chunk_length_s: 30,
            stride_length_s: 5,
            return_timestamps: false,
          });
          const ms = Math.round(performance.now() - t0);
          const text = ((result && result.text) || '').trim();
          console.log(`[whisper] 推理 ${ms}ms ->`, text);
          if (onFinalCb) onFinalCb(text);
        } catch (err) {
          console.error('[whisper] 识别失败', err);
          if (onErrorCb) onErrorCb('Whisper 识别失败：' + (err.message || String(err)));
        } finally {
          isListening = false;
          if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
          }
        }
      };
      mediaRecorder.start();
      isListening = true;
      return true;
    } catch (e) {
      console.error('[whisper] start 失败', e);
      const msg = (e && e.message) || String(e);
      let friendly = msg;
      if (/Permission|NotAllowed/i.test(msg)) {
        friendly = '麦克风权限被拒。请允许后重试。';
      } else if (/import|fetch|network/i.test(msg)) {
        friendly = '模型下载失败：' + msg + '（请检查网络，HuggingFace CDN 国内偶尔波动，可重试）';
      }
      if (onError) onError(friendly);
      isListening = false;
      return false;
    }
  }

  function stop() {
    if (mediaRecorder && isListening) {
      try { mediaRecorder.stop(); } catch (_) {}
    } else {
      isListening = false;
    }
  }

  return { start, stop, isSupported, getStatus, loadModel };
})();
