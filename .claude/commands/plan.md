# /plan - Generate Technical Plan

## Description
Generate a technical implementation plan from an approved spec, informed by the research report.

## Prerequisites
- The corresponding `spec.md` status **must** be `approved`.
- All conflicts in the spec **must** be `resolved`.
- `research.md` **should** exist (created during `/research` phase).

## Usage
```
/plan [spec directory path]
```

## Behavior
1. Verify prerequisites. Abort with a clear message if not met.
2. **Check spec dependencies**: verify all specs listed in "前置需求" have status `approved` or later. If not, warn user and wait for confirmation.
3. Read the `spec.md`, `research.md`, and any resolved conflict records.
4. Read `CONSTITUTION.md` for architectural constraints.
5. Generate `plan.md` in the spec directory, including:
   - **Work estimate** (S/M/L/XL complexity, estimated tasks, estimated timeline)
   - **Technology choices** with justification
   - **Architecture design** with component breakdown
   - **Integration points** with existing system
   - **Risk assessment** and mitigation strategies
   - **Data model changes** with migration strategy and rollback plan
   - **Security considerations** based on spec security requirements
   - **API contracts** reference (generate `contracts.md` if API changes are needed)
   - **Estimated complexity** per component
6. Generate `tasks.md` in the spec directory:
   - Break the plan into small, executable tasks
   - Each task must reference the User Story it implements
   - Tasks should be ordered by dependency
   - Mark parallelizable tasks with `[P-group-X]` notation
   - Mark dependent tasks with `[depends: N]` notation
   - Each task must include a **test strategy** (unit / integration / e2e)
   - Each task should be independently testable
7. If the spec involves API changes, generate `contracts.md` in the spec directory.
8. Present the plan summary to the user for awareness (no approval gate here — the spec was already approved).

## Constraints
- Plan must respect all principles in `CONSTITUTION.md`.
- Every task must map to at least one User Story.
- Tasks should be small enough for a single implementation cycle.
- Do not introduce technologies or patterns not justified by the requirements.
- If data model changes are irreversible, flag this explicitly and note it requires extra human approval during `/deploy`.
