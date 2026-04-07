# Examples

This directory contains **reference content** showing what a real req-driven project
looks like. It is not part of the framework core and is not copied into your project
by `req-init.sh` or `req-add-submodule.sh`.

## What's here

- `personas/` — example persona definitions (admin, end-user, manager, customer-service).
  Use these as inspiration when defining your own personas during `/req-translate`.

## Why it's separate from `framework/`

The framework core (`framework/`) is the **stable API** that downstream projects depend
on via submodule. Everything in `framework/` is loaded at runtime by slash commands and
scripts. If we shipped example personas as part of `framework/`, every project would
inherit them — and any update to the examples would force-trigger a sync.

By contrast, `examples/` is reference-only. Read it, copy bits you like, but don't expect
anything in here to be visible from inside your initialized project.

## Want a guided walkthrough?

See [`docs/example-walkthrough.md`](../docs/example-walkthrough.md) for a full intake →
spec → plan → implement story.
