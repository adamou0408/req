# Migration Guide

## v1 → v2

v2 restructures the upstream `adamou0408/req` repo into `framework/` (core) +
`examples/` (reference) and introduces install-time path variables. Existing v1
installations (where the entire repo was cloned/copied as the working directory) need
to migrate.

### If you cloned v1 directly as your working project

You have `intake/`, `specs/`, `personas/`, etc. at the root of your project, mixed
with the framework's own `.claude/commands/`, `AGENTS.md`, `CONSTITUTION.md`, `scripts/`.

**Migrate to v2:**

1. **Back up your work**
   ```bash
   git switch -c backup/pre-v2
   git push -u origin backup/pre-v2
   git switch main
   ```

2. **Pull the v2 framework as a submodule into a new location**
   ```bash
   git submodule add https://github.com/adamou0408/req .req-framework
   cd .req-framework && git checkout v2.0.0 && cd ..
   ```

3. **Bootstrap the new layout in place** — your existing `intake/`, `specs/`, etc.
   stay where they are at root. Tell req that `data_root: .`:
   ```bash
   cat > .req.config.yml <<'EOF'
   data_root: .
   code_root: .
   framework_root: .req-framework
   last_synced_version: 2.0.0
   EOF
   ```

4. **Remove the old framework files** that are now provided by the submodule:
   ```bash
   git rm -r .claude/commands AGENTS.md CONSTITUTION.md config scripts
   ```

5. **Regenerate the slash commands** from the new framework:
   ```bash
   bash .req-framework/framework/scripts/req-sync-commands.sh
   ```
   This produces `.claude/commands/req-*.md` (note the `req-` prefix — the v1
   commands were `/intake`, `/translate`, etc.; v2 commands are `/req-intake`,
   `/req-translate`, etc., to avoid colliding with other host commands).

6. **Update your muscle memory:** `/intake` → `/req-intake`, `/plan` → `/req-plan`,
   and so on for all 11 commands.

7. **Commit:**
   ```bash
   git add .req-framework .req.config.yml .claude/commands/req-*.md
   git commit -m "chore: migrate to req v2"
   ```

### If you installed v1 into an existing repo by copying files

Same as above, but in step 4 only remove the framework files you copied; leave your
host repo's own files alone.

### Behavioral changes you should know about

- **AI agents now read paths via variables.** Internal references in commands are
  resolved at sync time. If you fork commands to customize them, edit the originals
  in `.req-framework/framework/commands/` (or your fork) and re-run
  `req-sync-commands.sh`. Editing `.claude/commands/req-*.md` directly will be
  overwritten on the next sync.

- **`scripts/validate-spec.sh` argument changed.** v1: `./scripts/validate-spec.sh
  specs/user-search`. v2: `bash .req-framework/framework/scripts/validate-spec.sh
  user-search` (just the slug, resolved via `data_root`).

- **No `src/`, `tests/`, `infra/` at the upstream repo root.** If you were relying
  on these as starter directories, they are now created for you by `req-init.sh` in
  init mode, or live at your host repo root in submodule mode.
