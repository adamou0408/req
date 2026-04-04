# AI Agent Behavioral Specification

This document defines the behavioral rules and constraints for all AI agents operating within this demand-driven development framework.

## Core Directives

### 1. Requirement Translation

- **MUST** preserve the original context, tone, and intent of all raw inputs. Never delete or minimize any part of the original input.
- **MUST** identify all user personas involved in each requirement, cross-referencing with `personas/`.
- **MUST** generate User Stories for every identified persona, not just the requester.
- **MUST** produce testable acceptance criteria for each User Story.
- **MUST** link every generated spec back to its source in `intake/raw/`.

### 2. Conflict Detection

- **MUST** flag all detected conflicts between personas. Never silently resolve or ignore them.
- **MUST NOT** make decisions on behalf of humans when conflicts are detected. Only provide analysis and suggested resolution directions.
- **MUST** categorize conflicts by type: functional, priority, permission, or UX.
- **MUST** create a conflict record in `conflicts/` for every detected conflict.
- **MUST** add conflict markers to the corresponding `spec.md`.

### 3. Code Generation

- **MUST NOT** generate implementation code unless the corresponding `spec.md` status is `approved`.
- **MUST NOT** implement features for specs with unresolved conflicts (status != `resolved`).
- **MUST** ensure every piece of generated code is traceable to a specific User Story in the spec.
- **MUST** generate corresponding tests for every implementation.
- **MUST** run tests after code generation. If tests fail, attempt auto-fix up to 3 iterations before escalating to human intervention.

### 4. Traceability

- All AI outputs **MUST** be traceable to their originating requirement in `intake/raw/`.
- Spec files **MUST** contain source links to raw intake documents.
- Plan tasks **MUST** reference the User Stories they implement.
- Generated code **MUST** include references (via comments or documentation) to the spec and task that produced it.

### 5. Human Checkpoints

The following actions **REQUIRE** human approval and cannot be bypassed:

- Resolving requirement conflicts
- Approving specs (transitioning from `in-review` to `approved`)
- Overriding failed tests after 3 auto-fix attempts
- Deleting or archiving existing specs

### 6. State Management

Valid spec states and transitions:

```
draft → in-review → approved → in-progress → done
                  ↘ draft (rejected, needs rework)
approved → draft (requirement change via /iterate)
in-progress → draft (requirement change via /iterate)
done → draft (requirement change via /iterate)
```

- **MUST NOT** skip states. Each transition must be explicit and logged.
- **MUST** update `docs/changelog.md` on every state transition.

### 7. Communication Style

- When communicating with non-technical users: use plain language, avoid jargon, be patient and encouraging.
- When generating technical artifacts: be precise, structured, and comprehensive.
- Always confirm understanding before proceeding with translation.

### 8. Deployment & Feedback Loop

- **MUST** verify spec status is `approved` or later before allowing deployment.
- **MUST** run all tests and health checks before promoting to any environment.
- **MUST** automatically rollback on health check failure — never leave a broken deployment running.
- **MUST** create a new intake item in `intake/raw/` when deployment fails or monitoring alerts fire. This is the closed-loop mechanism.
- **MUST** deduplicate monitoring alerts within a 30-minute window to avoid intake flooding.
- **MUST NOT** deploy to production without explicit human approval.
- **MUST NOT** auto-resolve production incidents. Always route through the full demand-driven cycle (intake → translate → review → implement).
- **MUST** escalate if the same monitoring alert fires 3+ times within 24 hours.

### 9. Infrastructure Changes

- Infrastructure changes (Terraform, Docker, CI/CD) **MUST** follow the same spec-driven process as application code.
- **MUST NOT** modify infrastructure without a corresponding approved spec or explicit human instruction.
- All infrastructure is defined as code in `infra/` — no manual console changes.

## File Naming Conventions

| Type | Pattern | Example |
|------|---------|---------|
| Raw intake | `intake/raw/YYYY-MM-DD-{slug}.md` | `intake/raw/2026-04-04-add-search.md` |
| Spec | `specs/{feature-slug}/spec.md` | `specs/user-search/spec.md` |
| Plan | `specs/{feature-slug}/plan.md` | `specs/user-search/plan.md` |
| Tasks | `specs/{feature-slug}/tasks.md` | `specs/user-search/tasks.md` |
| Conflict | `conflicts/CONFLICT-{NNN}.md` | `conflicts/CONFLICT-001.md` |
| Review | `reviews/REVIEW-{feature-slug}-{date}.md` | `reviews/REVIEW-user-search-2026-04-04.md` |
| Persona | `personas/{role-slug}.md` | `personas/admin.md` |
| Auto-intake | `intake/raw/YYYY-MM-DD-auto-{alert}.md` | `intake/raw/2026-04-04-auto-high-error-rate.md` |
