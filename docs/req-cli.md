# `req` CLI — Phase 0 PoC

> **Status**: Proof of concept. Only `req ask` and `req list` subcommands implemented. **No existing `/req-*` command is modified.** This PoC exists so the framework can evaluate the "scripts generate option lists, AI does not improvise" pattern before wider adoption.

---

## Background

The req framework currently asks Claude to **interpret 14 command markdown files** for every workflow turn. A large portion of that work is deterministic — state transitions, prerequisite checks, Decision Brief templating, and especially **option list generation at user-choice decision forks**.

Every time a command like `/req-review` or `/req-resolve-conflict` needs to ask the user "what's your decision?", AI is asked to **improvise both the question text and the option labels**. This:

- burns tokens on deterministic work (~2,000 tokens per decision fork)
- causes option labels/descriptions to drift between sessions (no regression safety net)
- makes the decision points un-auditable (no fixed contract between command and UI)
- blocks testing (can't snapshot-test AI prose)

**The fix**: extract the question catalog into a YAML file; let a script (`req ask`) resolve each question id into the exact JSON payload that the `AskUserQuestion` tool expects; let commands **refer to the catalog id** instead of improvising.

This PoC proves the pattern on 5 representative questions (4 static, 1 dynamic).

---

## What's in the PoC

```
framework/
├── config/
│   └── questions.yaml                    — 5-entry question catalog
├── scripts/
│   ├── req                               — Python CLI (single file, executable)
│   └── tests/
│       ├── test_req_ask.sh               — 33-assertion smoke test (all passing)
│       └── fixtures/
│           ├── CONFLICT-test-001.md      — well-formed fixture for dynamic test
│           └── CONFLICT-test-malformed.md — malformed fixture for fallback test
└── (no command markdown touched)
```

**What is NOT in the PoC** (intentionally deferred):

- Any `/req-*` command markdown changes
- Other `req` subcommands (`spec status`, `review checklist`, `deploy pre-checks`, etc.)
- Helper shell functions in `_lib.sh`
- Python package structure (it's a single file for now)
- CI integration
- PyYAML bundling (relies on system `pip install pyyaml`)

---

## Quickstart

### Install dependencies

```bash
pip install pyyaml   # the only dependency
```

### List available questions

```bash
$ framework/scripts/req list
# Catalog: /path/to/framework/config/questions.yaml
  deploy.prod_confirmation            [static] Prod deploy
  intake.confirmation                 [static] Intake
  research.duplicate_action           [static] Duplicate
  resolve_conflict.picker             [dynamic] Conflict
  review.approval                     [static] Review
```

### Resolve a static question

```bash
$ framework/scripts/req ask review.approval
{
  "questions": [
    {
      "question": "此 spec 的審核結果？",
      "header": "Review",
      "multiSelect": false,
      "options": [
        {"label": "通過", "description": "所有檢查項通過，狀態 → approved，可進入 /req-plan"},
        {"label": "通過（附註）", "description": "主要通過但有小修正建議..."},
        {"label": "要求修改", "description": "列出需修正項目，狀態保持 in-review..."},
        {"label": "退件", "description": "與現有設計不符，狀態 → draft..."}
      ]
    }
  ]
}
```

The output is **exactly the JSON shape the `AskUserQuestion` tool consumes**. A command can pipe this directly:

```markdown
## Behavior (hypothetical future /req-review)

1. Run prerequisite checks (TODO: via `req review checklist <slug>`)
2. Run `req ask review.approval` — pipe the JSON to the `AskUserQuestion` tool parameters
3. Branch on the user's selection (deterministic lookup table)
```

No improvising option labels. No token spent on generating "通過 / 退件" variants every session.

### Resolve a dynamic question (extracts options from a file)

```bash
$ framework/scripts/req ask resolve_conflict.picker \
    --context data/conflicts/CONFLICT-001-rate-limit.md
{
  "questions": [
    {
      "question": "選擇「自訂 slug 建立速率限制」的解決方向",
      "header": "Conflict",
      "multiSelect": false,
      "options": [
        {"label": "Option 1：完全無限制", "description": "不設 rate limit..."},
        {"label": "Option 2：嚴格每日配額", "description": "每人每日最多 20 次..."},
        {"label": "Option 3：分層配額", "description": "每分鐘 10 次，burst..."}
      ]
    }
  ]
}
```

The dynamic handler parses the CONFLICT file's `## 可能解決方向` section, extracts each `### Option N：<title>` block, and pulls the first `做法` line as the description. If extraction fails, the script uses the `fallback_options` defined in the catalog (exit code 5) — the JSON is still valid, so the command can always proceed.

---

## questions.yaml schema

```yaml
catalog:
  <question_id>:            # dot-separated id, e.g. "review.approval"
    type: static | dynamic  # static = fixed options; dynamic = extracted from a file
    header: <string>        # UI chip label, max 12 chars
    multi_select: bool      # default false

    # for type: static
    question: <string>      # full question text; may contain {placeholders} filled by --var
    options:
      - label: <string>
        description: <string>

    # for type: dynamic
    source: conflict_file   # the only source implemented in the PoC
    question_template: <string>   # with {title} from the context file
    fallback_options:             # used if extraction fails
      - label: <string>
        description: <string>
```

### Adding a new question

1. Add an entry to `framework/config/questions.yaml`
2. Add a smoke-test case to `framework/scripts/tests/test_req_ask.sh`
3. (Future) Update the command markdown that references the id

---

## Exit codes

| Code | Meaning | JSON on stdout? |
|------|---------|-----------------|
| 0 | Success | Yes |
| 1 | Usage error (bad arguments) | No |
| 2 | Unknown question id | No |
| 3 | Malformed catalog | No |
| 4 | Missing or unreadable context file (dynamic) | No |
| 5 | Dynamic extraction failed — fallback options used | **Yes (valid)** |
| 10 | PyYAML not installed | No |

**Note**: exit code 5 is intentionally non-zero but accompanies a valid JSON payload. Command markdown should treat `0 or 5` as "proceed with the JSON" and `1-4 or 10` as "abort".

---

## Running the smoke tests

```bash
$ bash framework/scripts/tests/test_req_ask.sh
==============================================
  req ask — Smoke Tests
==============================================
...
==============================================
  Passed: 33   Failed: 0
==============================================
```

The test suite covers:

- All 5 catalog entries resolve to valid JSON
- Dynamic extraction works on well-formed fixtures
- Dynamic fallback triggers on malformed fixtures (and still emits valid JSON)
- Error paths return the expected exit codes (2, 4, 1)
- `req list` lists every entry

---

## Future integration pattern (not implemented)

Once the PoC is validated, the natural next step is to update command markdown to **reference catalog ids** instead of improvising. Example conceptual diff for `/req-review`:

### Before (current state — AI improvises)

```markdown
## Behavior

...

8. Present a Decision Brief and ask the user to approve or reject:
   - Summarise the checklist state in Chinese
   - Offer "通過" / "通過但有附註" / "要求修改" / "退件" as options
   - Use the AskUserQuestion tool
```

### After (future — deterministic)

```markdown
## Behavior

...

8. Run `req ask review.approval`. Pipe the JSON directly to the `AskUserQuestion` tool.
   Do NOT construct the options manually — they come from the catalog.
```

The "after" version:

- removes ~500 bytes of prose
- guarantees label consistency across sessions
- lets us regression-test the option list with `test_req_ask.sh`
- allows `req ask review.approval --format preview` (a future flag) to print a human-readable preview for documentation

---

## Why only 5 questions in the PoC?

The full catalog would cover every decision fork across the 14 `/req-*` commands — roughly 12-15 entries. This PoC includes 5 to **prove the pattern handles both the trivial case (static fixed options) and the hard case (dynamic extraction with fallback)**. If those work, the rest is mechanical.

The 5 entries are chosen to cover the distinct patterns:

| Entry | Pattern it demonstrates |
|-------|------------------------|
| `intake.confirmation` | Simplest 3-option fixed |
| `review.approval` | 4-option fixed with state implications in descriptions |
| `deploy.prod_confirmation` | Minimal 2-option (go / no-go) |
| `research.duplicate_action` | 3-option where descriptions carry process consequences |
| `resolve_conflict.picker` | **Dynamic extraction from a file**, with fallback safety net |

---

## Why Python, not Bash?

Bash's YAML parsing story is painful (awk hacks or an external `yq` dependency). The existing `_lib.sh` uses an `awk`-based minimal YAML parser which is fine for flat key-value configs like `.req.config.yml`, but can't handle nested catalogs cleanly.

Python 3 with PyYAML is the pragmatic choice:

- Python 3 is on virtually every dev machine
- PyYAML is ubiquitous and well-maintained
- Error handling / type checking is much cleaner than bash
- Single-file scripts are easy to read and test

Bash stays the right choice for the existing thin wrappers (`req-init.sh`, `status-report.sh`). Python is reserved for business logic.

---

## What we learn from this PoC

If the PoC is accepted and expanded:

1. **Token savings are measurable**: every decision fork that used to cost ~2,000 tokens of AI improvisation now costs 0 (script output is loaded as plain JSON).
2. **Option consistency is enforced**: changing an option label requires editing YAML + test + docs, not hoping AI happens to use the same phrasing.
3. **Tests become possible**: `test_req_ask.sh` is the first real test in the framework. The pattern can extend to `test_req_spec_status.sh`, `test_req_review_checklist.sh`, etc.
4. **External tooling can hook in**: a CI job can run `req ask review.approval > expected.json` and diff against a committed snapshot.

If the PoC is rejected:

- Total sunk cost: 1 Python file, 1 YAML file, 2 test fixtures, 1 test script, this doc
- **Zero impact on any existing command** — the files can be deleted without touching the rest of the framework

---

## Next step (pending user decision)

Expand this PoC into Phase 1 of the scripting migration:

- Add `req spec status <slug>` / `req spec set-status <slug> <new>` subcommands
- Add `req changelog append <entry>` subcommand
- Migrate `/req-autonomy` and `/req-audit` (both 100% deterministic) to use the CLI
- Add smoke tests for those subcommands
- Measure actual token savings by running `/req-autonomy` under old and new implementations

Until that decision is made, this PoC stands alone and the rest of the framework is unchanged.
