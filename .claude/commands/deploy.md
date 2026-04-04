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
4. Verify Docker image builds successfully

### Deployment (by environment)

#### `dev`
- Auto-deploy on every push to `develop`
- No approval required
- Relaxed health check thresholds

#### `staging`
- Auto-deploy when PR merges to `main`
- Health check must pass within 2.5 minutes
- **On failure**: auto-rollback + create intake item via feedback loop

#### `prod`
- **Requires explicit human approval** (GitHub Environment protection)
- Health check must pass within 5 minutes
- **On failure**: auto-rollback + create intake item + escalate to team

### Post-deployment
1. Run health check against the deployed environment
2. Verify application responds correctly
3. Generate deployment report
4. If deployment fails:
   - Automatically rollback to previous version
   - Create a new intake item in `intake/raw/` documenting the failure
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
- **MUST** verify spec status before deployment (spec gate)
- All deployment actions are logged for traceability
