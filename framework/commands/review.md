# /review - Spec Review

## Description
Generate a review checklist for a spec pending approval, present it as a Decision Brief, and record the human's decision.

## Usage
```
/review [spec directory path]
```

## Behavior

**Prerequisite checks and option lists are handled by the `req` CLI.** Do NOT re-implement checks or improvise options.

### 1. Run checklist
Run `req review checklist <slug>`. This returns JSON with `all_pass`, `pass_count`, `fail_count`, and `items[]` — each item has `id`, `label`, `pass`, `detail`.

### 2. Render Decision Brief
Using the checklist JSON, print a **Decision Brief in Chinese**:

```markdown
### 📋 決策摘要：規格審核 — {title}

**目標**：判斷此 spec 是否可從 `in-review` 進入 `approved`。

**Checklist 結果**：{pass_count}/{total} 通過
{for each failed item: - ⚠️ {label}: {detail}}
{for each passed item: - ✅ {label}}

**建議**：{if all_pass: "建議 Approve" | else: "有 {fail_count} 項未通過，建議 Request changes"}

👉 建議先看各項的 detail 再做決定。
```

### 3. Collect decision
Run `req ask review.approval` and pipe the JSON directly to `AskUserQuestion`. Do NOT construct options manually.

### 4. If `Approve w/ notes` or `Request changes`:
Run `AskUserQuestion` again to collect which specific checklist items need attention (multiSelect across the failed items from step 1).

### 5. Record result
- Save review checklist to `${REQ_DATA_ROOT}/reviews/REVIEW-{slug}-{date}.md`.
- On **Approve / Approve w/ notes**: run `req spec set-status <slug> approved --by "/req-review"`.
- On **Request changes**: status stays `in-review`, record change requests in review file.
- On **Reject**: run `req spec set-status <slug> draft --reason "rejected" --by "/req-review"`.

## Constraints
- **MUST** use `req review checklist` for all checks. Do NOT parse spec.md directly.
- **MUST** use `req ask review.approval` for the decision options. Do NOT improvise.
- **MUST** use `req spec set-status` for state transitions. Do NOT edit spec.md directly.
- **MUST NOT** auto-approve. Always wait for explicit human confirmation.
- Specs with unresolved conflicts cannot be approved (checklist enforces this).
- **NEVER** leave a review in an inconsistent state.
