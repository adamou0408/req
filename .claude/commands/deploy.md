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
6. If plan includes irreversible data model changes, require additional human confirmation

### Deployment Strategy

#### Strategy Selection
Choose deployment strategy based on risk level:

| 策略 | 何時使用 | 說明 |
|------|----------|------|
| **Direct** | dev 環境 | 直接替換，無回滾保護 |
| **Rolling** | staging 環境（預設） | 逐步替換實例，自動回滾 |
| **Canary** | prod 環境（預設） | 先導 5% 流量，觀察後全量 |
| **Blue-Green** | prod 環境（高風險變更） | 完整備援切換 |

可透過參數覆蓋：`/deploy prod --strategy=blue-green`

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
   - Create a new intake item in `intake/raw/` documenting the failure
   - Create a post-mortem record in `docs/postmortems/` (for staging and prod failures)
   - This intake item feeds back into the demand-driven cycle

### Feedback Loop (Closed-Loop)
When a deployment fails, the system automatically:
1. Rolls back to the last known-good version
2. Creates `intake/raw/YYYY-MM-DD-auto-deploy-{env}-failure.md`
3. The failure report follows the `bug-report` template
4. This triggers the standard `/translate` → `/detect-conflicts` → `/review` cycle
5. The issue is treated as a new requirement, going through the full process

## Constraints
- **MUST NOT** deploy to `prod` without human approval
- **MUST** rollback automatically on health check failure
- **MUST** create feedback intake on any deployment failure
- **MUST** create post-mortem record on staging/prod failures
- **MUST** verify spec status before deployment (spec gate)
- **MUST** verify security scan passed before deployment
- **MUST** use canary strategy for production by default (unless overridden with justification)
- All deployment actions are logged for traceability
