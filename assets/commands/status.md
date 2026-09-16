---
description: Show Evolver health — Proxy status, evolution memory, workspace id, network claim, and full-engine availability.
---

Report Evolver health as a short checklist. Use the available filesystem and shell tools for
the current platform; do not assume a POSIX shell.

1. **Proxy** — call `evolver_status`. Show its node id, pending counts, and last sync. If
   unreachable, say that running `evolver` once in a git repository starts the Proxy; local
   recall and capture remain available.
2. **Network claim** — check `~/.evomap/claim_url`. If it contains an HTTPS `evomap.ai`
   link, report that the node is awaiting claim and show the link without modifying it.
3. **Evolution memory** — use an existing
   `<workspace>/memory/evolution/memory_graph.jsonl` when present; otherwise inspect
   `~/.evolver/memory/evolution/memory_graph.jsonl`. Report the selected path and count of
   non-empty JSONL rows without printing their contents.
4. **Workspace id** — find the git root. If it contains a `workspace/` directory, inspect
   `workspace/.evolver/workspace-id`; otherwise inspect `.evolver/workspace-id` at the git
   root. Report only present/missing, never the id value.
5. **Full engine** — check whether `evolver` is installed and report its version. If absent,
   say that `npm install -g @evomap/evolver` enables `/evolver-run`, `/evolver-review`, and
   `/evolver-solidify`.

Finish with one line on overall readiness and the single next action, if any.
