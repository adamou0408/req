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
6. Present the impact analysis and branch on `REQ_AUTONOMY_LEVEL` (exported by `_lib.sh`, defaults to `strict`):
   - **strict** — wait for explicit human approval before proceeding to re-implementation (current behavior).
   - **balanced / auto** — if the impact is **low** (≤1 spec affected, minor version bump, no new conflicts detected, no source files in `${REQ_CODE_ROOT}/src/` marked as affected), auto-proceed without waiting and annotate the `docs/changelog.md` entry with `[autonomy: balanced]` or `[autonomy: auto]`. For any impact above low (≥2 specs, major bump, new conflicts, or affected source files), fall back to strict behavior — wait for human approval regardless of level. This is a SOFT checkpoint that graduates back to HARD when impact exceeds the threshold.
7. After approval (or auto-proceed), the normal flow resumes: `/review` → `/plan` → `/implement`.

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
