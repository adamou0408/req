# /implement - AI Implementation

## Description
Execute the technical plan by generating code and tests automatically.

## Prerequisites
- `plan.md` and `tasks.md` must exist in the spec directory.
- The corresponding `spec.md` status **must be `in-progress`** — meaning the human has already accepted the plan via the ExitPlanMode popup at the end of `/req-plan`. If status is still `approved`, **refuse** and remind the user to run `/req-plan` and accept the plan first.
- If `contracts.md` exists, API contracts must be implemented first.

## Usage
```
/implement [spec directory path]
```

## Behavior
1. Verify prerequisites. Abort with a clear message if not met. Specifically check:
   - `plan.md` and `tasks.md` exist
   - `spec.md` status is exactly `in-progress` (not `approved`, not `done`). If status is `approved`, abort with: "Plan has not been accepted. Run /req-plan and accept the plan via the approval popup before implementing."
   - **Consult project context (if present)**: if `${REQ_DATA_ROOT}/docs/project-context.md` exists (produced by `/req-onboard`), read its **stack**, **conventions**, and **entry points** sections. Treat the detected stack/framework/libraries and naming/format conventions as **hard constraints** on generated code: prefer the existing stack, match existing patterns, and do not introduce foreign dependencies unless explicitly justified in the implementation report. If the file is absent (pre-onboarding project), proceed with generic conventions and note this fact in the implementation report's "Context sources" line.
2. Update `spec.md` version history (increment version, note implementation start).
4. Process tasks from `tasks.md`:
   - Respect dependency order: tasks with `[depends: N]` wait for task N to complete.
   - Execute parallelizable tasks (same `[P-group-X]`) concurrently when possible.
   - For each task:
     a. **If `contracts.md` exists**: implement contracts/interfaces first (types, API stubs)
     b. Generate test(s) in `${REQ_CODE_ROOT}/tests/` **before** implementation code (test-first approach)
        - Follow the task's **test strategy**: generate unit, integration, and/or e2e tests as specified
     c. Generate implementation code in `${REQ_CODE_ROOT}/src/`
     d. Add traceability comment in generated code:
        ```
        // Spec: specs/{feature}/spec.md — User Story: "As a ..."
        // Task: specs/{feature}/tasks.md — Task N
        ```
     e. Run the tests
     f. If tests fail:
        - Analyze the failure
        - Auto-fix the code
        - Re-run tests
        - Repeat up to **3 times**
     g. If still failing after 3 attempts:
        - Mark the task as `needs-human-intervention`
        - Log the failure details
        - Continue with independent tasks if possible
     h. Mark the task as complete in `tasks.md`
5. After all tasks are processed:
   - Run the full test suite (unit → integration → e2e)
   - Generate an implementation report including:
     - Tasks completed vs. tasks needing intervention
     - Test coverage summary (by layer: unit/integration/e2e)
     - Security check summary (no hardcoded secrets, input validation present)
     - Any deviations from the plan
     - Code review readiness assessment
6. If all tasks pass: update `spec.md` status to `done`.

## Constraints
- All generated code must be traceable to a task and User Story (via comments).
- Do not write code that isn't required by the tasks.
- Follow existing code patterns and conventions in `${REQ_CODE_ROOT}/src/`.
- Log every auto-fix attempt for transparency.
- Generate tests before implementation code (test-first).
- Respect parallel group markings — do not serialize tasks that can run in parallel.
