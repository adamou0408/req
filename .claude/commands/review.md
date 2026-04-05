# /review - Generate Review Checklist

## Description
Generate a human-readable review checklist for a spec pending approval.

## Usage
```
/review [spec directory path]
```

## Behavior
1. Read the specified `spec.md` from the spec directory.
2. Generate a comprehensive review checklist covering:
   - [ ] All User Stories are complete and reasonable
   - [ ] Acceptance criteria are specific and testable
   - [ ] All detected conflicts have been resolved
   - [ ] No open questions remain unanswered
   - [ ] No overlap with existing approved features
   - [ ] Non-functional requirements are addressed
   - [ ] Security requirements are assessed (資料分類, 認證, 授權, 加密, 審計, 個資)
   - [ ] Spec dependencies (前置需求) are valid and approved
   - [ ] Success metrics are defined and measurable
   - [ ] Spec owner and reviewer are assigned
   - [ ] Traceability to original intake is intact (intake → research → spec)
3. Save the review checklist to `reviews/REVIEW-{feature-slug}-{date}.md` using the template from `reviews/_template.md`.
4. Present the checklist to the human reviewer in a clear, readable format.
5. Upon human approval:
   - **MUST** update ALL checklist items to `[x]` that have been verified
   - **MUST** leave items as `[ ]` if they were NOT verified and add a note explaining why
   - **MUST** fill in the reviewer name and date
   - Update `spec.md` status from `in-review` to `approved`
   - Log the approval in `docs/changelog.md`
6. Upon rejection:
   - Note the feedback on the specific checklist items that failed
   - Reset `spec.md` status to `draft`
   - Summarize what needs to change
7. Post-implementation verification:
   - When spec status transitions to `done`, **MUST** re-verify the review checklist
   - Add an "Implementation Verification" section with actual test results, task completion status, and deployment status
   - Update any checklist items whose status changed during implementation

## Constraints
- The review checklist must be understandable by non-technical stakeholders.
- Do not auto-approve. Always wait for explicit human confirmation.
- Specs with unresolved conflicts (`detected` or `under-discussion`) cannot be approved.
- **NEVER** leave a review in an inconsistent state: if the result is `approved`, all verified items must be `[x]`.
- **NEVER** transition spec to `done` without updating the review checklist to reflect final status.
