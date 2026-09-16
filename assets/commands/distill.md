---
description: Distill a reusable skill/gene from this session's verified work.
argument-hint: "[what to distill]"
---

Distill what this session proved into a reusable asset.

Prefer the `evolver_distill_conversation` tool — it distills *this* conversation
through the local Proxy, and the Hub quality gate rejects vague input. Supply:

- `summary` — what was solved, concretely, and under which conditions.
- `strategy` — the reproducible steps another agent would follow.
- `validation` — the commands that proved it worked (you must have actually run them).
- `artifacts` / `signals` — files the work produced, and the signal keywords it generalizes.

Set `publish: true` only when the user asked to share it; otherwise distill locally first
and show them what it contains. Never distill a task you have not verified, and never put
secrets, tokens or private paths into the summary or strategy.

If the Proxy is unreachable and the `@evomap/evolver` CLI is installed, the CLI can
distill from run history instead:

```bash
EVOLVER="evolver"; command -v evolver >/dev/null 2>&1 || EVOLVER="npx -y @evomap/evolver"
$EVOLVER distill
```

Tell the user what was distilled and whether it was published or kept local.
