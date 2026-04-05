# /resolve-conflict - Guided Conflict Resolution

## Description
Guide humans through a structured conflict resolution process with decision framework, impact analysis, and documentation.

## Usage
```
/resolve-conflict [conflict file path | all]
```

If `all` is specified, process every conflict with status `detected` or `under-discussion`.

## Behavior

### 1. Load Conflict Context
- Read the specified conflict record from `conflicts/CONFLICT-{NNN}.md`
- Read the related `spec.md` and its User Stories
- Read the persona definitions for all involved roles

### 2. Present Decision Framework
For each conflict, present a structured analysis:

#### Impact Matrix
For each resolution option, show:
| 方案 | 受益角色 | 受損角色 | 開發成本 | 風險 |
|------|----------|----------|----------|------|

#### Trade-off Analysis
- What does each persona gain or lose?
- Are there creative solutions that serve both personas (compromise)?
- What is the technical feasibility of each option?
- Which option aligns best with the project's CONSTITUTION principles?

#### Recommendation
- AI provides a recommended option with justification
- **But explicitly states this is a suggestion, not a decision**

### 3. Capture Human Decision
- Wait for the human to select a resolution option
- Require the human to provide:
  - Which option they chose (or a custom option)
  - The reasoning behind the decision
  - Any additional constraints or conditions

### 4. Update Records
- Update `conflicts/CONFLICT-{NNN}.md`:
  - Set status to `resolved`
  - Fill in decision record (選擇方案, 決策者, 決策日期, 理由)
- Update the corresponding `spec.md`:
  - Remove or update conflict markers (⚠️)
  - Adjust User Stories based on the resolution
  - Add a note in the spec linking to the conflict record
- Log the resolution in `docs/changelog.md`

### 5. Check Readiness
- After resolving, check if the spec has any remaining unresolved conflicts
- If all conflicts are resolved:
  - Notify the user that the spec is ready for `/review`
  - Update conflict status in the spec from ⚠️ to ✅

## Constraints
- **MUST NOT** resolve conflicts autonomously — always wait for human decision
- **MUST** present all options fairly without bias (even if AI has a recommendation)
- **MUST** require reasoning from the human — "just because" is not sufficient
- **MUST** update all related documents atomically (conflict record + spec + changelog)
- **MUST** preserve the full conflict history (append resolution, don't delete original analysis)
