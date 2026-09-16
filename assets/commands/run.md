---
description: Run one Evolver self-evolution cycle on the current repo (collect signals → select/mutate genes → propose changes).
argument-hint: "[--loop] [--dry-run] [--strategy=balanced|innovate|harden|repair-only]"
---

Run an Evolver evolution cycle in the **current git repository**.

The user's flags, if they gave any, arrive as the `User input:` line at the end of
this message. Pass them through verbatim — never drop a protective flag such as
`--dry-run`, and never invent flags the user did not type.

1. Confirm we're in a git repo (`git rev-parse --is-inside-work-tree`). If not, tell the
   user Evolver requires git and stop.
2. Resolve the CLI and run it with those flags:

```bash
EVOLVER="evolver"; command -v evolver >/dev/null 2>&1 || EVOLVER="npx -y @evomap/evolver"
EVOLVE_STRATEGY="${EVOLVE_STRATEGY:-balanced}" $EVOLVER run
```

3. Summarize what changed: which signals were collected, which gene was selected or
   mutated, and whether any changes are now **pending solidify**. If changes are pending,
   remind the user they can inspect and accept them with `/evolver-review` (or roll back
   with `/evolver-review --reject`).

Do not auto-approve pending changes — leave that to the user via `/evolver-review`.
