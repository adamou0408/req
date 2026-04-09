# Claude Code 權限模板說明

> 本文件說明 `framework/templates/settings.json` 中每條權限條目的**對應指令**、**設計理由**，以及**移除後會斷鏈的功能**。企業導入 req 框架時，安全團隊可以照這份文件逐條審查。
>
> 若修改了 `settings.json`，**請一併更新本文件**，以免漂移。`settings.json` 裡有一行 comment 指向這份文件作為提醒。

---

## 原則

req 框架把權限切成兩個層次：

1. **Deny（不可寫）**：框架自身檔案與 git 內部狀態 — 這兩類永遠不允許 AI 直接改寫，避免自修改框架或污染 git 歷史。
2. **Allow（可寫）**：業務資料目錄（`intake/`、`specs/`、`personas/`、`conflicts/`、`reviews/`、`docs/`）與生成程式碼目錄（`src/`、`tests/`）— 這是 AI 需要主動產出內容的區域。

所有 Read 預設全開（`Read(**)`），因為 AI 需要讀整個 host repo 以做調研、偵測衝突、onboarding。若你的 repo 含敏感檔案（例如 `.env`、私鑰），建議**另外在 `deny` 加上明確條目**（例如 `Read(.env)`、`Read(secrets/**)`）。

---

## Deny 條目

### `Edit(${REQ_FRAMEWORK_ROOT}/**)` / `Write(${REQ_FRAMEWORK_ROOT}/**)`

| 屬性 | 內容 |
|------|------|
| 保護對象 | `.req-framework/`（submodule 模式）或 `./framework/`（init 模式）— 框架本體，含 CONSTITUTION、AGENTS、command 定義、templates |
| 為什麼要 deny | 禁止 AI 自修改框架規則。若 AI 能改寫 CONSTITUTION 或 command 定義，使用者將無法信任框架的穩定性，也會讓版本升級時產生無法追蹤的差異。 |
| 受影響指令 | **無** — 所有 `/req-*` 指令只讀 framework，從不寫 |
| 移除後會發生什麼 | 理論上 AI 會開始「修補」框架以迴避它覺得麻煩的規則。一兩個 session 後你的 framework 會變成各 session 客製版本，升級將不可能。 |
| 建議保留 | **是** — 這是硬性邊界，不建議放寬 |

### `Edit(.git/**)` / `Write(.git/**)`

| 屬性 | 內容 |
|------|------|
| 保護對象 | `.git/` 內部狀態（index、objects、refs、hooks）|
| 為什麼要 deny | AI 若能直接改 `.git/`，可以竄改歷史、植入 post-commit hook、偽造提交者身分 |
| 受影響指令 | **無** — 框架透過 `git` 指令（走 Bash 白名單）而非直接改 `.git/` 檔案 |
| 移除後會發生什麼 | 歷史完整性失去保證；可能被利用做供應鏈攻擊 |
| 建議保留 | **是** — 企業安全團隊通常會強制此項 |

---

## Allow 條目

### `Read(**)`

| 屬性 | 內容 |
|------|------|
| 允許對象 | 整個 host repo |
| 為什麼要 allow | AI 需要讀 spec / code / personas / conflicts 才能做 research、detect-conflicts、onboarding。若讀取受限，`/req-research` 的去重檢查會失效 |
| 受影響指令 | `/req-research`、`/req-onboard`、`/req-audit`、`/req-detect-conflicts`、`/req-iterate` |
| 敏感檔案怎麼辦 | 另外以 `Read(.env)` 或 `Read(secrets/**)` 加入 `deny`；`deny` 優先於 `allow` |
| 建議保留 | **是**，但建議**明確加密/機密目錄的 deny** |

### `Edit(${REQ_DATA_ROOT}/intake/**)` / `Write(${REQ_DATA_ROOT}/intake/**)`

| 屬性 | 內容 |
|------|------|
| 允許對象 | `intake/raw/` 與 `intake/` 根目錄 |
| 為什麼要 allow | `/req-intake` 建立 raw 檔案、`/req-feedback` 建立 `*-auto-*.md` 自動化 intake |
| 受影響指令 | `/req-intake`、`/req-feedback` |
| 移除後會發生什麼 | `/req-intake` 完全無法運作；`/req-feedback` 無法把監控異常自動回寫 |
| 建議保留 | **是** |

### `Edit(${REQ_DATA_ROOT}/specs/**)` / `Write(${REQ_DATA_ROOT}/specs/**)`

| 屬性 | 內容 |
|------|------|
| 允許對象 | 所有 spec 目錄及其內容 |
| 為什麼要 allow | `/req-translate` 建立 spec.md、`/req-plan` 產 plan.md/tasks.md/contracts.md、`/req-detect-conflicts` 添加衝突標記、`/req-review` 更新 status、`/req-implement` 更新版本歷史 |
| 受影響指令 | `/req-translate`、`/req-plan`、`/req-detect-conflicts`、`/req-review`、`/req-resolve-conflict`、`/req-implement`、`/req-iterate`、`/req-onboard`（deep 模式產生 legacy specs）|
| 移除後會發生什麼 | 主流程全部斷鏈 — 等於完全不能用這個框架 |
| 建議保留 | **是** — 這是核心權限 |

### `Edit(${REQ_DATA_ROOT}/personas/**)` / `Write(${REQ_DATA_ROOT}/personas/**)`

| 屬性 | 內容 |
|------|------|
| 允許對象 | 所有 persona 檔案 |
| 為什麼要 allow | `/req-translate` 遇到新角色時建立；`/req-onboard` 從既有 repo 反推 persona |
| 受影響指令 | `/req-translate`、`/req-onboard` |
| 移除後會發生什麼 | 遇到新角色時 AI 會 abort，必須人工先建立 persona 檔案 |
| 建議保留 | **是** |

### `Edit(${REQ_DATA_ROOT}/conflicts/**)` / `Write(${REQ_DATA_ROOT}/conflicts/**)`

| 屬性 | 內容 |
|------|------|
| 允許對象 | `conflicts/CONFLICT-*.md` |
| 為什麼要 allow | `/req-detect-conflicts` 建立衝突檔案；`/req-resolve-conflict` 更新狀態 |
| 受影響指令 | `/req-detect-conflicts`、`/req-resolve-conflict` |
| 移除後會發生什麼 | 衝突無法被記錄；跨角色衝突會被靜默忽略 — 違反 CONSTITUTION「人類把關決策」原則 |
| 建議保留 | **是** |

### `Edit(${REQ_DATA_ROOT}/reviews/**)` / `Write(${REQ_DATA_ROOT}/reviews/**)`

| 屬性 | 內容 |
|------|------|
| 允許對象 | `reviews/REVIEW-*.md` |
| 為什麼要 allow | `/req-review` 產生審核 checklist |
| 受影響指令 | `/req-review` |
| 移除後會發生什麼 | 審核結果無處落檔，無法追溯誰在何時批准了什麼 |
| 建議保留 | **是** |

### `Edit(${REQ_DATA_ROOT}/docs/**)` / `Write(${REQ_DATA_ROOT}/docs/**)`

| 屬性 | 內容 |
|------|------|
| 允許對象 | `docs/changelog.md`、`docs/project-context.md`、`docs/existing-features.md`、`CONSTITUTION.md` 覆寫層 |
| 為什麼要 allow | 所有指令都會更新 `changelog.md`；`/req-onboard` 產出 `project-context.md` 與 `existing-features.md`；`/req-onboard deep` 可能產出專案特化 CONSTITUTION |
| 受影響指令 | 幾乎所有 `/req-*`（因 changelog 更新） |
| 移除後會發生什麼 | changelog 無法更新 → metrics 計算（詳見 `docs/metrics.md`）失效；`/req-audit` 的 drift 檢查會失去 changelog 基準 |
| 建議保留 | **是** |

### `Edit(${REQ_CODE_ROOT}/src/**)` / `Write(${REQ_CODE_ROOT}/src/**)`

| 屬性 | 內容 |
|------|------|
| 允許對象 | 生成的應用程式碼 |
| 為什麼要 allow | `/req-implement` 產出實作；`/req-iterate --fixup` 做 patch-level 修補 |
| 受影響指令 | `/req-implement`、`/req-iterate --fixup` |
| 移除後會發生什麼 | `/req-implement` 完全無法運作 — 如果你希望 AI 只做到 plan 層次、不碰實作程式碼，可以**移除這兩條** |
| 建議保留 | **視場景而定**。若你想把 req 當作「需求與設計」工具而不讓 AI 寫生產程式碼，可移除。要同步在 `deny` 加 `Edit(src/**)`、`Write(src/**)` 以明示禁止 |

### `Edit(${REQ_CODE_ROOT}/tests/**)` / `Write(${REQ_CODE_ROOT}/tests/**)`

| 屬性 | 內容 |
|------|------|
| 允許對象 | 生成的測試程式碼 |
| 為什麼要 allow | `/req-implement` 強制 test-first，會先寫測試再寫實作 |
| 受影響指令 | `/req-implement`、`/req-iterate --fixup` |
| 移除後會發生什麼 | `/req-implement` abort — 測試寫不進去就無法走完流程 |
| 建議保留 | **視場景而定**（同 `src/` 的考量）|

---

## 更嚴格環境的客製化

### 場景 1：只用 req 到 plan 層次，AI 不寫程式碼

把這四條從 `allow` 搬到 `deny`：

```json
"deny": [
  "Edit(${REQ_FRAMEWORK_ROOT}/**)",
  "Write(${REQ_FRAMEWORK_ROOT}/**)",
  "Edit(.git/**)",
  "Write(.git/**)",
  "Edit(${REQ_CODE_ROOT}/src/**)",
  "Write(${REQ_CODE_ROOT}/src/**)",
  "Edit(${REQ_CODE_ROOT}/tests/**)",
  "Write(${REQ_CODE_ROOT}/tests/**)"
]
```

**影響**：`/req-implement` 會直接 abort。`/req-plan` 之前的所有階段照常運作。

### 場景 2：機密檔案完全不可讀

在 `deny` 加上機密目錄：

```json
"deny": [
  "Edit(${REQ_FRAMEWORK_ROOT}/**)",
  "Write(${REQ_FRAMEWORK_ROOT}/**)",
  "Edit(.git/**)",
  "Write(.git/**)",
  "Read(.env)",
  "Read(secrets/**)",
  "Read(**/*.pem)",
  "Read(**/*.key)"
]
```

**影響**：`/req-research` 與 `/req-onboard` 掃描時會自動跳過這些路徑，不會因缺檔 crash。

### 場景 3：禁止 AI 執行 git commit

settings.json 的 Bash 白名單不在本文件範疇（屬於 Claude Code 自身設定），但若你希望 AI 產出變更但**不自動 commit**，可在你的 Claude Code 設定加上 `Bash(git commit:*)` 到 deny。

**影響**：AI 完成 `/req-implement` 後不會自動 commit；你需要手動 `git add && git commit`。框架本身不依賴自動 commit。

---

## 與設定漂移的對抗

- **修改 `settings.json` 時**：務必同步更新本文件對應段落。`settings.json` 裡已附一行 comment 指向本文件作為提醒。
- **加新 `/req-*` 指令時**：若新指令需要新的寫入路徑（例如 `${REQ_DATA_ROOT}/monitoring/**`），**必須**在本文件新增一個 sub-section 說明理由。
- **CI 檢查建議**：可以在 `/req-audit` 加一條規則「比對 `settings.json` 每條 `allow` 是否存在於 `docs/permissions.md`」，偏離則報 drift。
