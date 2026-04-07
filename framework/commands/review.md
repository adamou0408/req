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
4. Present the checklist to the human reviewer using the **Interactive Review UX** below — not just a flat markdown dump.

   #### Interactive Review UX
   a. **TL;DR block first** (≤ 6 lines, fixed format) so the reviewer can judge in 5 seconds:
      ```
      ✅ REVIEW: <spec title>
      範圍: <one sentence — what this spec delivers>
      User Stories: <N 個> | 衝突: <已解決 X / 全部 Y> | 安全性: <OK / 待補>
      風險點: <最高風險的一句話,沒有就寫「無」>
      AI 信心: <High / Medium / Low> — <one-line reason>
      待人類確認的關鍵項: <列出 1–3 個 checklist 中最值得人眼判斷的項目>
      ```
   b. **Then call the `AskUserQuestion` tool** with the decision question. Options:
      - `Approve` — 全部通過,送進 /plan
      - `Approve w/ notes` — 通過但需記錄補充意見
      - `Request changes` — 退回 draft,需修正
      - `Reject` — 整個 spec 不採用
      This renders as a popup picker in Claude Code instead of asking the reviewer to type free text.
   c. If the reviewer picks `Approve w/ notes` or `Request changes`, call `AskUserQuestion` **again** to collect which specific checklist item(s) failed (multiSelect across the checklist items). Avoid free-text whenever the answer can be a fixed choice.
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
