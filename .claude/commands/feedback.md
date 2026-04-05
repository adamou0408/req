# /feedback - Process Monitoring Feedback

## Description
Process feedback from monitoring systems, health checks, or production incidents, and route them back into the demand-driven development cycle as new intake items.

This command is the manual trigger for the closed-loop feedback mechanism. It can also be triggered automatically by the monitoring system via webhooks.

## Usage
```
/feedback [alert description or monitoring data]
```

## Behavior

### 1. Classify the Feedback
Determine the type and severity:
- **Type**: service-down, high-error-rate, high-latency, deployment-failure, user-error-report
- **Severity**: critical (很急), warning (普通), info (不急)

### 2. Deduplication Check
- Check `intake/raw/` for similar auto-generated intake items created within the last 30 minutes
- If a duplicate exists, append new information to the existing intake rather than creating a new one

### 3. Create Intake Item
- Generate `intake/raw/YYYY-MM-DD-auto-{alert-slug}.md`
- Use the appropriate template based on feedback type:
  - Service down / deployment failure → `bug-report` template
  - High latency / high error rate → `user-feedback` template
  - Feature suggestion from usage patterns → `quick-idea` template
- Mark the intake as auto-generated with metadata:
  - Source: monitoring system name
  - Auto-generated: true
  - Requires triage: true

### 4. Triage Recommendation
Provide an initial assessment:
- Impact scope (how many users affected)
- Urgency recommendation
- Related existing specs (if any)
- Suggested priority

### 5. Post-Mortem (for critical and staging/prod failures)
- For **critical** issues or deployment failures:
  - Create a post-mortem record in `docs/postmortems/YYYY-MM-DD-{slug}.md` using the template
  - Pre-fill: event date, severity, timeline, related spec/intake links
  - The 5 Whys analysis and lessons learned sections are left for human completion
- Post-mortems are informational — they don't block the pipeline but are mandatory for production incidents

### 6. Route to Next Step
- For **critical** issues: immediately notify + create post-mortem + recommend `/research` → `/translate` → fast-track review
- For **warning** issues: create intake and recommend standard `/research` → `/translate` flow
- For **info** issues: create intake, batch for next review cycle

## Constraints
- **MUST** preserve all monitoring data in the intake item
- **MUST** deduplicate within 30-minute windows to avoid alert storms
- **MUST** link back to the monitoring source (dashboard URL, alert ID, etc.)
- **MUST NOT** auto-resolve production issues — always route through the full cycle
- **MUST** escalate if the same alert fires 3+ times within 24 hours

## Closed-Loop Integration
This command completes the feedback loop:

```
Deploy → Monitor → Alert → /feedback → post-mortem + intake/ → /research → /translate → spec → /review → /implement → Deploy → ...
```

Every production issue is treated as a new requirement, ensuring continuous improvement.
