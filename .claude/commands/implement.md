# /implement - AI Implementation

## Description
Execute the technical plan by generating code and tests automatically.

## Prerequisites
- `plan.md` and `tasks.md` must exist in the spec directory.
- The corresponding `spec.md` status must be `approved`.
- If `contracts.md` exists, API contracts must be implemented first.

## Usage
```
/implement [spec directory path]
```

## Behavior
1. Verify prerequisites. Abort with a clear message if not met.
2. Update `spec.md` status to `in-progress`.
3. Update `spec.md` version history (increment version, note implementation start).
4. Process tasks from `tasks.md`:
   - Respect dependency order: tasks with `[depends: N]` wait for task N to complete.
   - Execute parallelizable tasks (same `[P-group-X]`) concurrently when possible.
   - For each task:
     a. **If `contracts.md` exists**: implement contracts/interfaces first (types, API stubs)
     b. Generate test(s) in `tests/` **before** implementation code (test-first approach)
        - Follow the task's **test strategy**: generate unit, integration, and/or e2e tests as specified
     c. Generate implementation code in `src/`
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
- Follow existing code patterns and conventions in `src/`.
- Log every auto-fix attempt for transparency.
- Generate tests before implementation code (test-first).
- Respect parallel group markings — do not serialize tasks that can run in parallel.
