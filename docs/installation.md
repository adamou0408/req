# Installation Guide

The **req** framework supports two installation modes from the same upstream repo:

| Mode | Use when | Result |
|---|---|---|
| **Init** | You want a brand-new requirement-driven project from scratch | Self-contained project with `intake/`, `specs/`, `src/`, `tests/` at the root |
| **Submodule** | You want to add req to an existing codebase without disturbing it | Framework lives in `.req-framework/`, business data in `.req/`, generated code goes into your existing `src/` and `tests/` |

Both modes share the same upgrade path.

---

## Init mode — new project

Use this when you're starting from nothing and want a fresh requirement project.

### Option A — copy mode (no git submodule)

```bash
mkdir my-new-req-project && cd my-new-req-project
git clone https://github.com/adamou0408/req /tmp/req-src
bash /tmp/req-src/framework/scripts/req-init.sh --mode=copy
git init && git add -A && git commit -m "chore: bootstrap req project"
```

You'll get this layout:
```
my-new-req-project/
├── .req.config.yml          ← data_root=. code_root=. framework_root=.req-framework
├── .req-framework/          ← copy of framework + VERSION + CHANGELOG + MIGRATION
├── .claude/commands/req-*.md ← auto-generated slash commands
├── intake/raw/
├── specs/
├── personas/
├── conflicts/
├── reviews/
├── docs/changelog.md
├── src/
└── tests/
```

### Option B — submodule mode (recommended for upgradability)

```bash
mkdir my-new-req-project && cd my-new-req-project
git init
git submodule add https://github.com/adamou0408/req .req-framework
bash .req-framework/framework/scripts/req-init.sh --mode=submodule
git add -A && git commit -m "chore: bootstrap req project"
```

Same layout, but `.req-framework/` is a git submodule pinned to a specific commit, so
you can `git submodule update --remote .req-framework` later to upgrade.

---

## Submodule mode — existing repo (zero-invasive)

Use this when you have an existing application and want to add req on top without
changing your existing `src/`, `tests/`, `README.md`, or CI.

```bash
cd /path/to/your-existing-repo
git submodule add https://github.com/adamou0408/req .req-framework
bash .req-framework/framework/scripts/req-add-submodule.sh
# answer the prompts:
#   data_root: .req       (default — req's business data lives here)
#   code_root: .          (default — generated code goes into your real ./src/, ./tests/)
git add .req.config.yml .req .claude/commands/req-*.md
git commit -m "chore: install req framework"
```

What was added:
- `.req.config.yml`
- `.req/` (business data: intake, specs, personas, conflicts, reviews, docs)
- `.claude/commands/req-*.md` (11 auto-generated slash commands, prefixed `req-`)

What was **not** touched:
- Your existing `src/`, `tests/`, `README.md`, `.gitignore`, CI workflows
- Your existing `.claude/commands/*.md` (if any) — only `req-*.md` files are created/replaced

---

## Upgrade

Whenever upstream releases a new version (e.g. v2.0.0):

### Tag mode (recommended for stability)

```bash
cd .req-framework
git fetch --tags
git checkout v2.0.0
cd ..
bash .req-framework/framework/scripts/req-sync-commands.sh
git add .req-framework .claude/commands/req-*.md .req.config.yml
git commit -m "chore: bump req framework to v2.0.0"
```

### Rolling mode (track main)

```bash
git submodule update --remote .req-framework
bash .req-framework/framework/scripts/req-sync-commands.sh
git add .req-framework .claude/commands/req-*.md .req.config.yml
git commit -m "chore: bump req framework"
```

### Major version warning

`req-sync-commands.sh` compares the new VERSION against `last_synced_version` in
`.req.config.yml`. If the major version changed (e.g. 1.x → 2.x), it prints a
warning pointing at `MIGRATION.md`. Read the migration guide before continuing.

---

## Local customizations (don't lose them on upgrade)

The framework's commands are auto-regenerated on every sync, so **never edit
`.claude/commands/req-*.md` directly** — they have a `<!-- AUTO-GENERATED -->` header
and your edits will be overwritten.

If you need to add team-specific commands or override behavior:
- Add new files to `.claude/commands/` with a different prefix (e.g. `req-local-*.md`).
  These are not touched by `req-sync-commands.sh`.
- For deeper customization, fork `adamou0408/req`, edit `framework/commands/*.md` in
  your fork, point your submodule at the fork, and re-sync.

---

## Uninstall

```bash
rm -rf .req-framework .req .req.config.yml
rm .claude/commands/req-*.md
git submodule deinit .req-framework 2>/dev/null
git rm -r .req-framework 2>/dev/null
```

Your host repo returns to exactly its pre-install state.
