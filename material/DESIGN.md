# Furet - 設計文件

## 概述

Furet（法語：雪貂）是一個個人 AI 助手，使用自建 agent loop 與可設定的 LLM connection profile。
介面：CLI + Discord bot，透過 Gateway 常駐程式統一管理。

## 技術選型

| 項目 | 選擇 | 原因 |
|------|------|------|
| 語言 | TypeScript | 強型別 |
| AI 引擎 | 自建 protocol-neutral agent loop + adapter | 完全掌控，不依賴任何 SDK |
| API 路由 | 使用者設定的 connection profile | protocol、base URL、auth、model 與 capabilities 分離 |
| Web / code capabilities | 本地安全 web_fetch；active-model hosted web_search；code_execution 顯式 unavailable | hosted 能力不跨模型 fallback，也不把 provider sandbox 偷換成 host shell |
| Discord | discord.js | 社群最大、文件最齊 |
| 排程 | node-cron | 輕量，cron 語法 |
| Google API | googleapis | 官方全家桶（Calendar / Gmail / Drive / Tasks） |
| 向量搜尋 | Gemini embedding (gemini-embedding-001, 3072 維) | 語意記憶召回 |
| 執行環境 | Node.js 直接執行（tsx） | agent 需要直接操作 workspace 檔案 |

## 架構

```
使用者輸入（CLI / Discord）
    │
    ▼
Agent (agent.ts) ── normalized LLM client ──► profile adapter ──► 使用者設定的 gateway / upstream
    │
    ├── System Prompt = prompt.ts（AGENT.md + 日期時間 + SOUL.md + MEMORY.md + skills）
    │
    ├── Web / code capability tools
    │   ├── web_fetch（本地 SSRF-safe HTTP fetch）
    │   ├── web_search（只使用 request-scoped active model 的 Responses hosted 能力；不跨模型 fallback）
    │   └── code_execution（未設定 provider sandbox 時明確 unavailable；不以 host bash 冒充）
    │
    ├── Custom Tools（本地執行，透過 tools/registry.ts 統一管理；exposure 分級見 Tool 系統）
    │   ├── tool_catalog # 探索／代理入口，exposure 開啟時走它取用未直接暴露的工具
    │   ├── bash / read_file / write_file / get_weather
    │   ├── image_gen     # GPT-only，Responses API 生圖／參考圖 edit 並附檔
    │   ├── diary_note / memory_* # 日記補註與記憶管理（search / list / add / replace / remove）
    │   ├── cron_*        # 排程管理（create / list / delete / toggle / update）
    │   ├── reminder_*    # 提醒管理（create / list / delete）
    │   ├── discord_*     # Discord 操作（fetch / send / buttons / react / pin / thread / forum / edit / delete）
    │   ├── google_*      # Google API（calendar / gmail / drive / tasks）
    │   ├── soul_guardian_* # 核心檔案保護
    │   └── skill_*       # 技能安裝/移除
    │
    ▼
回應（CLI stdout / Discord 漸進式編輯訊息）
```

## Agent Loop

`src/agent.ts` — 核心循環，只使用 `src/llm/types.ts` 的 normalized request/response；`src/llm/client.ts` 依 active profile 選擇 adapter。第一個正式 adapter 是 `openai_chat_completions`。

### Connection profile、模型與思考等級

`config.llm.active_profile` 選出目前 connection profile。每個 profile 分別保存 `protocol`、`baseUrl`、`auth`、`apiKey`、`model`、`reasoningEffort`、token-limit field、capabilities 與 model list；不得依 model ID 前綴猜測協議或能力。

每個 session 建立時會從 active connection profile 快照 `profile + model + reasoning effort`，並持久化於 session source of truth。每次 `ask()` 開始時，`sessionLlmProfile()` 將 session 選擇與 connection profile 合成 immutable request profile，再綁進 AsyncLocalStorage。同一請求的主對話、compaction、attachment vision、self-evolve 子請求，以及 hosted web/image/code capability 都沿用這份 profile。`/model` 只更新目前 Discord session 的 model 與 reasoning effort，不改 connection profile 的 protocol、endpoint、auth、capability 或其他 session。

OpenAI Chat adapter 依 profile 的 `tokenLimitField` 選擇 `max_completion_tokens` 或 `max_tokens`。`reasoningEffort: default` 不送 reasoning 欄位，其餘值以 `reasoning_effort` 傳給相容 gateway。Hosted capability 由 profile 明確宣告；不支援時工具不曝光，也不能跨 profile 或跨模型 fallback。

### API 錯誤可觀測性與暫時性重試

`postLlmJson()` 的 transport-level `fetch()` 失敗會包成帶 `cause` 的 Error，保留請求 endpoint 與底層錯誤鏈。`src/logger.ts` 對 `err` 欄位使用遞迴 serializer，記錄 Error 的 `type`、`message`、`stack`、自有屬性（如 `code`）與 `cause`；呼叫端應傳入原始 Error（`{ err }`），不要只留下 `err.message`，否則會遺失 `ECONNREFUSED`、`ECONNRESET`、DNS 等真正原因。

短暫的網路錯誤，以及 HTTP `408`、`429`、`500`、`502`、`503`、`504`、`529`，會在共用 LLM HTTP boundary 內最多嘗試 3 次。等待時間優先採用標準 `Retry-After`，否則使用約 1 秒、2 秒的 exponential backoff 加少量 jitter；其他 4xx 等明確請求錯誤不重試。重試邊界刻意放在單次 Chat Completions API 呼叫內：若前一個 agent turn 已經成功執行本地工具，下一次模型整理回覆時遇到 502，只會重送同一份 messages 給模型，**不會重新進入已完成的本地工具執行迴圈**，避免寄信、寫檔或 Discord 操作等副作用重複發生。provider-side 的 web search／fetch／code execution 屬該 API request 內部能力，遇到 transport-level 不確定結果時仍可能由上游重做，但不會重跑 Furet 本地工具。

整個 `ask()` 跑在獨立的 request context（AsyncLocalStorage）裡，見「Request Context」一節。

### Logging：依本地日期每天分檔

`src/logger.ts` 用 pino + pino-pretty，把 log 以人類可讀的 `[YYYY-MM-DD HH:mm:ss] LEVEL: msg {json}` 單行格式寫入 `logs/`。日誌**依本地日期每天分檔**，檔名為 `logs/furet-YYYY-MM-DD.log`。

`src/dailyFileStream.ts` 的 `createDailyFileStream()` 提供這個行為：pino-pretty 在主執行緒把每筆 log 格式化後寫進一個自訂 Writable，該 Writable 在每次寫入前用 `Intl.DateTimeFormat("en-CA", { timeZone })` 取當下本地日期挑檔名。跨午夜時會無縫關掉舊 stream、開新日期檔，**不需重啟程序**；檔案一律以 `flags: "a"`（append）開啟，啟動時不會覆蓋既有的當日 log。

為什麼不用 pino-pretty 的 `destination` 直接指路徑：那是固定字串，無法在跨午夜時自動換檔。改用 Writable 當 destination 才能在寫入當下決定檔名。

**分檔時區跟 `config.timezone` 同一口徑**：`logger.ts` 傳入 `resolveTimeZone()`（`src/utils/time.ts`）的結果——與 `today()`（記憶檔名、日記日期）、`nowWithZone()`（system prompt）共用同一支時區解析，優先序為 `config.timezone` → 系統 IANA 時區（`Intl.DateTimeFormat().resolvedOptions().timeZone`）→ `UTC`，**不硬編碼任何地區**。`createDailyFileStream` 的 `timeZone` 參數預設 `UTC`，只是底層工具在呼叫端未傳值時的最終保險；正常路徑一律由 `logger.ts` 傳入解析後的時區。這樣分檔日期與記憶／日記日期不會分岔——先前把 fallback 寫死成 `Asia/Taipei` 才會造成文件宣稱與實作不一致。

**底層錯誤不會變成 uncaught crash**：`fs.WriteStream` 可能在 open 階段（權限不足、路徑不存在）或寫入時拋錯並 emit `error`；沒人監聽的話 Node 會升級成未處理例外直接讓程序倒下。自訂 Writable 因此分兩條路徑轉送，並用旗標互斥保證任一次錯誤只傳播一次、callback 不重複：

- 進行中的寫入遇錯 → 透過該次 `write()` 的 `callback(err)` 回報，Node 依標準 stream 語意 destroy 外層並對消費者 emit `error`。
- 非寫入期間浮現的錯誤（非同步 open 失敗、閒置時底層出錯）→ 由持久的 `error` listener 轉成 `outer.destroy(err)`。跨午夜換掉的舊 stream 之後才出錯的話，其 listener 會自行略過，不干擾新檔。

`logger.ts` 再對 pretty stream 掛一個最終保險 `error` listener：真的寫檔失敗時印到 stderr（此時 logger 本身可能已無法寫檔），而不是讓錯誤逸散。


1. 組 system prompt（`prompt.ts` 的 `buildSystemPrompt()`）
2. 自動記憶召回：用使用者訊息呼叫 permission-aware `searchUnified()`，以同一套 FTS + vector
   索引跨對話、日記、人物、工具證據與附件召回，再把結果注入 system prompt。
   `prompt` 為 null 時（Discord 路徑）改取 session 最後一則 user message，並剝掉
   `[msg:id 時間] <@id>(帳號名｜暱稱):` 這類中繼資料前綴，避免稀釋語意訊號
3. 從 session 載入歷史 messages（標準 multi-turn 格式），用 `trimToTokenBudget()` 控制 context 上限，
   再經 `ensureUserFirst()` 確保第一則是 user role
4. 送 API，收到回應 → 正規化 `message.content`、`tool_calls`、`finish_reason` 與 usage
5. 若 provider 回傳 base64 `image` block，立即寫入 `workspace/attachments/` 並排入 request-scoped 附件佇列；session 只留文字佔位，不保存大型 base64
6. 有 `tool_calls` → 本地執行 → 以 `role: tool` + `tool_call_id` 回送 → 回到 4
7. 沒有 `tool_calls` → 最後一輪，回傳文字與附件路徑

### Session 與 API 的訊息流

- Session 存：對話 messages、完整 local `toolHistory`（工具 input / output / 成敗），以及用量；不存 thinking，見下；不把 live `tool_result` 或 provider-owned server-tool protocol blocks 混入對話 messages。使用者訊息無法持久化時不啟動模型，Discord trigger 會明確回報；assistant message 是交付前必須成功的 durable boundary。回答已生成並保存後，usage、conversation-window、attachment reference 與 Discord message ID 等 bookkeeping 改採 best-effort，失敗只記錄待修復狀態，不能吞掉已完成的文字或附件。工具執行後若 audit ledger 寫入失敗也繼續整理回覆，避免重試造成外部副作用重複。
- 送 API 時：從 session 展開成標準 OpenAI multi-turn messages。舊 session 的 thinking、local tool protocol 與 provider-owned server-tool blocks 只作唯讀相容，不跨回合重播；歷史只保留可攜的 user／assistant 文字與圖片，另外在 system prompt 注入最近 8 筆本地工具工作的有界摘要。當次 live request 的 function calls 則以 assistant `tool_calls` 和對應的 `role: tool` 訊息維持到模型完成最終回答。

- `trimToTokenBudget()`：從最新往回取，粗估 token（JSON 長度 / 4），確保 tool_use/tool_result 配對不被拆散。
  單則訊息本身就超過預算時，至少保留最後一則（否則會送出空 messages）
- `ensureUserFirst()`：部分 OpenAI-compatible router 對 assistant-first 歷史相容性不一致。session 開頭可能是 assistant
  （cron/reminder 主動推播、或 trim 從中間切開），此時在最前面補一則 user 說明，
  而不是把那些 assistant 訊息丟掉——它們是真的推播過的紀錄，砍掉會失去上下文
- Memory hook（JOURNAL.md 的 Memory Hook section）每 5 則 user message 才附加一次（定期 nudge）

### 為什麼不存 thinking block

thinking block 的 `signature` 不是 `thinking` 欄位的校驗碼 —— **它才是內容本身**：模型端的
加密推理酬載（gpt-5.6-sol 走 router 時是 Fernet token，`gAAAAAB...`，約 1.3KB），只有模型端
解得開；`thinking` 欄位本身只是一行標題（實測約 43 字元）。

它唯一有作用的時機是「同一輪內接著回送 tool_result」，所以 `ask()` 的 live turn 迴圈裡照常
帶著。但**跨輪重送沒有意義**：歷史裡配對的 tool_use 本來就會被濾掉，推理接續性早就斷了，
等於每輪多背幾百個 token 換不到東西。因此 `stripThinking()` 在存進 session 前把它拿掉，
展開歷史時再濾一次以相容舊 session。

### Tool history：完整保存、精簡重播

每次**本地** tool 執行完，`ask()` 都會以 `Session.recordToolEvent()` 寫入不可變的 `toolHistory`：

- tool call ID、執行時間、工具名稱；
- 完整 input（例如 bash command）；
- 完整文字 result；
- 成功／失敗狀態。

這份完整紀錄存於 active session JSON，也會跟著 session archive／compact archive 保存，是稽核與後續查證的資料來源；不因為 context 控制而截斷。每筆 tool call、完整 result 切片與 bounded evidence summary 亦透過統一搜尋 ingestion pipeline 建立可重建的 FTS／embedding projection。搜尋投影本身先遮罩 secrets，因此 FTS、召回輸出與外部 embedding payload 都不含 credential；未遮罩的原始證據只留在既有權限保護的 session source of truth。

正常下一輪不會把完整 stdout 或每一筆工具操作塞回 messages。`renderToolHistory()` 只把**最近 8 筆**投影到 system prompt，每筆 input 最多 180 字、outcome 最多 280 字，並標示為 untrusted data。模型因此知道「做過什麼、成功或失敗、結果概略」，但不會每輪重付長輸出的 token；需要細節時，目前仍可從 session JSON／archive 查閱。

舊版 session 曾把 `tool_use` 摘成多條 `[System] Tools actually executed...` synthetic user message。載入歷史時會略過這些 legacy recap，讓它們隨 compact 或 archive 自然退場；新 tool history projection 取而代之。

`thinking` 不寫入 session。reasoning signature 只在同一輪接著回送 `tool_result` 時有效；跨 request 重播既不能可靠延續推理，也只會消耗 context。保留可驗證的 tool evidence、最終文字回覆及 compact continuation brief，比保存私有逐字推理可靠。

### 關鍵函式

- `ask(prompt, options)` — 主入口。prompt 為 null 時從 session 尾部取（Discord 用）
- `generateLlmResponse(request, profile)` — normalized client；依 profile protocol 選 adapter
- `OpenAIChatAdapter.generate(...)` — Chat Completions wire mapping、tool arguments 與 usage 正規化
- `postLlmJson(...)` — auth、timeout、retry 與 HTTP error boundary
- `estimateTokens(msg)` — 粗估 token 數
- `trimToTokenBudget(messages, maxTokens)` — token-based 歷史裁切
- `ensureUserFirst(messages)` — 對 assistant-first 不相容的 router 補上 synthetic user context

## Request Context

`src/tools/context.ts` — 用 `AsyncLocalStorage` 做請求範圍隔離。

cron / reminder / journal 跟使用者對話是並行跑的，trigger 與待送附件因此必須綁在請求上。
放在模組級全域變數會互相覆蓋：cron 觸發時把 trigger 蓋成 `"cron"`，正在執行 tool call 的
非 owner 請求就繞過了 `registry.ts` 的 owner-only 檢查；附件也會串到別人的回覆去。

- `runWithContext(trigger, userId, profile, fn, { sessionId, channelId })` — `ask()` 用它包住整個執行流程，並把搜尋權限所需的 request identity 綁在同一個 ALS scope
- `getTrigger()` / `setTrigger()` / `getUserId()` / `getSessionId()` / `getChannelId()` — 工具權限與搜尋 visibility 判定用的 request identity
- `queueAttachment()` / `drainAttachments()` — 工具排隊的檔案附件
- ALS 範圍外呼叫時退回 `{ trigger: "unknown", pendingFiles: [] }`

附件由 `ask()` 在結束時收集，透過 `AgentResponse.attachments` 回傳給呼叫端。這同時涵蓋本地工具用 `discord_attach_to_reply` 排入的檔案、profile-gated `image_gen` 經 Responses API 生成的圖片，以及 provider 直接回傳之 base64 `image` block。`image_gen` 可把 `workspace/attachments/` 內的圖片轉成 data URL，作為 Responses API 的 `input_image`；生成人格本人時以 `use_identity_reference=true` 掛上 `config.image_generation.identity_reference_path`，其他服裝／場景參考則用 `reference_images`。有參考圖時 tool 會用 edit action；不傳 `input_fidelity`，避免實際 image backend 與父層模型不同時拒絕不支援的參數。讀檔失敗或 canonical path 未設定會直接報錯，不得宣稱已鎖臉。

生成檔不落在 `workspace/attachments/` 根目錄：呼叫端應先列出（`ls`）`workspace/attachments/` 的現有目錄，再透過 `output_directory` 優先指定語意合適的既有相對子目錄；未指定時由工具直接存入通用的 `generated-images/`。`filename_hint` 會清理成安全、可辨識的檔名 stem，再加時間戳與隨機尾碼避免碰撞。輸出目錄同時做 lexical path 與 `realpath` 邊界檢查，拒絕絕對路徑、`..` 逃逸與 symlink 逃逸。工具從一開始就寫入最終路徑並只把該路徑排入附件佇列，不再依賴生成後移動／改名，因此不會留下失效的 queued path。`drainAttachments()` 會去重並丟棄已被移動／改名而不存在的舊路徑，避免單一 stale path 讓 Discord 拒絕整批附件；Discord 最終進度訊息若在附檔 edit 時失敗，會記錄原始 Error 並退回發送一則新的完整回覆，而不是靜默留下工具進度。`image_gen` 使用 request-scoped active model 呼叫 Responses；目前 registry 只對 GPT route 暴露，非支援模型不會看到或呼叫此工具，且不會改用另一個模型代跑。

## Prompt 架構

`src/prompt.ts` — 組裝 system prompt。各 md 檔自帶 XML tag（如 `<agent-instructions>`、`<persona>`、`<memory>`），`buildSystemPrompt()` 只負責拼接，不硬塞任何 tag。

順序按語意分組：**你是誰 → 怎麼做事 → 知道什麼 → 會什麼 → 現在在哪**，接著就是對話。
三塊記憶相鄰，runtime context 緊貼 messages，錨定留在最後一段。

| 層 | 來源 | XML tag | 說明 |
|----|------|---------|------|
| 人格層 | `workspace/SOUL.md` | `<persona>` | 名字、個性、語氣 |
| 系統層 | `workspace/AGENT.md` | `<agent-instructions>` | 行為規則、工具指南、workspace 邊界 |
| 主人層 | `workspace/OWNER.md` | `<owner>` | owner 的身分、稱呼、權限（永遠內嵌，見下） |
| 記憶層 | `workspace/MEMORY.md` | `<memory>` | 長期記憶（有字數上限） |
| 人物層 | `workspace/PEOPLE.md` | `<people>` / `<people-index>` | 使用者身分、稱謂、權限（大小門檻，見下） |
| 召回層 | 自動（向量搜尋） | `<recalled-memories>` | 根據 user message 語意召回的相關記憶 |
| 技能層 | `workspace/skills/*/SKILL.md` | `<skills>` | 已啟用技能的描述 |
| 工具索引層 | registry metadata（動態） | `<tool-index>` | exposure 開啟時列出 `tool_catalog` 可達的能力群；關閉時不插入（見 Tool 系統 › Tool Exposure） |
| Runtime policy 層 | `src/prompt.ts`（程式生成） | `<runtime-policy>` | 與輸出攔截直接耦合、不可被 workspace 精簡掉的 Discord 回覆／靜默協定 |
| Application Emoji 層 | `src/emoji.ts`（程式生成，動態） | `<application-emojis>` | 目前 Application 擁有之 emoji 的精簡名稱清單，僅 Discord trigger 注入；無 emoji 時整層不產生（見 Application Emoji） |
| 時間層 | 自動生成 | （無） | 當前日期時間（時區由 `config.timezone` 決定） |
| 額外層 | `options.systemPrompt` | （無） | 動態注入（如 Discord channel ID、session ID、flush 指令） |
| 錨定層 | 自動生成 | `<persona-reminder>` | 結尾把語氣的最終依據指回 `<persona>` |

AGENT.md 整份載入每一輪 prompt，唯一的例外是 `## Onboarding Protocol`：該段只在 `OWNER.md`
仍含模板佔位符（或檔案不存在）時保留，設定完成後於載入時剝除。條件放在 `prompt.ts` 而非改檔案，
workspace 的 AGENT.md 因此能與 `templates/` 保持一致，同時已設定的 workspace 不必為永遠不會
再觸發的指令付出每輪的 token。

### OWNER.md 為什麼獨立成一層

稱呼、身分、權限每一輪都要用得到，但這些資訊原本散在三個檔案：SOUL.md 的人格描述、
PEOPLE.md 的 owner 條目、MEMORY.md 的 Owner 段。三處都不具權威，改一處另外兩處不會跟著動。

更關鍵的是 PEOPLE.md 有大小門檻：超過 `peopleInlineLimit` 就退化成一行指標，
owner 的稱呼規則會整個從 prompt 消失，而程式不會察覺。

`OWNER.md` 因此**不套大小門檻**——它是單一 owner 的精簡權威檔，本來就不該長到需要設限；
會長大的是 PEOPLE.md 和 MEMORY.md。OWNER 的地址、工作或關係等資料可以改變，但應在同一欄位
原地更新並移除舊值，不把修正歷史或重複副本散到 MEMORY.md。職責嚴格劃分：

- `SOUL.md` 只管人格語氣，不寫稱呼
- `OWNER.md` 是 owner 稱呼、身分、帳號、住處、工作、關係、權限等個人檔案的唯一權威
- `PEOPLE.md` 只放 owner 以外的人物檔案
- `MEMORY.md` 只放非人物檔案的長期操作脈絡：規則、偏好、反覆流程、持續計畫與世界事實
- `memory/yyyy-MM-dd.md` 記錄當天發生的事；可記「今天得知某資料」，但不能取代權威檔更新

`soul_guardian` 一併監控 OWNER.md。

召回記憶由 `ask()` 搜出來後傳進 `buildSystemPrompt()`，跟另外兩塊記憶排在一起——
掛在字串尾端會排到錨定層後面，讓「結尾指回 persona」失效。
各區塊組裝前先 trim：workspace 的 md 檔尾端自帶換行，不修掉會出現三連換行。

`<tool-index>` 同理由 `ask()` 依 exposure feature flag 決定後傳進 `buildSystemPrompt()`
的 `toolIndex` 參數，插在 skills 之後、runtime context（datetime / channel）之前——
跟召回記憶一樣**不能**掛在字串尾端，否則會排到 persona anchor 後面，破壞「錨定留在
最後一段」的不變量。tool history 投影是唯一刻意接在 anchor 之後的區塊：它是 untrusted
的近期工具紀錄，要緊貼 messages，且本身已標明邊界。

### persona 的位置與錨定

persona 通常只有一兩百字，AGENT.md 的操作規範動輒好幾千字（實測 177 vs 7376，比例 40:1）。
夾在大量「高效助理」指令中間的 persona 會被蓋過去，語氣完全跟著 AGENT.md 走。三個機制頂住：

1. persona 放最前面——先講「你是誰」，再講「怎麼做事」
2. AGENT.md 開頭的 `## Voice` 明確劃分：persona 決定**怎麼說**，AGENT.md 決定**做什麼**，
   衝突時語氣以 persona 為準
3. 結尾的 `<persona-reminder>` 利用結尾的注意力高點把語氣依據指回去

人格的主觀喜惡只作用於人際、生活、遊戲、審美等非技術選擇。凡涉及程式碼、code review、除錯、系統設計、架構、資安、工具、規格或系統維運，`SOUL.md` 與 `MEMORY.md` 明確要求回到證據、測試、文件與工程準則；可以下明確結論，但不能用人格偏好代替技術判斷。這條邊界避免 persona 的「喜惡分明」外溢到技術分析。

`PEOPLE.md` 一併載入 system prompt——AGENT.md 的「Use titles from `workspace/PEOPLE.md`」
要那個檔案在場才有依據。

### 防「宣稱完成」的規則配平

`Never fabricate tool results` 擋的是**偽造結果內容**，但更常見的失效形式是**宣稱狀態**：
沒調用工具就說「建立完成」、工具回錯卻回報成功、只做一半說全做完——這三種字面上都不算
"pretend a result"。

力道也要對稱：同一份文件裡有五條在推「快、果斷、別確認、每次都要有進展」
（`Act, don't describe`、`Complete-or-Deliver`、`Turn limit`、`No over-confirmation`、
`No drip-feeding`），只有一條防幻覺對上它們的話，做不到時最省事的滿足方式就是宣稱做完了。
兩條規則一起配平：

- `Never claim completion without evidence` 把 done/created/sent 這類詞定義成「關於世界的
  斷言」，只有實際跑過工具並讀過結果才能講
- `Complete-or-Deliver` 寫成三選項，「說明卡在哪」也算完整回應——否則誠實回報卡住反而違規，
  等於在獎勵假宣稱

### XML 標籤與附加內容

**標籤一律由 `prompt.ts` 的 `section()` 套上，不倚賴檔案內容自帶。** `wrapTag()` 是冪等的：
檔案已經有就不重複包，檔案裡的標籤掉了就補上。兩者分工是——檔案內的標籤是**檔案格式**
（讓 `memory_add` / `people_add` 知道內容該塞在哪），prompt 裡的標籤是**組裝時的區塊邊界**，
由 code 保證。少了這層保證，檔案被改壞時 prompt 會靜默少一層邊界，而程式無從得知。

附加內容時**必須先剝掉包裝、接完再包回去**——直接往檔案尾端接會落到結束標籤外面，
那段內容就會跑出區塊。

`src/utils/tagged-file.ts` 提供共用處理，`memory_*` 和 `people_*` 都走它：

- `stripTag(content, tag)` — 去掉外層包裝
- `wrapTag(body, tag)` — 包回去（已經有就不重複包）
- `appendInsideTag(current, addition, tag)` — 在標籤內部尾端附加

缺少標籤的檔案會在下次寫入時自動補上。

### 檔案落點

agent 寫檔只有兩個目的地，由 `src/paths.ts` 定義：

| 常數 | 路徑 | 用途 |
|---|---|---|
| `ATTACHMENTS_DIR` | `workspace/attachments/` | agent 產出或下載的一切檔案 |
| `TRASH_DIR` | `workspace/.trash/` | 全域唯一回收桶，刪除一律 `mv` 到這 |

路徑不指定到絕對位置的話，agent 會依當下工作目錄各建一個，長出巢狀的
`workspace/attachments/.trash/`，以及沒有任何程式碼或文件依據的 `pages/`、`tmp/`。

約束寫在三個地方，缺一不可：

- `paths.ts` — 程式碼唯一來源，`dashboard.ts` 等寫檔處一律引用常數，不自己 `resolve`
- `bash.ts` 的 tool description — agent 決定「刪除／存檔要放哪」的當下讀到的就是它
- `AGENT.md` 的 File Locations — 涵蓋 `write_file`、`curl` 等其他寫檔路徑

只改其中一處沒有用：路徑常數管不到 agent 的自由發揮，而工具說明只覆蓋該工具。

### SKILL.md 的讀取

`src/skills.ts` 是讀 `workspace/skills/` 的唯一入口，`prompt.ts`（組 system prompt）
和 `tools/builtin/skill.ts`（skill_* 工具）共用：

- `parseSkillFrontmatter(content)` — 解析開頭的 YAML frontmatter，`description` 只取第一行
- `listSkillDirs()` — 列出 skill 目錄，目錄不存在回空陣列
- `readSkillMeta(dir)` — 讀某個 skill 的 SKILL.md metadata，讀不到回 `null`

集中在一處是因為這兩個呼叫端必須看到同一份解析結果——各自實作一份的話，
「system prompt 看到的描述」和「`skill_list` 回報的描述」會不一致。

注意 `loadSkills()` 只載入**已註冊在 `config.skills` 的目錄**——目錄存在不等於啟用，
`skill_list` 的 `active` / `inactive` 就是在區分這件事。
`memoryCharLimit` 只算標籤內的實質內容，包裝本身不吃額度。

### 人物維護

PEOPLE.md 的編輯走 `people_*` 工具，跟 `memory_*` 同構（substring 操作）。
不用 `write_file` 的原因：整份覆寫會弄丟 `<people>` 包裝標籤，
而且 agent 得先讀全文再重組，容易改壞既有條目。工具內部會確保標籤還在，並重建向量索引。

權限上 `people_add` / `people_update` **刻意不設 owner-only**——
agent 要能在非 owner 講話時記下對方是誰，鎖起來等於永遠記不了非 owner。
真正的權限判定看 `config.discord.owner_id`，不是 PEOPLE.md，所以寫入不會造成提權。
`people_remove` 是破壞性操作，維持 owner-only。

觸發時機寫在 `JOURNAL.md` 的三個 hook 裡（Memory Hook / Session Summarize / Daily Journal Step 3），
以及 AGENT.md 的 User Hierarchy 一節。三者都明確劃分：
**OWNER.md 記 owner 是誰，PEOPLE.md 記其他人是誰，MEMORY.md 記非人物檔案的規則與長期脈絡，日記記發生了什麼**。

### PEOPLE.md 的大小門檻

PEOPLE.md 會隨著認識的人變多而長大，不適合無條件塞進每一次請求
（目前 145 字元 ≈ 42 token，但 20 人的規模就會到 ~858 token/次）。

`config.prompt.peopleInlineLimit`（預設 1500 字元）控制行為：

- **小於門檻** → 直接內嵌全文。成本幾十個 token，換到稱謂和權限一定正確
- **超過門檻** → 只放一段 `<people-index>` 指標，說明檔案多大、
  要用 `read_file` 讀，以及什麼時機該讀（稱呼陌生使用者、做權限敏感操作前）
- **`0`** → 永不內嵌，一律走指標

檔案不存在或是空的時候兩者都不產生，不會留下空區塊。

## Session 管理

`src/session.ts` — 每個對話一個 JSON 檔案。

| 場景 | Session ID | 檔名 |
|------|-----------|------|
| CLI | `cli` | `workspace/sessions/cli.json` |
| Discord 頻道 | `discord-channel-{channelId}` | `workspace/sessions/dc-{channelId}__{頻道名}.json` |
| Discord DM | `discord-dm-{userId}` | `workspace/sessions/dm-{userId}__{名稱}.json` |

Session ID 是內部 routing key（不變）；檔名另外把長前綴縮寫成 `dc-` / `dm-`，
並帶上頻道名 slug 方便在資料夾裡辨識。頻道改名時 `setChannelName()` 自動 rename 舊檔。
分界符 `__` 讓掃檔能在 id 邊界精確比對，也相容尚未縮寫的舊檔名。

### Session 格式

Messages 可以是純文字 string 或 ContentBlock[]（含 tool_use；thinking 不保存）。每則新 message 另帶本機穩定 `searchId`，讓 active、compact、archive 與 restart reconciliation 對同一內容使用相同 deterministic document identity。舊 session 沒有 `searchId` 時，會依 session、ordinal、role、content 與時間建立穩定 fallback 並在 reconciliation 後寫回。session JSON 另有 `toolHistory`，保存完整 local tool input / result，和對話 context 分開。

```json
{
  "messages": [
    { "role": "user", "content": "<@id>(name): 內容", "time": "04/29 14:19", "msgId": "149...", "replyTo": "149..." },
    { "role": "assistant", "content": [{"type":"text","text":"回覆"}], "time": "04/29 14:19" }
  ],
  "toolHistory": [
    { "id": "toolu_...", "time": "04/29 14:20", "tool": "bash", "input": {"command":"npm run build"}, "result": "...", "isError": false }
  ]
}
```

### Compact 與歸檔流程

`/compact` 或自動 compact 會先把即將被 summary 取代的原始 messages 寫成 `*-compact-*.json` archive，並索引到 SQLite；JSON archive 寫入失敗就中止 compact、保留 active session 原樣。summary 只是 active context cache，帶 `isCompactSummary`，不是原始歷史；後續歸檔會略過它，避免重複或把 synthetic text 誤當對話。

`/new` 或每日 journal 觸發完整 session 歸檔：
1. Silent memory flush：注入 flush 指令到 systemPrompt，讓 agent 自由使用 memory tools 整理記憶
2. 原始 messages、usage 與 `toolHistory` 歸檔到 `workspace/sessions/archive/`；SQLite 只作搜尋索引，JSON 是耐久的 source of truth
3. 清空 active session

### Session 搜尋投影與 reconciliation

搜尋索引不再等待 session 結束：`Session.append()` 先同步寫入 active JSON，成功後才把該 message 轉成 `search_documents` + FTS + durable embedding job；一次 agent request 完成時，再建立保留前後文的 conversation-window document。工具紀錄由 `Session.recordToolEvent()` 同一路徑建立 call、result chunks 與 evidence summary。

compact、archive、Discord `/new`、CLI `new` 與 gateway startup recovery 都只呼叫 `reconcileSessionIndex()`。reconciliation 會重新從 durable session source 產生 deterministic documents 並 upsert 缺漏，不自行發明另一種 chunk/embedding 邏輯。Session 歷史跨 archive segment 是 append-only；active JSON 在 compact/clear 後只剩尾端，因此 session reconciliation 不使用「來源未出現就刪除」策略，避免把已歸檔歷史誤刪。Workspace 文件等真正代表完整當前狀態的來源，才使用 source-level remove-missing reconciliation。

固定 harness control message、onboarding context、compact synthetic summary不作一般 message document；compact summary 以獨立衍生 source type 保存，不能取代原始訊息。

## Discord Bot

`src/bot.ts` — Discord.js client，整合進 Gateway。

### 觸發條件
- **完全忽略頻道**：`discord.ignored_channels` 列到的 channel / thread ID，在 `MessageCreate`
  handler **最早期**（自己訊息判斷之後、任何觸發判定與 session 建立之前）就 `return`，
  透過 `src/utils/ignored-channels.ts` 的 `isIgnoredChannel()` 精確比對 `message.channelId`。
  命中時既不觸發也不記錄，即使該訊息 @ bot、reply bot、來自 DM，或該頻道之後被列入
  `ambient_channels`。thread **不繼承** parent（thread 有自己的 ID）。此清單優先權高於所有
  其他觸發條件，是最高優先的靜默閘門。開源核心不寫死任何頻道 ID，實際 ID 只放在正式
  `config.yaml`。
- 被 `@mention` 或收到 DM
- **Ambient 頻道**：`discord.ambient_channels` 列到的 channel ID，不用 `@` bot 直接講話就會回。
  只精確比對 `message.channelId`，底下開的 thread **不繼承**（thread 有自己的 ID，要就自己列進去）。
  是否回其他 bot 依 `respond_to_bots`。
- DM 只回 owner（`config.yaml` 的 `owner_id`）
- Guild / channel 白名單過濾；ambient 頻道視同已通過 channel 白名單
  （兩份清單同時存在時，以 ambient 為準）

觸發判定只做在 `bot.ts`，AGENT.md 不提。同一個判斷寫在程式和 prompt 兩個地方會分岔，
所以 AGENT.md 只保留 `[context]` 前綴的旁聽訊息不要回這一條。

### 訊息處理
- **同 session 串行化**：Discord.js 不會等待 async `MessageCreate` listener；若同頻道短時間連續進訊息，原本會各自載入 `Session` 並同時跑 `ask()`，造成檔案互相覆寫、後一則提早混入前一輪 context、回覆順序顛倒。`bot.ts` 因此用 process-local keyed Promise queue，以 session ID 為 key，把 session 建立、starter/onboarding、訊息格式化與 append、agent 執行、進度及最終 Discord 送出包在同一個 task；上一個 task 完整結束後下一個才開始。不同頻道／DM 的 key 不同，仍可並行。task 失敗只拒絕該 caller，queue tail 會吸收錯誤讓後續繼續；清理時以 Promise identity 比對，避免舊 task 的 finally 誤刪已有新工作接上的 chain。排在既有 trigger 後方的 context 訊息即使 session 檔尚未建立，也會因 queue 已存在而保留；會讀寫／歸檔 session 的 `/new`、`/compact` 也先 defer interaction，再進同一條 queue。
- **Session 隔離**：未被觸發且 session 不存在 → 不記錄。一旦 bot 被觸發，該頻道的所有訊息才會 append
- Content 格式：`<@userId>(帳號名｜暱稱): 內容`
- Mention 正規化：`<@userId>` → `<@userId>(帳號名｜暱稱)` 進 prompt，輸出時 strip 括號。
  `username` 是身分依據（全域唯一且穩定），暱稱只用於稱呼。暱稱為寫入當下的快照；
  兩者相同時只留一個，DM 無 guild 時只有 username。
- 稱呼的優先序（寫在 AGENT.md）：persona／PEOPLE.md 指定的稱呼 > 暱稱 > username。
  暱稱只是預設值，PEOPLE.md 指定了就以它為準。
- Thread/論壇貼文首次進入時以 `[System]` user message 存入 starter message

### 長訊息分段
Discord V1 的 `content` 單則上限為 2,000 字元。一般回覆、slash command 回覆與 Gateway 主動推送共用
`utils/chunk-message.ts` 以 2,000 字元分段；若切點落在 fenced code block 內，前一段會自動補上關閉 fence，
下一段以相同語言標記重新開啟，避免 diff、log 等長 code block 吞掉後續文字。

### Discord 訊息模型

Furet 的 Discord 輸出統一使用標準 V1 訊息 payload：

- `src/utils/discord-message.ts` 統一建立一般訊息、interaction reply、message edit 與重啟後 raw webhook PATCH 的 `content`、附件、legacy action-row buttons 與 allowed mentions payload；文字一律放在標準 `content`，不採用 component-only message payload。
- Slash command 的一般文字回覆、`/new`、聊天、工具進度、cron、reminder、Forum starter、Discord send/edit tool、外掛 text transport 與按鈕訊息共用這個 V1 輸出層。`deferReply()` 只負責 interaction acknowledgement，內容由後續的回覆 payload 提供。
- 需要卡片欄位、橫向 inline 資訊格或 Embed 排版的輸出使用 Legacy Embed；目前 `/status` 與有內容的 `/task` 屬於此類。一般聊天與純文字狀態不為了視覺一致性硬套 Embed。
- 本機檔案以 Discord V1 的一般 attachments 上傳；圖片和其他檔案都由 Discord 的原生附件顯示處理。
- Discord 輸入解析涵蓋一般 `message.content`、Embed 的 author/title/description/fields/footer，以及一般 uploads 與 Embed image/thumbnail。為了讓重啟前的歷史 component-only 訊息仍可被引用，`extractMessageText()` 另有唯讀遞迴文字相容解析；它不參與任何新訊息輸出。極少數重啟中的舊 interaction response 若被 Discord 拒絕以 `content` 編輯，會只針對該既存 response 以原格式完成「重啟成功」更新。`discord_fetch_message`、channel history、Forum starter、回覆圖片與輸入格式化共用 `extractMessageText()` / `extractMessageAttachments()`。
- Modal、autocomplete、reaction、typing 與 pin 不屬於 message payload。
- 按鈕狀態更新也共用 V1 migration policy：若按鈕訊息是歷史 Components V2，第一次狀態更新會建立帶相同 custom IDs 的 V1 替代訊息、刪除舊訊息，並把新的 message ID 寫回按鈕狀態檔；工具動作只會在遷移成功後執行。

### 漸進式進度訊息
Tool call 執行時即時顯示進度（`→` / `✓` / `✗`），完成後替換成最終回覆。防抖 1 秒避免 Discord rate limit。

Agent 在 tool call 之間產生的文字以 `> 引用` 併進同一則進度訊息（`ProgressEvent` 的 `text`）。
這些文字只存在於 session，不在 `ask()` 的回傳值裡——回傳的是最後一輪、沒有 tool call 的文字。
純過場，最終回覆會覆蓋整則訊息，不另發訊息。emit 點在執行工具之前，順序才與實際動作一致。
單段上限 300 字，整則超過 1900 字截尾，保留在 Discord V1 的 2000 字元上限內；`text` 事件不套用防抖。

### 靜默回覆哨符（`[no_reply]`）
一般 Discord 對話與排程 / 提醒**共用同一套哨符判定**：當模型**最終**文字回覆整則就是
`[no_reply]` 時，不向下游送出任何訊息。一般對話由 `handleTrigger` 直接刪掉進度訊息後 return；
排程與提醒由 `gateway.ts` 判定為 no-reply 後不推播（cron 的 `on_event` 模式下代表「正常、無事可報」）。

光有輸出攔截不夠：模型若不知道哨符存在，就永遠不會主動選擇它。但這項規則也不能只放在
使用者可精簡或整份替換的 `workspace/AGENT.md`。`src/prompt.ts` 因此對 Discord trigger 固定生成
`<runtime-policy>`：每回合自行在文字、reaction + 文字、reaction-only、完全不互動之間選最輕的
適當回應；reaction-only 或不互動時，工具做完後最終只回 `[no_reply]`。有實質內容的直接問題或
請求原則上仍要文字回覆，不能拿靜默逃避工作；mention 與 DM 只代表 Discord 的傳輸／路由形式，
本身不構成必須回文字的理由，仍應依訊息意圖判斷。`[context]` 旁聽訊息禁止文字回覆，可視情況
只按 reaction，再以哨符收尾。

這個分工讓 code-owned runtime policy 負責「何時自主安靜」與哨符語法，輸出邊界負責「真的不要
送出去」，而 cron 的 `on_event` runtime context 再針對「正常無事」加強一次。`AGENT.md` 不再承擔
這個程式協定；它只保留可由使用者客製的工作方式。也不能只放在 cron tool description：那只在
建立排程時可見，既管不到一般聊天，也不保證未來觸發排程的模型仍記得。

判定集中在 `src/utils/no-reply.ts` 的 `isNoReplySentinel()`，`bot.ts` 與 `gateway.ts` 都 import
它，不再各自實作：**trim 後整則相等、大小寫不敏感**，`[no_reply]` / `  [NO_REPLY]  ` 都算。
刻意不是 `includes`——一般對話的回覆常夾帶說明文字，`includes` 會把「我先不回好了，[no_reply]」
這種含實質內容的訊息整個誤吞。因此哨符只在整則就是它本身時才生效，夾帶其他文字時**不**生效。

Canonical token 統一為 `[no_reply]`。程式生成的 prompt 與 tool schema 都從
`src/utils/no-reply.ts` 匯入 `NO_REPLY_TOKEN`，避免 runtime 字串各自寫死；code-owned `<runtime-policy>`
也用同一常數生成，讓模型一定知道如何輸出，不依賴 `AGENT.md`。架構文件只記錄協定。helper 另外接受早期排程用過的 legacy alias
`[noreply]`（無底線）以相容既有 crons，但不在任何 prompt / 文件裡宣傳。

攔截點在下游輸出邊界：一般對話是 `bot.ts` 的 `handleTrigger`，排在既有 `!response.text` 空文字
分支之後；排程與提醒是 `gateway.ts` 各自的執行段。它們都不動 agent 串流、核心執行迴圈或工具流程，
session 照常記錄該回合。

### Discord 按鈕工具

`discord_send_buttons` 是通用的 Discord component 工具，不把「確認流程」、私人外掛或特定服務寫死在主程式。呼叫端自行提供訊息內容、1–25 顆按鈕、標籤、樣式與行為；每列最多 5 顆、每則訊息最多 5 列。「確認／修改／拒絕」只是其中一種組合，不是工具固定的 UI 或語意。

每顆按鈕支援三種底層行為：

- **`execute`**：在 `discord-owner` request context 中呼叫指定的已註冊 tool 與參數；仍經過 `executeTool()` 的 owner-only、model gate 與 plugin availability 檢查。
- **`edit`**：開啟 Discord Modal，修改指定 `execute` 按鈕之 action args 內一個 top-level string 欄位，修改後按鈕組保持可操作。可選擇把該欄位設為動態 preview，讓原訊息同步更新。
- **`close`**：關閉整組按鈕，不執行外部 action。顯示文字由呼叫端提供，不預設代表拒絕或取消。

按鈕狀態持久化在 `workspace/config/furet.db` 的 `discord_button_messages` 表，因此訊息建立後即使 Gateway 重啟，既有按鈕仍能找到對應 action。生命週期與 Discord message ID 是可索引欄位；按鈕定義、action args、允許使用者與逐顆結果保留為 JSON 欄位，兼顧查詢／原子狀態轉移與 payload 彈性。Gateway 啟動時會把舊版 `workspace/config/discord-buttons.json` 以單一 transaction 匯入 SQLite，確認成功後才把舊檔移到 `workspace/.trash/`；匯入失敗則停止接受 Discord 流量，不會靜默遺失尚未操作的按鈕。每組按鈕有到期時間，並支援兩種互動模式：預設 `group` 在第一個 execute／close 後結束整組；`independent` 則讓每顆 execute 各自執行，完成後只停用該顆並保留其他按鈕，全部處理完才把整組標成完成。每組按鈕可指定 `allowed_user_ids`；省略時只允許 `config.discord.owner_id`。未列入者只收到 ephemeral 拒絕訊息。允許非 owner 點擊時，action 會以 `discord-other` request context 執行，因此仍不能繞過 owner-only tool 權限。

Button message 會停用 allowed mentions，避免外部文字或草稿意外 ping 使用者。`group` 模式執行 action 前，會在 SQLite transaction 內確認目前仍為 `pending` 才原子轉成 `processing` 並移除按鈕；`independent` 模式用 process-local execution set 鎖住單顆按鈕，顯示暫時的處理中狀態，成功或失敗後再以 transaction 持久化該顆結果。快速重複點擊不會讓同一組 group action 重複取得執行權，並行更新也不再靠整份 JSON 的 read-modify-rename。Modal 目前只修改一個字串欄位。

### Slash Commands
- `/new` — silent memory flush + 歸檔 session + AI 重新打招呼
- `/status` — 顯示 model / tokens / sessions / crons / reminders / plugin jobs / plugins / skills
- `/restart` — 重啟 gateway（spawn detached child）
- `/model` — 切換目前 session 的 AI 模型與思考等級（模型名稱 autocomplete from that session profile’s `GET /models` discovery；effort 省略時為 default）
- `/google-auth` — Google OAuth 授權流程
- `/task` — 列出 Google Tasks
- `/plugin` — owner-only 外掛管理入口；必填 `動作` 選安裝／更新／卸載，共用 `目標` string：安裝時自由輸入 GitHub URL，更新／卸載時依 `動作` autocomplete 已安裝外掛，更新省略目標代表全部

### Application Emoji（自訂表情）

`src/emoji.ts` — 讓 bot 在自己的訊息裡使用 Application 專屬 emoji（`client.application.emojis`，不隸屬任何 guild）。通用開源核心，**不寫死任何使用者的 emoji ID、名稱或圖片**；個人化語意（每顆 emoji 的 meaning / 場合 / 頻率）不在此核心，屬另列的可選擴充。

**資料流**

1. **同步**：Discord `ClientReady` 時 `bot.ts` 呼叫 `syncApplicationEmojis(client)`，用 `client.application.emojis.fetch()` 抓 Application 自己擁有的 emoji，建成記憶體快取（`name → { id, animated }`）。這是唯一資料來源，不讀任何寫死清單。
2. **注入 prompt**：`prompt.ts` 只在會送往 Discord 的回合（`discord-owner` / `discord-other` / `cron` / `reminder`），透過 `buildEmojiPromptSection()` 把精簡的 `:name:` 清單與一句輸出語法說明包成 `<application-emojis>` 注入 system prompt。無可用 emoji 時回空字串，**不加空泛區塊**。
3. **解析送出**：模型以穩定語法 `:name:` 引用。所有 Discord 文字出口在最終化文字後、`chunkMessage()` 分段前呼叫 `resolveEmojiMarkup()`，把已快取的名稱換成 Discord 接受的 `<:name:id>`（動畫為 `<a:name:id>`）。涵蓋一般回覆與 `/new`（`bot.ts`）、cron / reminder 主動推送（`gateway.ts` 的 `sendToChannel`），以及 Discord message/edit/forum/button/reaction 工具出口；全部共用同一支解析器。
4. **重新同步**：啟動同步負責首載。之後 `getEmojiCatalog()` / `resolveEmojiMarkup()` / prompt 組裝前會做 **lazy TTL refresh**（`EMOJI_CACHE_TTL_MS`，10 分鐘）：距上次成功同步超過 TTL 就觸發一次**非阻塞**背景刷新（本輪先用既有快取，結果供下一輪），有 in-flight 旗標避免並發互相覆寫。新增／刪除 emoji 後最多一個 TTL 反映，**不需 slash command 或額外 UI**。

**Token 控制**：prompt 只放名稱清單 + 一句語法，刻意不逐顆描述語意，也不放 raw ID；只在 Discord 對話與可能推播到 Discord 的 cron/reminder trigger 注入；CLI／journal 不付這個 token。

**失敗降級**：`syncApplicationEmojis()` 吞掉所有錯誤、記錄**原始 Error**（`{ err }`，保留 cause / code），回傳成功與否但**永不拋出**；ready handler 因此不會因它啟動失敗。同步失敗時快取維持空的（安全的無 emoji 模式）：prompt 不加區塊、解析器直接回原文，訊息照常送出。

**安全邊界**：
- 名稱不在快取時 `resolveEmojiMarkup()` **保留原文 `:name:`**（可讀降級），**絕不捏造 ID**。
- **不解析 code fence（``` / ~~~）與 inline code span（成對 backtick）內的文字**，避免範例、log、程式碼裡的 `:name:` 被替換；跨行 fence 的判定要求對整段文字（而非個別 chunk）解析，因此解析一律在分段前做。
- 名稱比對限 Discord 合法字元 `[A-Za-z0-9_]{2,32}`；快取為空時整條路徑零成本 short-circuit。

## Gateway

`src/gateway.ts` — 常駐程式，統一管理所有背景服務。

| 服務 | 說明 |
|------|------|
| Cron 排程 | 每 1 小時重新載入 crons.json，執行到期任務 |
| Reminder | 一次性提醒，每 15 秒輪詢 reminders.json 掃到期的，觸發後自動刪除 |
| Journal | 每天固定時間：使用 `journal.model` 指定的獨立模型 silent flush 所有 active session → 歸檔 → 重寫日記 → 更新 MEMORY.md |
| Soul Guardian | 可選的 deterministic 內建排程，直接執行完整性檢查並把 drift 送到指定 Discord 頻道；不經 LLM，重複未處理 drift 以 fingerprint 去重 |
| Discord Bot | 有 token 且 enabled 時啟動 |
| Plugins | 背景服務接流量前先 `loadPlugins()`；Discord 啟用時待 client ready 後才 `startPlugins()`，再註冊含外掛在內的 slash commands。Discord 停用或登入失敗時仍啟動非 Discord 能力，message transport 會明確拒絕。shutdown 時 `stopPlugins()`（見 Plugin 系統） |
| PID file | `furet.pid`，啟動時殺掉舊進程確保單實例 |

日記重寫（Daily Journal Step 1）讀的是 `journal_transcript_by_date` 產生的**當天乾淨對話投影**，每日檔的 diary_note 補註只當輔助。transcript 是完整的對話紀錄；diary_note 僅補充明確背景、有證據的當下反思、跨日關聯與附件／工具脈絡，不重複記錄事件，也不把未確認的情緒推測寫成事實。

`diary_note` 是補充性的日記註記，不是事件記錄，因此不能成為日記骨架。它只保存 transcript 無法保留的明確背景、有證據的當下反思、跨日關聯，以及附件或工具結果的必要脈絡；不得把推測的心理狀態寫成事實。Daily Journal prompt 以 transcript 為唯一事實來源，找出整天的主線，把相關的起因、行動、反應與結果融合成有脈絡的第一人稱段落；diary_note 只作為輔助色彩織入。正文以連續散文為主，只有真正的清單才用 bullet；實作命令、檔名與中間步驟只保留足以理解事件意義的部分，避免成品退化成 changelog、工作報告或分類後的流水帳。這項規則必須同時維護 runtime `workspace/JOURNAL.md` 與 `templates/JOURNAL.md`。部署時使用 `scripts/migrate-diary-note.ts` 做精確、可重跑的段落遷移與舊名稱掃描，不得整份 template 覆蓋客製 workspace。Apply 前必須完成 projected-state preflight 並指定 backup directory；兩個 runtime 檔先寫 temp，再逐一 rename，任何失敗都從備份回滾整組檔案，避免半套切換。

### 背景工作的模型路由

- Cron 與 Reminder 有 `channel_id` 時，執行端會載入該 Discord channel／thread／DM 對應 session 的 `modelSettings`，只借用它解析 request-scoped LLM profile；排程 prompt 不重播聊天歷史，產生的推播仍由 `sendAndPersist()` 寫回目標 session。沒有 `channel_id` 或無法解析 Discord session 時，使用 active connection profile 的預設模型。
- Journal 不跟隨任何 conversation session。`journal.model` 是整條日記流程的獨立模型設定，涵蓋每日 silent memory flush、session archive 前整理與最終日記重寫；留空才使用 active connection profile 的預設模型。
- 上述 profile 都在每次背景工作開始時解析成 immutable request profile，同一輪不受並行 `/model` 變更影響。
- 每次 Agent request 的 system prompt 都會注入非敏感的 `<llm-context>`，包含該輪已固定的 profile name、protocol、model 與 reasoning effort。模型因此能準確回答自己當下使用的路由，不需從模型名稱或全域 config 猜測；base URL、auth、API key 與 capability 細節不注入。Profile/model 文字以 JSON string escaping 維持單行，不能偽造 prompt 區塊邊界。

### Reminder 用輪詢而不是 setTimeout

`tickReminders()` 每 15 秒讀一次 `reminders.json`，把 `triggerAt <= now` 的撈出來執行。
不用「每筆一個 `setTimeout`」是因為：

- `setTimeout` 的 delay 是 32-bit signed，超過 `2^31-1`（約 24.8 天）會溢位變成**立即觸發**
- 記憶體裡的 timer 會跟檔案不同步，手動編輯 `reminders.json` 改時間不會生效
- 停機期間錯過的提醒會被靜默丟掉

輪詢下檔案是唯一真相，間隔多長都行，停機錯過的下次掃到就補發（不設時間門檻，
log 會記 `lateBySec` 標示遲了多久）。精度 15 秒。

兩個防重複機制：觸發前**先**從檔案移除再跑 `ask()`（中途崩潰不會重播），另外用
`runningReminders` Set 擋住同一筆在上一輪還沒跑完時被下一輪重複撈到。

### cron / reminder 的 prompt 是「給未來的自己的指令」

存進 `crons.json` / `reminders.json` 的 `prompt` **不是**預先寫好、到時候原文送出的訊息，
而是給未來的自己的指令；觸發時 gateway 把它包上 context 丟進 `ask()`，agent 當下產生的
回覆才是使用者收到的內容。

這樣才有 agent 的價值（觸發當下可以查行事曆、算天數、看當下 context），也才能配合補發 ——
文字寫死「現在剩三天」的話，遲送就是錯的；寫成「算一下還剩幾天再告訴她」才會在送出當下算對。

詳細寫法指引放在 `gateway.ts` 觸發時包的那層 context，**不放在 tool description**：
tool description 每次請求都要送，觸發 context 只在觸發時付一次。schema 那邊只留一句話。

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

`src/tools/registry.ts` — 統一管理所有 tool，並且是**工具分級（exposure）的唯一來源**。
新增 tool 只需：
1. 在 `tools/builtin/` 建立檔案，導出 `Tool` 物件
2. 在 `registry.ts` import，用 `reg(tool, exposure, group, { keywords, aliases, modelPredicate })`
   加進 `baseRegistrations`

`Tool` 介面本身不變；分級 metadata 包在 registry 端的 `ToolRegistration`（`tools/metadata.ts`）：
`exposure`（`native` / `match` / `index` / `on-demand`）、`group`、`keywords`、`aliases`、
`signals`、`modelPredicate`。builtin 檔因此不用為了分級而改介面。module load 時會驗證工具名唯一、
exposure 合法、`match` 至少有 keyword/alias/signal。

`executeTool(name, args)` 是**唯一執行入口**：owner-only 判定、bash allowlist、`read_file`
路徑 guard 都在這裡。`executorMap` 與 owner-only 權限跟分級共用同一份註冊資料。
`getToolDefinitions(ctx)` 每輪算出要送 API 的工具清單、`renderToolIndex()` 產生 `<tool-index>`、
`getRegistration(name)` 供進度顯示查目標工具，全部由 registry 對外導出，`agent.ts` 不自行 filter。Registry 輸出 protocol-neutral function definition；adapter 才轉成 provider wire schema。

### Tool 列表

能力概覽，方便一眼看完 agent 能做什麼。**實際註冊清單以 `src/tools/registry.ts` 為準**——
新增 tool 時如果只改了 registry 沒回來補這張表，以 registry 為對。

| Tool | 說明 |
|------|------|
| `bash` | 執行 shell 指令 |
| `read_file` | 讀檔 |
| `write_file` | 寫檔 |
| `get_weather` | OpenWeatherMap 天氣查詢；先以 Direct Geocoding 解析地點，再用經緯度取得目前天氣與預報，並為容易誤判的地名提供明確別名 |
| `diary_note` | 追加 transcript 無法保留的日記補註，並透過統一搜尋索引建立可重建 projection；不做事件流水帳 |
| `memory_search` | Permission-aware 統一 hybrid search；偏重人物、長期記憶、日記與重要對話證據 |
| `memory_list` | 列出所有記憶檔 |
| `memory_add` | 在 MEMORY.md 新增條目（有字數上限） |
| `memory_replace` | 用 substring match 更新 MEMORY.md |
| `memory_remove` | 用 substring match 刪除 MEMORY.md 條目 |
| `people_add` | 在 PEOPLE.md 新增一個人 |
| `people_update` | 用 substring match 更新 PEOPLE.md |
| `people_remove` | 用 substring match 刪除 PEOPLE.md 條目（owner-only） |
| `cron_create/list/delete/toggle/update` | 排程管理 |
| `reminder_create/list/delete` | 提醒管理 |
| `discord_fetch_message/channel_messages` | 抓 Discord 訊息 |
| `discord_send_message/react/pin/unpin` | Discord 互動 |
| `discord_send_buttons` | 發送 1–5 顆可自訂標籤、樣式、可操作使用者與行為的按鈕；可執行 tool、開 Modal 修改參數或直接關閉 |
| `discord_create_thread/forum_post/delete_thread` | Discord 討論串 |
| `discord_edit_message/delete_message` | 編輯/刪除 bot 訊息 |
| `discord_attach_to_reply` | 附件到回覆 |
| `image_gen` | GPT-only：Responses API 原生 `image_generation`；支援 canonical identity、最多 4 張 attachments 參考圖，以及有路徑邊界檢查的分類目錄／描述性檔名，直接以最終路徑存檔並排入回覆附件（owner-only） |
| `web_search` | 只透過 request-scoped active model 使用 Responses hosted web search；不跨模型 fallback |
| `web_fetch` | 本地 SSRF-safe HTTP(S) 讀取與 bounded text extraction |
| `code_execution` | 顯式 capability tool；未設定 provider sandbox 時回報 unavailable，不以 host bash 代替 |
| `google_calendar_*` | Google Calendar CRUD |
| `google_gmail_*` | Gmail 搜尋/讀取/寄信/草稿 |
| `google_drive_*` | Drive 搜尋/讀取/上傳 |
| `google_tasks_*` | Tasks 列表/建立/完成/刪除 |
| `soul_guardian_*` | 核心檔案保護（status/check/approve/restore/history） |
| `session_search` | 與 memory_search 共用 `searchUnified()`，但限定／偏重對話、工具、compact summary 與附件來源 |
| `sessions_by_date` | 依日期（YYYY-MM-DD）撈當天所有歸檔 session 的原始內容，供除錯／稽核 |
| `journal_transcript_by_date` | 依日期產生移除工具與 harness 雜訊的對話投影，供日記重建 |
| `skill_install/uninstall/list` | 技能管理 |
| `usage_dashboard` | 用量／成本儀表板，輸出 PNG 到 attachments/ |
| `discord_bot_mention_toggle` | 切換是否回應其他 bot |
| `tool_catalog` | native 探索／代理入口：list_groups / search / describe / call，`call` 委派回 `executeTool()`（見 Tool Exposure） |
| `self_evolve` | 使用 request-scoped active model 修改自身代碼，sub-ask 模式；不另切 coding model |

### Tool Exposure（分級曝光）

**曝光層只管理模型每輪看見多少工具資訊；權限仍由 `executeTool()` + `OWNER_ONLY_TOOLS` +
trigger + 各工具確認規則負責。隱藏工具不等於降權，surface 工具也不等於提權。**

由 `config.tools.exposure.enabled`（feature flag，預設 `false`）控制：

- **關閉** → 行為與分級前完全一致：所有符合 model gate 的本地 function tool 都送，GPT-only
  `image_gen` 對非 GPT 仍過濾。一鍵 rollback 就是把 flag 設回 `false`。
- **開啟** → 每輪只送必要工具的 schema，其餘走 `tool_catalog`。

四個等級（`tools/metadata.ts` 的 `ExposureLevel`）：

- `native`：每輪都送完整 schema（`tool_catalog` / `bash` / `read_file` / `write_file` /
  `diary_note` / `memory_search` / `people_add` / `people_update` / `discord_react` /
  `discord_attach_to_reply`）。`web_fetch` 與顯式 web/code capability tools 同樣由 registry 管理。
- `match`：由 `matchTools()` 這個 **deterministic** matcher（不另呼叫 LLM）依當輪 prompt 的
  中英文 keyword、alias、名稱，或工具明確宣告的日期時間／圖片附件 signal 命中才送。命中有上限
  `config.tools.exposure.max_matched_tools`（預設 12，clamp 1–50，native 不計入），
  排序 exact name/alias > 多 keyword > 單 keyword/signal。signal 必須由每個工具在 registry 明確宣告；目前 `hasDateTime` 用於排程／日曆候選，`hasImageEditRequest`（附件加上修圖語意）用於圖片編輯；`hasAttachment` 保留給確實需要所有圖片附件的外掛。圖片關鍵字使用「幫我畫」「畫一張」等詞組，不使用單字「畫」，避免「計畫」誤觸。
- `index`：不送 schema，只在 `<tool-index>` 列出所屬能力群，需要時走 `tool_catalog`。
- `on-demand`：不進 `<tool-index>`，只有使用者點名或 `tool_catalog.search` 才找得到；
  給破壞性 / 不可逆 / 極低頻工具（delete 類、soul_guardian approve/restore、skill install/uninstall）。

`tool_catalog`（`tools/builtin/tool-catalog.ts`）是統一探索／代理入口，永遠 `native`：

- `list_groups` 列 index+match 可見能力群（on-demand 不列）；`search` 搜尋**所有**非 native
  註冊（含 on-demand），可用 `query` 查單一意圖，也可用 `queries` 在一次 tool call 內分別評分最多
  8 個互不相關的查詢，避免把不同能力需求壓成同一袋關鍵字；`describe` 回 description + input schema；
  `call` 代理執行。
- **`call` 一律委派回注入的 `executeTool()`**，不碰 executor map，因此 owner-only、bash
  allowlist、read_file guard、寄信/刪除確認全部照舊生效；`call` 拒絕呼叫自己（不遞迴）；
  unknown tool / 權限不足 / schema 錯以純字串回給模型。輸出視為 untrusted metadata。
- 避免循環 import：registry 建 catalog 時**注入** `executeTool` 與註冊清單，catalog 不 import
  registry。

`agent.ts` 端：`getToolDefinitions()` 每輪算清單傳給 `callOpenAIChat()`；`withTools=false` 的
compact 流程仍完全不送工具。模型透過 `tool_catalog` `describe`/`call` 點到的工具會被加進
request-scoped `enabledTools`，後續回合可直接暴露其 schema；進度顯示標成
`tool_catalog → <target>`，tool history 照常留稽核證據。`image_gen` 的 hosted-image capability gate 由
`modelPredicate` 在 `getToolDefinitions` 與 legacy 清單兩處都套用，catalog 不繞過。

## Plugin 系統（私有外掛）

對外掛作者的完整規格、可執行範例、安全檢查表與疑難排解見 [`docs/PLUGINS.md`](../docs/PLUGINS.md)。本節保留核心內部設計與不變量。

`src/tools/plugin-loader.ts` + `src/tools/plugin-types.ts` — 讓受信任的本機外掛從 `config.yaml` 指定的路徑載入並註冊工具、背景工作、Discord slash command 與事件，**不需修改 `src/tools/registry.ts`**，也不把私人連線資料寫進 repo。

### 安裝與管理

`src/plugin-manager.ts` 是 CLI 與 Discord 共用的 managed plugin service；`src/plugin-cli.ts` 提供 host-side 入口，`src/bot.ts` 的 owner-only `/plugin` 提供日常 Discord 入口：

```bash
furet plugin install <git-url-or-local-path> [--workspace <package-name-or-path>]
furet plugin list
furet plugin enable|disable <name>
furet plugin update [name]
furet plugin remove <name>

/plugin 動作:安裝 目標:https://github.com/owner/repository/tree/main/packages/example-plugin
/plugin 動作:更新 [目標:<autocomplete from installed plugins>]
/plugin 動作:卸載 目標:<autocomplete from installed plugins>
```

- Discord 只暴露一個 owner-only `/plugin` 指令，不使用 subcommand；必填的 `動作` choice 選擇安裝、更新或卸載，共用的選填 `目標` string 依動作解讀。安裝時自由輸入公開 HTTPS GitHub 連結；若連結是 `/tree/<branch>/<path>` package URL，介面層先用 `git ls-remote --heads` 對遠端 refs 做最長前綴比對，因此 branch 名稱可包含 `/`，再拆出 workspace path 並委派 managed plugin service。更新／卸載時 autocomplete 依目前的 `動作` 回傳 managed plugin registry；更新省略 `目標` 代表更新全部，安裝與卸載則在執行時驗證目標必填。這種設計避免 Discord 把三個 subcommand 顯示成三列，同時保留安裝網址自由輸入與已安裝外掛選單。每次互動都直接比對 caller ID 與 `config.discord.owner_id`，不接受 guild role 或 channel allowlist 代替 owner 身分；安裝在 clone、dependency install 與 build 前先 defer interaction。
- CLI 保留 list／enable／disable／update，以及本機目錄、SSH 或其他 Git URL 等維運功能；Discord UX 不暴露 list／enable／disable 這些低頻操作，也不提供 auth 流程。私有 repository 由主機既有 Git 認證或 SSH 設定處理。
- CLI 與 Discord 只負責解析輸入、授權與呈現結果，install/update/remove 都委派同一組 `plugin-manager.ts` 函式，避免兩套管理邏輯分岔。
- Managed checkout 固定放在 `workspace/plugins/`，安裝來源、package 對應與啟用狀態都記在 mode `0600` 的 `workspace/config/plugins.json`；runtime loader 會把 managed registry 與 `config.yaml` 的手動外掛合併，重複路徑以手動設定為準。這讓容器可維持唯讀掛載 `config.yaml`，Discord 安裝仍只需寫入 workspace。
- plugin package 必須在 `package.json` 宣告 `furet.plugin`（package 內的相對 entry path）；可選 `furet.name`，否則用去掉 npm scope 的 package name。安裝器拒絕絕對路徑與 `..` 逃逸。
- Git 來源 shallow clone；本機目錄則複製進 managed area。安裝／更新會執行 `npm install`，並在 package 有 `build` script 時執行；npm workspace monorepo 可用 package name 或相對路徑選定。這些 scripts 等同執行受信任程式碼，不能把 installer 當 sandbox。
- 每次安裝擁有一份獨立 checkout，即使多個 plugin 來自同一個 monorepo 也不共用。這讓 uninstall 可以把該次安裝建立的 package、`node_modules`、lockfile 與原始碼整份移除，不必猜哪些 artifact 仍被別的 plugin 共用。`update` 會建立新的 staged checkout、重裝 dependencies、重建該 plugin，驗證 identity／entry 後原子替換；local copy 不做 in-place update。
- enable／disable／install／remove 只改持久設定，**不自動重啟 gateway**。remove 會在同一次操作中移除 registry record，並把該 plugin 的專屬 checkout 與 `workspace/config/plugins/<name>.yaml` 一起移到 `workspace/.trash/`；registry 寫入失敗時兩者都回復。若讀到舊版共用 checkout，單顆卸載會完整失敗且不修改任何資料，不會假裝成功卻留下 package、`node_modules` 或 lockfile；應先一起移除該來源的舊 plugins，再按需重新安裝。
- 仍保留手動 `config.plugins` path，方便開發中的單檔 module；installer 是正式 UX，不是 loader 的必要依賴。

### 設定

`config.plugins`（預設空陣列）每筆 `{ path, enabled }`：

- `path`：外掛模組路徑，**絕對**或**相對 Furet root**（`src/paths.ts` 的 `ROOT`）。相對路徑一律對 `ROOT` 解析，不依當下工作目錄——CWD 會漂移。
- `enabled`：`false` 直接跳過。省略 `enabled` 視為 `true`。
- 正規化在 `config.ts` 的 `mergePluginsConfig()`：非物件、`path` 非字串或空的條目直接丟棄，畸形設定不會讓 config load 崩潰。

每顆已載入外掛另有自己的 `workspace/config/plugins/<manifest.name>.yaml`。`src/plugin-config.ts` 在外掛載入時建立空 YAML，並提供結構化 `read(defaults)`、`write()`、`update()`；寫入採 mode `0600` 與原子 rename。設定與 `workspace/plugins/` 的 managed checkout 分離，因此更新或重裝原始碼不會覆蓋部署設定。

外掛設定中的 `schedules.<id>` 是主架構保留區，可覆寫該外掛宣告的 `enabled`、`schedule`、`timezone`；載入時會重新跑 cron 與欄位驗證。外掛自己的頻道、顯示選項等欄位由外掛透過同一個 config store 管理。秘密仍優先放 `.env`，不寫進公開 repository、tool description 或錯誤訊息。

### Plugin API（穩定介面）

外掛模組 default export（或直接匯出同形狀的 namespace）為 `PluginModule`。`tools`、`schedules`、`events` 都是可選能力；至少要宣告一項，讓只做背景工作的外掛不必硬塞一個工具。

```typescript
interface PluginModule {
  manifest: {
    name: string;
    start?: (context: PluginRuntimeContext) => Promise<void> | void;
    stop?: (context: PluginRuntimeContext) => Promise<void> | void;
  };
  tools?: PluginToolRegistration[];
  schedules?: PluginScheduleRegistration[];
  commands?: PluginSlashCommandRegistration[];
  events?: PluginEventRegistration[];
}

interface PluginScheduleRegistration {
  id: string;                     // plugin 內唯一；runtime key 為 <plugin>:<id>
  name?: string;
  schedule: string;               // node-cron expression（五欄，亦支援 seconds 欄）
  timezone?: string;              // IANA timezone
  timeoutMs?: number;             // 超時告警；callback 不會被強制中止
  run: (context: PluginRuntimeContext) => Promise<void> | void;
}

interface PluginEventRegistration {
  event: "journal:completed";
  id: string;
  timeoutMs?: number;
  run: (payload: JournalCompletedEvent, context: PluginRuntimeContext) => Promise<void> | void;
}

interface PluginMessageTransport {
  sendText(input: { channelId: string; content: string }): Promise<{ messageId: string }>;
  editText(input: { channelId: string; messageId: string; content: string }): Promise<{
    messageId: string;
    migrated: boolean;
  }>;
}

interface PluginRuntimeContext {
  ask(prompt: string, options?: { systemPrompt?: string; maxTurns?: number; model?: string }): Promise<AgentResponse>;
  messages: PluginMessageTransport;
  config: PluginConfigStore;
}
```

- **Tool 名稱全域唯一**：跟 builtin 或其他外掛撞名的工具會被拒，整個外掛不載入（不 silent shadow）。
- **Slash command 名稱全域唯一**：外掛之間撞名會拒絕後載入的外掛；與 Furet 內建指令撞名時主架構不註冊該外掛指令，內建行為保持權威。command 預設 owner-only、ephemeral，handler 回傳字串由主架構送出。
- **Plugin manifest 名稱全域唯一**：它是 schedules／events 的 namespace，重名外掛整體跳過。
- **`ownerOnly` 預設 true**：私有外掛工具預設鎖 owner；明確 `false` 才放給 `discord-other`。外掛背景 callback 本身是受信任的 in-process code，呼叫 `context.ask()` 時使用獨立的 `plugin` trigger，不冒充 Discord 使用者。
- **Agent API 受限**：背景工作只拿到 `prompt`、`systemPrompt`、`maxTurns`、`model`；不能自行偽造 trigger、user ID、Discord session 或進度 callback。回傳完整 `AgentResponse`。
- **Plugin message transport**：背景工作與在 `manifest.start(context)` 初始化的外掛工具可保留 `context.messages`，以 `sendText()`／`editText()` 發送或更新指定頻道的純文字。Discord 啟用時 `manifest.start()` 只會在 client ready 後執行，因此 lifecycle 當下即可使用 transport；Discord 停用或登入失敗時仍啟動外掛的非 Discord 能力，但 message operation 會明確回報 unavailable。主架構只提供標準 Discord V1 純文字傳輸與「僅能編輯 bot 自己訊息」的權限檢查，不把特定外掛的呈現格式或資料規則帶進核心，也不暴露 Discord client、token、raw interaction 或訊息讀取能力。transport 不做 Application Emoji 展開、ANSI 修復、Markdown 格式化或其他內容改寫，並明確拒絕超過 2000 字元的單則內容。`editText()` 對一般 V1 原地編輯；歷史 Components V2 則建立 V1 替代訊息、刪除舊訊息，回傳新的權威 `messageId` 與 `migrated: true`，外掛必須保存回傳 ID。

### 載入、排程與事件生命週期

- `loadPlugins()`：驗證 manifest、tools、schedules、slash commands 與 events；任一能力無效就整個外掛不載入。schedule ID／event ID 必須是穩定安全字串，cron expression 先用 `node-cron.validate()` 檢查。目前事件白名單只有 `journal:completed`。
- `startPlugins(runtime)`：先執行可選的 `manifest.start()`；成功後才啟用工具並註冊外掛 schedules。Discord 啟用時，gateway 先載入 manifest，待 Discord client ready 後才呼叫 `startPlugins()`，完成後才註冊 slash commands；因此 lifecycle 與剛啟動的 schedule 不會撞上尚未初始化的 client。無 `start()` 的外掛也要等 gateway 呼叫 `startPlugins()` 才會真正開始背景排程。Discord 停用或登入失敗時仍會呼叫 `startPlugins()`，但 message transport 會回傳明確的 unavailable error。
- **Schedule ownership**：外掛 schedule 不寫入 `workspace/config/crons.json`，也不受 `cron_*` 工具修改；它跟著外掛設定與程序生命週期，自動啟動、自動停止。`workspace/config/plugins/<name>.yaml` 可覆寫排程，重啟後套用。`/status` 以 `Plugin Jobs` 顯示已註冊數與正在執行數，並列出 plugin state。
- **Slash command ownership**：只有 `started` 外掛的 command 會在 Discord ready 時與內建清單一起註冊；安裝、更新或設定 command 後需重啟。輸入由主架構轉成純值 args，handler 只取得 caller/channel/guild 與自己的 config store，不接觸 Discord token 或原始 interaction。
- **不重疊**：同一個 plugin job 上一輪尚未結束時，新 tick 會略過並記 warning。預設 10 分鐘後記 timeout warning；JavaScript callback 無法安全強殺，因此仍保持 running 狀態直到實際 settle，避免 timeout 後下一 tick 反而重疊。
- `emitPluginEvent()`：只派送給 `started` plugin，handler 彼此並行、失敗互相隔離。內建 journal 的 `ask()` 成功 resolve 後才發出 `journal:completed`，payload 帶固定日期與 agent 最終文字；handler 的失敗不會把已完成的內建 journal 改判失敗。
- `stopPlugins()`：先停止所有 plugin schedules，再 best-effort 執行每個 `manifest.stop()`。SIGINT／SIGTERM 仍有 gateway 5 秒總硬限；`/restart` 維持立即 exit、由 systemd 拉起。
- 外掛載入與啟動依舊 fail-soft：單一外掛 import、驗證、start 或 schedule registration 失敗只把該 plugin 標成 failed，工具保持 inactive，其他服務照常啟動。

### 避免循環 import

`plugin-loader.ts` import `registry.ts` 取 `registerPluginTools()` / `hasToolName()` 把註冊推進去；**registry 從不 import loader**（只 import `plugin-types.ts` 的型別）。註冊資料放在 registry 的獨立可變陣列 `pluginRegistrations`，builtin 的 `registrations` 與其 module-load 驗證維持不動；所有消費端（`getToolDefinitions`、`renderToolIndex`、`tool_catalog` 的 `listRegistrations`、`registrationMap` / `executorMap`、model gate）透過 `allRegistrations()` 把外掛折進來。`registerPluginTools()` 在同步臨界區再驗一次全域唯一（撞名先整批拒絕再變動，不留半批）。

### 權限與 catalog 一致性

已成功啟動的外掛工具跟 builtin 走**同一條** `executeTool()`：owner-only（`isOwnerOnly` 併查 `pluginOwnerOnly`）、model-capability gate、runtime string-result contract、路徑 guard、確認規則全部照舊。`tool_catalog` 的 `list_groups` / `search` / `describe` / `call` 都只看得到 active 外掛工具，`call` 一樣委派回 `executeTool()`，所以**外掛的 ownerOnly 不會被 catalog 繞過**。exposure OFF 的 legacy 全工具清單也只折入 active 外掛，並對每個 builtin/plugin registration 套用同一個 `modelPredicate`；不能只特判 `image_gen`，否則私人外掛的 model gate 會在 rollback 模式失效。

### 已知限制

第一版 `Tool.execute` 仍是 `Promise<string>`，並在統一執行入口做 runtime 型別檢查；外部 JavaScript plugin 回傳 `undefined` 等非字串值時會成為可恢復的 tool error，不會一路流到 `agent.ts` 對 `.slice()` 造成 crash。先不為了圖片結果大改 agent protocol。**Livly screenshot 若要在同一輪直接做視覺辨識**（把截圖當 image block 餵回模型），需要後續擴充 rich tool result（讓 tool 回傳結構化內容 / 圖片而非純字串），連動 `agent.ts` 的 tool_result 組裝與 `ContentBlock` 流。這次聚焦「擴充註冊」，rich result 留待後續。

## 記憶系統

### 四層設計

| 層 | 檔案 | 用途 |
|----|------|------|
| Owner 檔 | `workspace/OWNER.md` | owner 個人資料的唯一權威：稱呼、身分、帳號、住處、工作、關係、權限；變更時原地更新 |
| 長期記憶 | `workspace/MEMORY.md` | 非人物檔案的規則、偏好、流程、持續計畫與世界事實；有字數上限（config `memoryCharLimit`），滿了需整合 |
| 每日檔 | `workspace/memory/yyyy-MM-dd.md` | 日記成品與少量 transcript 外補註；完整事件／對話以 session transcript 為原始來源，不代替其他權威檔 |
| 人物檔 | `workspace/PEOPLE.md` | owner 以外人物的權威資料（名字、Discord ID、關係、稱呼與權限） |

### 儲存層

`workspace/config/furet.db`（SQLite，better-sqlite3 + sqlite-vec + FTS5）：

| 表 | 用途 |
|----|------|
| `memory_vectors` | 記憶文字 + 來源檔案 |
| `memory_vectors_vec_cos` | sqlite-vec 向量索引（Gemini embedding，3072 維，cosine 距離） |
| `memory_vectors_vec` | L2 向量表，開機時內容自動搬到 cosine 表，不參與搜尋 |
| `memory_fts` | FTS5 全文搜尋索引（存 CJK bigram token，非原文） |
| `fts_meta` | FTS 索引的內容格式版本，版本不符就在開機時重建 |
| `session_archive` | 歸檔的 session messages |
| `session_fts` | FTS5 session 全文搜尋（存 CJK bigram token，非原文） |
| `session_summary_vectors` | Legacy compact summary projection；統一搜尋切換完成前保留 |
| `session_summary_vectors_vec_cos` | Legacy compact summary cosine projection；統一搜尋切換完成前保留 |
| `search_documents` | 所有來源正規化後的 searchable chunk；deterministic `id` + integer `rowid` |
| `search_documents_fts` | 統一 FTS5 projection，rowid 對齊 `search_documents` |
| `search_document_embeddings` | document、embedding model、dimension、content hash 與完成時間 metadata |
| `search_document_vectors_vec_cos` | 統一 3072 維 cosine vector projection |
| `embedding_jobs` | 持久化 embedding outbox；pending／processing／failed／complete 與 retry 狀態 |
| `attachment_records` | 附件 reference、durable local path、hash、OCR／視覺描述／文件文字與處理狀態 |
| `attachment_jobs` | 附件下載、OCR、vision 與文件 parser 的持久化 retry outbox |
| `discord_button_messages` | Discord 按鈕定義、權限、生命週期與執行結果 |

### 記憶工具

- `diary_note`：追加 transcript 無法保存的明確背景、有證據反思、跨日關聯或附件／工具脈絡；寫入每日檔後立即接入統一索引，不做事件記錄
- `memory_search`：呼叫 permission-aware `searchUnified()`，偏重 durable memory、people、diary 與重要 conversation evidence
- `memory_add/replace/remove`：操作非人物檔案的長期脈絡 MEMORY.md，並透過 workspace adapter 重建統一搜尋 documents
- `session_search`：與 memory_search 共用同一個 hybrid search，只調整來源 filter、ranking profile 與輸出格式
- 自動召回：每次對話以 request identity 先做 visibility filter，再從統一索引召回；trace 會記錄命中文件、來源與分數

### 搜尋投影維護

- Session message、conversation window、tool evidence 與附件 reference 在 durable persistence 後立即建立／更新統一 documents。
- compact、archive、`/new`、startup restore 只呼叫同一個冪等 reconciliation，補齊缺漏而不另做一套 embedding。
- PEOPLE.md、MEMORY.md、OWNER.md 與正式日記由 workspace source adapter 以 remove-missing policy 重建；刪除來源內容會同步移除失效 projection。
- `scripts/backfill-search-index.ts` 可 dry-run、冪等回填歷史來源、修復 orphan FTS/vector rows，並輸出來源與 job 狀態報告。 `--dry-run` 不初始化 SQLite、不建立 schema、也不修復 projection，只掃描 durable sources 並輸出預演報告。
- `scripts/migrate-diary-note.ts` 只在部署時精確遷移 runtime AGENT.md/JOURNAL.md；不整份覆蓋客製 workspace。

### 統一搜尋 ingestion 與 embedding outbox

`src/search-index.ts` 是新搜尋投影的唯一寫入層：

1. source adapter 先產生 `SearchDocumentInput`。workspace adapter 中，`OWNER.md`／`PEOPLE.md`／`MEMORY.md` 是常駐事實、沒有事件時間，其文件 `occurred_at` 為空；每日檔的檔名本身即日期，因此 diary 文件以該日期作為 `occurred_at`。`excludeRecentDays` 的近期日記排除是比對 `source_id` 檔名，與 `occurred_at` 無關。
2. `ingestSearchDocuments()` 正規化文字並先遮罩 secrets，再計算 deterministic ID／SHA-256 content hash，並在同一個 SQLite transaction 內 upsert document、FTS row 與 embedding job。未遮罩原文仍只存在 durable source。`NON_EMBEDDED_SOURCE_TYPES` 列出不進向量索引的 source type（目前為 `tool_result`、`tool_call` 與 `diary_note`）：這些文件照常寫入 FTS，但不建 embedding job，`embedding_status` 記為 `skipped`。原始工具輸出量大而語意檢索價值低，其語意入口由同一事件的 `tool_evidence_summary` 提供——該摘要取輸出的開頭 1,000 與結尾 500 字元，因此工具輸出結尾的錯誤與結論同樣涵蓋在內。`tool_call` 存的是工具的呼叫參數——shell script、程式碼與 JSON；這類文字的向量依語法聚類而非依意圖，語意檢索價值極低，而真正用來找指令的關鍵字搜尋由 FTS 提供。與它 1:1 的 `tool_evidence_summary` 仍記錄哪個工具、何時執行、輸出為何。上游配額以「請求次數」計價，因此筆數而非長度決定成本，而 `tool_call` 與 `tool_evidence_summary` 各佔待嵌入總量的近四成。`diary_note` 不建向量的理由不同：它的 source_id 是 `YYYY-MM-DD.md` 日期檔，而 auto recall 以 `excludeRecentDays` 排除兩天內的日期檔；補註又在當晚被 `reindexDiary` 刪除、由已建向量的 `diary` 散文取代，因此補註向量在其整個存活期間都讀不到。補註所註解的對話本身已由 session message 與 conversation window 建立向量。
3. 寫入層只依 identity/hash 去重，不用 cosine 相似度刪資料；不同時間的相似事件都會保留。
4. `processEmbeddingJobs()` 由 gateway 的單一背景 worker 分批處理。程序中斷後仍可重試的 pending/failed job 留在 SQLite，卡住的 processing job 超時後回到 retry 流程；達最大嘗試次數的 failed job 另列為 `exhausted`，不再混入 `remaining` 或讓 drain 永遠無法完成。
5. embedding 模型由 `SEARCH_EMBED_MODEL` 指定（`gemini-embedding-2`，3,072 維，輸入上限 8,192 tokens）。不同模型的向量沒有可比性，因此更換模型必須清空 `search_document_embeddings` 與向量表後整批重打；`search_document_embeddings.model` 記錄每筆向量由哪個模型產生。legacy `memory_vectors`／session summary 投影仍固定在其既有模型，`embed()` 因此由呼叫端指定模型，不共用單一常數。
6. 佇列依召回價值排序而非 FIFO：owner／memory／people 最先，其次 diary，再來 compact summary、session message 與 conversation window，附件與 tool evidence 之後，tool 記帳類最後。上游配額才是瓶頸，先進先出會讓 workspace 的記憶與日記被數千筆工具文件壓在後面。
7. embedding 金鑰池由 `getEmbedKeys()` 從 `GOOGLE_API_KEY` 與 `GOOGLE_API_KEYS` 讀取，兩個變數都接受逗號分隔，解析後去重。每把金鑰有各自的上游配額，因此 worker 對每把可用金鑰開一條並行 lane，各 lane 從同一個佇列 claim；claim 是同步 SQLite transaction，不會把同一筆 job 發給兩條 lane。
8. 失敗分類決定「誰的錯」：`quota`（429）與 `credential`（401／403）是金鑰的問題，`transient`（5xx、無 HTTP status 的網路中斷）是基礎設施的問題，兩者都把 claim 時遞增的 attempt 回滾，文件因此不會被上游狀況耗盡重試預算；只有 `permanent`（其餘 4xx、維度不符）才計入 `MAX_EMBED_ATTEMPTS`。金鑰層級的失敗會把該把金鑰冷卻（60 秒起、倍增至上限 1 小時，成功後歸零）並中斷該 lane，其餘 lane 照常運作；全部金鑰都在冷卻時 worker 才整個暫停。查詢時的向量檢索優先取用未冷卻的金鑰。
9. FTS／recall 使用的 searchable projection 與外部 embedding payload 都使用遮罩後文字；本機 durable source 與權限 metadata 不因遮罩而失去可稽核性。查詢本身在送 embedding provider 前也會遮罩可能的 credential。
10. vector rowid 與 FTS rowid 都使用 `search_documents.rowid`，deterministic text ID 則放在 unique `id`；這避開 sqlite-vec 只接受 integer rowid 的限制，同時保持 reconciliation 冪等。
11. 同一 document 的文字 hash 未變時仍比較 metadata；visibility/channel/ordinal 等欄位變更會立即更新文件與 FTS metadata，但不重新排 embedding。Hybrid search 使用最低 cosine 門檻，auto recall 只採高可信 vector 命中；visibility、source/profile 與 exclusion 條件盡量下推 SQL，FTS 直接只排名合格列，sqlite-vec 則因 KNN 先取 `k` 的限制漸進擴大 `k`，再由 joined SQL filter 排除不合格列。相鄰 context 重新套用同一份完整 filter，不能讓被排除的 document/session/source 或近期日記從 context 回流。搜尋工具另有單筆與總輸出 budget，rank 分數不偽裝成絕對相關度百分比。
12. Canonical workspace/session write 與可重建 projection 分離：canonical write 成功後即回報成功，projection 失敗則記錄為 reindex pending；session JSON 採 temp + rename，持久化失敗時回滾記憶體狀態且不得建立幽靈索引。所有 Discord 遠端附件及 provider／本機工具輸出的附件都先只建立純 `AttachmentReference`、寫入 session JSON，成功後才 upsert `attachment_records`、job 與搜尋文件。

部署觀察期採新舊資料表並行：讀取入口已統一到 hybrid search，但 legacy memory/session tables 暫不刪除，作為資料比對與程式 rollback 的安全網。回滾時還原上一版程式與 runtime AGENT.md/JOURNAL.md 備份；新表是可重建 projection，不影響 session JSON、archive、workspace 文件或附件原檔。

### 附件索引與非同步分析

Discord uploads、Embed image/thumbnail、回覆引用與 Forum starter 附件會先建立不落 DB 的 `AttachmentReference`，隨訊息成功持久化到 session JSON 後，才建立 SQLite `attachment_records`、job 與搜尋投影；session JSON 保存 stable reference，SQLite 保存處理狀態與抽取結果。遠端 URL 的 query 不進 searchable metadata，背景 worker 會盡快把原檔下載到 `workspace/attachments/search-index/`，避免 Discord CDN URL 過期後失去原始證據。所有遠端圖片／附件下載都經 pinned-DNS safe fetch：逐跳驗證 redirect、拒絕 loopback／private／link-local 位址、限制 timeout，並以 streaming byte counter 在超限時立即中止；本機檔也在讀取前先檢查大小。相同 bytes 在不同訊息被引用時保留各自 reference metadata；binary 本身不塞進 SQLite。

送往模型的圖片一律先要求 Discord 的縮圖版本：image token 依像素數計價，而辨識文字、UI 狀態與主體不需要原解析度。縮放在仍握有 Discord 回報長寬的收集點完成（`boundedImageUrl`），依原比例換算目標尺寸——Discord 會精確縮放到指定的寬高而非等比內縮，缺長寬時因此不改寫，寧可不縮也不送變形的圖。只有 `media.discordapp.net` 會實際縮放，`cdn.discordapp.com` 會忽略參數；簽章參數必須原樣保留。落地保存的仍是原檔，縮圖只用於模型請求。

帶圖片的對話輪次會在同一次請求裡產生描述：該輪本來就已上傳圖片，追加一個 `<image-index>` 區塊只花 output token，省下第二次重新上傳圖片的視覺呼叫。區塊在送往 Discord 前（含進度訊息）剝除，並依序寫入該訊息的圖片附件記錄，標記 `vision_status='complete'`。背景 vision worker 會跳過已完成的記錄，因此它是取代而非競爭；區塊缺漏、格式錯誤、編號超界或非對話來源的附件（工具輸出、生成圖、歷史回填）仍由 worker 照常描述。

附件視覺描述固定使用工作所屬 request/session 的模型；`attachment_analysis` 只控制 endpoint credentials、語言、預算與 worker 限制，不允許另設模型，因此不會暗中由其他模型代跑。wire format 固定為 OpenAI-compatible `/chat/completions`，使用 Bearer auth 與 `image_url` data URI。該區塊預設 `enabled: false`；端點不支援目前模型的 vision 時會明確失敗。`base_url`／`api_key_env` 留空時沿用 `llm`。

模型自己產生的圖片（生圖工具與內嵌輸出）標記為 `relation='generated'`，不跑視覺描述：產生它的 prompt 已經是對話的一部分並建立索引，比事後再看圖產生的描述更能表達意圖。OCR 仍照跑（本機、免費）。

`attachment_jobs` 是可重啟、可重試的 outbox。圖片同時經 Tesseract.js (`eng+chi_tra`) OCR 與目前 vision model 的客觀描述；vision prompt 明確把圖片內容視為 untrusted evidence，不執行畫面中的指令。Tesseract.js 的 npm postinstall 不下載語言資料；`eng`／`chi_tra` traineddata 會在首次建立 OCR worker 時依 runtime 設定取得並寫入 cache，因此完全 air-gapped 的部署必須在啟動 worker 前預先提供語言資料，並設定受控的 `langPath`／cache path。OCR、vision 與文件抽取各自保存 stage status：已成功的結果立即寫入並建立部分搜尋投影，後續只重試失敗階段，不因另一階段暫時失敗而丟掉可用證據。文字與程式碼檔直接抽取；PDF、DOCX、PPTX、XLSX、ODF、RTF、CSV、Markdown、HTML、EPUB 使用 `officeparser` 產生文字與內嵌圖片 OCR。`pdfjs-dist` 與 `qs` 透過 lockfile override 固定至已修補版本；升級 override 後必須在乾淨安裝上跑 PDF extraction fixture，且 production audit 必須為零漏洞。處理邊界包含下載大小、解壓 bytes、ZIP entry、spreadsheet cell 與 abort timeout；失敗會保留原因並依退避策略重試。

Provider 生成圖片及本地工具排入最終 Discord 回覆的檔案，會在 request 完成時附到最後一則 assistant message，再走相同的 attachment ingestion，而不是另開生成檔專用索引。這條路徑先 stat/hash 並建立不落 DB 的 reference，session JSON temp+rename 成功後才建立附件 record/job/search projection；若 session 寫入失敗則回滾記憶體 reference，不留下 ghost attachment。所有 attachment metadata、OCR、視覺描述與文件 chunks 最後仍落入 `search_documents`／FTS／embedding outbox；attachment worker 只負責把原始檔轉成統一文件。達最大嘗試次數的附件 job 另列 `exhausted`，不計入可繼續處理的 `remaining`。

### 向量表的一致性

`memory_vectors`、向量表、`memory_fts` 三張表用同一個 rowid 對齊，所以：

- 新增時必須**明寫 rowid**（`INSERT INTO ... (rowid, embedding)`），不能靠隱式遞增
- 三個 insert 包在同一個 transaction 裡——任何一句失敗就整批回滾。
  否則 `memory_vectors` 會留下沒有向量的孤兒列，rowid 從此永久錯位，
  之後所有搜尋都會 JOIN 到錯誤的記憶內容
- sqlite-vec 的 rowid 參數綁定只吃 `BigInt`，傳一般 number 會被拒

### 時間與時區

`src/utils/time.ts` — 所有時間格式化都走 `config.timezone`，沒有任何地區寫死。
`timezone` 留空時用系統時區（`Intl.DateTimeFormat().resolvedOptions().timeZone`），
所以別人裝起來預設就是對的。

- `stamp()` — 對話用的 `MM/DD HH:mm`
- `today()` — 當地日期 `YYYY-MM-DD`（記憶檔名、日記日期）
- `clockTime()` — 當地 `HH:mm:ss`（記憶條目）
- `nowWithZone()` — 完整時間 + 時區名，給 system prompt

用 `sv-SE` locale 是因為它輸出 ISO 風格的 `YYYY-MM-DD HH:mm:ss`，切片位置固定不受 locale 影響。

注意記憶檔名和日記日期**必須用 `today()` 而不是 `toISOString()`**——後者是 UTC 日期，
在 UTC+8 會讓早上 8 點前寫的記憶跑到前一天的檔案去。

### 中文全文搜尋（CJK bigram）

`src/utils/cjk.ts` — FTS5 預設的 unicode61 tokenizer 不斷中文，整段中文會變成一個 token，
所以查「主人」「記憶」永遠搜不到。內建的 trigram tokenizer 也不夠：它要求至少 3 個字元，
而中文最常見的正是 2 字詞。

解法是自己把中文展開成 bigram 再交給 unicode61：

- `toSearchTokens(text)` — 「主人要求」→「主人 人要 要求」。非 CJK 片段原樣保留
  （逐字拆會讓 `weather` 變成 `w e a t h e r`，索引膨脹又不精確）
- `toSearchQuery(query)` — 查詢端套同一個展開，並移除 FTS5 語法字元（冒號會被當 column filter）
- `highlightMatches(text, query)` — FTS 表存的是展開後的 token，`highlight()` 會回傳
  展開結果（不能看），因此改為自己在原文上標記

**FTS 表存 bigram token，不存原文**；顯示時 JOIN 回來源表（`memory_vectors` / `session_archive`）取原文。
展開規則改變時把 `db.ts` 的 `FTS_CONTENT_VERSION` +1，開機就會用新規則重建索引（`fts_meta` 記錄版本）。

實測改善（真實資料）：「記憶」0 → 4 筆、「日記」0 → 10 筆、「主人」3 → 20 筆。

限制：bigram 只能匹配原文中連續出現的字。查「貓咪疫苗」不會命中「貓咪的疫苗」——
要跨詞搜尋得用空白分開（FTS5 預設 AND 語意）。

### 距離度量

向量表指定 `distance_metric=cosine`：搜尋是把 `1 - distance` 當 cosine 相似度在比，
而 vec0 預設的 L2 距離與它對不上（`SCORE_THRESHOLD = 0.65` 會變成要求 cosine > 0.94，
語意召回幾乎永遠是空的）。指定 cosine 後 `distance = 1 - cos`，`1 - distance` 才是相似度。

### Memory Hook（定期 nudge）

每 5 則 user message 附加一次記憶提示（不是每輪），提醒 agent 檢查是否需要用
diary_note / memory_replace / memory_remove 保存資訊。內容是 `JOURNAL.md` 的 Memory Hook section。

### Silent Memory Flush

`/new` 歸檔和每日 journal 觸發前，執行 silent memory flush：
- Flush 指令注入 systemPrompt（不污染 session 歷史）
- Agent 自由使用所有 memory tools 整理記憶
- 不限制格式，由 agent 自行判斷什麼值得保存

## 專案結構

列到目錄職責為止，不逐一列檔名——檔名清單複製到這裡就會開始腐爛，
而 `ls` 永遠是對的。要知道有哪些 tool 看 `src/tools/registry.ts`。

```
furet/
├── src/
│   ├── agent.ts              # agent loop（API call + 執行循環），系統核心
│   ├── gateway.ts            # 常駐程式（cron + reminder + journal + Discord + PID）
│   ├── bot.ts / cli.ts       # 兩個入口：Discord 與終端機
│   ├── prompt.ts             # system prompt 組裝（從 workspace 的 md 檔載入）
│   ├── paths.ts              # 所有路徑常數的唯一來源
│   ├── config.ts             # config.yaml 載入 + ${VAR} 解析 + mtime cache
│   ├── db.ts / embedding.ts  # SQLite（sqlite-vec + FTS5）與向量化
│   ├── session.ts            # session 持久化
│   ├── skills.ts             # SKILL.md 讀取（frontmatter / 目錄掃描）
│   ├── types.ts              # 共用型別（Tool、ContentBlock、Message）
│   ├── google/               # Google OAuth（token 持久化 + auto refresh）
│   ├── utils/                # 無狀態工具函式（時間、CJK 斷詞、計價、格式化…）
│   └── tools/
│       ├── registry.ts       # tool 註冊中心 ← tool 的權威清單
│       ├── context.ts        # request context（AsyncLocalStorage）
│       ├── guard.ts          # 非 owner 的檔案讀取路徑邊界
│       ├── plugin-types.ts   # 私有外掛的穩定 API/型別
│       ├── plugin-loader.ts  # 外掛動態載入 + start/stop 生命週期
│       └── builtin/          # 每個 tool 一個檔
├── workspace/                # agent 工作空間（不進 git，由 templates/ 初始化）
│   ├── *.md                  # AGENT / SOUL / MEMORY / PEOPLE / JOURNAL
│   ├── config/               # crons.json, reminders.json, google-token.json, furet.db
│   ├── memory/               # 每日記憶
│   ├── sessions/             # session 持久化 + archive/
│   ├── skills/               # 技能（每個有 SKILL.md）
│   ├── plugins/              # managed private plugin source checkouts
│   ├── attachments/          # agent 產出／下載的檔案（唯一落點）
│   └── .trash/               # 全域唯一回收桶（刪除一律 mv 到這）
├── templates/                # workspace 初始模板（進 git）
├── material/DESIGN.md        # 本文件
├── scripts/ · bin/           # 輔助腳本與執行檔
├── config.example.yaml       # 設定範本 ← 設定欄位的權威清單
└── config.yaml · .env        # 實際設定與敏感資訊（都不進 git）
```

## 設定

分兩層：`.env` 放敏感資訊（API key、token），`config.yaml` 放行為設定。
`config.yaml` 的字串支援 `${VAR}` 展開，由 `config.ts` 的 `resolveEnvVars()` 在載入時解析——
所以 key 只存在於 `.env`，`config.yaml` 只寫 `"${LLM_API_KEY}"`。

**完整欄位與預設值以 `config.example.yaml` 為準**（每個欄位都有行內註解說明用途）。
程式碼端的預設值在 `config.ts` 的 `DEFAULTS`，兩者要一起改。

這裡不複製一份欄位清單——複製出來的那份只會過時，讀的人還得猜哪份是對的。

## 待辦

### Streaming 回覆
目前 agent loop 是等整包回應才顯示。改成 SSE streaming 後 Discord 端可以邊生成邊更新訊息，CLI 端邊打邊顯示。需改 OpenAI Chat adapter 為 stream mode，解析 SSE event，加 `onText` callback。

### Intent Analysis（實驗中）
在 agent loop 前做一輪意圖分析，顯示在 Discord 進度訊息，並注入 system prompt 讓主 agent 參考。目前在 `feat/intent-analysis` branch，效果不穩定（模型容易被 session 歷史汙染，回覆風格偏離）。

### Tool 分權 × 模型分流
### 工具權限

`registry.ts` 的 `OWNER_ONLY_TOOLS` 列出只有 owner 能用的工具，
非 owner（`trigger === "discord-other"`）呼叫會被擋下並回傳提示。

`bash` 是特例：它是沒有沙箱的任意指令執行，開放給非 owner 等於把 shell 開給
任何能 @ 到 bot 的人。預設鎖成 owner-only，要放寬得在 `config.tools.bash_owner_only`
明示 false，或把個別 user ID 列進 `config.tools.bash_allowed_users`（僅放寬 bash，
其他 owner-only 工具照擋）。`self_evolve` 這類會改動自身原始碼的工具則不提供放寬選項。

工具**曝光**（exposure）跟工具**權限**是分開的兩層：`tool_catalog` 讓模型能找到並代理呼叫
未直接暴露的工具，但代理一律回到 `executeTool()`，所以 on-demand / index 的降低可見度不會
變成降低權限，owner-only 檢查也不會被 catalog 繞過（見 Tool 系統 › Tool Exposure）。

`write_file` 同樣列入 owner-only：它沒有路徑邊界，寫得進 `src/` 就等於繞過
`bash` 的限制。非 owner 也沒有寫任意檔案的需求——記人記事走 `people_*` /
`memory_*`，那些工具的落點寫死在 `paths.ts`。

#### 檔案讀取邊界（`tools/guard.ts`）

`read_file` **不能**用同一招整個擋掉：AGENT.md 的開場流程每次都要讀當天的
daily memory，skill 也只給路徑不給內容（`prompt.ts` 的 `loadSkills`），
全鎖等於陌生人一互動就失去上下文、skill 全失效。

擋的是路徑而不是工具。`checkFileAccess()` 只在 `trigger === "discord-other"`
時生效，拒絕：

- `WORKSPACE_DIR` 以外的一切 → 擋掉 `config.yaml`（含 Discord token）與整個 `src/`
- `workspace/config/` → `google-token.json`、`furet.db`
- `workspace/sessions/` → 其他人的對話紀錄

比對前先 `resolve()` 正規化 `..`，再 `realpathSync()` 解 symlink——只比字面
路徑的話，一條指向外部的 symlink 就能繞過整道邊界。

`memory_search`／`session_search` 另有獨立的 visibility boundary：搜尋候選在 ranking 前依 request context 的 owner、user 與 channel identity 過濾；`owner_private` 不會對非 owner 回傳，`channel:<id>`／`user:<id>` 只對相符 caller 開放。Session、tool、附件與 workspace 私人來源目前預設採保守的 `owner_private`。這個預設也代表目前尚未啟用 Discord 頻道成員式 recall；未來只有在 durable source 能保存並驗證 guild channel membership、thread membership 與 DM participants 後，才能把對應 session／attachment projection 升級為 `channel:<id>` 或 `user:<id>`，且必須同步更新既有文件的 visibility metadata，不能只改新寫入資料。

另一個結構性缺口：非 owner 的訊息會進 session（`bot.ts` 的 messageCreate），
owner 稍後在同頻道觸發時 trigger 是 `discord-owner`、權限全開，而那段內容
還在上下文裡。prompt injection 可以借 owner 的手執行，本層擋不住。

按 trigger 類型分配不同模型和 tool 權限。例如 discord-owner 用全部 tools，discord-other 限制危險操作，coding 任務自動切強模型。目前只有 owner-only tool 擋法，模型分流只有 self_evolve。

### Bash Sandbox
非 owner 的 bash 指令跑在限制環境（timeout + 禁止寫入敏感路徑 + 禁止讀 .env）。目前 bash 完全開放給所有人。

### Unified Search 部署與後續清理

統一 document/FTS/vector/outbox、active session、tool history、附件 OCR／視覺描述／文件抽取、workspace adapters、hybrid ranking、visibility filter、auto recall 與歷史回填均已實作。正式部署必須先 build，再對 runtime workspace 執行 diary-note migration dry-run／apply、跑 backfill 與權限／recovery smoke test，全部通過後才重啟。部署後 transcript 成為事件主紀錄，`diary_note` 只補 transcript 無法保存的背景、反思與跨日脈絡；每日補註檔因此可能比舊版稀疏，這是預期行為，不代表當天沒有事件，Daily Journal 必須以 `journal_transcript_by_date` 為骨架。完全 air-gapped 的環境還要在首次 OCR 前預先佈署 Tesseract traineddata。觀察期內保留 legacy `memory_vectors`、`session_fts` 與 compact summary tables；現有 legacy 內容都可由 workspace 文件、session JSON／archives 與 compact source 重建，外掛正式 API 也不提供只寫 legacy table 的入口。若私人外掛曾繞過 API 直接寫入 legacy table，必須先另行匯出，不能假設 backfill 會保留。確認資料量、搜尋品質、job failure 與權限邊界穩定後，另開清理變更移除舊表與舊函式。

### Unified search hardening (PR #17)

- Trigger authorization is fail-closed through a central positive allowlist; `unknown` and future trigger kinds receive neither owner-only tools nor owner-private recall.
- Auto-recalled user/tool/OCR/vision/attachment evidence is emitted inside a structured untrusted-data boundary and cannot grant permissions or redefine the active task.
- Session JSON commits use a cross-process lock, revisioned three-way merge, unique temporary files, file `fsync`, atomic rename, and directory `fsync`; destructive concurrent rewrites fail instead of erasing newer events.
- Unified FTS has its own persisted content-version key and rebuilds from `search_documents.text` when tokenization changes. Hybrid vector search has a bounded scan budget and reports final `k`, iterations, scanned rows, and truncation.
- Attachment analysis has an independent provider/transport/model configuration, concurrency cap, daily successful-description budget, absolute HTTP deadlines, signed Discord CDN URL refresh provenance, and separate permanent versus refreshable retry accounting.
- `npm run attachment-gc` reports unreferenced attachment-index files older than the retention window; deletion requires `--apply`, and files referenced by active sessions, archives, or attachment records are preserved.
