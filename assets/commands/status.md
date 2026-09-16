---
description: Show Evolver health — Proxy status, evolution memory, workspace id, and whether the full engine is installed.
---

Report Evolver health as a short checklist.

1. **Proxy** — call the `evolver_status` tool (registered by this plugin). If it returns
   status, show `node_id`, `outbound_pending`, `inbound_pending`, `last_sync_at`. If it
   errors, the Proxy is down — note that it starts when you run `evolver` once in a git
   repo, and that recall and turn-end capture keep working regardless.

2. **Evolution memory** — does the local graph exist, and how many outcomes?

```bash
F=~/.evolver/memory/evolution/memory_graph.jsonl
[ -f "$F" ] && echo "memory graph: $F ($(wc -l < "$F" | tr -d ' ') outcomes)" || echo "no local evolution memory yet (it appears after a turn ends with changes in a git repo)"
```

3. **This workspace's id** — the forge-resistant scoping key (only in a git repo):

```bash
R=$(git rev-parse --show-toplevel 2>/dev/null); [ -n "$R" ] && { [ -f "$R/.evolver/workspace-id" ] && echo "workspace-id: present" || echo "workspace-id: not yet created"; } || echo "not a git repo — memory inactive here"
```

4. **Full engine (optional)** — is the `@evomap/evolver` CLI installed?

```bash
command -v evolver >/dev/null 2>&1 && evolver --version 2>/dev/null | head -1 || echo "evolver CLI not installed — the plugin's memory and tools still work; 'npm i -g @evomap/evolver' unlocks /evolver-run"
```

Finish with one line on overall readiness.
