# Token Measurement — Phase 0 Baseline Report

> Generated: 2026-04-09 07:16
> Method: heuristic token estimation (CJK ~0.8 tok/char, ASCII ~0.25 tok/char)
> Approach: OLD = full AI-interpreted markdown; NEW = thin wrapper + `req` CLI for D-sections

## 1. Per-Command Token Analysis (14 commands)

Each command's markdown is classified into D (Deterministic — scriptable) and A (AI-required) sections.

| Command | Bytes | OLD tokens | D ratio | D tokens | A tokens | NEW tokens | Saving | Saving % |
|---------|-------|-----------|---------|----------|----------|-----------|--------|----------|
| `audit` | 5,638 | 1,406 | 100% | 1,406 | 0 | 150 | 1,256 | 89% |
| `autonomy` | 5,233 | 1,282 | 100% | 1,282 | 0 | 100 | 1,182 | 92% |
| `deploy` | 6,931 | 1,739 | 100% | 1,739 | 0 | 200 | 1,539 | 88% |
| `detect-conflicts` | 1,854 | 460 | 100% | 460 | 0 | 125 | 335 | 73% |
| `feedback` | 5,042 | 1,256 | 89% | 1,117 | 139 | 339 | 917 | 73% |
| `implement` | 3,732 | 930 | 55% | 511 | 419 | 719 | 211 | 23% |
| `intake` | 3,405 | 860 | 78% | 670 | 190 | 415 | 445 | 52% |
| `iterate` | 7,974 | 1,978 | 93% | 1,839 | 139 | 389 | 1,589 | 80% |
| `onboard` | 2,574 | 640 | 100% | 640 | 0 | 125 | 515 | 80% |
| `plan` | 7,561 | 1,897 | 92% | 1,745 | 152 | 452 | 1,445 | 76% |
| `research` | 2,509 | 624 | 100% | 624 | 0 | 150 | 474 | 76% |
| `resolve-conflict` | 5,349 | 1,338 | 86% | 1,150 | 188 | 413 | 925 | 69% |
| `review` | 5,234 | 1,313 | 100% | 1,313 | 0 | 200 | 1,113 | 85% |
| `translate` | 2,746 | 686 | 75% | 514 | 172 | 422 | 264 | 38% |
| **Total** | | **16,409** | | | | **4,199** | **12,210** | **74%** |

**100% Deterministic commands (7/14)**:
- `/audit` (1,406 tokens → 150, save 89%)
- `/autonomy` (1,282 tokens → 100, save 92%)
- `/deploy` (1,739 tokens → 200, save 88%)
- `/detect-conflicts` (460 tokens → 125, save 73%)
- `/onboard` (640 tokens → 125, save 80%)
- `/research` (624 tokens → 150, save 76%)
- `/review` (1,313 tokens → 200, save 85%)

## 2. Always-Loaded Context (per session)

These files may be read by multiple commands per session:

| File | Tokens |
|------|--------|
| `AGENTS.md` | 4,096 |
| `CONSTITUTION.md` | 2,907 |
| **Combined** | **7,003** |

In the OLD approach, AI re-reads relevant sections per command. In the NEW approach,
enforcement sections (§5b autonomy matrix, §6 state machine) are handled by scripts —
AI only reads semantic sections (§1 Translation, §2 Conflicts, §3 Code Gen) when needed.

## 3. Workflow Simulation (quickstart: intake → plan)

Simulates 7 steps of a typical feature cycle on `examples/quickstart/`.

| Step | Command | OLD tokens | NEW tokens | Saving | Saving % | Notes |
|------|---------|-----------|-----------|--------|----------|-------|
| 1. Intake | `intake` | 2,912 | 1,814 | 1,098 | 38% | AI generates one-sentence summary + infers personas |
| 2. Research | `research` | 2,349 | 350 | 1,999 | 85% | Parent only sees subagent summary; branching is lookup table |
| 3. Translate | `translate` | 3,946 | 2,208 | 1,738 | 44% | AI: identify personas, generate User Stories + acceptance criteria |
| 4. Detect Conflicts | `detect-conflicts` | 2,874 | 285 | 2,589 | 90% | 100% delegation to subagent; parent is thin wrapper |
| 5. Resolve Conflict | `resolve-conflict` | 4,815 | 1,774 | 3,041 | 63% | AI: trade-off analysis + impact matrix; rest is D |
| 6. Review | `review` | 4,641 | 680 | 3,961 | 85% | 100% D: checklist checks + Decision Brief + AskUserQuestion |
| 7. Plan | `plan` | 13,647 | 5,038 | 8,609 | 63% | AI: plan architecture generation; rest is D (prereqs, templates, Brief) |
| **Total** | | **35,184** | **12,149** | **23,035** | **65%** | |

## 4. Per-Step Breakdown

### 1. Intake (`/req-intake`)

| Component | OLD tokens | NEW tokens |
|-----------|-----------|-----------|
| Command markdown | 860 | 225 |
| AGENTS.md sections | 1,841 | 327 |
| CONSTITUTION.md | 0 | 0 |
| Referenced files | 211 | 982 |
| CLI JSON output | — | 280 |
| **Total** | **2,912** | **1,814** |

### 2. Research (`/req-research`)

| Component | OLD tokens | NEW tokens |
|-----------|-----------|-----------|
| Command markdown | 624 | 150 |
| AGENTS.md sections | 1,514 | 0 |
| CONSTITUTION.md | 0 | 0 |
| Referenced files | 211 | 0 |
| CLI JSON output | — | 200 |
| **Total** | **2,349** | **350** |

### 3. Translate (`/req-translate`)

| Component | OLD tokens | NEW tokens |
|-----------|-----------|-----------|
| Command markdown | 686 | 250 |
| AGENTS.md sections | 2,004 | 736 |
| CONSTITUTION.md | 0 | 0 |
| Referenced files | 1,256 | 982 |
| CLI JSON output | — | 240 |
| **Total** | **3,946** | **2,208** |

### 4. Detect Conflicts (`/req-detect-conflicts`)

| Component | OLD tokens | NEW tokens |
|-----------|-----------|-----------|
| Command markdown | 460 | 125 |
| AGENTS.md sections | 1,432 | 0 |
| CONSTITUTION.md | 0 | 0 |
| Referenced files | 982 | 0 |
| CLI JSON output | — | 160 |
| **Total** | **2,874** | **285** |

### 5. Resolve Conflict (`/req-resolve-conflict`)

| Component | OLD tokens | NEW tokens |
|-----------|-----------|-----------|
| Command markdown | 1,338 | 225 |
| AGENTS.md sections | 1,350 | 327 |
| CONSTITUTION.md | 0 | 0 |
| Referenced files | 2,127 | 982 |
| CLI JSON output | — | 240 |
| **Total** | **4,815** | **1,774** |

### 6. Review (`/req-review`)

| Component | OLD tokens | NEW tokens |
|-----------|-----------|-----------|
| Command markdown | 1,313 | 200 |
| AGENTS.md sections | 1,023 | 0 |
| CONSTITUTION.md | 0 | 0 |
| Referenced files | 2,305 | 0 |
| CLI JSON output | — | 480 |
| **Total** | **4,641** | **680** |

### 7. Plan (`/req-plan`)

| Component | OLD tokens | NEW tokens |
|-----------|-----------|-----------|
| Command markdown | 1,897 | 300 |
| AGENTS.md sections | 2,086 | 409 |
| CONSTITUTION.md | 2,907 | 2,907 |
| Referenced files | 6,757 | 982 |
| CLI JSON output | — | 440 |
| **Total** | **13,647** | **5,038** |

## 5. Decision Data — Should we proceed with Phase 1?

### Token savings
- **Per feature cycle** (7 steps): 23,035 tokens saved (65%)
- **Per 5 features/month**: ~115,175 tokens/month
- **Per 50 features/month**: ~1,151,750 tokens/month

### Command markdown compression
- **Total command markdown**: 16,409 tokens (OLD) → 4,199 tokens (NEW)
- **Compression**: 74% reduction

### Top 5 commands by token saving potential

| Rank | Command | D ratio | Saving | Why |
|------|---------|---------|--------|-----|
| 1 | `iterate` | 93% | 1,589 tokens | AI: impact analysis |
| 2 | `deploy` | 100% | 1,539 tokens | 100% D: pre-checks + health checks + rollback |
| 3 | `plan` | 92% | 1,445 tokens | AI: plan architecture generation (§6) |
| 4 | `audit` | 100% | 1,256 tokens | 100% D: grep + diff + report generation |
| 5 | `autonomy` | 100% | 1,182 tokens | 100% D: config read/write + matrix print |

### Rule-base vs AI verdict per command

| Command | Verdict | Rationale |
|---------|---------|-----------|
| `audit` | **Script 100%** | No AI judgment needed. Entire command can be a shell/Python script. |
| `autonomy` | **Script 100%** | No AI judgment needed. Entire command can be a shell/Python script. |
| `deploy` | **Script 100%** | No AI judgment needed. Entire command can be a shell/Python script. |
| `detect-conflicts` | **Script 100%** | No AI judgment needed. Entire command can be a shell/Python script. |
| `feedback` | Script + thin AI | ~89% scriptable. AI only for: S: triage recommendation |
| `implement` | AI-primary | Only 55% scriptable. Core work is AI: AI: code + test generation, auto-fix |
| `intake` | Hybrid | ~78% scriptable. AI needed for: AI: one-sentence summary + persona inference |
| `iterate` | Script + thin AI | ~93% scriptable. AI only for: AI: impact analysis |
| `onboard` | **Script 100%** | No AI judgment needed. Entire command can be a shell/Python script. |
| `plan` | Script + thin AI | ~92% scriptable. AI only for: AI: plan architecture generation (§6) |
| `research` | **Script 100%** | No AI judgment needed. Entire command can be a shell/Python script. |
| `resolve-conflict` | Script + thin AI | ~86% scriptable. AI only for: AI: impact matrix + trade-off analysis |
| `review` | **Script 100%** | No AI judgment needed. Entire command can be a shell/Python script. |
| `translate` | Hybrid | ~75% scriptable. AI needed for: AI: persona identification + User Story generation |

## 6. Caveats & Limitations

1. **Token counts are estimates**: uses heuristic (CJK ~0.8 tok/char, ASCII ~0.25 tok/char),
   not the actual Claude tokenizer. Real counts may differ by 10-20%.
2. **AI output tokens not measured**: this only measures input context (what AI reads).
   AI output (generated User Stories, plan sections, Decision Briefs) is a separate cost.
3. **AGENTS.md section proportions are estimated**: sections aren't clearly byte-delimited;
   proportions are rough.
4. **Subagent tokens excluded**: `/research`, `/detect-conflicts`, `/onboard` delegate to
   subagents. Their token cost is separate from the parent command and not reduced by scripting.
5. **Tool call overhead excluded**: each Bash/Read/Edit tool invocation has ~50-100 tokens of
   schema overhead. The NEW approach may have more tool calls (CLI invocations) that partially
   offset the context savings.
6. **This is a single-pass simulation**: real sessions may re-read files, retry, or branch.
   Actual savings could be higher (re-reads avoided) or lower (more branching).

---

## 7. Phase 1 Delta — `/req-autonomy` Migration

> Measured after commit: autonomy.md rewritten as thin CLI wrapper

### Command markdown delta

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| `autonomy.md` bytes | 5,233 | 1,221 | **-4,012 (77%)** |
| `autonomy.md` tokens | 1,282 | 304 | **-978 (76%)** |
| 14-command total tokens | 16,409 | 15,431 | **-978 (6%)** |

### What moved out of markdown into code/data

| Artifact | Destination | Tokens removed from markdown |
|----------|-------------|------------------------------|
| Checkpoint matrix (7×3 table) | `framework/config/autonomy-matrix.yaml` | ~400 |
| Three level descriptions (L1/L2/L3) | `autonomy-matrix.yaml` + CLI | ~300 |
| Behavior logic (read/validate/write/changelog) | `framework/scripts/req` Python | ~200 |
| Safety net explanation | `autonomy-matrix.yaml` `safety_net_note` | ~80 |

### What stays in markdown

| Content | Tokens | Why |
|---------|--------|-----|
| Command description + usage | ~100 | User needs to know syntax |
| "delegate to CLI" behavior | ~100 | AI needs to know to call `req autonomy` |
| Constraints (3 lines) | ~100 | Enforcement reminder |

### Actual vs estimated

| | Estimated (from baseline report) | Actual |
|---|---|---|
| autonomy.md saving | 1,182 tokens (92%) | 978 tokens (76%) |
| Reason for gap | Estimated wrapper at 100 tokens | Actual wrapper is 304 tokens (includes usage/constraints) |

The actual saving is **17% below estimate** — the thin wrapper still carries usage examples and
constraint reminders that the baseline assumed would be 100 tokens. This is expected: wrappers
can't be zero-content because AI needs to know the CLI exists and what arguments to pass.

**Correction factor for remaining estimates**: multiply baseline savings by ~0.83 to account for
wrapper overhead. Revised full-workflow estimate: 23,035 × 0.83 ≈ **19,100 tokens saved (54%)**
per feature cycle. Still a significant reduction.

### Test coverage

| Test suite | Assertions | Status |
|------------|-----------|--------|
| `test_req_ask.sh` | 33 | ✅ all pass |
| `test_req_autonomy.sh` | 24 | ✅ all pass |
