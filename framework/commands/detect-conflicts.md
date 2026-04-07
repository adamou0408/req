# /detect-conflicts - Requirement Conflict Detection

## Description
Scan specs for cross-persona conflicts and flag them for human resolution.

## Usage
```
/detect-conflicts [spec directory path | all]
```

If `all` is specified, scan every spec in `${REQ_DATA_ROOT}/specs/`.

## Behavior
1. Analyze the User Stories across different personas in the specified spec(s).
2. Detect the following conflict types:
   - **Functional conflict**: Persona A wants X, Persona B wants not-X
   - **Priority conflict**: Multiple personas need the same limited resource
   - **Permission conflict**: One persona wants open access, another wants restrictions
   - **UX conflict**: Simplification vs. feature richness
3. For each detected conflict:
   - Create a conflict record in `${REQ_DATA_ROOT}/conflicts/CONFLICT-{NNN}.md` using the template from `${REQ_FRAMEWORK_ROOT}/framework/templates/conflict.md`
   - Set conflict status to `detected`
   - Add a conflict marker (⚠️) in the corresponding `spec.md` under the "Conflict Markers" section
4. Provide AI analysis for each conflict:
   - Background context
   - Why these needs are in tension
   - 2-3 possible resolution directions (without making the decision)
5. Report summary to the user:
   - Number of conflicts found
   - Severity assessment
   - Recommendation to proceed to human review

## Constraints
- **MUST NOT** resolve conflicts autonomously. Only detect, analyze, and suggest.
- **MUST** flag every conflict found, even minor ones. Let humans decide what to dismiss.
- Cross-spec conflicts (between different features) should also be detected when scanning `all`.
