# /autonomy - Switch Human-Checkpoint Autonomy Level

## Description
View or change how many human checkpoints the framework enforces. The req framework defines seven human checkpoints in [AGENTS.md §5](${REQ_FRAMEWORK_ROOT}/framework/AGENTS.md). This command lets a project dial the level of AI autonomy without editing the framework itself.

## Usage
```
/autonomy                     # print current level + the checkpoint matrix
/autonomy strict              # switch to L1 Strict (default, 7/7 human)
/autonomy balanced            # switch to L2 Balanced (5/7 human)
/autonomy auto                # switch to L3 Auto (5/7 human, larger grey-area discretion)
```

## Three Levels (Supervised Model)

| # | Checkpoint | L1 Strict | L2 Balanced | L3 Auto |
|---|---|---|---|---|
| 1 | Conflict resolution (`/req-resolve-conflict`) | 👤 Human | 👤 Human | 👤 Human |
| 2 | Spec approval (`/req-review`) | 👤 Human | 👤 Human | 👤 Human |
| 3 | Plan approval (`/req-plan` → ExitPlanMode) | 👤 Human | 👤 Human | 👤 Human |
| 4 | Production deploy (`/req-deploy`) | 👤 Human | 👤 Human | 👤 Human |
| 5 | 3-strike test failure (`/req-implement`) | 👤 Human | 👤 Human | 👤 Human |
| 6 | Duplicate intake handling (`/req-research`) | 👤 Human | 🤖 AI recommendation | 🤖 AI recommendation |
| 7 | Iteration impact approval (`/req-iterate`) | 👤 Human | 🤖 Auto if ≤1 spec affected & minor bump | 🤖 Auto if ≤1 spec affected & minor bump |

**L1 Strict** — current v2.1.0 default; every checkpoint requires explicit human input.
**L2 Balanced** — low-risk automation (duplicate handling on `/req-research`, minor iterations on `/req-iterate`) takes the AI-recommended path, but the AI **MUST** annotate the action in the summary / changelog so it's auditable.
**L3 Auto** — same five hard checkpoints as Balanced, plus expanded AI discretion in grey areas:
- On `/req-research`, partial overlaps (30-80%) no longer require a flag — the AI proceeds on its recommendation silently.
- On `/req-detect-conflicts`, `severity: low` conflicts may be skipped and only reported as an aggregate count in the subagent summary (never silently dropped — always logged).
- High-risk feasibility findings (Red) still stop and wait for human confirmation.

The five L1-L3 hard checkpoints (conflict resolution, spec/plan approval, production deploy, 3-strike failure) **MUST NEVER** be bypassed by any autonomy level.

### Safety net for L2/L3

`balanced` and `auto` are only safe when paired with the `/req-audit` + `/req-iterate --fixup` workflow. Automated decisions made under these levels leave breadcrumbs (`[autonomy: ...]` changelog tags, `TODO(auto)` markers). Run `/req-audit` periodically (it is read-only and may be scheduled) to surface drift; then run `/req-audit --iterate` — or `/req-iterate --fixup <spec-slug>` — to repair each row under a *shrink-wrapped* approval (diff-only spec review + ≤5-task micro-plan). The five hard checkpoints still apply, but each post-hoc review unit is much smaller, which is what makes L3 actually usable. See `commands/audit.md` and the Fixup Mode section in `commands/iterate.md` for details.

> Note: there is intentionally no L4 / "Yolo" level. The leverage at higher autonomy comes from **shrinking the approval unit** (via fixup) rather than from removing approvals.

## Behavior

### 1. No argument — display current state

- Read `autonomy_level` from `.req.config.yml` (default `strict` if missing).
- Print the current level.
- Print the checkpoint matrix above.
- Do **NOT** change anything.

### 2. Argument provided — change level

- Validate argument against `strict|balanced|auto`. On invalid input, print the three valid values and abort.
- Use the Edit tool to update `.req.config.yml`:
  - If the file already has `autonomy_level:` line → replace its value
  - If not (v2.1.0 config) → append `autonomy_level: <level>` after `framework_root:`
- Append a one-line audit entry to `${REQ_DATA_ROOT}/docs/changelog.md`:
  ```
  ## {YYYY-MM-DD}
  - autonomy level: {old} → {new} (via /req-autonomy)
  ```
- If switching to `auto`, print a warning: `⚠ L3 Auto is recommended only for solo projects or prototypes. Do not use for team or production work without a code review gate.`
- Print the updated checkpoint matrix so the user sees what just changed.

### 3. No argument + interactive fallback

- If the harness supports `AskUserQuestion` and the user seems to be exploring (not scripting), offer a picker with three options (Strict / Balanced / Auto), each with a `preview` containing the relevant column of the matrix. On selection, fall through to step 2 as if the user had passed the argument.

## Constraints

- **MUST NOT** modify `.req.config.yml` without also writing the audit line in `docs/changelog.md`.
- **MUST NOT** change autonomy level silently — always print confirmation + matrix.
- **MUST** validate the argument before any write.
- **MUST NOT** remove other lines from `.req.config.yml` — only replace or append `autonomy_level:`.
- **MUST** respect `REQ_AUTONOMY_LEVEL` env var if set (session-level override by power users), but **do not** persist env var values to the config file.
