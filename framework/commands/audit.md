# /audit - Drift Detection for Done Specs

## Description
Read-only sweep comparing `done` / `in-progress` specs against code, TODO markers, and changelog. Produces a severity-ranked drift report.

## Usage
```
/audit                       # full sweep → write AUDIT-{timestamp}.md
/audit --spec <slug>         # restrict to one spec
/audit --since <date>        # only consider entries on or after YYYY-MM-DD
/audit --iterate             # sweep + stream each drift row through /iterate --fixup
```

## Behavior

**The read-only sweep is fully handled by `req audit run`.** Do NOT re-implement drift detection.

### Bare `/audit` (no `--iterate`):
1. Run `req audit run [--spec <slug>] [--since <date>]`.
2. Print the report from stdout.
3. Done. Do NOT modify any spec, code, or changelog.

### With `--iterate`:
1. Run `req audit run --format json [--spec <slug>] [--since <date>]`.
2. Parse the JSON `rows` array.
3. For each row with severity `high` or `medium`, invoke `/req-iterate --fixup --from-audit <report-path>` targeting that row's spec slug.
4. Process rows **one at a time, sequentially**. Each fixup walks through HARD checkpoints.
5. After all rows: append a "Fixup outcomes" section to the audit report.

### Scheduling:
- Bare `/audit` (read-only) **MAY** be scheduled (cron, CI). It only writes the report file.
- `--iterate` **MUST NOT** be scheduled. Human-initiated only.

## Constraints
- **MUST** delegate drift detection to `req audit run`. Do NOT grep code or parse changelog manually.
- **MUST NOT** modify any spec, code, or changelog under bare `/audit`.
- **MUST** write the audit report even on zero-drift (continuous audit history).
- **MUST** process `--iterate` rows sequentially, never in parallel.
