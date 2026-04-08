# /iterate - Requirement Change Iteration

## Description
Handle requirement changes by analyzing impact, updating specs, and managing the re-implementation cycle.

## Usage
```
/iterate [change description or path to intake file]    # forward change (normal mode)
/iterate --fixup <spec-slug>                             # retrospective repair of one spec
/iterate --fixup --from-audit <audit-file>               # replay drift rows from a /audit report
```

## Behavior
1. If a raw description is provided, first save it as a new intake file via the `/intake` process.
2. Analyze the change content and identify:
   - Which existing specs in `${REQ_DATA_ROOT}/specs/` are affected
   - Which parts of each spec need to change
   - Which implemented code in `${REQ_CODE_ROOT}/src/` would need modification
3. Generate an **impact analysis report**:
   - List of affected specs with specific sections impacted
   - List of affected source files
   - New conflicts that may arise from the change
   - Estimated scope of rework
4. For each affected spec:
   - Increment the spec version in the version history table (e.g., v1.0 → v1.1 for minor, v2.0 for major)
   - Update the `spec.md` with change markers (clearly showing what changed and why)
   - Reset the spec status to `draft` or `in-review` as appropriate
   - Update dependency references if affected specs have downstream dependents
   - Add a changelog entry in `${REQ_DATA_ROOT}/docs/changelog.md`
5. If new conflicts are detected, create conflict records in `${REQ_DATA_ROOT}/conflicts/`.
6. **Print a Decision Brief** in Chinese (per [AGENTS.md](../AGENTS.md) §7.0 Language Convention) summarising the impact analysis with drill-down links. Format defined in the "Decision Brief" section below.
7. Branch on `REQ_AUTONOMY_LEVEL` (exported by `_lib.sh`, defaults to `strict`) following the [Next Step Picker Convention](../AGENTS.md#7b-next-step-picker-convention):
   - **strict** — print the Brief, then call `AskUserQuestion` with the picker defined below. Wait for explicit human selection before proceeding.
   - **balanced / auto** — if the impact is **low** (≤1 spec affected, minor version bump, no new conflicts detected, no source files in `${REQ_CODE_ROOT}/src/` marked as affected), print the Brief and auto-take the AI-recommended option *without* calling `AskUserQuestion`. Annotate the `docs/changelog.md` entry with `[autonomy: balanced]` or `[autonomy: auto]`. For any impact above low (≥2 specs, major bump, new conflicts, or affected source files), fall back to strict behavior — call the picker regardless of level. This is a SOFT checkpoint that graduates back to HARD when impact exceeds the threshold.
8. After the picker selection (or auto-proceed), the normal flow resumes: `/review` → `/plan` → `/implement`.

## Decision Brief

```markdown
### 📋 決策摘要：需求變更影響分析 — <change summary>

**目標**：判斷此變更是否進入 re-implementation cycle，或先回頭討論 scope。

**關鍵事實**（每項附原檔連結）：
- 觸發來源：<intake 檔案連結 或 變更描述一句話>
- 受影響的 specs：<列出 N 個 spec 名稱與目前狀態> → 詳見 [specs/](${REQ_DATA_ROOT}/specs/)
- 受影響的程式檔：<列出 M 個檔案；若 0 寫「無」>
- 版本變動：<minor (v1.0 → v1.1) / major (v1.x → v2.0) / patch (fixup)>
- 新衝突：<偵測到 K 個新衝突；若 0 寫「無」>
- 預估範圍：<low / medium / high；low 在 balanced/auto 下會自動前進>
- 自動化判定：<在 balanced/auto 下會 auto-proceed / 仍需 picker>

**需特別關注**：
- ⚠️ <若有新衝突，列出最高嚴重度的一條>
- ⚠️ <若涉及 ≥2 specs 或 major bump，提醒會 fallback 到 strict picker>
- ⚠️ <若是 fixup 模式，列出 5 task 上限與不可改 acceptance criteria 的限制>

**建議**：<AI 推薦的下一步與一句話理由，例如「建議直接進入 re-implementation — 影響範圍 low、無新衝突」>

👉 建議先點開受影響的 specs 確認 change marker 後再做決定。
```

Then call `AskUserQuestion` with **at most three options**, AI-recommended option first with `（建議）` suffix:

- `進入 re-implementation（建議）` — 觸發 `/req-review` → `/req-plan` → `/req-implement` 的標準後續流程
- `先擴大影響分析` — 重跑 impact analysis 並把使用者指定的 spec 列入掃描範圍（避免漏判）
- `保留變更紀錄不前進` — 受影響 specs 已標記版本與 change marker，但暫不重跑後續流程

When `--fixup` is in effect, the picker options change to:

- `執行 micro-plan（建議）` — 進入 fixup 的 review/plan/implement 子流程，task 上限 5
- `先讀 audit 報告` — 不前進，重新打開 AUDIT-*.md 讓人工再核對
- `升級成 forward iteration` — 拒絕 fixup（因為超出 fixup 適用範圍），改用一般 `/req-iterate` 流程

## Constraints (Decision Brief related — see also bottom-of-file constraints)

- **MUST** print the Decision Brief in Chinese before either calling the picker or auto-proceeding under balanced/auto (per AGENTS.md §7b).
- **MUST NOT** auto-proceed on anything above the low-impact threshold defined in step 7 — picker required.
- **MUST NOT** use free-text confirmation in place of the picker (per AGENTS.md §7b anti-patterns).
- **MUST NOT** call the picker on automated webhook invocations of forward iteration (e.g. iterate triggered indirectly by `/feedback`); print the Brief into the changelog entry instead and require manual `/req-iterate` for re-implementation.

## Fixup Mode (`--fixup`)

Fixup mode is **additive** to the forward-change flow above. It exists so higher autonomy levels (L2/L3) have a real safety net for the drift their automated decisions can introduce. Input is not a new requirement but a *drift record* — a description of the gap between an already-approved spec and the current state of the code, usually produced by `/audit`.

### Trigger semantics

- `/iterate --fixup <spec-slug>` — manual targeted repair when the user already knows what is broken.
- `/iterate --fixup --from-audit <audit-file>` — replay drift rows from a prior `/audit` report.
- `/audit --iterate` — preferred batch mode; see `audit.md`.
- **MUST NOT** be triggered automatically by cron, hooks, or any unsupervised mechanism. `/audit` may be scheduled (read-only); `/iterate --fixup` may not. Otherwise fixup itself becomes an unsupervised autonomy expansion and defeats its purpose.

### Behavior in fixup mode

1. Load the drift record (from CLI arg or audit file). Each drift row **MUST** name a single target spec slug.
2. Verify the target spec status is `done` (or `in-progress`). Fixup **MUST NOT** target `draft`/`in-review` specs — those go through normal review.
3. Generate a **repair impact analysis** scoped to the drift row only. Compute:
   - Which acceptance criteria were violated (existing criteria only — fixup never invents new ones)
   - Which source files in `${REQ_CODE_ROOT}` need adjustment
   - Whether any non-`done` specs would be touched (if yes → refuse, see below)
4. Apply a **patch-level** version bump to the target spec (e.g. v1.1.0 → v1.1.1), with reason tag `retroactive repair` in the version history table — distinct from `requirement change` used by forward iteration.
5. Reset the spec status to `draft` with reason `fixup` (`done → draft [reason: fixup]`). Add a changelog entry tagged `[fixup: {slug}] [autonomy: {level}] audit={file}`.
6. Generate a **micro-plan** — a flat task list capped at **5 tasks**. The micro-plan **MUST** only contain tasks that close drift rows. No refactors, no scope expansion.
7. Walk the micro-plan through `/review` (using the diff-only fixup review variant) → `/plan` (ExitPlanMode with the micro-plan body) → `/implement`. All five HARD checkpoints still apply; fixup only shrinks the **size** of each approval, never bypasses one.
8. After re-implementation, write the audit-trail file `${REQ_DATA_ROOT}/audits/FIXUP-{slug}-{YYYY-MM-DD-HHMM}.md` containing: the triggering drift row, the spec diff, the micro-plan, test results before/after, reviewer name, and the autonomy level at time of run.
9. If the original drift was traced to an `[autonomy: auto]` changelog entry, add a back-link from that entry to the new fixup entry, so a human scanning the changelog can trace "autonomous decision → later repair" in both directions.

### Refusal rules (fixup **MUST** refuse and escalate)

Fixup is intentionally narrow. If any of the following hold, fixup **MUST NOT** proceed; instead it prints a clear refusal and tells the user to run normal `/iterate` with a fresh intake:

- The repair requires **adding or changing acceptance criteria** (that is a forward change, not a repair).
- The micro-plan would exceed **5 tasks**.
- The repair touches files under `infra/` (per AGENTS §12, infra changes need a spec-driven forward path).
- The target spec or any affected file is already promoted to **production** (HARD checkpoint CP4 stands; prod issues go through the §9 closed-loop intake path).
- The repair would require modifying **≥2 specs** (cross-spec drift is forward-iteration territory).
- The drift represents **architectural regret** — the abstraction itself was wrong. Fixup **MUST** refuse rather than paper over a design mistake; emit a recommendation to run normal `/iterate`.

### Interaction with HARD checkpoints

| Checkpoint | Behavior under fixup |
|---|---|
| CP1 conflict resolution | Untouched. Fixup never resolves conflicts. |
| CP2 spec approval | Diff-only review variant: only the changed criteria + the triggering drift row are listed. Reviewer ticks one box. |
| CP3 plan approval | Micro-plan with task cap 5. ExitPlanMode still fires. Over the cap → refused. |
| CP4 production deploy | Untouched. Fixup only operates on non-deployed branches. |
| CP5 3-strike test failure | Unchanged. Fixup is *more* likely to hit this because it touches legacy code; escalation path is identical. |

## Constraints
- Never automatically re-implement under `strict` without human review of the impact analysis.
- Under `balanced`/`auto`, the low-impact threshold defined in step 6 is the **only** condition for skipping human approval — **MUST NOT** auto-proceed on anything above that.
- Preserve the history: do not delete old spec content, mark it as superseded.
- Link the change back to the new intake that triggered it.
- Requirement changes are normal — communicate this positively, never frame changes as problems.
- Fixup mode **MUST NOT** be triggered automatically (no cron, no hooks). The user — or `/audit --iterate` after the user reads the audit report — initiates each repair run.
- Fixup mode **MUST NOT** invent or modify acceptance criteria, exceed the 5-task micro-plan cap, touch `infra/`, or operate on production-promoted code. On any of these, it refuses and escalates to normal `/iterate`.
- Every fixup run **MUST** write a `FIXUP-*.md` audit-trail file and a tagged `docs/changelog.md` entry. Silent fixups are forbidden.
