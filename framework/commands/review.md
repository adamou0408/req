# /review - Generate Review Checklist

## Description
Generate a human-readable review checklist for a spec pending approval.

## Usage
```
/review [spec directory path]
```

## Behavior
1. Read the specified `spec.md` from the spec directory.
2. Generate a comprehensive review checklist covering:
   - [ ] All User Stories are complete and reasonable
   - [ ] Acceptance criteria are specific and testable
   - [ ] All detected conflicts have been resolved
   - [ ] No open questions remain unanswered
   - [ ] No overlap with existing approved features
   - [ ] Non-functional requirements are addressed
   - [ ] Security requirements are assessed (資料分類, 認證, 授權, 加密, 審計, 個資)
   - [ ] Spec dependencies (前置需求) are valid and approved
   - [ ] Success metrics are defined and measurable
   - [ ] Spec owner and reviewer are assigned
   - [ ] Traceability to original intake is intact (intake → research → spec)
3. Save the review checklist to `${REQ_DATA_ROOT}/reviews/REVIEW-{feature-slug}-{date}.md` using the template from `${REQ_FRAMEWORK_ROOT}/framework/templates/review.md`.
4. Present the spec to the human reviewer using the **Decision Brief UX** below — not just a flat markdown dump. The Brief gives the reviewer enough context to drill down before making a judgment, replacing the older compressed TL;DR pattern.

   #### Decision Brief UX
   a. **Print a Decision Brief in Chinese** (per [AGENTS.md](../AGENTS.md) section 7.0 Language Convention). The Brief does **NOT** compress the spec into 6 lines — it summarises each key fact and links to the source so the reviewer can drill down before deciding:

      ```markdown
      ### 📋 決策摘要：規格審核 — <spec title>

      **目標**：判斷此 spec 是否可從 `in-review` 進入 `approved`，或需退回修正。

      **關鍵事實**（每項附原檔連結）：
      - 規格範圍：<一句話描述本 spec 交付什麼> → 詳見 [spec.md#需求摘要](../specs/<feature-slug>/spec.md#需求摘要)
      - User Stories：<N 個故事，涵蓋 M 個 personas> → 詳見 [spec.md#使用者故事](../specs/<feature-slug>/spec.md#使用者故事)
      - 衝突狀態：<已解決 X / 全部 Y；若 Y=0 則寫「無偵測到衝突」> → 詳見 [conflicts/](../conflicts/)
      - 安全性評估：<OK / 待補；簡述資料分類與認證需求> → 詳見 [spec.md#安全性需求](../specs/<feature-slug>/spec.md#安全性需求)
      - 追溯來源：<原始 intake 檔案名> → 詳見 [intake/raw/<file>.md](../intake/raw/<file>.md)
      - 前置依賴：<列出前置 specs 與其狀態> → 詳見 [spec.md#依賴關係](../specs/<feature-slug>/spec.md#依賴關係)

      **需特別關注**：
      - ⚠️ <第一個 AI 信心度低或有歧義的項目，附對應段落連結>
      - ⚠️ <第二個需要人眼判斷的事項，附連結；若無則寫「無」>

      **建議**：<AI 推薦的選項與一句話理由，例如「建議 Approve — 所有 checklist 項目通過且無高風險點」>

      👉 建議先點開上列連結確認細節後再做決定。
      ```

   b. **Then call the `AskUserQuestion` tool** per the [Next Step Picker Convention](../AGENTS.md#7b-next-step-picker-convention) (max 3 options, AI-recommended option first with `（建議）` suffix). The four historical outcomes are collapsed into 3 picker options + automatic "Other":
      - `Approve（建議）` — 全部通過，送進 /plan（補充意見走第二輪 picker 收集）
      - `Request changes` — 退回 draft，列出待修正的 checklist 項目
      - `Reject` — 整個 spec 不採用，標記為 wontfix

      The "Other" entry is added by the tool itself and covers edge cases like "Approve with conditional notes" — pick it only if none of the three explicit options fit.

      If the AI recommendation is *not* Approve (e.g. Decision Brief flagged a high-risk item), reorder so the recommended option is first and update its `（建議）` suffix accordingly.

   c. If the reviewer picks `Approve` and the Decision Brief mentioned items needing notes, call `AskUserQuestion` **again** to collect notes (single picker: `加註意見` / `直接通過`). If the reviewer picks `Request changes`, call `AskUserQuestion` **again** to collect which specific checklist item(s) failed (multiSelect across the checklist items). Avoid free-text whenever the answer can be a fixed choice.

   d. Only after the structured answer is captured, render the full markdown checklist for the record (saved to `reviews/`).

5. Upon human approval:
   - **MUST** update ALL checklist items to `[x]` that have been verified
   - **MUST** leave items as `[ ]` if they were NOT verified and add a note explaining why
   - **MUST** fill in the reviewer name and date
   - Update `spec.md` status from `in-review` to `approved`
   - Log the approval in `${REQ_DATA_ROOT}/docs/changelog.md`
6. Upon rejection:
   - Note the feedback on the specific checklist items that failed
   - Reset `spec.md` status to `draft`
   - Summarize what needs to change
7. Post-implementation verification:
   - When spec status transitions to `done`, **MUST** re-verify the review checklist
   - Add an "Implementation Verification" section with actual test results, task completion status, and deployment status
   - Update any checklist items whose status changed during implementation

## Constraints
- The review checklist must be understandable by non-technical stakeholders.
- Do not auto-approve. Always wait for explicit human confirmation.
- Specs with unresolved conflicts (`detected` or `under-discussion`) cannot be approved.
- **NEVER** leave a review in an inconsistent state: if the result is `approved`, all verified items must be `[x]`.
- **NEVER** transition spec to `done` without updating the review checklist to reflect final status.
