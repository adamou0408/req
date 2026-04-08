# /research - Requirement Research & Deduplication

## Description
Before translating a raw requirement into a spec, research existing specs for duplicates/overlaps, assess feasibility, and gather technical context. This command is a **thin wrapper** that delegates the heavy lifting to the `req-research` subagent so the main conversation context stays clean.

## Usage
```
/research [path to intake file]
```

## Behavior

1. **Delegate to subagent**: invoke the `req-research` subagent via the Agent tool. Pass the intake file path and a short description like "Run req-research deduplication and feasibility analysis on this intake."
2. The subagent will:
   - Scan all existing specs for duplicates and partial overlaps
   - **Also** compare against `${REQ_DATA_ROOT}/docs/existing-features.md` (the onboarding inventory, if present). A match there means the feature is already implemented in the host repo and the new intake is likely a modification rather than a new build.
   - Assess feasibility (new tech, integrations, schema changes, security)
   - Gather related code/persona/conflict context
   - Write `${REQ_DATA_ROOT}/specs/{feature-slug}/research.md`
   - Return a structured summary (under 30 lines), including the `matched-existing-feature:` field
3. **Surface the subagent's summary** to the user as-is — do not re-summarize or expand it.
4. **Print the Decision Brief** in Chinese (per [AGENTS.md](../AGENTS.md) §7.0 Language Convention) summarising the subagent findings with drill-down links. Format defined in the "Decision Brief" section below.
5. **Branch on the subagent's `recommended next step:` field AND `REQ_AUTONOMY_LEVEL`**, applying the [Next Step Picker Convention](../AGENTS.md#7b-next-step-picker-convention):
   - `recommended next step: proceed to /req-translate` → automatically run `/req-translate` on the intake (all levels). **No picker**, but the Brief is still printed for the record.
   - `recommended next step: merge via /req-iterate <slug>` →
     - **strict**: print the Brief, then call `AskUserQuestion` with the picker defined below. SOFT checkpoint — human chooses.
     - **balanced / auto**: auto-execute the merge. Print the Brief with the AI-recommended option highlighted; **do not** call `AskUserQuestion`. Annotate the changelog entry with `[autonomy: balanced]` or `[autonomy: auto]`.
   - `recommended next step: wait for human decision` (e.g. Red feasibility) → always print the Brief and call the picker, regardless of autonomy level.

## Decision Brief

```markdown
### 📋 決策摘要：需求研究結果 — <intake slug>

**目標**：根據去重與可行性分析結果，決定此 intake 的下一步。

**關鍵事實**（每項附原檔連結）：
- 原始 intake：[<file>](${REQ_DATA_ROOT}/intake/raw/<file>.md)
- 研究報告：[research.md](${REQ_DATA_ROOT}/specs/<feature-slug>/research.md)
- 重複度評估：<高 (>80%) / 中 (30-80%) / 低 (<30%) / 無重疊>
- 既有 feature 命中：<existing-features.md 中的條目；若無寫「未命中」>
- 可行性等級：<Green / Yellow / Red>，主要風險：<一句話>
- 安全相關：<是 / 否；若是列出主要面向>

**需特別關注**：
- ⚠️ <若可行性為 Red，列出阻擋原因與對應段落連結>
- ⚠️ <若重複度高，列出建議併入的 spec 與其狀態>

**建議**：<AI 推薦的下一步與一句話理由，例如「建議直接 /req-translate — 與既有 specs 無重疊且可行性為 Green」>

👉 建議先點開 research.md 確認細節後再做決定。
```

Then call `AskUserQuestion` with **at most three options**, AI-recommended option first with `（建議）` suffix. Concrete picker shapes by branch:

**Branch A — duplicate / overlap detected**:
- `併入既有 spec（建議）` — 觸發 `/req-iterate <slug>`，把本次 intake 視為既有需求的變更
- `仍建立新 spec` — 強制進入 `/req-translate`，由人工確認新舊需求確實獨立
- `稍後再決定` — 保留 intake 與 research 報告，不前進

**Branch B — feasibility Red / waits for human**:
- `補充技術細節（建議）` — 暫停流程，由人工提供缺漏資訊後再重跑 `/req-research`
- `強制進入 /req-translate` — 知道風險仍要前進，AI 不為決定背書
- `取消此 intake` — 標記 intake 為 `wontfix`，不再進入後續流程

For Branch A under `balanced` / `auto`, the picker is **skipped** — auto-take the first option and log the decision.

## Constraints
- **MUST** delegate to `req-research`; do not perform the spec scan inline in the main conversation
- **MUST** preserve the subagent's structured summary verbatim in the user-facing output
- **MUST** print the Decision Brief in Chinese before any auto-chain or picker call (per AGENTS.md §7b)
- **MUST NOT** auto-merge or auto-iterate under `strict` — picker required
- **MUST NOT** call `/req-translate` if the subagent flagged duplicates with >80% overlap (all levels) without going through the picker first
- **MUST NOT** bypass a `wait for human decision` recommendation even under `auto` (feasibility Red is not a SOFT checkpoint)
- **MUST NOT** use free-text confirmation in place of the picker (per AGENTS.md §7b anti-patterns)
