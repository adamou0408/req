# /detect-conflicts - Requirement Conflict Detection

## Description
Scan specs for cross-persona conflicts and flag them for human resolution. This command is a **thin wrapper** that delegates to the `req-conflict-detector` subagent so the main conversation context is not polluted by per-spec analysis text.

## Usage
```
/detect-conflicts [spec directory path | all]
```

If `all` is specified, scan every spec in `${REQ_DATA_ROOT}/specs/`.

## Behavior

1. **Delegate to subagent**: invoke the `req-conflict-detector` subagent via the Agent tool. Pass the spec path or the literal `all`.
2. The subagent will:
   - Analyze User Stories across personas
   - Detect functional / priority / permission / UX conflicts
   - Write conflict records to `${REQ_DATA_ROOT}/conflicts/CONFLICT-{NNN}.md`
   - Add ⚠️ markers to the affected `spec.md` files
   - Return a structured summary (under 40 lines, one line per conflict)
3. **Surface the subagent's summary** to the user as-is.
4. If `conflicts detected > 0`, recommend the next step shown by the subagent (`/req-resolve-conflict <path-or-all>`). Do NOT auto-trigger it — conflict resolution is a human checkpoint per AGENTS.md §5.

## Constraints
- **MUST** delegate to `req-conflict-detector`; do not perform persona analysis inline in the main conversation
- **MUST NOT** resolve conflicts autonomously (HARD checkpoint — applies at every autonomy level)
- **MUST NOT** auto-trigger `/req-resolve-conflict` — always wait for the human
- Cross-spec conflicts (between different features) **MUST** be detected when scanning `all`
- Under `REQ_AUTONOMY_LEVEL=auto`, the subagent **MAY** skip `severity: low` conflicts (not create a CONFLICT-NNN record for them) but **MUST** report the skipped count and slugs under `skipped-low-severity-conflicts` in its return summary. Never silently drop.
