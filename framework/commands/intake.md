# /intake - Submit a New Requirement

## Description
Capture raw requirement input from any user and initiate the AI translation pipeline.

## Usage
```
/intake
```

## Behavior
1. Ask the user three questions in plain, friendly language:
   - **Who are you?** (role, department, or just a name)
   - **What do you want?** (in their own words, any format)
   - **Why?** (what problem does this solve, or what value does it bring)
2. Save the response to `${REQ_DATA_ROOT}/intake/raw/YYYY-MM-DD-{slug}.md` where `{slug}` is a short kebab-case summary of the request.
3. Use the quick-idea template from `${REQ_FRAMEWORK_ROOT}/framework/templates/intake/quick-idea.md` as the base format.
4. **Output a Decision Brief** to the user and call `AskUserQuestion` for confirmation before automatically chaining into `/research`. Format defined in the "Decision Brief" section below.
5. Only after the user confirms via `AskUserQuestion`, automatically trigger the `/research` workflow on the newly created file (deduplication and feasibility check before translation).

## Decision Brief

Before triggering `/research`, the agent **MUST** print the following block in Chinese (per [AGENTS.md](../AGENTS.md) section 7.0 Language Convention) to give the submitter a chance to verify and drill down before the pipeline runs.

```markdown
### 📋 決策摘要：新需求收件確認

**目標**：確認下列需求摘要正確，並決定是否進入 /research 階段。

**關鍵事實**（每項附原檔連結）：
- 原始需求檔案：[YYYY-MM-DD-{slug}.md](${REQ_DATA_ROOT}/intake/raw/YYYY-MM-DD-{slug}.md)
- 需求摘要：<AI 從使用者輸入濃縮的一句話>
- 推論涉及角色：<列出 1~3 個 persona，附 [persona 連結](${REQ_DATA_ROOT}/personas/<slug>.md)；新角色標 (新)>
- 與既有 specs 的可能關聯：<列出 0~3 個既有 spec 連結，若無則寫「未發現重疊」>
- AI 建議的 feature slug：`<kebab-case-slug>`

**需特別關注**：
- ⚠️ <若有歧義或模糊用詞，列出並建議使用者補充>
- ⚠️ <若推論的角色為新建立，提醒使用者確認>

**建議**：建議「確認送出」，由 /research 進一步驗證去重與可行性。如有歧義建議先選「補充細節」。

👉 建議先點開上列連結確認細節後再做決定。
```

Then call `AskUserQuestion` with options:
- `確認送出` — 進入 /research，開始去重與可行性檢查
- `補充細節` — 回到問答，補充缺漏資訊
- `取消` — 暫不送出，原始檔保留但不進入後續流程

## Constraints
- Accept ANY format of input. Never reject input for being too vague or unstructured.
- Preserve the user's exact words in the raw file.
- Add metadata (date, source) but do not edit the user's content.
- **MUST** print the Decision Brief and call `AskUserQuestion` before chaining into `/research`. Do **NOT** silently auto-chain.
- All Decision Brief content **MUST** be in Chinese (Language Convention).

## Output
- File created: `${REQ_DATA_ROOT}/intake/raw/YYYY-MM-DD-{slug}.md`
- Decision Brief printed to user, followed by `AskUserQuestion` confirmation popup
- On `確認送出`: automatic handoff to `/research` (which proceeds to `/translate` if no duplicates found)
- On `補充細節`: return to the three-question flow
- On `取消`: leave the raw file in place but skip the pipeline; user can re-run `/intake` later
