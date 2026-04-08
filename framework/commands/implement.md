# /implement - AI Implementation

## Description
Execute the technical plan by generating code and tests automatically.

## Prerequisites
- `plan.md` and `tasks.md` must exist in the spec directory.
- The corresponding `spec.md` status **must be `in-progress`** — meaning the human has already accepted the plan via the ExitPlanMode popup at the end of `/req-plan`. If status is still `approved`, **refuse** and remind the user to run `/req-plan` and accept the plan first.
- If `contracts.md` exists, API contracts must be implemented first.

## Usage
```
/implement [spec directory path]
```

## Behavior
1. Verify prerequisites. Abort with a clear message if not met. Specifically check:
   - `plan.md` and `tasks.md` exist
   - `spec.md` status is exactly `in-progress` (not `approved`, not `done`). If status is `approved`, abort with: "Plan has not been accepted. Run /req-plan and accept the plan via the approval popup before implementing."
2. Update `spec.md` version history (increment version, note implementation start).
4. Process tasks from `tasks.md`:
   - Respect dependency order: tasks with `[depends: N]` wait for task N to complete.
   - Execute parallelizable tasks (same `[P-group-X]`) concurrently when possible.
   - For each task:
     a. **If `contracts.md` exists**: implement contracts/interfaces first (types, API stubs)
     b. Generate test(s) in `${REQ_CODE_ROOT}/tests/` **before** implementation code (test-first approach)
        - Follow the task's **test strategy**: generate unit, integration, and/or e2e tests as specified
     c. Generate implementation code in `${REQ_CODE_ROOT}/src/`
     d. Add traceability comment in generated code:
        ```
        // Spec: specs/{feature}/spec.md — User Story: "As a ..."
        // Task: specs/{feature}/tasks.md — Task N
        ```
     e. Run the tests
     f. If tests fail:
        - Analyze the failure
        - Auto-fix the code
        - Re-run tests
        - Repeat up to **3 times**
     g. If still failing after 3 attempts:
        - Mark the task as `needs-human-intervention`
        - Log the failure details
        - Continue with independent tasks if possible
     h. Mark the task as complete in `tasks.md`
5. After all tasks are processed:
   - Run the full test suite (unit → integration → e2e)
   - Generate an implementation report including:
     - Tasks completed vs. tasks needing intervention
     - Test coverage summary (by layer: unit/integration/e2e)
     - Security check summary (no hardcoded secrets, input validation present)
     - Any deviations from the plan
     - Code review readiness assessment
6. If all tasks pass: update `spec.md` status to `done`.
7. **Print a Decision Brief** in Chinese (per [AGENTS.md](../AGENTS.md) §7.0 Language Convention) summarising the implementation outcome with drill-down links. Format defined in the "Decision Brief" section below.
8. **Call `AskUserQuestion`** with the picker defined below, applying the [Next Step Picker Convention](../AGENTS.md#7b-next-step-picker-convention). The picker decides whether the implementation flows on to deployment, queues for code review, or stops for human intervention.

## Decision Brief

```markdown
### 📋 決策摘要：實作完成 — <feature title>

**目標**：判斷此實作下一步：進入 /req-deploy、等待 code review、或停下來處理失敗任務。

**關鍵事實**（每項附原檔連結）：
- 規格與計畫：[spec.md](${REQ_DATA_ROOT}/specs/<feature-slug>/spec.md) / [plan.md](${REQ_DATA_ROOT}/specs/<feature-slug>/plan.md) / [tasks.md](${REQ_DATA_ROOT}/specs/<feature-slug>/tasks.md)
- 任務完成狀況：<X/Y 完成；needs-human-intervention: Z>
- 測試結果：unit <pass/fail>，integration <pass/fail>，e2e <pass/fail>
- Auto-fix 次數：<總共重試 N 次；達到 3 次上限的任務數 M>
- 安全掃描：<無硬編密鑰 / 有硬編密鑰；輸入驗證 OK / 待補>
- 偏離計畫：<列出與 plan.md 差異的項目；若無寫「無」>
- Spec 狀態：<done / in-progress（若有 needs-human-intervention 任務）>

**需特別關注**：
- ⚠️ <若有 needs-human-intervention 任務，列出最關鍵的一個與失敗原因>
- ⚠️ <若 e2e 測試有失敗，列出失敗 case>
- ⚠️ <若部署影響評估有不可逆變更，提醒 /req-deploy 會觸發人工核准>

**建議**：<AI 推薦的下一步與一句話理由，例如「建議進入 code review — 全部任務通過且無安全告警」>

👉 建議先點開實作報告與測試輸出確認細節後再做決定。
```

Then call `AskUserQuestion` with **at most three options**, AI-recommended option first with `（建議）` suffix. The recommendation depends on the implementation outcome:

**Branch A — all tasks passed, ready for deployment**:
- `進入 /req-deploy（建議）` — 觸發 `/req-deploy <env>`，預設 `staging`
- `先做 code review` — 暫停部署，建立 PR 等待人工 code review（per AGENTS.md §11）
- `保留為 done 不前進` — spec 留在 `done` 狀態，使用者稍後再手動部署

**Branch B — some tasks `needs-human-intervention` (3-strike test failure)**:
- `查看失敗任務並修復（建議）` — 列出 needs-human-intervention 任務，等待人工接手；spec 留在 `in-progress`
- `跳過失敗任務繼續部署` — **AI 強烈不建議**，但允許使用者強制前進（會在 changelog 留下警示記錄）
- `回退到 /req-iterate` — 把失敗視為需求變更，重跑 `/req-iterate` 調整 spec

For Branch B, the agent **MUST NOT** auto-take any option regardless of autonomy level — 3-strike failure is a HARD checkpoint per AGENTS.md §5.

## Constraints
- All generated code must be traceable to a task and User Story (via comments).
- Do not write code that isn't required by the tasks.
- Follow existing code patterns and conventions in `${REQ_CODE_ROOT}/src/`.
- Log every auto-fix attempt for transparency.
- Generate tests before implementation code (test-first).
- Respect parallel group markings — do not serialize tasks that can run in parallel.
- **MUST** print the Decision Brief in Chinese before calling the picker (per AGENTS.md §7b).
- **MUST NOT** auto-chain into `/req-deploy` — deployment is always a separate decision moment.
- **MUST NOT** mark any task as `done` if it is in `needs-human-intervention` state — that state is the picker's input.
- **MUST NOT** use free-text confirmation in place of the picker (per AGENTS.md §7b anti-patterns).
