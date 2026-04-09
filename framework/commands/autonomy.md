# /autonomy - Switch Human-Checkpoint Autonomy Level

## Description
View or change how many human checkpoints the framework enforces.

## Usage
```
/autonomy              # show current level + checkpoint matrix
/autonomy strict       # L1: all 7 checkpoints human-enforced (default)
/autonomy balanced     # L2: 5 hard + 2 AI-recommended
/autonomy auto         # L3: 5 hard + expanded AI discretion
```

## Behavior

**This command is fully handled by `req autonomy`.** Do NOT improvise — delegate to the CLI.

### No argument:
Run `req autonomy current` and print the output (markdown table).

### With argument:
Run `req autonomy set <level>` and print the output.
If the CLI exits non-zero, print its stderr message and stop.

### Interactive fallback:
If no argument and the user seems to be exploring, run `req ask autonomy.level_picker` and pipe the selection to `req autonomy set`.

## Constraints
- **MUST** delegate all logic to `req autonomy`. Do NOT read `.req.config.yml` or `docs/changelog.md` directly.
- **MUST** print whatever the CLI returns — do not rephrase or summarize.
- The canonical checkpoint matrix lives in `framework/config/autonomy-matrix.yaml`. AGENTS.md §5b describes the semantics.
