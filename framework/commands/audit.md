# /audit - Drift Detection for Done Specs

## Description
Read-only sweep that compares every `done` (and `in-progress`) spec against the current state of the code, tests, and recent changelog. Produces a severity-ranked **drift report** the user reviews. Optionally streams each drift row into `/iterate --fixup` so the human can repair them in bulk under shrink-wrapped approval units.

`/audit` exists so higher autonomy levels (L2/L3) have a real safety net: automated decisions made under `balanced`/`auto` leave breadcrumbs (`[autonomy: ...]` changelog entries, `TODO(auto)` markers); `/audit` is what finds them later. Without `/audit`, fixup has nothing to act on.

## Usage
```
/audit                       # detect drift, write report, do not modify anything
/audit --iterate             # detect drift, then stream each row through /iterate --fixup
/audit --since <date>        # only consider specs touched / changelog entries on or after <date>
/audit --spec <slug>         # restrict the sweep to one spec
```

## Behavior

### 1. Read-only sweep (always)

For every spec under `${REQ_DATA_ROOT}/specs/` whose status is `done` or `in-progress` (filtered by `--spec` / `--since` if given), gather drift rows from four sources. Each drift row **MUST** carry: `spec-slug`, `source` (one of `spec-code`, `auto-residue`, `changelog-review`, `test-retro`), `severity` (`high|medium|low`), and a one-sentence description.

#### 1a. Spec ↔ code drift
- Re-extract the acceptance criteria block from `spec.md`.
- For each criterion that names a symbol, file path, or User Story ID, grep `${REQ_CODE_ROOT}` for it.
- Missing symbols, unreferenced User Story IDs in the source tree, and `@skip` / `xfail` markers on tests that map back to the criterion become drift rows. Default severity: `high`.

#### 1b. Autonomous-run residue
- grep `${REQ_CODE_ROOT}` for `TODO(auto)`, `FIXME(auto)`, and any comment tag the framework reserves for L2/L3 runs (per AGENTS §5b, automated branches must annotate; this step verifies they did).
- Each match becomes a drift row. Default severity: `medium`.

#### 1c. Changelog review
- Parse `${REQ_DATA_ROOT}/docs/changelog.md` for entries tagged `[autonomy: balanced]` or `[autonomy: auto]` (filtered by `--since`).
- For each entry, verify the referenced spec still satisfies its acceptance criteria (re-running 1a in narrow mode against just that spec).
- Entries whose spec no longer holds become drift rows, back-linked to the changelog entry. Default severity: `high`.

#### 1d. Test retrospective
- Re-run the most recent test suite for each `done` spec (the framework records the test command in the spec's implementation report).
- Newly-failing acceptance tests for a `done` spec become drift rows. Default severity: `high`.

### 2. Write the audit report

Always write to `${REQ_DATA_ROOT}/audits/AUDIT-{YYYY-MM-DD-HHMM}.md` with the following structure:

```markdown
# Audit Report — {YYYY-MM-DD HH:MM}

- **Triggered by:** {user | scheduled}
- **Scope:** {full | --spec <slug> | --since <date>}
- **Autonomy level at audit time:** {strict|balanced|auto}

## Drift Summary
| # | Spec | Source | Severity | Description |
|---|------|--------|----------|-------------|
| 1 | user-search | spec-code | high | Acceptance criterion AC-3 references `searchUsers()` not found in code_root |
| ... |

## Recommended Actions
- High severity: run `/iterate --fixup --from-audit AUDIT-...md` to address rows 1, 4, 7
- Medium severity: review TODO(auto) markers in src/services/search.py
- Low severity: ...

## Notes
- Skipped specs: ... (with reason)
- Test reruns failed to launch for: ... (manual investigation needed)
```

The report **MUST** be written even when zero drift rows are found (so the audit history is uninterrupted).

### 3. Decision Brief & picker (interactive runs only)

After the audit report is written, **if the run is interactive** (not scheduled / not from a hook), print a Decision Brief in Chinese (per [AGENTS.md](../AGENTS.md) §7.0 Language Convention) summarising the drift findings with drill-down links, then call `AskUserQuestion` per the [Next Step Picker Convention](../AGENTS.md#7b-next-step-picker-convention).

For **scheduled** runs (cron / hook), skip the Brief and picker entirely — only the audit file is written, and a follow-up interactive `/audit --iterate` is required to act on it.

If the audit found **zero drift rows**, skip the Brief and picker; print a one-line "no drift" message instead. The audit file is still written so the audit history stays continuous.

```markdown
### 📋 決策摘要：drift 偵測結果 — <YYYY-MM-DD HH:MM>

**目標**：判斷如何處理本次偵測到的 drift。

**關鍵事實**（每項附原檔連結）：
- 審計報告：[AUDIT-{YYYY-MM-DD-HHMM}.md](${REQ_DATA_ROOT}/audits/AUDIT-{YYYY-MM-DD-HHMM}.md)
- 掃描範圍：<full / --spec <slug> / --since <date>>
- Drift rows 總數：<N rows>
- 嚴重度分布：<high: X / medium: Y / low: Z>
- 來源分布：<spec-code: A / auto-residue: B / changelog-review: C / test-retro: D>
- 涉及的 specs：<列出 1~3 個 spec 名稱與連結>
- 自動化背景：當前 autonomy level <strict | balanced | auto>

**需特別關注**：
- ⚠️ <最高嚴重度的一條 drift 摘要與對應 spec 連結>
- ⚠️ <若有跨多 spec 的 drift，列出提醒 fixup 會逐一處理>
- ⚠️ <若 high severity 數量 ≥3，建議優先處理>

**建議**：<AI 推薦的下一步與一句話理由，例如「建議立即跑 /audit --iterate — 5 個 high severity drift 都在 fixup 適用範圍內」>

👉 建議先點開 AUDIT-*.md 確認 drift 細節後再做決定。/iterate --fixup 會走 HARD checkpoint，AI 不會代為決定每一條的修復方式。
```

Then call `AskUserQuestion` with **at most three options**, AI-recommended option first with `（建議）` suffix:

- `跑 /audit --iterate（建議）` — 觸發 `--iterate` 模式，逐 row 進入 `/iterate --fixup`，每條走完整 HARD checkpoint
- `只看報告不修` — 不前進，audit 報告已寫入，由人工日後決定
- `只跑 high severity` — 觸發 `--iterate` 但只處理 high severity rows，medium/low 留待下次

If the AI recommendation differs (e.g. "報告為空" or "low severity 居多建議延後"), reorder the picker so the recommended option is first and rewrite its `（建議）` suffix accordingly.

### 4. `--iterate` mode (optional, requires explicit flag)

If `--iterate` is passed (either by the user directly or via the picker in step 3):
- Print the drift summary to the user.
- For each drift row whose severity is `high` or `medium`, invoke `/iterate --fixup --from-audit <this-audit-file>` targeting that row's spec slug.
- Process rows **one at a time**, sequentially. **MUST NOT** parallelize fixup runs — each one walks through review/plan/implement and needs its own human approval moment.
- If a fixup run is refused (per the refusal rules in `iterate.md`), surface the refusal to the user and continue to the next row.
- After all rows are processed, append a "Fixup outcomes" section to the audit report listing per-row results: `repaired | refused | failed`.

### 5. Scheduling

- The bare `/audit` form (read-only) **MAY** be scheduled (cron, hooks, CI). It only writes the audit file; it never modifies specs or code.
- The `--iterate` form **MUST NOT** be scheduled. It must be human-initiated, every time, because it walks through HARD checkpoints.

## Constraints

- **MUST NOT** modify any spec, source file, test, or changelog under bare `/audit`. The bare form is strictly read-only — its only side effect is writing the audit report file.
- **MUST** write the audit report even on a zero-drift sweep, so the audit history is continuous.
- **MUST NOT** run `--iterate` automatically from any scheduler / hook. Only human invocation.
- **MUST** process `--iterate` rows sequentially, never in parallel.
- **MUST** record the autonomy level in effect at audit time in the report header (so a future reader can correlate aggressive runs with the drift they produced).
- **MUST** tolerate missing test commands, skipped specs, and unreadable files — record them under `Notes`, never crash the sweep.
- **MUST NOT** invent acceptance criteria during the sweep — only check existing ones.
- **MUST** print the Decision Brief in Chinese before calling the picker for interactive runs with non-zero drift (per AGENTS.md §7b).
- **MUST NOT** print the Brief or call the picker on a zero-drift sweep, or on scheduled runs — keep automation channels quiet.
- **MUST NOT** use free-text confirmation in place of the picker (per AGENTS.md §7b anti-patterns).
