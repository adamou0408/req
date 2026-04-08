# /feedback - Process Monitoring Feedback

## Description
Process feedback from monitoring systems, health checks, or production incidents, and route them back into the demand-driven development cycle as new intake items.

This command is the manual trigger for the closed-loop feedback mechanism. It can also be triggered automatically by the monitoring system via webhooks.

## Usage
```
/feedback [alert description or monitoring data]
```

## Behavior

### 1. Classify the Feedback
Determine the type and severity:
- **Type**: service-down, high-error-rate, high-latency, deployment-failure, user-error-report
- **Severity**: critical (很急), warning (普通), info (不急)

### 2. Deduplication Check
- Check `${REQ_DATA_ROOT}/intake/raw/` for similar auto-generated intake items created within the last 30 minutes
- If a duplicate exists, append new information to the existing intake rather than creating a new one

### 3. Create Intake Item
- Generate `${REQ_DATA_ROOT}/intake/raw/YYYY-MM-DD-auto-{alert-slug}.md`
- Use the appropriate template based on feedback type:
  - Service down / deployment failure → `bug-report` template
  - High latency / high error rate → `user-feedback` template
  - Feature suggestion from usage patterns → `quick-idea` template
- Mark the intake as auto-generated with metadata:
  - Source: monitoring system name
  - Auto-generated: true
  - Requires triage: true

### 4. Triage Recommendation
Provide an initial assessment:
- Impact scope (how many users affected)
- Urgency recommendation
- Related existing specs (if any)
- Suggested priority

### 5. Post-Mortem (for critical and staging/prod failures)
- For **critical** issues or deployment failures:
  - Create a post-mortem record in `${REQ_DATA_ROOT}/docs/postmortems/YYYY-MM-DD-{slug}.md` using the template
  - Pre-fill: event date, severity, timeline, related spec/intake links
  - The 5 Whys analysis and lessons learned sections are left for human completion
- Post-mortems are informational — they don't block the pipeline but are mandatory for production incidents

### 6. Route to Next Step
- For **critical** issues: immediately notify + create post-mortem + recommend `/research` → `/translate` → fast-track review
- For **warning** issues: create intake and recommend standard `/research` → `/translate` flow
- For **info** issues: create intake, batch for next review cycle

### 7. Decision Brief

If `/feedback` was triggered manually (not by the monitoring webhook), **MUST** print a Decision Brief in Chinese (per [AGENTS.md](../AGENTS.md) section 7.0 Language Convention) before chaining into `/research`. For automated webhook invocations, print the Brief into the auto-generated intake item as a header so reviewers see it when triaging — but do **NOT** call `AskUserQuestion` (the loop must stay automatic).

```markdown
### 📋 決策摘要：監控回饋處理 — <alert summary>

**目標**：判斷此監控事件如何進入需求循環。

**關鍵事實**（每項附原檔連結）：
- 事件分類：<type / severity> → 詳見 [新建 intake 檔案](${REQ_DATA_ROOT}/intake/raw/YYYY-MM-DD-auto-{slug}.md)
- 影響範圍：<受影響使用者數量或範圍>
- 30 分鐘內重複次數：<N 次；若 ≥3 已升級>
- 相關既有 specs：<列出 0~3 個既有 spec 連結，若無則寫「未發現關聯」>
- 監控來源：<dashboard URL / alert ID> → <連結>
- 建議路由：<critical / warning / info 對應的下游動作>

**需特別關注**：
- ⚠️ <若為 critical：提醒已建立 post-mortem 並需要快速通道審核>
- ⚠️ <若 24 小時內第 3 次以上：提醒已觸發升級通報>

**建議**：<AI 推薦的處理路徑與一句話理由>

👉 建議先點開上列連結確認細節後再做決定。
```

For manual invocations, then call `AskUserQuestion` per the [Next Step Picker Convention](../AGENTS.md#7b-next-step-picker-convention) (max 3 options, AI-recommended option first with `（建議）` suffix). The recommendation depends on the alert classification:
- `進入需求循環（建議）` — 自動轉交 `/research`（critical / warning 類預設）
- `先檢視原始監控資料` — 暫不轉交，由人工先看 dashboard
- `去重併入既有 intake` — 若 AI 已建議重複項目，將本次資訊併入

For info-level alerts the AI recommendation should swap to `先檢視原始監控資料（建議）` (no urgency, batch later). For obvious duplicates the recommendation should swap to `去重併入既有 intake（建議）`. Always exactly one `（建議）` per picker.

## Constraints
- **MUST** preserve all monitoring data in the intake item
- **MUST** deduplicate within 30-minute windows to avoid alert storms
- **MUST** link back to the monitoring source (dashboard URL, alert ID, etc.)
- **MUST NOT** auto-resolve production issues — always route through the full cycle
- **MUST** escalate if the same alert fires 3+ times within 24 hours
- **MUST** print the Decision Brief in Chinese for manual invocations and embed it in the intake item header for automated invocations
- **MUST NOT** call `AskUserQuestion` for automated webhook invocations — the closed loop must stay automatic; the Brief is for record only

## Closed-Loop Integration
This command completes the feedback loop:

```
Deploy → Monitor → Alert → /feedback → post-mortem + intake/ → /research → /translate → spec → /review → /implement → Deploy → ...
```

Every production issue is treated as a new requirement, ensuring continuous improvement.
