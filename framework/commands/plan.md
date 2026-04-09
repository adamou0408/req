# /plan - Generate Technical Plan

## Description
Generate a technical implementation plan from an approved spec, informed by the research report.

## Prerequisites
- The corresponding `spec.md` status **must** be `approved`.
- All conflicts in the spec **must** be `resolved`.
- `research.md` **should** exist (created during `/research` phase).

## Usage
```
/plan [spec directory path]
```

## Behavior
1. Verify prerequisites. Abort with a clear message if not met.
1a. **Idempotency check for resumed sessions**: if `plan.md` or `tasks.md` already exists in the spec directory, branch on `spec.md` status:
    - **Status is `approved`** (plan exists from a previous `/req-plan` run that never reached `in-progress`, or a session crash before ExitPlanMode): run `git diff --stat` against existing `plan.md` / `tasks.md` / `contracts.md` to show the reviewer what is currently on disk, then ask: `Overwrite / Show full diff / Cancel`. Proceed only after explicit choice.
    - **Status is `in-progress`**: refuse with `Plan has already been accepted (spec is in-progress). Use /req-iterate to adjust this feature, or /req-iterate --fixup for patch-level changes.` Do NOT overwrite.
    - **Status is `done`**: refuse with `Spec is done. Use /req-iterate to reopen or /req-iterate --fixup for targeted patches.` Do NOT overwrite.
    - **Status is `draft` or `in-review`**: this is inconsistent state (plan without approval). Report the inconsistency and ask the user to manually resolve before continuing.
2. **Check spec dependencies**: verify all specs listed in "前置需求" have status `approved` or later. If not, warn user and wait for confirmation.
3. Read the `spec.md`, `research.md`, and any resolved conflict records.
4. Read CONSTITUTION for architectural constraints, **preferring the project-specific overlay**:
   - If `${REQ_DATA_ROOT}/CONSTITUTION.md` exists (produced by `/req-onboard deep`), read that — it contains project-specific stack, naming, and CI constraints layered on top of the framework version.
   - Otherwise, fall back to `${REQ_FRAMEWORK_ROOT}/framework/CONSTITUTION.md`.
5. Generate `plan.md` in the spec directory, following the [plan.md template](../templates/spec/plan.md) section by section. Every section marked with `*` in the template is mandatory. The **部署影響評估 / Deployment Impact Assessment** block is mandatory in full — see CONSTITUTION.md > Architectural Guardrails > Deployment Integrity for the canonical list of required sub-sections, and [deployment-checklist.md](../templates/spec/deployment-checklist.md) for the detailed check list per sub-section.
6. Generate `tasks.md` in the spec directory:
   - Break the plan into small, executable tasks
   - Each task must reference the User Story it implements
   - Tasks should be ordered by dependency
   - Mark parallelizable tasks with `[P-group-X]` notation
   - Mark dependent tasks with `[depends: N]` notation
   - Each task must include a **test strategy** (unit / integration / e2e)
   - Each task should be independently testable
7. If the spec involves API changes, generate `contracts.md` in the spec directory. When the API has any form of quota or rate limit, **MUST** fill the `速率限制與配額` section. When the API is internet-facing or has multiple clients, **MUST** fill the `版本策略` section (not "無" unless genuinely no versioning is planned).
8. **Print a Decision Brief** in Chinese (per [AGENTS.md](../AGENTS.md) section 7.0 Language Convention) summarising the plan with drill-down links, then call `ExitPlanMode`. Format defined in the "Decision Brief" section below.
9. **Trigger Plan Mode approval**: after the Decision Brief is printed, **MUST** call the `ExitPlanMode` tool. This surfaces the native Claude Code approval popup so the human can accept or reject the technical plan. Do **NOT** proceed to `/req-implement` in the same turn — wait for the human to accept the plan via the popup.
10. Once the human accepts the plan via ExitPlanMode, update `spec.md` status from `approved` to `in-progress` and log the transition in `${REQ_DATA_ROOT}/docs/changelog.md`. Only after this transition is `/req-implement` allowed to run.

## Decision Brief

The Decision Brief is the bridge between writing `plan.md` / `tasks.md` and asking the human to approve via `ExitPlanMode`. It does **NOT** compress the plan into 6 lines — it summarises each key fact with a drill-down link so the reviewer can read the actual content before deciding.

```markdown
### 📋 決策摘要：技術計畫 — <feature title>

**目標**：判斷此技術計畫是否可進入實作階段（spec 從 `approved` → `in-progress`）。

**關鍵事實**（每項附原檔連結）：
- 工作量與複雜度：<S/M/L/XL，N 個任務，預估週期> → 詳見 [tasks.md](../specs/<feature-slug>/tasks.md)
- 技術選型：<列出 1~3 個關鍵技術決策> → 詳見 [plan.md#技術選型](../specs/<feature-slug>/plan.md#技術選型)
- 架構設計重點：<元件拆解的一句話> → 詳見 [plan.md#架構設計](../specs/<feature-slug>/plan.md#架構設計)
- 資料模型變更：<新增/修改/刪除的表格摘要；若無寫「無」> → 詳見 [plan.md#資料模型變更](../specs/<feature-slug>/plan.md#資料模型變更)
- 部署影響六大項：<逐項一句話狀態：健康檢查 / Schema / 設定 / 資源 / 持久性 / 觀測性> → 詳見 [plan.md#部署影響評估](../specs/<feature-slug>/plan.md#部署影響評估)
- 最高風險：<風險評估表中可能性 × 影響最高的一項> → 詳見 [plan.md#風險評估](../specs/<feature-slug>/plan.md#風險評估)

**需特別關注**：
- ⚠️ <若有不可逆資料變更，列出並提醒會觸發 /deploy 的人工核准>
- ⚠️ <若有非向後相容的 schema 變更，列出>
- ⚠️ <若資源預算缺口或外部相依未確認，列出；若無則寫「無」>

**建議**：<AI 推薦的後續動作與一句話理由，例如「建議接受 — 部署影響均為向後相容，風險可控」>

👉 建議先點開上列連結確認細節後再做決定。接著系統會跳出原生核准 popup。
```

Then immediately call `ExitPlanMode`.

## Constraints
- Plan must respect all principles in `${REQ_FRAMEWORK_ROOT}/framework/CONSTITUTION.md`.
- Every task must map to at least one User Story.
- Tasks should be small enough for a single implementation cycle.
- Do not introduce technologies or patterns not justified by the requirements.
- If data model changes are irreversible, flag this explicitly and note it requires extra human approval during `/deploy`.
- **Deployment impact assessment is mandatory**: every section marked `*` in the [plan.md template](../templates/spec/plan.md) must be filled. A conclusion of "no impact" is acceptable but the section must be present. Do **NOT** print the Decision Brief or call `ExitPlanMode` if any mandatory sub-section is blank.
- **MUST** print the Decision Brief in Chinese before calling `ExitPlanMode`. Do **NOT** call `ExitPlanMode` without the Brief.
- Non-backward-compatible schema changes declared in the deployment impact assessment automatically inherit the "irreversible data model changes" gate in `/deploy` — no duplicate declaration needed.
- **MUST NOT** auto-trigger `/req-implement` after `/req-plan`. The ExitPlanMode handshake is the gate — `/req-implement` only runs after the spec status transitions to `in-progress`.
- **MUST NOT** transition the spec to `in-progress` without the human first accepting the plan via ExitPlanMode.
