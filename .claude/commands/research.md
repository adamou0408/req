# /research - Requirement Research & Deduplication

## Description
Before translating a raw requirement into a spec, research existing specs for duplicates/overlaps, assess feasibility, and gather technical context. This prevents duplicate specs and wasted effort.

## Usage
```
/research [path to intake file]
```

## Behavior

### 1. Deduplication Check
- Scan ALL existing specs in `specs/` for similar or overlapping requirements
- Compare the raw intake content against:
  - Existing spec titles and summaries
  - User Stories in existing specs
  - Acceptance criteria in existing specs
- If a **duplicate** is found (>80% overlap):
  - Flag the duplicate and recommend merging into the existing spec via `/iterate`
  - Do NOT proceed to `/translate`
- If a **partial overlap** is found (30-80%):
  - Flag the overlap and present options:
    - Merge into existing spec (via `/iterate`)
    - Create as a separate spec with explicit dependency link
    - Proceed as independent spec (with justification)
  - Wait for human decision before proceeding

### 2. Feasibility Assessment
- Identify if the requirement involves:
  - New technology not currently in the stack
  - External integrations or third-party dependencies
  - Data model changes (schema migrations)
  - Security-sensitive operations (authentication, authorization, encryption)
- Flag any high-risk items that need extra consideration during `/plan`

### 3. Technical Context Gathering
- Identify related existing code in `src/` that may be affected
- Identify related infrastructure in `infra/` that may need changes
- Note any existing persona definitions in `personas/` that are relevant
- Check for any unresolved conflicts in `conflicts/` that may interact

### 4. Generate Research Report
- Create `specs/{feature-slug}/research.md` using the template from `specs/_template/research.md`
- Include:
  - Deduplication results
  - Feasibility assessment
  - Related existing specs (with links)
  - Related existing code (file paths)
  - Technical risks identified
  - Recommended approach

### 5. Handoff
- If no duplicates and feasibility is acceptable: automatically proceed to `/translate`
- If issues found: present findings and wait for human decision

## Constraints
- **MUST** check for duplicates before every new spec creation
- **MUST NOT** skip this step, even if the requirement seems obviously new
- **MUST** preserve the original intake file (immutability principle)
- **MUST** create research.md even if no issues are found (for audit trail)
- Research reports are informational — they do not block the process unless duplicates are found
