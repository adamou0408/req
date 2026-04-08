# /deploy - Closed-Loop Deployment

## Description
Deploy the application through the closed-loop pipeline, with spec gates, health checks, and automatic feedback on failure.

## Prerequisites
- All specs for features being deployed must have status `approved` or `done`
- All conflicts must be `resolved`
- CI pipeline (tests) must be passing
- Docker image must build successfully

## Usage
```
/deploy [environment]
```

Where `environment` is one of: `dev`, `staging`, `prod`

## Behavior

### Pre-deployment Checks
1. Verify all relevant specs are `approved` or `done`
2. Verify no unresolved conflicts exist
3. Verify all tests pass
4. Verify security scan passed (CI security job)
5. Verify Docker image builds successfully
6. **Verify deployment impact assessment is complete** in every relevant `plan.md`. The canonical list of required sub-sections lives in CONSTITUTION.md > Architectural Guardrails > Deployment Integrity. Abort deployment with a clear error if any mandatory sub-section is blank.
7. **Verify config parity**: if the assessment lists new or changed environment variables, confirm they exist in the target platform configuration (Coolify env vars / K8s ConfigMap / K8s Secret) before deploying.
8. If any plan's Schema Backward Compatibility sub-section is marked as non-backward-compatible, treat it as an irreversible data model change and require additional human confirmation.

### Deployment Strategy

#### Strategy Selection
Choose deployment strategy based on risk level:

| Strategy | When to use | Description |
|----------|-------------|-------------|
| **Direct** | `dev` environment | 直接替換，無回滾保護 |
| **Rolling** | `staging` environment (default) | 逐步替換實例，自動回滾 |
| **Canary** | `prod` environment (default) | 先導 5% 流量，觀察後全量 |
| **Blue-Green** | `prod` environment (high-risk changes) | 完整備援切換 |

可透過參數覆蓋：`/deploy prod --strategy=blue-green`

### Decision Brief & Confirmation

After all Pre-deployment Checks pass and the strategy is selected, **MUST** print a Decision Brief in Chinese (per [AGENTS.md](../AGENTS.md) section 7.0 Language Convention) before triggering the actual deployment. For `prod`, follow the Brief with `AskUserQuestion` to collect explicit human approval (in addition to GitHub Environment protection). For `dev` / `staging`, the Brief is still printed for the deployment record but no AskUserQuestion is required.

```markdown
### 📋 決策摘要：部署 — <feature title> → <env>

**目標**：判斷是否執行本次部署。

**關鍵事實**（每項附原檔連結）：
- 目標環境與策略：<env / strategy>，預估健康檢查窗口 <N 分鐘> → 詳見 [/deploy 策略表](../commands/deploy.md#strategy-selection)
- 本次包含的 specs：<列出 1~3 個 spec 名稱與狀態> → 詳見 [specs/](../specs/)
- 不可逆變更：<列出非向後相容的 schema 變更或標示「無」> → 詳見 [plan.md#部署影響評估](../specs/<feature-slug>/plan.md#部署影響評估)
- 設定同步狀態：<已驗證的環境變數同步結果，或標示「無變更」>
- 回滾計畫：<簡述：自動回滾觸發條件、回滾目標版本> → 詳見 [/deploy#post-deployment](../commands/deploy.md#post-deployment)
- 資源預算對齊：<實際 limits vs plan 預算的差異，或「對齊」>

**需特別關注**：
- ⚠️ <若有不可逆變更，列出並提醒>
- ⚠️ <若 prod 且為高風險變更，建議考慮 Blue-Green>
- ⚠️ <若 config parity 有任何例外狀況>

**建議**：<AI 推薦的決策與一句話理由，例如「建議確認部署 — 變更全為向後相容，rolling 策略足夠」>

👉 建議先點開上列連結確認細節後再做決定。
```

For `prod`, then call `AskUserQuestion`:
- `確認部署` — 進入實際部署流程
- `延後` — 暫不部署，保留所有檢查結果
- `取消` — 中止本次 /deploy

For `dev` / `staging`, proceed automatically after printing the Brief.

### Deployment (by environment)

#### `dev`
- Auto-deploy on every push to `develop`
- Strategy: Direct
- No approval required
- Relaxed health check thresholds

#### `staging`
- Auto-deploy when PR merges to `main`
- Strategy: Rolling
- Health check must pass within 2.5 minutes
- **On failure**: auto-rollback + create intake item via feedback loop

#### `prod`
- **Requires explicit human approval** (GitHub Environment protection)
- Strategy: Canary (default) or Blue-Green (for high-risk changes)
- Canary flow:
  1. Deploy to 5% of instances
  2. Monitor error rate and latency for 10 minutes
  3. If metrics are healthy: promote to 25% → 50% → 100%
  4. If metrics degrade at any stage: auto-rollback entire canary
- Health check must pass within 5 minutes
- **On failure**: auto-rollback + create intake item + escalate to team + trigger post-mortem

### Post-deployment
1. Run health check against the deployed environment
2. Verify application responds correctly
3. Generate deployment report
4. If deployment fails:
   - Automatically rollback to previous version
   - Create a new intake item in `${REQ_DATA_ROOT}/intake/raw/` documenting the failure
   - Create a post-mortem record in `${REQ_DATA_ROOT}/docs/postmortems/` (for staging and prod failures)
   - This intake item feeds back into the demand-driven cycle

### Feedback Loop (Closed-Loop)
When a deployment fails, the system automatically:
1. Rolls back to the last known-good version
2. Creates `${REQ_DATA_ROOT}/intake/raw/YYYY-MM-DD-auto-deploy-{env}-failure.md`
3. The failure report follows the `bug-report` template
4. This triggers the standard `/translate` → `/detect-conflicts` → `/review` cycle
5. The issue is treated as a new requirement, going through the full process

## Constraints
- **MUST NOT** deploy to `prod` without human approval (both GitHub Environment protection AND the Decision Brief AskUserQuestion confirmation)
- **MUST NOT** deploy if any relevant `plan.md` has an incomplete deployment impact assessment (see CONSTITUTION.md > Deployment Integrity for the canonical sub-section list)
- **MUST NOT** deploy if declared environment variables are missing from the target platform configuration
- **MUST** print the Decision Brief in Chinese before any deployment (all environments), even when no AskUserQuestion follows
- **MUST** rollback automatically on health check failure
- **MUST** create feedback intake on any deployment failure
- **MUST** create post-mortem record on staging/prod failures
- **MUST** verify spec status before deployment (spec gate)
- **MUST** verify security scan passed before deployment
- **MUST** treat non-backward-compatible schema changes as irreversible data model changes (extra human approval required)
- **MUST** use canary strategy for production by default (unless overridden with justification)
- All deployment actions are logged for traceability
