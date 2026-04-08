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

### 3. `--iterate` mode (optional, requires explicit flag)

If `--iterate` is passed:
- Print the drift summary to the user.
- For each drift row whose severity is `high` or `medium`, invoke `/iterate --fixup --from-audit <this-audit-file>` targeting that row's spec slug.
- Process rows **one at a time**, sequentially. **MUST NOT** parallelize fixup runs — each one walks through review/plan/implement and needs its own human approval moment.
- If a fixup run is refused (per the refusal rules in `iterate.md`), surface the refusal to the user and continue to the next row.
- After all rows are processed, append a "Fixup outcomes" section to the audit report listing per-row results: `repaired | refused | failed`.

### 4. Scheduling

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
