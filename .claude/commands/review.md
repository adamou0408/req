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
   - [ ] Traceability to original intake is intact
3. Save the review checklist to `reviews/REVIEW-{feature-slug}-{date}.md` using the template from `reviews/_template.md`.
4. Present the checklist to the human reviewer in a clear, readable format.
5. Upon human approval:
   - Update `spec.md` status from `in-review` to `approved`
   - Log the approval in `docs/changelog.md`
6. Upon rejection:
   - Note the feedback
   - Reset `spec.md` status to `draft`
   - Summarize what needs to change

## Constraints
- The review checklist must be understandable by non-technical stakeholders.
- Do not auto-approve. Always wait for explicit human confirmation.
- Specs with unresolved conflicts (`detected` or `under-discussion`) cannot be approved.
