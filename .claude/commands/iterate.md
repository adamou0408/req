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
   - Which existing specs in `specs/` are affected
   - Which parts of each spec need to change
   - Which implemented code in `src/` would need modification
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
   - Add a changelog entry in `docs/changelog.md`
5. If new conflicts are detected, create conflict records in `conflicts/`.
6. Present the impact analysis to the user and **wait for human approval** before proceeding to re-implementation.
7. After approval, the normal flow resumes: `/review` → `/plan` → `/implement`.

## Constraints
- Never automatically re-implement without human review of the impact analysis.
- Preserve the history: do not delete old spec content, mark it as superseded.
- Link the change back to the new intake that triggered it.
- Requirement changes are normal — communicate this positively, never frame changes as problems.
