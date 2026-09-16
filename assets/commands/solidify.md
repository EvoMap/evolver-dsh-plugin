---
description: Solidify the current working changes into a durable Evolver gene/capsule (with rollback safety).
argument-hint: "[--dry-run] [--intent=repair|optimize|innovate] [--summary=\"...\"]"
---

Solidify the current working-tree changes into a durable Evolver asset.

1. Ensure we're in a git repo and show `git diff --stat` so the user sees what will be
   captured.
2. Resolve the CLI and run solidify with the flags from the `User input:` line at the end
   of this message, verbatim:

```bash
EVOLVER="evolver"; command -v evolver >/dev/null 2>&1 || EVOLVER="npx -y @evomap/evolver"
$EVOLVER solidify
```

3. If the user did not provide `--summary`, infer a concise one-line summary from the diff
   and pass it as `--summary="..."`.
4. Report the gene/capsule that was created or updated, and whether a rollback point was
   recorded.

Tip: pass `--dry-run` first to preview without writing.
