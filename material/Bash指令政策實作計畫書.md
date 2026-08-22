# Furet Bash 指令政策完整實作計畫書

> 狀態：設計稿，尚未實作
> 修訂日期：2026-08-22
> 適用基準：`/home/iiimabbie/.furet-dev/furet-agent`
> 原則：只在獨立開發 clone 實作；不得直接修改運行中的 `/home/iiimabbie/.furet`。

## 文件導覽與相依關係

本文件是三份互相銜接的安全架構計畫之一：

- [Subagent（派小弟）完整實作計畫書](./Subagent實作計畫書.md)
- **Bash 指令政策完整實作計畫書（本文件）**
- [記憶抽取與彙整管線完整實作計畫書](./記憶管線實作計畫書.md)

建議實作順序：

```text
PR A：Subagent read-only MVP
  ↓ 提供隔離 worker 與 capability 基礎
PR B：Bash command policy
  ↓ 提供可測試、可解釋的 shell 安全決策
PR C：Memory extraction/consolidation pipeline
  ↓ 可選擇使用 read-only worker 做候選抽取，但寫入仍由受控流程完成
PR D（後續）：允許特定 Subagent 使用受控 Bash／隔離 worktree
```

三份文件不是同一個大型 PR。每份各自可驗收、可回滾；跨文件介面則在本節與第 14 節固定下來。

---

## 1. 文件目的

目前 Furet 對 Bash 的主要邊界是「誰可以呼叫」與工具描述中的行為提醒。這能擋住非 owner，但不能完整回答：

- 某條指令本身是否安全？
- 為什麼允許或拒絕？
- 多個 shell 結構串接時要如何判斷？
- 同一條命令在主 Agent、Subagent、排程任務中是否應有不同權限？
- 規則改動後如何用測試證明沒有放寬危險操作？
- policy 判斷與實際執行如何分離，避免工具自行決定安全性？

本計畫要把 Bash 從「owner-only 的任意 shell」提升成可測試、可解釋、可稽核的 command policy 系統。

核心原則：

> 先把命令正規化與分類，再由獨立 policy engine 作出決策；executor 只能執行已獲授權的命令，不能自行放寬政策。

---

## 2. 目標與非目標

### 2.1 目標

1. 建立純函式、可單元測試的 policy engine。
2. 將決策分為 `allow`、`confirm`、`forbidden`。
3. 每次決策都回傳命中的規則、理由與可稽核資訊。
4. 多條規則命中時採最嚴格結果。
5. 辨識 shell chain、redirect、substitution、pipeline 等結構，避免只看第一個 token。
6. 依執行主體套用 capability profile：主 Agent、Subagent、cron/reminder 可有不同政策。
7. 保留 owner 最終控制權，但不把「owner」等同於「所有命令自動安全」。
8. 為未來 Subagent 的受控 Bash 與 worktree sandbox 建立前置能力。

### 2.2 非目標

第一版不做：

- 完整 Bash AST 或 shell sandbox 的自製替代品。
- 容器／VM 級隔離。
- 自動批准任意 `sudo`、systemd、網路管理或 credential 操作。
- 讓非 owner 取得 Bash。
- 讓 read-only Subagent MVP 直接使用 Bash。
- 以 LLM 自由文字判斷取代 deterministic policy。
- 對使用者隱藏命令被擋下或需要確認的原因。

---

## 3. 威脅模型

需要防範的主要失敗模式：

### 3.1 命令表面安全、實際有副作用

例如：

```bash
python3 -c '...write/delete...'
find ... -exec sh -c '...' \;
git clean -fdx
curl URL | sh
npm install package
```

只用 executable 名稱白名單會被繞過。

### 3.2 Shell 組合語法繞過

例如：

```bash
safe-command && dangerous-command
safe-command; dangerous-command
safe-command $(dangerous-command)
safe-command > sensitive-file
```

policy 必須評估整個 command，而不是只檢查第一段。

### 3.3 路徑逃逸與錯誤工作目錄

即使是 `mv`、`cp` 或 `git`，在錯誤 repo、符號連結或 `../` 目標下仍可能破壞運行環境或敏感檔案。

### 3.4 資料外洩

`curl`、`scp`、`gh`、`git push`、email/API 工具可能把 `.env`、token、私人文件或 session 內容送到外部。

### 3.5 權限與責任混淆

主 Agent、Subagent、排程任務若共用相同 shell 權限，隔離設計就失去意義。

### 3.6 Policy 與 executor 漂移

若 executor 會偷偷改寫 command、加入 shell wrapper 或在 policy 後追加參數，先前判斷就不再有效。

---

## 4. 決策模型

### 4.1 三態結果

```ts
type PolicyDecision = "allow" | "confirm" | "forbidden";
```

- `allow`：符合目前 profile 可自動執行。
- `confirm`：必須取得 owner 對「這一條具體命令」的明確同意。
- `forbidden`：即使 owner 發出一般任務，也不得由 Agent 自動執行；若真要做，應由 owner 親自操作，或先修改政策並審查。

嚴格度：

```text
allow < confirm < forbidden
```

任何多重命中都取最高嚴格度。

### 4.2 決策結果結構

```ts
interface BashPolicyResult {
  decision: PolicyDecision;
  commandHash: string;
  normalizedCommand: string;
  profile: BashPolicyProfile;
  matchedRules: Array<{
    id: string;
    decision: PolicyDecision;
    reason: string;
    segment?: string;
  }>;
  hazards: string[];
  requiresExactConfirmation: boolean;
}
```

不得只回傳 boolean。沒有理由與規則 ID 的決策不可稽核。

### 4.3 預設拒絕

若 parser 無法理解命令、遇到未知 wrapper 或 policy engine 內部錯誤：

- 主 Agent profile：至少 `confirm`。
- Subagent profile：`forbidden`。
- cron/reminder profile：`forbidden`。

安全系統不得在解析失敗時 fail-open。

---

## 5. Capability Profiles

```ts
type BashPolicyProfile =
  | "owner-interactive"
  | "subagent-readonly"
  | "subagent-worktree"
  | "scheduled-task";
```

### 5.1 `owner-interactive`

- 只適用於 owner 觸發的互動 session。
- 允許常見唯讀診斷、build、test、git inspection。
- 可能修改 repo、安裝依賴、push、系統服務等行為至少需要 `confirm` 或直接禁止。
- confirmation 必須綁定 exact command hash，不能一次授權後無限沿用。

### 5.2 `subagent-readonly`

- 配合 [Subagent 計畫書](./Subagent實作計畫書.md) 的第一階段。
- 第一版原則上不提供 Bash 工具；若內部測試啟用，僅允許非常有限的唯讀命令。
- 禁止 redirect、command substitution、network、package manager、git mutation、任意 script interpreter。
- 不提供互動確認；遇到 `confirm` 直接視同 `forbidden` 並回報主 Agent。

### 5.3 `subagent-worktree`

- 僅供後續階段。
- 必須先有獨立 worktree／sandbox root、路徑 guard、輸出限制與 abort propagation。
- 允許在隔離目錄內 build/test/產生 diff。
- 禁止 push、PR、修改運行環境、讀取 credentials。
- 最終套用與 commit 仍由主 Agent處理。

### 5.4 `scheduled-task`

- 沒有即時 owner confirmation，因此預設只允許固定模板與唯讀命令。
- 不接受任務輸入直接拼接進 shell。
- 需要 mutation 的排程應改用專用 typed tool，而不是 Bash。

---

## 6. 命令解析與正規化

### 6.1 不用字串 prefix 當唯一防線

規則可使用 token prefix，但前提是先做安全 tokenization，並且辨識 shell control operators。

需要辨識：

- `&&`、`||`、`;`、newline
- pipeline `|`、background `&`
- redirects：`>`、`>>`、`<`、`2>`、heredoc
- command substitution：`$(...)`、backticks
- subshell：`(...)`
- environment assignment
- wrapper：`bash -c`、`sh -c`、`env`、`sudo`
- glob 與 brace expansion

### 6.2 第一版策略

第一版不必完整執行 Bash expansion，但必須保守分類：

1. 將 command 切成 top-level segments。
2. 任一 segment 無法可靠解析時提高決策嚴格度。
3. `bash -c`／`sh -c` 的 inner command 必須遞迴評估。
4. command substitution 需遞迴評估，Subagent profile 直接禁止。
5. redirect 需檢查目標路徑；不能解析時至少確認。
6. executor 執行的字串必須與 policy 評估的字串一致。

### 6.3 工作目錄與路徑

policy input 必須包含 resolved cwd：

```ts
interface BashPolicyInput {
  command: string;
  cwd: string;
  profile: BashPolicyProfile;
  userId?: string;
  trigger: string;
}
```

路徑政策至少區分：

- runtime repo：`/home/iiimabbie/.furet`
- dev clone：`/home/iiimabbie/.furet-dev/furet-agent`
- workspace attachments：`workspace/attachments/`
- trash：`workspace/.trash/`
- sensitive config：`.env`、Google token、credential stores
- system paths：`/etc`、`/usr`、systemd unit 等

對符號連結與 `..` 要使用 canonical path 驗證，不能只做字串 startsWith。

---

## 7. 規則資料模型

```ts
interface BashPolicyRule {
  id: string;
  description: string;
  profiles: BashPolicyProfile[];
  decision: PolicyDecision;
  reason: string;
  matcher: RuleMatcher;
  tests: {
    match: string[];
    notMatch?: string[];
  };
}
```

matcher 可逐步支援：

- executable/token prefix
- argument predicate
- shell feature predicate
- path class predicate
- network/mutation category
- exact command template

每條規則必須自帶 `match` 與必要的 `notMatch` 測試案例。新增規則但沒有測試，不應通過 CI。

### 7.1 規則優先原則

- 不依檔案順序決定結果。
- 全部匹配後取最嚴格決策。
- `forbidden` 不可被另一條 `allow` 覆蓋。
- 規則衝突要全部列入 `matchedRules`，方便調查。

### 7.2 建議分類

- `shell.syntax.*`
- `filesystem.read.*`
- `filesystem.write.*`
- `filesystem.delete.*`
- `git.inspect.*`
- `git.mutate.*`
- `git.remote.*`
- `network.download.*`
- `network.upload.*`
- `package.install.*`
- `process.service.*`
- `credential.access.*`
- `interpreter.inline.*`

---

## 8. 第一版政策基線

以下是方向，不是可直接複製的完整 allowlist。

### 8.1 通常可允許的唯讀操作

在正確 cwd 且無危險 shell 語法時：

- `git status`、`git diff`、`git log`、`git show`
- `npm run build`、已知測試 script
- `find` 的純列舉模式（禁止 `-exec`、`-delete`）
- `wc`、`sort`、`sed -n` 等唯讀文字處理
- 對非敏感檔案的檢查命令

但 AGENT 規則仍要求檔案檢查優先使用 `read_file`，Bash allow 不代表應濫用。

### 8.2 需要確認的操作

- 修改 dev clone 檔案的 script
- `git commit`、branch 操作、rebase/reset（依模式細分）
- `git push`、建立 PR
- package install/update
- 下載檔案
- 對 attachments/trash 的批次移動
- 執行來源可控但有副作用的 migration

PR workflow 可以把一組操作視為 owner 已明確要求的 task，但 executor 仍要留下 policy 紀錄；是否需要逐條再確認由 confirmation scope 規則決定。

### 8.3 預設禁止的操作

- 讀出或傳送 credentials、token、`.env` 內容
- `curl | sh`、遠端 script 直接執行
- 無 sandbox 的 `rm -rf`；依現行規則刪除應移到 `workspace/.trash/`
- 任意修改 `/home/iiimabbie/.furet` 原始碼
- 非 owner 的 shell
- Subagent push／PR／restart／systemctl
- 關閉安全機制、修改 policy 後同一流程自我批准
- 不可逆系統破壞命令

---

## 9. Confirmation 設計

### 9.1 精確授權

confirmation 需綁定：

- command hash
- cwd
- profile
- userId
- expiry
- 可執行次數（通常一次）

若命令內容、工作目錄或執行主體改變，授權失效。

### 9.2 不應詢問的情況

- policy 為 `forbidden`：直接拒絕並說明替代方案。
- Subagent／scheduled-task：無互動 confirmation channel，回傳被擋下。
- owner 已在同一訊息明確命令一個安全且具體的動作，可由 task authorization 規則判定是否已滿足確認；不可把模糊目標視為任意 shell 授權。

### 9.3 Discord 互動

第一版可先由 Agent 用文字確認，後續再設計 button/modal。無論 UI 為何，底層都必須產生一次性 approval record，不能只依 session 中「好」這個字猜測。

---

## 10. Policy 與 Executor 分離

建議模組：

```text
src/security/bash-policy/
  types.ts
  parser.ts
  path-policy.ts
  rules.ts
  evaluate.ts
  confirmation.ts
src/tools/builtin/bash.ts
```

流程：

```text
bash tool input
  → resolve execution context/cwd
  → evaluateBashPolicy(input)
  → forbidden: throw typed policy error
  → confirm: require exact approval token
  → allow: pass immutable command to executor
  → execute with timeout/output cap/abort signal
  → audit result
```

`bash.ts` 不應同時負責規則定義、confirmation 與 child process 執行。

### 10.1 TOCTOU 防護

- policy 後不得改寫 command。
- cwd 應在 policy 與 spawn 前各驗證一次。
- approval token 包含 command hash。
- 若執行前 workspace boundary 或 symlink resolution 改變，重新評估。

---

## 11. Audit 與錯誤處理

每次 Bash 呼叫至少記錄：

- timestamp
- actor/profile/trigger（不記敏感 prompt 全文）
- normalized command 或安全摘要
- cwd class
- decision
- matched rule IDs
- confirmation ID（若有）
- exit code、signal、timeout、output truncation
- duration

不得把 secret 原樣寫進 log。command 可能含 secret 時，應先 redaction，再 log hash 與摘要。

錯誤類型：

```ts
class BashPolicyDeniedError extends Error {}
class BashConfirmationRequiredError extends Error {}
class BashParseError extends Error {}
class BashExecutionError extends Error {}
```

這些錯誤要保留 `cause`，沿用目前完整錯誤鏈 logging 設計。

---

## 12. 與 Subagent 的整合

依 [Subagent 計畫書](./Subagent實作計畫書.md)：

### 12.1 Read-only MVP

- Subagent tool allowlist 不含 Bash。
- Subagent 可使用 `read_file` 與允許的 server-side read tools。
- 驗證型 agent 只能產出分析與證據，不直接執行 mutation。

### 12.2 後續 worktree 階段

必須同時滿足：

- `subagent-worktree` profile
- 獨立 canonical sandbox root
- 真正 abort propagation
- 無 credentials
- 無 Discord/Gmail/Calendar/Drive mutation
- 無 git remote mutation
- 結果以 patch/diff handoff 回主 Agent

Bash policy 是必要條件，但不是 sandbox 的替代品。

---

## 13. 與記憶管線的整合

依 [記憶管線計畫書](./記憶管線實作計畫書.md)：

- 記憶抽取與彙整不應靠任意 Bash 修改 `MEMORY.md`。
- 使用 typed repository API、lock/lease 與 atomic write。
- 若 worker 需要搜尋程式或 session，優先用專用工具。
- 排程 consolidation 不使用 `owner-interactive` profile。
- migration script 如必須使用 Bash，只在 owner 明確觸發下執行，並留下 policy audit。

---

## 14. 跨計畫固定介面

三份計畫共同使用以下概念：

```ts
interface ExecutionIdentity {
  actor: "main-agent" | "subagent" | "scheduled-task";
  userId?: string;
  trigger: string;
  taskId?: string;
  subagentId?: string;
}

interface CapabilityContext {
  identity: ExecutionIdentity;
  capabilities: string[];
  abortSignal?: AbortSignal;
}
```

Bash tool 必須從可信 runtime context 取得 identity/capability，不接受模型在 tool input 自稱 owner 或指定 profile。

---

## 15. 設定設計

建議 config：

```yaml
security:
  bashPolicy:
    enabled: true
    audit: true
    confirmationTtlSeconds: 300
    profiles:
      ownerInteractive: true
      subagentReadonly: false
      subagentWorktree: false
      scheduledTask: false
```

注意：config 只控制 profile 是否啟用，不應允許用單一 `unsafe: true` 關閉所有規則。

---

## 16. 實作階段

### Phase 0：現況測繪

- 盤點 `bash.ts`、registry owner guard、context propagation。
- 列出目前 Bash 的實際使用案例。
- 整理 runtime/dev clone/workspace/sensitive paths。
- 同步更新 `material/DESIGN.md`。

### Phase 1：純 policy engine

- 建立 types、parser、rule evaluator。
- 實作三態與最嚴格合併。
- 建立規則自帶 match/notMatch tests。
- 尚不接 executor。

### Phase 2：接入主 Agent Bash

- `bash.ts` 呼叫 policy。
- 建立 typed errors 與 audit log。
- 保留現有 timeout、1MB output cap、非互動執行要求。
- 對現有常用工作流跑回歸測試。

### Phase 3：Confirmation

- exact command approval token。
- expiry/one-shot/cwd/profile 綁定。
- Discord 文字或互動元件整合。

### Phase 4：Subagent worktree（另一個後續 PR）

- sandbox root/path guard。
- `subagent-worktree` profile。
- patch handoff。
- 不與 Bash policy MVP 混在同一 PR。

---

## 17. 測試計畫

至少包含：

1. 單一 allow rule。
2. allow + confirm 命中，結果 confirm。
3. allow + forbidden 命中，結果 forbidden。
4. 未知 executable fail-safe。
5. `safe && dangerous` 能識別第二段。
6. `bash -c` 遞迴評估。
7. command substitution 在 Subagent 被禁止。
8. redirect 到敏感路徑被禁止。
9. canonical path 擋住 `../` 與 symlink escape。
10. `find -exec` 不被純 `find` allow rule 放行。
11. `git status` 與 `git push` 分類不同。
12. `curl URL | sh` 被禁止。
13. confirmation token command 改一字即失效。
14. confirmation 過期與重放失敗。
15. scheduled task 遇到 confirm 轉為拒絕。
16. abort/timeout 能終止 child process。
17. output cap 生效。
18. audit log 不洩漏測試 secret。
19. executor 收到的 command 與 policy hash 一致。
20. policy internal error 不會 fail-open。

自動化測試檔依既有規範：可在本機執行，但未經姊姊明確同意不得 commit、push 或納入 PR。

---

## 18. 驗收標準

- [ ] 所有 Bash 呼叫先經獨立 policy engine。
- [ ] 結果不是 boolean，而是具理由的三態決策。
- [ ] 多重命中採最嚴格結果。
- [ ] parser 能識別基本 shell chain、redirect、substitution、wrapper。
- [ ] policy 解析失敗時 fail-closed。
- [ ] owner、Subagent、scheduled task profile 分離。
- [ ] confirmation 綁定 exact command/cwd/profile 且一次性。
- [ ] runtime repo 與 sensitive paths 有明確保護。
- [ ] audit 可追查規則與執行結果，不洩漏 secret。
- [ ] Subagent read-only MVP 不因本 PR 自動取得 Bash。
- [ ] `material/DESIGN.md` 已同步。
- [ ] build、typecheck、規則測試與回歸案例通過。

---

## 19. 回滾策略

- policy engine 與 executor 以 feature flag 接入。
- 發生誤擋時可暫時回到「owner-interactive only」，不能切成 unrestricted shell。
- 規則版本需可辨識，audit 紀錄寫入 policy version。
- 回滾 code 不刪 audit；便於比較行為變化。

---

## 20. 最終決策

Bash policy 的重點不是增加更多提醒文字，而是把安全判斷變成：

```text
可解析
＋ 可測試
＋ 可解釋
＋ 可稽核
＋ 與執行分離
```

第一版先守住主 Agent 的 Bash；Subagent 仍維持 read-only。等 policy、sandbox、abort 與 worktree 都成熟後，才在獨立 PR 開放有限的 Subagent shell 能力。
