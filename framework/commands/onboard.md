# /onboard - Reverse Onboarding for Existing Repos

## Description
Scan the host repository and seed `${REQ_DATA_ROOT}/` with personas, a feature inventory, and project context so subsequent `/req-*` commands have a baseline to work from. This is a **thin wrapper** that delegates the heavy scanning to the `req-onboarder` subagent.

Run this **once** after installing the framework into an existing repo (`req-add-submodule.sh`). Init-mode projects usually have nothing to scan and can skip it. Onboarding is a one-time bootstrap; it is **not** a checkpoint in AGENTS.md §5 and does not consume any autonomy-level budget.

## Usage
```
/onboard                       # no arg → AskUserQuestion popup (preview the 3 depths)
/onboard shallow               # README + manifests only → 1 file
/onboard medium                # default — + src tree + entry points + CI → personas + feature inventory
/onboard deep                  # + legacy reverse-specs + project-specific CONSTITUTION overlay
```

## Behavior

1. **Validate argument** against `shallow|balanced|medium|deep` (the canonical values are `shallow`, `medium`, `deep`). On invalid input, print the three valid values and abort.
2. **No-argument path**: call `AskUserQuestion` with three options (Shallow / Medium / Deep). Each option's `preview` field **MUST** contain the scan scope and the exact file list that will be produced, so the user can judge before committing. On selection, fall through to the delegate step.
3. **Delegate to the `req-onboarder` subagent** via the Agent tool. Pass:
   - The chosen depth
   - The host root (the directory containing `.req.config.yml`)
   - A note that this may be a re-run (subagent will self-detect by checking existing files)
4. Wait for the subagent's structured summary (≤40 lines) and **surface it verbatim** to the user. Do not re-summarize or expand it.
5. If the summary reports `merged with existing: yes`, emphasize to the user that the run was a merge (some files may have been preserved if marked `source: human`).
6. Recommend `/req-intake` as the next step, regardless of depth.

## Constraints
- **MUST** delegate the scan to `req-onboarder`; do not perform source-tree scanning inline in the main conversation
- **MUST** preserve the subagent's structured summary verbatim
- **MUST NOT** run `/req-intake` or any other `/req-*` command automatically after onboarding — always let the user decide
- **MUST NOT** treat `/req-onboard` as a checkpoint; it never blocks any other command
- **MUST** validate the depth argument before delegating
