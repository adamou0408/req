---
source: auto-generated
generated_by: req-onboarder
generated_at: {{DATE}}
---

# Existing Features Inventory

> This file lists features that already exist in the host repository at the time `/req-onboard` was run. `/req-research` reads it as a second deduplication baseline (in addition to `specs/`), so new intake items that overlap with existing code can be flagged before a new spec is written.
>
> **Do not edit entries in-place**. If a feature is added to the host code, re-run `/req-onboard` to refresh. The re-run will append new entries under a dated `## Added on ...` subheading; it will never delete or rewrite the originals.

## Features

### {{FEATURE_SLUG}}

- **Summary**: {{ONE_LINE_SUMMARY}}
- **Implementation**: {{SRC_PATH_OR_ENTRY_POINT}}
- **Likely personas**: {{PERSONA_SLUGS}}
- **Evidence**: {{WHERE_DETECTED}}

<!--
Repeat the block above for each detected feature. Keep slugs kebab-case and
STABLE across re-runs so the dedup-check can rely on them.
-->

---

## Added on {{DATE}}

<!--
Re-runs of /req-onboard append new features here instead of rewriting the
list above. This preserves history and avoids churning git diffs.
-->
