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
├── .claude/agents/req-*.md   ← auto-generated subagents (research / conflict-detector)
├── .claude/settings.json    ← permissions whitelist (only created if absent)
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
- `.claude/agents/req-*.md` (auto-generated subagents — `req-research`, `req-conflict-detector`)
- `.claude/settings.json` (permissions whitelist, **only if you didn't already have one** — see note below)

What was **not** touched:
- Your existing `src/`, `tests/`, `README.md`, `.gitignore`, CI workflows
- Your existing `.claude/commands/*.md` (if any) — only `req-*.md` files are created/replaced
- Your existing `.claude/agents/*.md` (if any) — only `req-*.md` files are created/replaced
- Your existing `.claude/settings.json` (if any) — the framework will **never** overwrite it; if you want the framework's deny/allow rules, manually merge from `.req-framework/framework/templates/settings.json`

---

## Post-install onboarding (submodule mode)

When you install the framework into an **existing** repo, `.req/personas/` starts empty and `.req/specs/` knows nothing about the features already implemented in your codebase. Running `/req-onboard` once, immediately after install, lets the framework scan the host repo and seed baseline artifacts so subsequent `/req-*` commands have context to work from.

```bash
/req-onboard                  # no arg → popup picker showing the 3 depths
/req-onboard shallow          # README + manifests → 1 file
/req-onboard medium           # default — + src tree + entry points + CI → personas + feature inventory
/req-onboard deep             # + legacy reverse-specs + project-specific CONSTITUTION overlay
```

| Depth | What it scans | What it writes | When to use |
|---|---|---|---|
| `shallow` | `README.md`, package manifest(s) | `.req/docs/project-context.md` | Small repos, quick smoke test |
| `medium` (default) | + `src/` tree + entry points + CI config | + `.req/personas/*.md` (3–5 auto-detected) + `.req/docs/existing-features.md` | Most existing repos — best cost/value |
| `deep` | + every main feature | + `.req/specs/legacy-*/spec.md` + `.req/CONSTITUTION.md` | Large legacy repos where you want the framework to fully understand the code |

**Safe to re-run.** Re-running `/req-onboard` later will merge new findings into existing files instead of overwriting them. Any persona you manually edit should have its frontmatter changed from `source: auto-generated` to `source: human` — the onboarder will then skip it on future runs.

Onboarding is **not** a checkpoint — it never blocks any other `/req-*` command, and its artifacts are optional. A project that never runs `/req-onboard` behaves exactly like v2.2.0. Init-mode projects usually have nothing to scan and can skip this step.

---

## Autonomy levels

Since v2.2.0 you can dial how many human checkpoints the framework enforces via `/req-autonomy`. Three levels are provided (the supervised model):

| Level | Who decides | When to use |
|---|---|---|
| `strict` (default) | 7/7 checkpoints require a human | Team projects, regulated domains, anything touching real customers |
| `balanced` | 5/7 require a human (duplicate handling and low-impact iterations auto-proceed on AI recommendation) | Small team MVPs, internal tools |
| `auto` | 5/7 require a human, plus expanded AI discretion on grey-area items (partial overlaps, low-severity conflicts) | Solo projects, prototypes, spike work |

The **five HARD checkpoints** that every level enforces: conflict resolution, spec approval, plan approval (ExitPlanMode), 3-strike test failure intervention, production deploy. See [framework/AGENTS.md §5](../framework/AGENTS.md) for the full matrix.

Switch the level at any time:
```bash
/req-autonomy                  # view current level + matrix
/req-autonomy balanced         # switch to L2
/req-autonomy auto             # switch to L3 (prints warning)
```

The level is persisted as `autonomy_level:` in `.req.config.yml` so it's shared via git across your team. Every switch is logged to `docs/changelog.md` for auditability. Existing v2.1.0 configs without the field default to `strict` — no migration needed.

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
