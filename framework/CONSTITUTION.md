# Project Constitution

These are the **inviolable principles** of this project. All AI agents, all processes, and all contributors must adhere to them without exception.

> **Path notation**: Paths like `intake/`, `specs/`, `src/`, `infra/` are logical names. Their actual on-disk location is resolved via `.req.config.yml` (`data_root` for business data; `code_root` for generated code; `framework_root` for framework files). See [AGENTS.md](AGENTS.md) for details.

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
- Specs live in `${REQ_DATA_ROOT}/specs/` and follow the defined template structure.

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

- The chain of traceability: `${REQ_DATA_ROOT}/intake/raw/ → ${REQ_DATA_ROOT}/specs/ → plan → tasks → ${REQ_CODE_ROOT}/src/ + ${REQ_CODE_ROOT}/tests/`
- No orphan code: if a piece of code cannot be linked to a spec, it must be justified or removed.
- No orphan specs: if a spec has no originating intake, it must be justified or removed.
- All changes are logged in `${REQ_DATA_ROOT}/docs/changelog.md`.

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

> Security is not a feature; it is the foundation.

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
- Raw inputs in `${REQ_DATA_ROOT}/intake/raw/` are **immutable** once committed. They serve as the historical record.
- Specs may be updated, but all changes must be tracked via git history and `${REQ_DATA_ROOT}/docs/changelog.md`.
- Conflict records are append-only until resolved.

### Quality Assurance
- Every implementation must have corresponding automated tests.
- Tests must map to acceptance criteria in the spec.
- Test failures block deployment and trigger auto-fix cycles.

### Deployment Integrity
- Infrastructure is defined as code in `${REQ_CODE_ROOT}/infra/` — no manual changes.
- CI pipeline enforces spec gates: code cannot merge without approved specs.
- Deployment to production requires explicit human approval (GitHub Environment protection).
- Failed deployments auto-rollback and create feedback intake items.
- All environments (dev, staging, prod) are defined declaratively in `${REQ_CODE_ROOT}/infra/terraform/environments/` (or whatever IaC layout the host project uses).
- Every plan must include a **deployment impact assessment** covering health check latency, schema backward compatibility, configuration/secret parity, resource budget, data persistence, and observability — even if the conclusion is "no impact." See `${REQ_FRAMEWORK_ROOT}/framework/templates/spec/deployment-checklist.md` for the full check list.
- Schema changes must follow the **Expand & Contract** pattern by default. Non-backward-compatible changes require explicit justification in the plan and are treated as irreversible data model changes under `/deploy`, triggering additional human approval.
- New or changed environment variables must be synchronized to `.env.example` AND the deployment platform configuration (Coolify environment variables / K8s ConfigMap / K8s Secret) within the same change set. Sensitive values must never live in ConfigMap or image layers.
- Resource budgets (memory, CPU, external call frequency, connection pool size) declared in the plan become the baseline for platform resource limits. Exceeding them in production is treated as a monitoring signal and generates a feedback-loop intake item.

### Feedback Loop Integrity
- Monitoring alerts with `feedback_loop: true` automatically generate intake items.
- Duplicate alerts within 30 minutes are deduplicated to prevent intake flooding.
- Escalation triggers if the same alert fires 3+ times in 24 hours.
- Auto-generated intake items are clearly marked as `source: monitoring-feedback-loop`.

---

## Glossary / 術語表

This glossary fixes the canonical Chinese / English pairing for every cross-cutting term used in the framework. When authoring new files, **always pick the term from this table** rather than inventing a new translation. If you need a term that does not appear here, add it in the same change.

The Language Convention in [AGENTS.md](AGENTS.md) > section 7.0 governs *which* language each file should default to. This glossary governs *which words* to use when both languages must coexist.

### Workflow & process

| English | 中文 | Notes |
|---------|------|-------|
| Intake | 需求收件 | Use as both noun and verb (e.g. `/intake` command). |
| Raw intake | 原始需求 | The immutable file under `intake/raw/`. |
| Translate | 轉譯 | The `/translate` step that turns raw intake into a structured spec. |
| Research | 調研 | The `/research` step. Outputs `research.md`. |
| Spec | 規格 | Singular preferred. The `spec.md` file. |
| Plan | 技術計畫 | Output of `/plan`, file is `plan.md`. |
| Tasks | 任務清單 | Output of `/plan`, file is `tasks.md`. |
| Review | 審核 | The `/review` step and the `review.md` artifact. |
| Implement | 實作 | The `/implement` step. |
| Deploy | 部署 | Use 部署 not 佈署. |
| Feedback | 回饋 | The `/feedback` command and closed-loop mechanism. |
| Iterate | 迭代 | The `/iterate` command for requirement changes. |
| Conflict | 衝突 | Cross-persona requirement conflicts. |
| Persona | 角色 | A user role identified during translation. |
| User Story | 使用者故事 | "As a [role], I want [feature], so that [benefit]." |
| Acceptance criteria | 驗收條件 | Testable per-story criteria. |

### Spec / plan / state

| English | 中文 | Notes |
|---------|------|-------|
| Status | 狀態 | Always quoted with backticks: `draft`, `in-review`, `approved`, `in-progress`, `done`. |
| Dependencies (前置需求) | 前置需求 | Specs that must be approved first. |
| Spec owner | Spec 擁有者 | The accountable human owner. |
| Reviewer | 審核者 | Same. |
| Open question | 開放問題 | Items pending clarification. |
| Risk assessment | 風險評估 | The risk table in plan.md. |
| Data model change | 資料模型變更 | Schema-related modifications. |
| Migration | 遷移 | Database or data migrations. |
| Rollback | 回滾 | Reverting a deploy or migration. |

### Deployment vocabulary

| English | 中文 | Notes |
|---------|------|-------|
| Deployment Impact Assessment | 部署影響評估 | The mandatory section in plan.md. |
| Health check | 健康檢查 | Generic term. |
| Liveness probe | 存活檢查 | K8s `livenessProbe`; "我還活著嗎". |
| Readiness probe | 就緒檢查 | K8s `readinessProbe`; "我可以接流量嗎". |
| Graceful shutdown | 優雅關閉 | SIGTERM handling. |
| Schema backward compatibility | Schema 向後相容性 | Always with the English word "Schema". |
| Expand & Contract | 漸進式 Schema 遷移 | The three-phase migration pattern. |
| Irreversible data model change | 不可逆資料模型變更 | Triggers extra deploy approval. |
| Configuration parity | 設定同步 | `.env.example` ↔ Coolify / K8s ConfigMap / Secret. |
| Secret | Secret | Keep English; do not translate to 機密. |
| Resource budget | 資源預算 | Memory, CPU, connection pool, external calls. |
| Resource limit | 資源上限 | Platform-enforced cap. |
| Autoscaling | 自動擴展 | HPA / VPA. |
| Persistent volume | 持久化儲存 | Generic term. |
| Object storage | 物件儲存 | S3-compatible. |
| Backup | 備份 | Includes 3-2-1 strategy. |
| Disaster recovery (DR) | 災難復原 | RPO / RTO. |
| Canary | 金絲雀部署 | Or just "Canary" inline. |
| Blue-Green | 藍綠部署 | |
| Rolling update | 滾動更新 | |

### Observability vocabulary

| English | 中文 | Notes |
|---------|------|-------|
| Observability | 觀測性 | Umbrella term. |
| Logging | 日誌 | Plural form. |
| Structured log | 結構化日誌 | JSON logs. |
| Metrics | 指標 | RED / USE classifications. |
| Tracing | 追蹤 | Distributed tracing. |
| Span | Span | Keep English. |
| Alert | 告警 | Monitoring alert. |
| Runbook | 處理手冊 | Operational playbook. |
| SLO / SLI / SLA | 服務水準目標 / 指標 / 協議 | Use English acronyms in body, Chinese in headings. |
| Feedback loop | 閉環回饋 | The closed-loop mechanism in Principle 6. |

### Closed-loop mechanism

| English | 中文 | Notes |
|---------|------|-------|
| Closed-loop | 閉環 | As in Principle 6. |
| Post-mortem | 事後檢討 | The `${REQ_DATA_ROOT}/docs/postmortems/` artifact. |
| Auto-generated intake | 自動產生需求 | Items created via `/feedback`. |
| Deduplication | 去重 | 30-minute alert window. |
| Escalation | 升級通報 | 3+ alerts in 24h. |
