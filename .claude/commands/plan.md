# /plan - Generate Technical Plan

## Description
Generate a technical implementation plan from an approved spec.

## Prerequisites
- The corresponding `spec.md` status **must** be `approved`.
- All conflicts in the spec **must** be `resolved`.

## Usage
```
/plan [spec directory path]
```

## Behavior
1. Verify prerequisites. Abort with a clear message if not met.
2. Read the `spec.md` and any resolved conflict records.
3. Read `CONSTITUTION.md` for architectural constraints.
4. Generate `plan.md` in the spec directory, including:
   - **Technology choices** with justification
   - **Architecture design** with component breakdown
   - **Integration points** with existing system
   - **Risk assessment** and mitigation strategies
   - **Estimated complexity** per component
5. Generate `tasks.md` in the spec directory:
   - Break the plan into small, executable tasks
   - Each task must reference the User Story it implements
   - Tasks should be ordered by dependency
   - Each task should be independently testable
6. Present the plan summary to the user for awareness (no approval gate here — the spec was already approved).

## Constraints
- Plan must respect all principles in `CONSTITUTION.md`.
- Every task must map to at least one User Story.
- Tasks should be small enough for a single implementation cycle.
- Do not introduce technologies or patterns not justified by the requirements.
