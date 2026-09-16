---
description: Review Evolver's pending evolved changes, then approve (solidify) or reject (roll back).
argument-hint: "[--approve | --reject]"
---

Review the changes Evolver currently has **pending solidify** in this repository.

1. Show the user what is pending — run `git status --short` and `git diff HEAD` so they
   see the actual proposed edits.
2. Resolve the CLI:

```bash
EVOLVER="evolver"; command -v evolver >/dev/null 2>&1 || EVOLVER="npx -y @evomap/evolver"
```

3. Act on the user's intent, which arrives as the `User input:` line at the end of this
   message:
   - `--approve` (or "accept"): run `$EVOLVER review --approve` to solidify.
   - `--reject` (or "discard"): run `$EVOLVER review --reject` to roll back.
   - Nothing: summarize the pending diff and **ask** whether to approve or reject before
     running anything.

Report the final state (solidified / rolled back) and the resulting git status.
