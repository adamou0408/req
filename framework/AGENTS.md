# AI Agent Behavioral Specification

This document defines the behavioral rules and constraints for all AI agents operating within this demand-driven development framework.

> **Notation**:
> - Command names are shown without the `/req-` prefix for readability (e.g., `/intake`, `/translate`). When installed into a host repo, the actual slash commands are `/req-intake`, `/req-translate`, etc. (prefixed by `req-sync-commands.sh` to avoid collision with the host's existing commands).
> - Paths like `intake/raw/`, `specs/`, `personas/`, `src/`, `tests/` refer to the logical layout. The actual on-disk location is resolved via `.req.config.yml`:
>   - `data_root` → where `intake/`, `specs/`, `personas/`, `conflicts/`, `reviews/`, `docs/` live
>   - `code_root` → where generated `src/` and `tests/` live
>   - `framework_root` → where the framework submodule lives (for reading templates and `CONSTITUTION.md`)

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

The following five checkpoints are **HARD** — they cannot be bypassed by any autonomy level:

- Resolving requirement conflicts (via `/resolve-conflict`)
- Approving specs (transitioning from `in-review` to `approved`)
- Approving technical plans (transitioning from `approved` to `in-progress` via `/plan` → `ExitPlanMode` popup; `/implement` is blocked until this happens)
- Overriding failed tests after 3 auto-fix attempts
- Approving code for production deployment (via code review)

The following two checkpoints are **SOFT** — their behavior depends on `REQ_AUTONOMY_LEVEL`:

- Deciding how to handle duplicate requirements found during `/research`
- Approving impact analysis during `/iterate` (and deleting/archiving specs)

### 5a. Onboarding Artifacts

The optional `/onboard` command (v2.3.0+) seeds the following files in `${REQ_DATA_ROOT}/` by scanning the host repository. Other commands **MUST** read them when present and **MUST** tolerate their absence (pre-onboarding projects behave exactly as before):

- `${REQ_DATA_ROOT}/docs/project-context.md` — detected stack, domain summary, entry points, CI presence. Read by `/plan` and `/research` to avoid recommending foreign libraries or duplicating existing functionality.
- `${REQ_DATA_ROOT}/docs/existing-features.md` — inventory of features already present in the host code. Read by `/research` as a second deduplication baseline in addition to `specs/`.
- `${REQ_DATA_ROOT}/personas/<slug>.md` (auto-generated ones carry `source: auto-generated` frontmatter) — initial persona set for new specs.
- `${REQ_DATA_ROOT}/CONSTITUTION.md` (deep mode only) — project-specific architectural constraints. When present, `/plan` **MUST** read this instead of the framework's generic `CONSTITUTION.md`.

None of these files are checkpoints; their absence never blocks a command.

### 5b. Autonomy Level

All commands **MUST** read `REQ_AUTONOMY_LEVEL` (exported by `_lib.sh`'s `req_load_config`, defaulting to `strict` if absent from `.req.config.yml` for backward compatibility) and branch accordingly:

- **strict** (default) — enforce both HARD and SOFT checkpoints. Current v2.1.0 behavior.
- **balanced** — enforce HARD checkpoints; take the AI-recommended path on SOFT checkpoints. **MUST** annotate the automated action in the subagent summary / spec / changelog so it is auditable.
- **auto** — same as balanced, plus: `/research` partial overlaps proceed silently, `/detect-conflicts` may skip `severity: low` conflicts (but **MUST** report skipped count in the summary — never silently drop).

No autonomy level **MAY** bypass a HARD checkpoint. Use `/autonomy` to view or change the current level.

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
- **MUST** update the corresponding review checklist (`reviews/REVIEW-*.md`) on every state transition:
  - `approved`: all verified checklist items must be marked `[x]`, reviewer name and date filled
  - `done`: add implementation verification section (test results, task completion, deployment status)
- **MUST NOT** leave review checklists in an inconsistent state (e.g., result = `approved` but items still `[ ]`).

### 7. Communication Style

- When communicating with non-technical users: use plain language, avoid jargon, be patient and encouraging.
- When generating technical artifacts: be precise, structured, and comprehensive.
- Always confirm understanding before proceeding with translation.

### 7a. Spec Ownership & Review SLA

- Every spec **MUST** have a designated owner (Spec 擁有者) assigned during `/translate`.
- Reviews **MUST** be completed within 2 business days of spec submission.
- If the review deadline passes without action, **MUST** escalate to the technical lead.
- When `/plan` is executed, **MUST** verify that all specs listed in "前置需求" (dependencies) have status `approved` or later.
- If a dependency spec is not yet approved, **MUST** warn the user and wait for confirmation before proceeding.

### 8. Security & Compliance

- **MUST** include a security assessment section in every `spec.md`, even if minimal.
- **MUST NOT** generate code that stores secrets in source code, logs, or configuration files.
- **MUST** flag security-sensitive operations during `/research` and `/plan`:
  - Authentication and authorization changes
  - Encryption and data protection
  - External API integrations with credentials
  - User data handling (PII, payment info)
- **MUST** ensure generated code follows OWASP Top 10 prevention guidelines.
- **MUST** validate that CI includes dependency scanning and secret detection before deployment.
- **MUST** escalate to human review if generated code handles sensitive data paths.

### 9. Deployment & Feedback Loop

- **MUST** verify spec status is `approved` or later before allowing deployment.
- **MUST** run all tests and health checks before promoting to any environment.
- **MUST** automatically rollback on health check failure — never leave a broken deployment running.
- **MUST** create a new intake item in `intake/raw/` when deployment fails or monitoring alerts fire. This is the closed-loop mechanism.
- **MUST** deduplicate monitoring alerts within a 30-minute window to avoid intake flooding.
- **MUST NOT** deploy to production without explicit human approval.
- **MUST NOT** auto-resolve production incidents. Always route through the full demand-driven cycle (intake → translate → review → implement).
- **MUST** escalate if the same monitoring alert fires 3+ times within 24 hours.

### 10. Context Management

- When executing any command, **MUST** evaluate input file sizes before processing.
- If `spec.md` exceeds 3000 words, **MUST** produce a summary version for downstream stages.
- `/plan` **MUST** extract only User Stories and acceptance criteria from the spec, not the entire document.
- `/implement` **MUST** load only the current task's relevant spec fragment, not the entire spec + plan + tasks.
- **MUST NOT** load the full content of all related files simultaneously — prioritize relevant sections.
- Each stage output **MUST** include a "downstream summary" section:
  ```
  ## 下游摘要
  - 核心需求：（3 句話概述）
  - 關鍵約束：（最重要的 3 個）
  - 風險項目：（最高風險的 2 個）
  ```

### 11. Code Review

- AI-generated code **MUST** go through a review process before merging to `main`.
- `/implement` **SHOULD** create a pull request for generated code rather than committing directly to the main branch.
- Code review checks:
  - Security: no hardcoded secrets, no injection vulnerabilities
  - Traceability: code references the task/spec that produced it
  - Quality: follows existing code patterns and conventions
  - Test coverage: all acceptance criteria have corresponding tests
- For **hotfix** scenarios (critical production issues), code review can be deferred but **MUST** be completed within 24 hours.
- **MUST** log all code review outcomes in the implementation report.

### 12. Infrastructure Changes

- Infrastructure changes (Terraform, Docker, CI/CD) **MUST** follow the same spec-driven process as application code.
- **MUST NOT** modify infrastructure without a corresponding approved spec or explicit human instruction.
- All infrastructure is defined as code in `infra/` — no manual console changes.

## File Naming Conventions

All paths below are **relative to the project's `data_root`**, which is configured in
`.req.config.yml` and resolves to either `.` (init mode) or `.req` (typical
submodule-into-existing-repo mode). AI agents should treat these patterns as templates
and apply the resolved `data_root` prefix at write time. Generated source code and
tests are written under `code_root` (typically `.`, the host's real `src/` and `tests/`).

| Type | Pattern | Example (init mode) |
|------|---------|---------|
| Raw intake | `${REQ_DATA_ROOT}/intake/raw/YYYY-MM-DD-{slug}.md` | `intake/raw/2026-04-04-add-search.md` |
| Spec | `${REQ_DATA_ROOT}/specs/{feature-slug}/spec.md` | `specs/user-search/spec.md` |
| Plan | `${REQ_DATA_ROOT}/specs/{feature-slug}/plan.md` | `specs/user-search/plan.md` |
| Tasks | `${REQ_DATA_ROOT}/specs/{feature-slug}/tasks.md` | `specs/user-search/tasks.md` |
| Conflict | `${REQ_DATA_ROOT}/conflicts/CONFLICT-{NNN}.md` | `conflicts/CONFLICT-001.md` |
| Review | `${REQ_DATA_ROOT}/reviews/REVIEW-{feature-slug}-{date}.md` | `reviews/REVIEW-user-search-2026-04-04.md` |
| Research | `${REQ_DATA_ROOT}/specs/{feature-slug}/research.md` | `specs/user-search/research.md` |
| Persona | `${REQ_DATA_ROOT}/personas/{role-slug}.md` | `personas/admin.md` |
| Auto-intake | `${REQ_DATA_ROOT}/intake/raw/YYYY-MM-DD-auto-{alert}.md` | `intake/raw/2026-04-04-auto-high-error-rate.md` |
| Generated source | `${REQ_CODE_ROOT}/src/...` | `src/services/search.py` |
| Generated tests | `${REQ_CODE_ROOT}/tests/...` | `tests/test_search.py` |
