# /research - Requirement Research & Deduplication

## Description
Before translating a raw requirement into a spec, research existing specs for duplicates/overlaps, assess feasibility, and gather technical context. This command is a **thin wrapper** that delegates the heavy lifting to the `req-research` subagent so the main conversation context stays clean.

## Usage
```
/research [path to intake file]
```

## Behavior

1. **Delegate to subagent**: invoke the `req-research` subagent via the Agent tool. Pass the intake file path and a short description like "Run req-research deduplication and feasibility analysis on this intake."
2. The subagent will:
   - Scan all existing specs for duplicates and partial overlaps
   - **Also** compare against `${REQ_DATA_ROOT}/docs/existing-features.md` (the onboarding inventory, if present). A match there means the feature is already implemented in the host repo and the new intake is likely a modification rather than a new build.
   - Assess feasibility (new tech, integrations, schema changes, security)
   - Gather related code/persona/conflict context
   - Write `${REQ_DATA_ROOT}/specs/{feature-slug}/research.md`
   - Return a structured summary (under 30 lines), including the `matched-existing-feature:` field
3. **Surface the subagent's summary** to the user as-is — do not re-summarize or expand it.
4. **Decide the next step based on the summary AND `REQ_AUTONOMY_LEVEL`**:
   - `recommended next step: proceed to /req-translate` → automatically run `/req-translate` on the intake (all levels)
   - `recommended next step: merge via /req-iterate <slug>` →
     - **strict**: present the option to the user and wait for confirmation (human checkpoint)
     - **balanced / auto**: auto-execute the merge; the subagent summary must contain `autonomy_applied: balanced` (or `auto`) for auditability
   - `recommended next step: wait for human decision` (e.g. Red feasibility) → always stop and wait, regardless of level

## Constraints
- **MUST** delegate to `req-research`; do not perform the spec scan inline in the main conversation
- **MUST** preserve the subagent's structured summary verbatim in the user-facing output
- **MUST NOT** auto-merge or auto-iterate under `strict` — that requires human approval
- **MUST NOT** call `/req-translate` if the subagent flagged duplicates with >80% overlap (all levels)
- **MUST NOT** bypass a `wait for human decision` recommendation even under `auto` (feasibility Red is not a SOFT checkpoint)
