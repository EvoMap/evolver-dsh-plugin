---
description: Sync evolution assets (genes/capsules) between the local store and the EvoMap Hub.
argument-hint: "[--scope=all|purchased|published] [--type=Gene|Capsule] [--export=<path.gepx>] [--dry-run]"
---

Sync Evolver assets with the EvoMap Hub, passing through the flags from the `User input:`
line at the end of this message.

```bash
EVOLVER="evolver"; command -v evolver >/dev/null 2>&1 || EVOLVER="npx -y @evomap/evolver"
$EVOLVER sync
```

Afterwards, summarize: how many assets were pulled or updated, any local-only
(unpublished) assets it listed, and — if `--export` was given — where the `.gepx` archive
was written.

If it reports the node identity or Hub credentials are missing, point the user to
`/evolver-status` and the README's *EvoMap Hub* section.
