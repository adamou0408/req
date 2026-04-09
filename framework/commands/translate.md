# /translate - AI Requirement Translation

## Description
Translate raw, unstructured requirements from `intake/` into structured specs with User Stories and acceptance criteria.

## Usage
```
/translate [path to intake file]
```

## Behavior
1. Read the specified raw requirement file from `${REQ_DATA_ROOT}/intake/raw/`.
1a. **Idempotency check for resumed sessions**: if a `spec.md` already exists under `${REQ_DATA_ROOT}/specs/{feature-slug}/` that was generated from this same intake file, branch on `spec.md` status:
    - **Status is `draft` or `in-review`**: run `git diff --stat` against the existing `spec.md` to show the reviewer what is currently on disk, then ask: `Overwrite / Show full diff / Cancel`. Proceed only after explicit choice. This covers session crashes between `/req-translate` and `/req-review`.
    - **Status is `approved` / `in-progress` / `done`**: refuse with `Spec already exists and is past the draft stage. Use /req-iterate to modify it.` Do NOT overwrite.
    - **No existing spec matches this intake**: proceed normally (step 2 onwards).
2. Identify all user personas involved:
   - Cross-reference with existing personas in `${REQ_DATA_ROOT}/personas/`.
   - If a new persona is discovered, create a new persona file in `${REQ_DATA_ROOT}/personas/` using the `_template.md` format.
3. For each identified persona, generate:
   - A User Story in the format: **As a** [role], **I want** [feature], **so that** [benefit]
   - Testable acceptance criteria as a checklist
4. Create a new feature directory in `${REQ_DATA_ROOT}/specs/{feature-slug}/`.
5. Generate `spec.md` using the template from `${REQ_FRAMEWORK_ROOT}/framework/templates/spec/spec.md`:
   - Set status to `draft`
   - Set version to `v1.0`
   - Link back to the source intake file and `research.md`
   - Assign spec ownership (Spec 擁有者 = intake submitter, or ask if unclear)
   - Identify dependencies on existing specs (前置需求)
   - Include all User Stories and acceptance criteria
   - Include non-functional requirements if applicable
   - Include security requirements assessment
   - Include initial success metrics (suggest measurable goals)
   - List any open questions
6. Automatically execute `/detect-conflicts` on the new spec.
7. **Print a Decision Brief** in Chinese (per [AGENTS.md](../AGENTS.md) §7.0 Language Convention) summarising the spec with drill-down links. Format defined in the "Decision Brief" section below.
8. **Call `AskUserQuestion`** with the picker defined below, applying the [Next Step Picker Convention](../AGENTS.md#7b-next-step-picker-convention). The picker decides whether the spec proceeds to `/req-review`, returns to the submitter for clarification, or is parked.

## Decision Brief

```markdown
### 📋 決策摘要：規格初稿 — <spec title>

**目標**：判斷此 draft spec 是否進入 `/req-review`，或先補強再送出。

**關鍵事實**（每項附原檔連結）：
- Spec 檔案：[spec.md](${REQ_DATA_ROOT}/specs/<feature-slug>/spec.md)
- 來源 intake：[<file>](${REQ_DATA_ROOT}/intake/raw/<file>.md)
- 涉及 personas：<列出 N 個 personas，新建立的標 (新)> → 詳見 [personas/](${REQ_DATA_ROOT}/personas/)
- User Stories 數量：<N 個 stories>
- 偵測到的衝突數：<M 個；若 M=0 寫「無衝突」> → 詳見 [conflicts/](${REQ_DATA_ROOT}/conflicts/)
- 前置依賴 specs：<列出依賴 specs 與其狀態，若無寫「無」>
- Open questions：<尚未澄清的問題數量；若 0 寫「無」>
- Spec 擁有者：<姓名 / 角色>

**需特別關注**：
- ⚠️ <若偵測到衝突，列出最高嚴重度的一條與對應段落連結>
- ⚠️ <若有 open questions，列出最關鍵的一個>
- ⚠️ <若有新建立的 persona，提醒使用者確認定義>

**建議**：<AI 推薦的下一步與一句話理由，例如「建議直接送 /req-review — 無衝突且 open questions 為 0」>

👉 建議先點開 spec.md 確認 User Stories 與 acceptance criteria 後再做決定。
```

Then call `AskUserQuestion` with **at most three options**, AI-recommended option first with `（建議）` suffix:

- `送進 /req-review（建議）` — 自動觸發 `/req-review`，產生審核清單並等待人工核准
- `補充 open questions` — 暫停流程，列出 open questions 讓 spec 擁有者回覆後重跑 `/req-translate`
- `保留為 draft` — 不前進，spec 留在 `draft` 狀態，使用者稍後再處理

If the AI recommendation is *not* "proceed to review" (e.g. there are unresolved open questions or new conflicts), reorder the picker so the recommended option is first and update its `（建議）` suffix accordingly.

## Constraints
- Preserve original context and intent from the raw input.
- Do not add requirements that were not expressed or implied in the original input.
- Use plain language in User Stories — avoid technical jargon unless the requester used it.
- Every spec must link back to its intake source (traceability).
- **MUST** print the Decision Brief in Chinese before calling `AskUserQuestion` (per AGENTS.md §7b).
- **MUST NOT** auto-chain into `/req-review` without going through the picker — the spec owner should always have the chance to add open-question answers first.
- **MUST NOT** use free-text confirmation in place of the picker (per AGENTS.md §7b anti-patterns).
