# /implement - AI Implementation

## Description
Execute the technical plan by generating code and tests automatically.

## Prerequisites
- `plan.md` and `tasks.md` must exist in the spec directory.
- The corresponding `spec.md` status must be `approved`.

## Usage
```
/implement [spec directory path]
```

## Behavior
1. Verify prerequisites. Abort with a clear message if not met.
2. Update `spec.md` status to `in-progress`.
3. For each task in `tasks.md`, in dependency order:
   a. Generate implementation code in `src/`
   b. Generate corresponding test(s) in `tests/`
   c. Run the tests
   d. If tests fail:
      - Analyze the failure
      - Auto-fix the code
      - Re-run tests
      - Repeat up to **3 times**
   e. If still failing after 3 attempts:
      - Mark the task as `needs-human-intervention`
      - Log the failure details
      - Continue with independent tasks if possible
   f. Mark the task as complete in `tasks.md`
4. After all tasks are processed:
   - Run the full test suite
   - Generate an implementation report including:
     - Tasks completed vs. tasks needing intervention
     - Test coverage summary
     - Any deviations from the plan
5. If all tasks pass: update `spec.md` status to `done`.

## Constraints
- All generated code must be traceable to a task and User Story.
- Do not write code that isn't required by the tasks.
- Follow existing code patterns and conventions in `src/`.
- Log every auto-fix attempt for transparency.
