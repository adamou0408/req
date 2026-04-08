# Changelog

All notable changes to the **req** framework are documented in this file.
The framework follows [Semantic Versioning](https://semver.org/).

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
