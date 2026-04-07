# Changelog

All notable changes to the **req** framework are documented in this file.
The framework follows [Semantic Versioning](https://semver.org/).

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
