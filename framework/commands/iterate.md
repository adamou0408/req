# /iterate - Requirement Change Iteration

## Description
Handle requirement changes by analyzing impact, updating specs, and managing the re-implementation cycle.

## Usage
```
/iterate [change description or path to intake file]
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

## Constraints
- Never automatically re-implement under `strict` without human review of the impact analysis.
- Under `balanced`/`auto`, the low-impact threshold defined in step 6 is the **only** condition for skipping human approval — **MUST NOT** auto-proceed on anything above that.
- Preserve the history: do not delete old spec content, mark it as superseded.
- Link the change back to the new intake that triggered it.
- Requirement changes are normal — communicate this positively, never frame changes as problems.
