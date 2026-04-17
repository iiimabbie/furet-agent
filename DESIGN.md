# Furet - 個人助手設計文件

## 概述

Furet（法語：雪貂）是一個個人 AI 助手，使用自建 agent loop 直接呼叫 Anthropic Messages API。
介面：CLI + Discord bot，透過 Gateway 常駐程式統一管理。

## 技術選型

| 項目 | 選擇 | 原因 |
|------|------|------|
| 語言 | TypeScript | 強型別，適合 Java 背景 |
| AI 引擎 | 自建 agent loop + Anthropic Messages API | 完全掌控，不依賴任何 SDK |
| API 路由 | router-for.me (localhost:8317) | base_url 指向 local router |
| 網路搜尋 | Anthropic server-side web_search | `web_search_20250305`，不用自己接第三方 |
| 網頁讀取 | Anthropic server-side web_fetch | `web_fetch_20250910`，讀取指定 URL 內容 |
| 程式執行 | Anthropic server-side code_execution | `code_execution_20250825`，Python 計算與資料分析 |
| Discord | discord.js | 社群最大、文件最齊 |
| 排程 | node-cron | 輕量，cron 語法 |
| 執行環境 | Docker | 不在本機裝東西 |

## 架構

```
使用者輸入（CLI / Discord）
    │
    ▼
Agent (agent.ts) ── Anthropic Messages API ──► router (localhost:8317) ──► 上游
    │
    ├── System Prompt = prompt.ts（SYSTEM_INSTRUCTIONS + 日期時間 + FURET.md + MEMORY.md）
    │
    ├── Server-side Tools（Anthropic 提供，API 直接處理）
    │   ├── web_search（web_search_20250305，max_uses: 5）
    │   ├── web_fetch（web_fetch_20250910，max_uses: 5）
    │   └── code_execution（code_execution_20250825）
    │
    ├── Custom Tools（本地執行，透過 tools/registry.ts 統一管理）
    │   ├── bash          # shell 指令
    │   ├── read_file     # 讀檔
    │   ├── write_file    # 寫檔
    │   ├── get_weather   # 天氣（wttr.in）
    │   ├── memory_*      # 記憶管理（save / search / list / update_index）
    │   ├── cron_*        # 排程管理（create / list / delete / toggle）
    │   ├── reminder_*    # 提醒管理（create / list / delete）
    │   └── discord_fetch_message  # 抓取 Discord 訊息
    │
    ▼
回應（CLI stdout / Discord reply）
```

## Agent Loop

`src/agent.ts` — 核心循環，直接用 fetch 呼叫 Anthropic Messages API。

1. 組 system prompt（`prompt.ts` 的 `buildSystemPrompt()`）
2. 從 session 載入歷史 messages，送到 API
3. 收到回應 → 解析 text blocks + tool_use blocks
4. 有 tool_use → 本地執行 → tool_result 送回 → 回到 2（中間輪不存 session）
5. 沒有 tool_use → 最後一輪，只回傳這輪的文字

- Server-side tool（web_search / web_fetch）不需本地執行，API 直接處理
- Tool 定義用統一的 `Tool` 介面（`types.ts`），由 `tools/registry.ts` 轉成 Anthropic 格式
- `sanitizeContent()`：清除 API 回傳的多餘欄位（如 `caller`）
- `ask(prompt, options)` — prompt 為 null 時從 session 尾部取（Discord 用）

## Prompt 架構

`src/prompt.ts` — 組裝 system prompt。

| 層 | 內容 | 可改？ |
|----|------|--------|
| 系統層 | 執行規則、URL 處理、工具使用指南、Discord 訊息格式、記憶規則 | 否（寫死） |
| 時間層 | 當前日期時間（Asia/Taipei） | 自動 |
| 人格層 | `workspace/FURET.md`（名字、個性、語氣） | 是（外部檔案） |
| 記憶層 | `workspace/MEMORY.md`（長期記憶索引） | 是（AI 自行維護） |
| 額外層 | `options.systemPrompt`（如 Discord channel ID） | 動態 |

## Session 管理

`src/session.ts` — 每個對話一個 JSON 檔案，只存純文字對話。

| 場景 | Session ID | 位置 |
|------|-----------|------|
| CLI | `cli` | `workspace/sessions/cli.json` |
| Discord 頻道 | `discord-channel-{channelId}` | `workspace/sessions/discord-channel-*.json` |
| Discord DM | `discord-dm-{userId}` | `workspace/sessions/discord-dm-*.json` |

### Session 格式
所有 message 都是純文字 `content` + metadata 欄位（`time`、`msgId`、`replyTo`）。

```json
{ "role": "user", "content": "<@id>(name): 內容", "time": "04/17 14:19", "msgId": "149...", "replyTo": "149..." }
{ "role": "assistant", "content": "回覆內容", "time": "04/17 14:19", "msgId": "149..." }
```

- `time`：所有 message 都有
- `msgId`：Discord message ID（CLI 沒有）
- `replyTo`：被回覆的 message ID（僅 reply 時）
- Tool 互動（tool_use / tool_result）不存 session，只在當前對話的記憶體中
- 舊格式 session 載入時自動遷移（`migrateOldFormat()`）

### API 送出方式
Session 歷史打包成第一則 assistant message（JSON 格式），當前 user message 作為第二則送出。模型從 JSON 中讀取所有 metadata。

### 操作
- `/new` 指令：歸檔到 `workspace/sessions/archive/` 後清空
- `setLastAssistantMsgId()`：標記 bot 回覆的 Discord message ID

## Discord Bot

`src/bot.ts` — Discord.js client，整合進 Gateway。

### 觸發條件
- 被 `@mention` 或收到 DM
- DM 只回 owner（`config.yaml` 的 `owner_id`）
- Guild / channel 白名單過濾

### 訊息處理
- 所有訊息（不論是否觸發）都 append 到對應 session（結構化格式：content + time + msgId + replyTo）
- Content 格式：`<@userId>(暱稱): 內容`（乾淨文字，metadata 在獨立欄位）
- Mention 正規化：`<@userId>` → `<@userId>(暱稱)` 進 prompt，輸出時 strip 括號
- Bot 回覆的 Discord message ID 透過 `setLastAssistantMsgId()` 標記回 session
- `systemPrompt` 帶上 `Current Discord channel ID`，讓 agent 能用 `discord_fetch_message`

### Slash Commands
- `/new` — 歸檔 session，AI 重新打招呼（ephemeral reply）

## Gateway

`src/gateway.ts` — 常駐程式，統一管理所有背景服務。

| 服務 | 說明 |
|------|------|
| Cron 排程 | 每 30 秒重新載入 `workspace/crons.json`，執行到期任務 |
| Reminder | 一次性提醒，到期後自動刪除 |
| Journal | 每天固定時間（config 設定）自動寫日記 |
| Discord Bot | 有 token 且 enabled 時啟動 |

## Tool 系統

### Tool 介面

每個 tool 實作統一的 `Tool` 介面（`src/types.ts`）：

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}
```

### Tool Registry

`src/tools/registry.ts` — 統一管理所有 tool。新增 tool 只需：
1. 在 `tools/builtin/` 建立檔案，導出 `Tool` 物件
2. 在 `registry.ts` import 並加入陣列

Registry 負責：
- 將 `Tool` 介面轉成 Anthropic tool format（`input_schema`）
- 加上 server-side tools（web_search / web_fetch）
- 提供 `executeTool(name, args)` 統一執行入口

### Tool 列表

| Tool | 說明 | 持久化 |
|------|------|--------|
| `bash` | 執行 shell 指令 | - |
| `read_file` | 讀檔 | - |
| `write_file` | 寫檔 | - |
| `get_weather` | wttr.in 天氣查詢 | - |
| `memory_save` | 追加到當日記憶檔 | `workspace/memory/yyyy-MM-dd.md` |
| `memory_search` | 搜尋歷史記憶檔 | - |
| `memory_list` | 列出所有記憶檔 | - |
| `memory_update_index` | 覆寫 MEMORY.md | `workspace/MEMORY.md` |
| `cron_create` | 建立排程 | `workspace/crons.json` |
| `cron_list` | 列出排程 | - |
| `cron_delete` | 刪除排程 | `workspace/crons.json` |
| `cron_toggle` | 啟用/停用排程 | `workspace/crons.json` |
| `reminder_create` | 建立一次性提醒 | `workspace/reminders.json` |
| `reminder_list` | 列出提醒 | - |
| `reminder_delete` | 刪除提醒 | `workspace/reminders.json` |
| `discord_fetch_message` | 用 channel+message ID 抓 Discord 訊息 | - |
| `web_search` | Anthropic server-side 網路搜尋 | - |
| `web_fetch` | Anthropic server-side 讀取指定 URL | - |
| `code_execution` | Anthropic server-side Python 執行（計算、資料分析） | - |

## 記憶系統

兩層設計：

| 層 | 檔案 | 用途 |
|----|------|------|
| 長期記憶 | `workspace/MEMORY.md` | 持久事實，自動載入 system prompt |
| 每日記憶 | `workspace/memory/yyyy-MM-dd.md` | 當日事件、對話、感想 |

- `memory_save`：追加到當日檔案（寫前先讀，避免重複）
- `memory_update_index`：覆寫 MEMORY.md（寫前先讀）
- Agent 每輪對話後自動審視是否需要記錄
- Journal（每日排程）：整理當日記憶檔，補充遺漏

## 專案結構

```
furet/
├── src/
│   ├── agent.ts              # agent loop（API call + 執行循環）
│   ├── bot.ts                # Discord.js client
│   ├── cli.ts                # CLI 入口（readline）
│   ├── config.ts             # config.yaml 載入 + ${VAR} 解析
│   ├── gateway.ts            # 常駐程式（cron + reminder + journal + Discord）
│   ├── logger.ts             # pino log
│   ├── paths.ts              # 集中管理所有路徑常數
│   ├── prompt.ts             # system prompt 組裝
│   ├── session.ts            # session 持久化（純文字對話）
│   ├── types.ts              # 共用型別（Tool、ContentBlock、Message 等）
│   ├── utils/
│   │   └── format.ts         # markdown link 修正等
│   └── tools/
│       ├── registry.ts       # tool 註冊中心
│       └── builtin/
│           ├── bash.ts
│           ├── read-file.ts
│           ├── write-file.ts
│           ├── weather.ts
│           ├── memory.ts
│           ├── cron.ts
│           ├── reminder.ts
│           └── discord.ts
├── workspace/                # agent 工作空間（不進 git）
│   ├── FURET.md              # 人格設定
│   ├── MEMORY.md             # 長期記憶索引
│   ├── memory/               # 每日記憶
│   ├── sessions/             # session 持久化
│   ├── crons.json            # 排程
│   └── reminders.json        # 提醒
├── logs/                     # log（不進 git）
├── config.yaml               # 設定（不進 git）
├── config.example.yaml       # 設定範本
├── .env                      # 敏感資訊（不進 git）
├── .env.example
├── package.json
├── tsconfig.json
└── .gitignore
```

## 設定

### .env（敏感資訊）

```
LLM_API_KEY=                # Anthropic API key
LLM_BASE_URL=http://localhost:8317/v1  # API endpoint（指向 router）
DISCORD_TOKEN=              # Discord bot token
```

### config.yaml（非敏感設定）

```yaml
llm:
  api_key: "${LLM_API_KEY}"
  base_url: "${LLM_BASE_URL}"
  model: "claude-sonnet-4-20250514"

discord:
  enabled: true
  token: "${DISCORD_TOKEN}"
  allowed_channels: []
  allowed_guilds: []
  owner_id: "your-discord-user-id"

journal:
  enabled: true
  hour: 23
  minute: 50
```

## 開發進度

### Phase 1：CLI + Agent 核心 ✅
- 自建 agent loop（Anthropic Messages API，fetch-based）
- CLI 互動介面（readline）
- System prompt 架構（SYSTEM_INSTRUCTIONS + FURET.md + MEMORY.md）
- config.yaml + ${VAR} 環境變數解析
- 內建 tools: bash, read_file, write_file, get_weather
- Web search: Anthropic server-side tool（web_search_20250305）
- Log 埋點（pino → logs/furet.log）
- Session 持久化

### Phase 2：Custom Tools ✅
- Memory tools（save / search / list / update_index）
- Cron tools（create / list / delete / toggle）
- Reminder tools（create / list / delete）
- Gateway 常駐模式
- CLI 全域指令（npm link → `furet`）

### Phase 3：Discord 介面
- ✅ 3.1 MVP — mention 觸發、reply、session per channel/DM
- ✅ 3.2 訊息上下文 — 全訊息監聽、reply chain、mention 正規化、discord_fetch_message
- 🔲 3.3 Discord custom tools — send_message, react, pin, thread 操作等
- 🔲 3.4 智慧回應 — 自主判斷回文字 / react / 不回

### 代碼重構 ✅
- 集中路徑管理（paths.ts）
- 統一 Tool 介面 + registry 模式
- System prompt 獨立（prompt.ts）
- 共用型別（types.ts）
- Session 精簡：只存純文字對話，tool 互動不持久化
- 訊息時間戳（user + assistant）
- web_fetch server-side tool
- sanitizeContent 清除 API 多餘欄位

### Phase 4：權限 🔲
- Owner 判斷（目前只有 DM owner-only）
- 其他人不能執行高風險操作（bash 等）
