# Furet - 個人助手設計文件

## 概述

Furet（法語：雪貂）是一個基於 Claude Agent SDK 的個人助手 Discord Bot。
核心概念：Discord 作為介面，Claude Code 的全部能力作為引擎，再加上 Discord 操作、排程、記憶等擴充功能。

## 技術選型

| 項目 | 選擇 | 原因 |
|------|------|------|
| 語言 | TypeScript | 強型別，適合 Java 背景 |
| Discord 套件 | discord.js | 社群最大、文件最齊、更新最快 |
| AI 引擎 | @anthropic-ai/claude-agent-sdk | 官方 SDK，自帶 Claude Code 全部能力 |
| API 路由 | router-for.me (localhost:8317) | 避免 tool name 被 Anthropic 路由到 server-side 收費 |
| 排程 | node-cron | 輕量，cron 語法 |
| 執行環境 | Docker | 不在本機裝東西 |

## AI 引擎策略

使用 `@anthropic-ai/claude-agent-sdk`，透過 `ANTHROPIC_BASE_URL` 指向 local router。

```
Claude Agent SDK
    │ (Anthropic 原生格式)
    │ ANTHROPIC_BASE_URL=http://localhost:8317
    ▼
Router (router-for.me)
    │ 支援 Anthropic 原生格式 + Claude Code 相容
    ▼
上游 API
```

- SDK 內建 28 個 tools（Bash、Read、Write 等），全部自帶不用自己寫
- 經過 router 轉發，不直接打 Anthropic，避免 tool name 路由收費問題
- 已測試：48 個 tools（28 內建 + 20 custom）全部正常，無 400 錯誤

## 架構

```
Discord 訊息進來
    │
    ▼
Bot Event Handler (bot.ts)
    │
    ├── 解析訊息上下文 (context.ts)
    │   ├── reply chain（被回覆的原始訊息）
    │   ├── thread history（串內歷史）
    │   ├── 圖片附件（轉成 image content block）
    │   └── mention 解析
    │
    ├── 載入記憶 (memory)
    │
    ▼
組裝 Prompt（system prompt + memory + context + user message）
    │
    ▼
Claude Agent SDK query()
    │ ANTHROPIC_BASE_URL → router → 上游
    │
    ├── 內建 Tools（SDK 自帶，不用寫）
    │   ├── Bash（執行指令、git 等）
    │   ├── Read / Write / Edit（檔案操作）
    │   ├── Glob / Grep（搜尋）
    │   ├── WebSearch / WebFetch（網路）
    │   └── Task（子 agent）
    │
    ├── Custom Tools（自己寫）
    │   ├── Discord Tools（開串、刪串、送訊息...）
    │   ├── Cron Tools（建排程、列排程、刪排程）
    │   └── Memory Tools（存記憶、搜記憶）
    │
    ▼
回應貼回 Discord
```

## SDK 內建 Tools（不用實作）

透過 SDK 的 `allowedTools`，Claude 直接擁有以下 28 個 tool：

| Tool | 用途 |
|------|------|
| `Bash` | 執行 shell 指令、git |
| `Read` / `Write` / `Edit` | 檔案讀寫編輯 |
| `Glob` / `Grep` | 檔案搜尋、內容搜尋 |
| `WebSearch` / `WebFetch` | 網路搜尋、抓網頁 |
| `Task` / `Agent` | 子 agent |
| `TodoWrite` | 待辦事項 |
| `Monitor` | 監控 process |
| `NotebookEdit` | Jupyter notebook |
| `AskUserQuestion` / `SendMessage` | 互動 |
| `ListMcpResourcesTool` / `ReadMcpResourceTool` | MCP 資源 |
| `EnterPlanMode` / `ExitPlanMode` | 規劃模式 |
| `WorktreeCreate` / `WorktreeRemove` | Git worktree |
| `RemoteTrigger` / `ScheduleWakeup` | 遠端觸發、排程喚醒 |
| `CronCreate` / `CronDelete` / `CronList` | Cron 管理 |
| `TaskOutput` / `TaskStop` | Task 管理 |

## Custom Tools 設計

### Discord Tools

透過 `createSdkMcpServer` 註冊，Claude 可以自主呼叫。
完整清單見下方「決策紀錄 > Discord Tools 完整清單」。

### Cron Tools

Claude 可以**自主**建立排程（不只是使用者叫它排，它自己判斷該排也會排）。
排程觸發時會重新呼叫一次 agent query。

| Tool | 說明 | 參數 |
|------|------|------|
| `create_cron` | 建立排程任務 | schedule (cron 語法), prompt, channel_id, name? |
| `list_crons` | 列出所有排程 | - |
| `update_cron` | 修改排程 | cron_id, schedule?, prompt?, channel_id? |
| `delete_cron` | 刪除排程 | cron_id |

排程持久化在 `data/crons.json`，container 重啟時重新載入。

### Memory Tools

| Tool | 說明 | 參數 |
|------|------|------|
| `save_memory` | 儲存一則記憶 | content, tags? |
| `search_memory` | 搜尋相關記憶 | query |
| `list_memories` | 列出所有記憶 | - |
| `delete_memory` | 刪除記憶 | memory_id |

初期用檔案存（markdown），之後可換 SQLite + full-text search。

## 訊息監聽與 Session 管理

### 設計理念

採用 **持續監聽 + 本地儲存** 模式（參考 OpenClaw），而不是每次被呼叫時用 Discord API 撈歷史。
這樣 Furet 擁有完整的對話上下文，不只是被 mention 的那幾則。

### 訊息監聽

Bot 透過 Discord Gateway WebSocket 持續接收所有可見頻道的訊息事件：
- 每則訊息進來都寫入 History Store，不論是否 mention 或 reply Furet
- 訊息格式化後儲存，包含 sender、content、timestamp、messageId、attachments

### History Store（記憶體滑動視窗）

```
historyStore: Map<string, HistoryEntry[]>
```

- Key = channel ID 或 thread ID
- 每個 channel 保留最近 N 則訊息（預設 50，可設定）
- Map 最多保留 M 個 channel key（LRU 淘汰最久沒活動的 channel）
- 重啟後清空（純記憶體），可考慮之後加磁碟持久化

```typescript
interface HistoryEntry {
  messageId: string;
  sender: string;        // 顯示名稱
  senderId: string;      // Discord user ID
  content: string;       // 訊息內容
  timestamp: number;
  attachments: Attachment[];  // 圖片等附件
  replyTo?: {            // 如果是 reply，記錄被回覆的訊息
    messageId: string;
    sender: string;
    content: string;     // 被回覆訊息的內容快照
  };
}
```

### Reply Chain（重點改進）

OpenClaw 的弱點是 reply 時不知道回覆的是哪則訊息。Furet 要完整處理：

1. **監聽階段就記錄 reply 關係** — 每則訊息進 History Store 時，如果有 `message.reference`：
   - 從 History Store 查找被回覆的訊息（大部分情況下會在記憶體中）
   - 如果不在記憶體中（太舊的訊息），才 fallback 用 Discord API fetch
   - 將被回覆訊息的 sender + content 快照存進 `replyTo` 欄位

2. **組裝 prompt 時還原 reply chain** — 當 Furet 被觸發時：
   - History 中的每則訊息如果有 `replyTo`，格式化為：
     ```
     [Alice] (回覆 Bob 的「原始訊息內容」): 回覆的內容
     ```
   - 這樣 Claude 能看到完整的對話脈絡，誰在回覆誰、回覆的是什麼

3. **多層 reply chain** — 如果 A reply B、B reply C，組裝時能還原整條鏈
   （但不用遞迴太深，2-3 層就夠了）

### Session 分組

Session key 的組法：

| 場景 | Session Key | 說明 |
|------|------------|------|
| DM | `dm:<userId>` | 每個使用者獨立 session |
| Channel | `channel:<channelId>` | 每個頻道一個 session |
| Thread | `thread:<threadId>` | 每個討論串一個 session |

### 圖片處理

訊息帶附件時：
1. 監聽階段：將附件 metadata 存入 HistoryEntry（URL、type、filename）
2. 組裝 prompt 時：如果附件是圖片（png, jpg, gif, webp），轉成 image content block
3. 讓 Claude 直接看圖

### Token 控制

- History 滑動視窗自然限制了上下文量
- 組裝 prompt 時可再根據 token 預算截斷（先丟最舊的訊息）
- 之後可加 compaction（壓縮舊對話成摘要，參考 OpenClaw 的做法）

## 開發順序

### Phase 1：CLI + Agent 核心
- `src/cli.ts` — 終端機互動介面（readline）
- `src/agent.ts` — Claude Agent SDK 封裝，能 query、能用內建 tools
- 目標：終端機能對話，能執行 bash、讀寫檔案、搜網路

### Phase 2：Custom Tools
- `src/memory/` — Memory tools（存記憶、搜記憶）
- `src/tools/cron.ts` — Cron tools（建排程、列排程、刪排程）
- 目標：agent 能自主記憶和排程

### Phase 3：System Prompt + 權限
- System prompt 設計（人格、行為準則、智慧回應判斷）
- Owner 權限判斷
- 目標：有個性、有邊界的 agent

### Phase 4：Discord 介面
- `src/bot.ts` — Discord.js client、event handler
- `src/context.ts` — 訊息上下文組裝（reply chain、History Store、圖片）
- `src/tools/discord.ts` — Discord custom tools
- 目標：完整的 Discord bot

## 專案結構

```
furet/
├── src/
│   ├── cli.ts                # CLI 入口（Phase 1）
│   ├── index.ts              # Discord bot 入口（Phase 4）
│   ├── agent.ts              # Claude Agent SDK 封裝
│   ├── bot.ts                # Discord.js client、event handler（Phase 4）
│   ├── context.ts            # 訊息上下文組裝（Phase 4）
│   ├── tools/
│   │   ├── discord.ts        # Discord custom tools（Phase 4）
│   │   └── cron.ts           # Cron custom tools + scheduler（Phase 2）
│   └── memory/
│       └── index.ts          # 記憶讀寫（Phase 2）
├── data/
│   ├── memory.md             # 記憶存放
│   └── crons.json            # 排程持久化
├── .env                      # 敏感資訊（不進 git）
├── .env.example              # .env 範本（進 git）
├── config.yaml               # 非敏感設定（進 git）
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── .gitignore
```

## 設定

### .env（敏感資訊，不進 git）

```
DISCORD_TOKEN=              # Discord bot token
LLM_API_KEY=                # API key（給 router 用）
LLM_BASE_URL=http://localhost:8317  # API endpoint（指向 router）
```

### config.yaml（非敏感設定，進 git）

```yaml
# 權限
owner_id: "123456789"           # 主人的 Discord user ID

# Discord
allowed_channels:               # 允許互動的頻道（空 = 全部）
  - "channel_id_1"
  - "channel_id_2"

# History
history_limit: 50               # 每個 channel 保留的訊息數
history_max_channels: 1000      # 最多追蹤幾個 channel

# Rate Limiting
rate_limit_seconds: 10          # 同一使用者冷卻秒數

# 回應
max_message_length: 2000        # Discord 單則訊息上限

# 錯誤 Reaction
error_emoji: "🤕"
rate_limit_emoji: "⏳"

# 資料目錄
data_dir: "./data"
```

## 決策紀錄

### Discord Tools 完整清單

| Tool | 說明 | 參數 |
|------|------|------|
| `send_message` | 發送訊息到指定頻道 | channel_id, content, reply_to? |
| `create_thread` | 在頻道開討論串 | channel_id, name, content? |
| `delete_thread` | 刪除討論串 | thread_id |
| `archive_thread` | 封存討論串 | thread_id |
| `pin_message` | 釘選訊息 | message_id, channel_id |
| `unpin_message` | 取消釘選 | message_id, channel_id |
| `add_reaction` | 加反應 | message_id, channel_id, emoji |
| `remove_reaction` | 移除反應 | message_id, channel_id, emoji |
| `mention_user` | 提及使用者（包在訊息內容裡） | （透過 send_message 的 content 處理） |
| `edit_message` | 編輯 Furet 自己的訊息 | message_id, channel_id, new_content |
| `delete_message` | 刪除 Furet 自己的訊息 | message_id, channel_id |
| `get_message_history` | 讀取頻道歷史訊息 | channel_id, limit? |
| `list_channels` | 列出頻道清單 | guild_id |

#### 智慧回應判斷

Furet 需要自主判斷「要不要回覆在 Discord」：
- 使用者的結尾語（「好的」「嗯」「好」「謝謝」等）不需要文字回覆，**只需 reaction**
- 這個判斷由 Claude 的 system prompt 指導，不是硬 code 規則
- 讓 Claude 自己決定：回一則訊息、只 react、還是什麼都不做

### 權限控制

分為兩級：

| 角色 | 判斷方式 | 權限 |
|------|---------|------|
| **主人（Owner）** | 環境變數 `OWNER_ID` 比對 Discord user ID | 全部功能：Bash、file 操作、git、cron、Discord 管理 |
| **其他人** | 非 Owner 的所有人 | 僅對話、看圖、WebSearch；不能執行指令、不能管排程 |

- **DM 只限主人** — 其他人 DM Furet 直接 return，不回應
- 在頻道/thread 中，其他人可以跟 Furet 對話，但 Furet 不會幫他們執行有風險的操作

### 回應格式

- 長回應自動分段（Discord 單則訊息 2000 字元限制）
- 分段點優先選在段落結尾、程式碼區塊結尾，不要從中間斷開

### 錯誤處理

- Claude query 失敗時：在觸發訊息上 react 🤕
- 暫不客製化錯誤 emoji，但設計上預留設定欄位，之後可改

### Rate Limiting

防止有人瘋狂刷 `@Furet` 燒 API credit：
- 同一個使用者 N 秒內只能觸發一次（N 可設定，預設 10 秒）
- 被 rate limit 時不回應，或 react ⏳
- Owner 不受限制

### System Prompt

- 初期寫死在程式碼中（自用）
- 設計上預留設定檔機制，之後可抽成 `data/system-prompt.md` 讓人客製化
- 內容包含：人格設定、行為準則、回應風格、智慧回應判斷指引

### 參考架構

- OpenClaw — 訊息監聽 + History Store 滑動視窗模式（已採用）
- Hermes Agent — Tool name mapping 做法（已不需要，走 router 解決）

### Tool Name 路由問題（已解決）

- **問題**：直接打 Anthropic API 時，特定 tool name 組合會被路由到 server-side tools 額外收費
- **解法**：透過 `ANTHROPIC_BASE_URL` 指向 local router (router-for.me)，router 支援 Anthropic 原生格式 + Claude Code 相容
- **驗證**：已測試 48 個 tools 全部正常通過，無 400 錯誤
