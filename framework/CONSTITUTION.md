# Project Constitution

These are the **inviolable principles** of this project. All AI agents, all processes, and all contributors must adhere to them without exception.

---

## Principle 1: Zero Barrier for Requirement Providers

> Any format, any language, any level of detail is accepted as input.

- Raw input can be: free-form text, meeting notes, voice-to-text transcripts, screenshots with annotations, chat messages, emails, bullet points, or even a single sentence.
- The system never rejects an input for being "not detailed enough" or "not in the right format."
- The burden of structuring information falls entirely on AI, never on the requirement provider.

## Principle 2: Specs Are the Single Source of Truth

> Code is a product of specs, not the other way around.

- No code is written without a corresponding approved spec.
- If code and spec diverge, the spec is authoritative.
- Changes to behavior must originate as spec changes, not code changes.
- Specs live in `specs/` and follow the defined template structure.

## Principle 3: Humans Guard the Decision Gates

> Conflict resolution and final approval must be performed by humans.

- AI can analyze, suggest, and recommend — but never decide on:
  - Conflicting requirements between personas
  - Final approval of specs
  - Trade-offs involving business priorities
- These decision points are the **only** mandatory human involvement in the process.
- All other steps can be fully automated.

## Principle 4: Full Traceability

> Every line of code must trace back to a requirement.

- The chain of traceability: `intake/raw/ → specs/ → plan → tasks → src/ + tests/`
- No orphan code: if a piece of code cannot be linked to a spec, it must be justified or removed.
- No orphan specs: if a spec has no originating intake, it must be justified or removed.
- All changes are logged in `docs/changelog.md`.

## Principle 5: Continuous Iteration

> Requirement changes are the norm, not the exception.

- The system is designed for change. Changing requirements is expected and welcomed.
- When requirements change:
  1. Impact analysis is performed automatically
  2. Affected specs are flagged and reset to appropriate states
  3. Humans review and approve the changes
  4. AI re-implements as needed
- There is no penalty or friction for changing requirements.

## Principle 6: Closed-Loop Feedback

> Production issues automatically become new requirements.

- The system forms a complete loop: intake → develop → deploy → monitor → feedback → intake.
- When monitoring detects an issue in production (errors, latency, downtime):
  1. The system automatically creates a new intake item
  2. The issue goes through the standard demand-driven cycle
  3. No production issue is lost or ignored
- Failed deployments trigger automatic rollback AND create intake items.
- The feedback loop ensures continuous improvement without manual incident reporting.

---

## Principle 7: Security by Default

> 安全性不是功能，而是基礎。

- Every spec must include a security requirements assessment, even if the conclusion is "no special security needs."
- Generated code must pass security scanning before deployment.
- Secrets (API keys, credentials, tokens) must never enter version control.
- Dependencies must be regularly scanned for known vulnerabilities.
- Security-sensitive changes (authentication, authorization, encryption, data access) require explicit review during `/review`.

---

## Architectural Guardrails

### Process Integrity
- The workflow stages (intake → research → translate → detect-conflicts → resolve-conflicts → review → plan → implement → code-review → deploy → monitor → feedback) must be followed in order.
- No stage may be skipped.
- Each stage's output is the next stage's input.
- The feedback stage loops back to intake, completing the closed loop.

### Data Integrity
- Raw inputs in `intake/raw/` are **immutable** once committed. They serve as the historical record.
- Specs may be updated, but all changes must be tracked via git history and `docs/changelog.md`.
- Conflict records are append-only until resolved.

### Quality Assurance
- Every implementation must have corresponding automated tests.
- Tests must map to acceptance criteria in the spec.
- Test failures block deployment and trigger auto-fix cycles.

### Deployment Integrity
- Infrastructure is defined as code in `infra/` — no manual changes.
- CI pipeline enforces spec gates: code cannot merge without approved specs.
- Deployment to production requires explicit human approval (GitHub Environment protection).
- Failed deployments auto-rollback and create feedback intake items.
- All environments (dev, staging, prod) are defined declaratively in `infra/terraform/environments/`.

### Feedback Loop Integrity
- Monitoring alerts with `feedback_loop: true` automatically generate intake items.
- Duplicate alerts within 30 minutes are deduplicated to prevent intake flooding.
- Escalation triggers if the same alert fires 3+ times in 24 hours.
- Auto-generated intake items are clearly marked as `source: monitoring-feedback-loop`.
