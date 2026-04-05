# /translate - AI Requirement Translation

## Description
Translate raw, unstructured requirements from `intake/` into structured specs with User Stories and acceptance criteria.

## Usage
```
/translate [path to intake file]
```

## Behavior
1. Read the specified raw requirement file from `intake/raw/`.
2. Identify all user personas involved:
   - Cross-reference with existing personas in `personas/`.
   - If a new persona is discovered, create a new persona file in `personas/` using the `_template.md` format.
3. For each identified persona, generate:
   - A User Story in the format: **As a** [role], **I want** [feature], **so that** [benefit]
   - Testable acceptance criteria as a checklist
4. Create a new feature directory in `specs/{feature-slug}/`.
5. Generate `spec.md` using the template from `specs/_template/spec.md`:
   - Set status to `draft`
   - Set version to `v1.0`
   - Link back to the source intake file and `research.md`
   - Assign spec ownership (Spec 擁有者 = intake submitter, or ask if unclear)
   - Identify dependencies on existing specs (前置需求)
   - Include all User Stories and acceptance criteria
   - Include non-functional requirements if applicable
   - Include security requirements assessment
   - Include initial success metrics (suggest measurable goals)
   - List any open questions
6. Automatically execute `/detect-conflicts` on the new spec.
7. Report a summary to the user including:
   - Number of personas identified
   - Number of User Stories generated
   - Any conflicts detected
   - Next step: human review

## Constraints
- Preserve original context and intent from the raw input.
- Do not add requirements that were not expressed or implied in the original input.
- Use plain language in User Stories — avoid technical jargon unless the requester used it.
- Every spec must link back to its intake source (traceability).
