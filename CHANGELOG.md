# Changelog

All notable changes to the **req** framework are documented in this file.
The framework follows [Semantic Versioning](https://semver.org/).

## [2.4.0] — 2026-04-08

### Added
- **Next Step Picker Convention** — new AGENTS.md §7b that standardises every
  workflow checkpoint with multiple valid next actions. Each picker is preceded
  by a Chinese **Decision Brief** with drill-down links and is rendered via
  `AskUserQuestion` with **at most 3 options**, the AI-recommended option placed
  first and tagged `（建議）`. Always includes a non-destructive escape (e.g.
  `稍後再決定` / `取消` / `保留結果`). Replaces the v2.x mix of free-text
  confirmations, silent auto-chains, and "what would you like to do next?"
  prompts. Defines four explicit anti-patterns that new commands **MUST NOT**
  reintroduce.
- **Decision Brief + picker added to commands that previously had no structured
  handoff**: `/req-research`, `/req-translate`, `/req-detect-conflicts`,
  `/req-implement`, `/req-iterate`, `/req-audit`. Each picker is autonomy-aware:
  HARD checkpoints always render the picker; SOFT checkpoints under
  `balanced` / `auto` auto-take the recommended option but **MUST** still print
  the Brief for the audit trail.
- **`/req-audit` slash command** (carried over from the unreleased audit/fixup
  branch) — read-only drift sweep that compares every `done`/`in-progress` spec
  against the current state of code, tests, and changelog, producing a
  severity-ranked drift report under `${REQ_DATA_ROOT}/audits/`. Sources:
  spec↔code drift, autonomous-run residue (`TODO(auto)` markers),
  changelog-review of `[autonomy: ...]` entries, test retrospective. Bare form
  may be scheduled (cron, CI); `--iterate` form must be human-initiated.
- **`/req-iterate --fixup` mode** — additive to the forward-iteration flow.
  Targets a single `done`/`in-progress` spec, applies a patch-level version
  bump, generates a **micro-plan capped at 5 tasks**, walks the diff-only
  fixup variant of `/req-review` → `/req-plan` → `/req-implement`. All five
  HARD checkpoints still apply; fixup only shrinks the size of each approval,
  never bypasses one. Includes explicit refusal rules (no acceptance criteria
  changes, no `infra/` touches, no production-promoted code, no cross-spec
  drift, no architectural regret). Every fixup run writes a `FIXUP-*.md`
  audit-trail file.

### Changed
- **`/req-review` picker collapsed** from 4 historical outcomes (Approve /
  Approve w/ notes / Request changes / Reject) into 3 picker options + the
  automatic "Other" entry. Notes are now collected via a follow-up picker after
  Approve, keeping the primary picker compliant with the §7b 3-option cap.
- **Existing pickers retrofitted** to the §7b convention: `/req-intake`,
  `/req-feedback`, `/req-deploy`, `/req-resolve-conflict`, `/req-onboard`,
  `/req-autonomy`. Each now places the AI-recommended option first with
  `（建議）` suffix and rotates the recommendation based on context (e.g. high
  ambiguity in `/req-intake` swaps to `補充細節（建議）`; high-risk deploy in
  `/req-deploy` swaps to `延後（建議）`).
- **AGENTS.md §5/§5b updated** so that automated decisions made under
  `balanced` / `auto` leave breadcrumbs (`[autonomy: ...]` changelog tags,
  `TODO(auto)` markers) explicitly intended to be surfaced later by `/req-audit`
  and repaired by `/req-iterate --fixup`. The safety-net pairing is now
  documented as a hard requirement, not a recommendation.

## [2.3.0] — 2026-04-08

### Added
- **`/req-onboard` slash command** — one-time reverse onboarding for repos
  that install req on top of an existing codebase (submodule mode). Scans
  the host repo and seeds baseline personas, a feature inventory, and
  project context in `.req/` so subsequent `/req-*` commands have something
  to work from. Three depths: `shallow` (README + manifests),
  `medium` (default — + src tree + entry points + CI → personas +
  feature inventory), `deep` (+ legacy reverse-specs +
  project-specific `.req/CONSTITUTION.md` overlay).
- **`req-onboarder` subagent** — context-heavy scanning delegated out of the
  main conversation. Supports safe re-runs: auto-generated personas may be
  refreshed, but any persona whose frontmatter is `source: human` is
  preserved untouched. New features are appended under a dated subheading
  in `existing-features.md`.
- **`/req-research` now uses `.req/docs/existing-features.md` as a second
  deduplication baseline** (on top of `specs/`). New intake items that
  match an existing feature slug get `matched-existing-feature: <slug>` in
  the subagent summary and typically trigger a `merge via /req-iterate`
  recommendation instead of a fresh spec.
- **`/req-plan` now prefers `.req/CONSTITUTION.md` when present** (produced
  by `/req-onboard deep`) and falls back to the framework's generic
  `CONSTITUTION.md` otherwise. This lets `/req-plan` absorb project-specific
  stack, naming, and CI constraints without editing the framework.
- Two new templates: `framework/templates/spec/project-context.md` and
  `framework/templates/spec/existing-features.md`.
- New AGENTS.md §5a "Onboarding Artifacts" section documenting how other
  commands consume the onboarding outputs and tolerate their absence.

### Changed
- `req-add-submodule.sh` post-install message now recommends running
  `/req-onboard` as the third step before the first `/req-intake`.
- AGENTS.md §5a (autonomy) renumbered to §5b to make room for the
  onboarding section.

## [2.2.0] — 2026-04-08

### Added
- **Autonomy levels** (`strict` / `balanced` / `auto`) — a single project-level
  setting that controls how many of AGENTS.md §5's human checkpoints are actually
  enforced. `strict` (default) keeps the v2.1.0 behavior of 7/7 human checkpoints.
  `balanced` and `auto` hand off two SOFT checkpoints (duplicate intake handling
  and low-impact iteration approval) to the AI while keeping five HARD
  checkpoints (conflict resolution, spec approval, plan approval, 3-strike
  failure, production deploy) mandatory at every level.
- **New slash command** `/req-autonomy [strict|balanced|auto]` — view or change
  the current level. No argument prints the current level and a checkpoint
  matrix. Every change is logged to `docs/changelog.md` for auditability. Under
  `auto` the command prints a warning advising solo/prototype use only.
- **New config field** `autonomy_level:` in `.req.config.yml`. Loaded by
  `_lib.sh`'s `req_load_config` as `REQ_AUTONOMY_LEVEL`, defaulting to `strict`
  if absent — **fully backward compatible with v2.1.0** configs, no migration
  needed.
- `framework/commands/autonomy.md` — new command definition shipped and synced
  alongside the other 11 commands.

### Changed
- `framework/AGENTS.md §5` split into HARD (5) and SOFT (2) checkpoints; added
  new §5a explaining how each autonomy level branches.
- `framework/commands/research.md` duplicate/overlap handling branches on
  `REQ_AUTONOMY_LEVEL` (strict waits for human, balanced/auto auto-executes
  AI recommendation with audit annotation).
- `framework/commands/detect-conflicts.md` adds an `auto`-only constraint:
  low-severity conflicts may be skipped but **MUST** be reported as a count +
  list in the subagent summary (never silently dropped).
- `framework/commands/iterate.md` adds a low-impact auto-proceed path for
  balanced/auto (≤1 spec, minor bump, no new conflicts, no affected source);
  anything above that threshold still waits for human approval.
- `framework/agents/req-research.md` and `framework/agents/req-conflict-detector.md`
  return summaries now include an `autonomy_applied:` field and a
  `skipped-low-severity-conflicts:` field respectively.
- `req-init.sh` and `req-add-submodule.sh` write `autonomy_level: strict` into
  newly-generated `.req.config.yml` files.

## [2.1.0] — 2026-04-08

### Added
- **Subagents** for context-heavy commands. `framework/agents/req-research.md` and
  `framework/agents/req-conflict-detector.md` are now installed to `.claude/agents/`
  by `req-sync-commands.sh`. The matching slash commands `/req-research` and
  `/req-detect-conflicts` are now thin wrappers that delegate to the subagent so the
  main conversation context is no longer polluted by per-spec scan output.
- **Plan Mode integration for `/req-plan`.** After writing `plan.md` and `tasks.md`,
  `/req-plan` now calls `ExitPlanMode` to surface a native approval popup. The spec
  only transitions from `approved` to `in-progress` once the human accepts the plan,
  and `/req-implement` is blocked until that transition happens.
- **`.claude/settings.json` permissions template** (`framework/templates/settings.json`).
  Init and submodule installers now write a permissions-only settings file that denies
  edits to `${REQ_FRAMEWORK_ROOT}/**` and `.git/**` and whitelists writes under
  `${REQ_DATA_ROOT}` and `${REQ_CODE_ROOT}`. Existing `.claude/settings.json` files
  in the host repo are **never** overwritten — installers print a merge reminder.
- New AGENTS.md §5 human checkpoint: "Approving technical plans".

### Changed
- `framework/commands/research.md` and `framework/commands/detect-conflicts.md`
  rewritten as thin wrappers (delegation only).
- `framework/commands/plan.md` now calls `ExitPlanMode` and transitions spec status.
- `framework/commands/implement.md` now requires `spec.md` status to be exactly
  `in-progress` (not `approved`); refuses with a clear remediation message otherwise.
- `req-sync-commands.sh` now also syncs `framework/agents/*.md` to `.claude/agents/`.

## [2.0.0] — 2026-04-07

### Breaking
- **Repository restructured into `framework/` + `examples/` layout.** Slash command files
  moved from `.claude/commands/` to `framework/commands/`. Existing v1 installations
  (raw clone of repo root with `intake/`, `specs/` etc. at root) will not work after
  upgrading without re-installing via `req-init.sh` or `req-add-submodule.sh`.
- **Path variables introduced.** All command files now reference `${REQ_DATA_ROOT}`,
  `${REQ_CODE_ROOT}`, `${REQ_FRAMEWORK_ROOT}` instead of hardcoded `intake/`, `specs/`,
  `src/` etc. Variables are resolved at install time by `req-sync-commands.sh`.
- `scripts/validate-spec.sh` and `scripts/status-report.sh` now require
  `.req.config.yml` to be present in the host repo root or any ancestor directory.

### Added
- `framework/scripts/req-init.sh` — initialize a new req project (copy or submodule mode)
- `framework/scripts/req-add-submodule.sh` — install into an existing repo, zero-invasive
- `framework/scripts/req-sync-commands.sh` — regenerate `.claude/commands/req-*.md` after upgrades
- `framework/scripts/_lib.sh` — shared helpers (config loader, variable substitution)
- `.req.config.yml` schema (data_root / code_root / framework_root / last_synced_version)
- Major-version bump warning in `req-sync-commands.sh`
- `examples/personas/` — reference persona definitions (moved from `personas/examples/`)
- `MIGRATION.md` — manual migration guide for v1 → v2

### Changed
- Slash commands installed into host repos are prefixed `req-` (e.g. `/req-intake`)
  to prevent collision with the host's existing `.claude/commands/`.
- `framework/AGENTS.md` "File Naming Conventions" table now uses path variables.

### Removed
- Root-level `src/`, `tests/`, `infra/` placeholders (the framework no longer reserves
  business directories at the root of the upstream repo)

## [1.0.0] — earlier

- Initial flat-layout release with `intake/`, `specs/`, `personas/`, etc. at root.
