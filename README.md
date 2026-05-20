# 元宝胶囊 · Web Demo（公网分享版）

语音输入 → 结构化整理 Web Demo。本目录是"可直接 deploy 到 Vercel 拿到公网链接"的状态。

## 一句话特性

- 🎙️ **语音按钮 + 快捷键**：点麦克风或按 `空格` 开始/停止
- 📝 **录音转结构化**：5 种模式（聊天/笔记/邮件/任务/自动判断），转写完自动整理
- ✏️ **可编辑可复制**：原始转写 + 整理结果都是输入框，直接改、一键复制
- 🛠️ **PE 单独维护**：所有 Prompt 在 `prompts.js`，改完刷新即生效
- 🌐 **三层 LLM 兜底**：服务器代理（默认）→ 访客自带 Key（可选）→ Mock 本地模拟（永远兜底）

## 部署到 Vercel（推荐）

```bash
# 一次性
npm i -g vercel
vercel login

# 在本目录
cd yuanbao_capsule_web
vercel        # 第一次 deploy，跟着 prompt 走，全选默认即可
vercel --prod # 推到生产，拿到 *.vercel.app 公网链接
```

第一次 `vercel` 时它会问：
- Set up and deploy? → **Y**
- Which scope? → 选你自己
- Link to existing project? → **N**
- Project name? → 默认 `yuanbao-capsule-web` 即可
- In which directory is your code located? → **`./`**（直接回车）
- Override settings? → **N**

完成后会给你一个 `https://yuanbao-capsule-web-xxx.vercel.app` 链接。

## 配置 LLM（可选，让访客无需自带 key 就能体验真模型）

Vercel Dashboard → 你的项目 → **Settings → Environment Variables**：

| Key | 示例值 |
|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | `sk-...` |
| `LLM_MODEL` | `deepseek-chat` |
| `RATE_LIMIT_PER_MIN`（可选） | `30`（每个 IP 每分钟最多 30 次） |
| `LLM_TIMEOUT_MS`（可选） | `15000` |

加完点 **Redeploy**。

> 💡 不配也能跑：访客打开链接 → 默认走 mock 演示；如果想看真模型效果，访客可在「设置」里填自己的 base_url+key+model（直连，不消耗你的额度）。

## ASR 兼容性提醒

浏览器原生 Web Speech API：
- ✅ **Mac/iOS Safari**：走苹果本地引擎，国内能用
- ⚠️ **Chrome/Edge**：走 Google 服务，国内会报 `network` 错误
- ❌ **Firefox**：不支持

页面顶部有横幅提示访客优先用 Safari。Chrome 用户可以点「🎭 模拟一段语音」体验整理效果，绕开 ASR。

## 本地预览

```bash
# 任一 HTTP server 都行
python3 -m http.server 8000
# 或用 vercel dev 跑（顺带把 /api 也跑起来）
vercel dev
```

> 注意：直接 `file://` 打开 `index.html` 时，麦克风权限 + `/api/chat` 都会失效，建议起一个 HTTP server。

## 文件结构

```
yuanbao_capsule_web/
├── index.html           # 入口
├── style.css            # 暗色主题
├── prompts.js           # ★ PE 工作台：system / 5 mode / few-shot / 配置
├── llm.js               # LLM 调用层（auto/byok/mock 三档）
├── asr.js               # Web Speech API 封装 + 模拟回退
├── app.js               # 主交互
├── api/
│   └── chat.js          # ★ Vercel Serverless 代理：把请求转到真 LLM
├── package.json
├── vercel.json          # 安全 headers + Serverless 配置
└── README.md
```

## 三层 LLM 调用逻辑

```
访客点麦克风 → ASR 拿到文本 → LLM.complete()
                                    │
            ┌───────────────────────┼────────────────────────┐
            ▼                       ▼                        ▼
       provider=mock          provider=byok              provider=auto（默认）
       本地规则模拟         访客自己的 base_url+key       POST /api/chat
                                                              │
                                                       ┌──────┴──────┐
                                                       ▼             ▼
                                                  服务端有配     503 backend_not_configured
                                                  → 真模型         → 自动降级 mock + 提示访客
```

## 演示动线（90 秒）

1. 打开公网链接 → 顶部横幅说明 demo 用法
2. 点麦克风（或空格）→ 念一段口语化的话
3. 说完按空格 → 自动整理为结构化输出
4. 切换「整理模式」下拉 → 同一段原文换风格再整理
5. 点「📜 Prompt」→ 看真实发出的 Prompt
6. 改 `prompts.js` 某条规则 → `vercel --prod` → 同一段话出不同结果

## 安全说明

- 服务端 key 只存在 Vercel 环境变量，**前端代码里没有 key**
- 访客自带 key 模式：key 只存在访客自己的浏览器 localStorage，不会上传
- `/api/chat` 默认每 IP 30 次/分钟限流，可改 `RATE_LIMIT_PER_MIN`
- `vercel.json` 里设置了 `microphone=(self)` 权限策略和基础安全 headers
