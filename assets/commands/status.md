---
description: Show Evolver health — Proxy, running engine version, recent strategy recalls and reuse reports, evolution memory, network claim, and full-engine availability.
---

Report Evolver health as a checklist grouped under the headings below. Use the available
filesystem and shell tools for the current platform; do not assume a POSIX shell. Never print
token values.

Call `evolver_status` once and use its fields throughout; it returns `proxy` (the Proxy's own
status, or `reachable: false` with the error) and the plugin's view (`plugin`, `runtime`,
`proxy_endpoint`, `engine`, `recall`, `reuse_reports`).

1. **Plugin and runtime** — plugin version, platform/arch, Node version.
2. **Proxy** — reachable or not. When reachable: `status`, `node_id`, `hub_mode`,
   `hub_auth_status` (flag anything but `ok`), `last_sync_at` as a local time, `last_sync_error`,
   pending inbound/outbound counts, and any `reauth_backoff_until` / `hello_rate_limit_until`
   in the future. When unreachable: show the error, the endpoint it tried (`proxy_endpoint.url`
   and `url_source`), and say that `evolver lifecycle start` starts the Proxy (the plugin also tries this once per dsh process);
   reuse reports wait and are resent once it is up.
3. **Engine version** — `engine.running_version` (the Proxy actually serving, with
   `proxy_endpoint.pid` and `started_at`) and `engine.path_version` (the `evolver` on PATH).
   If `meets_minimum` is false, say network strategy recall needs `minimum_version` or newer and
   give `npm install -g @evomap/evolver@latest`, then `evolver lifecycle restart`.
   If `path_differs_from_running` is true, say the running Proxy is a different install from the
   one on PATH and should be restarted from the upgraded one. If both versions are null, say the
   version could not be determined.
4. **Strategy recall** — enabled or not; settings (`wait_ms`, `timeout_ms`, `min_similarity`,
   `max_strategy_chars`); the last recall (`last.status`, `last.at`, `last.duration_ms`) and the
   per-status `counts` since dsh started. Explain the last status in one line:
   `injected` (name the title, steps and chars), `no_candidates` (the network had nothing for that
   prompt), `all_filtered` (list `dropped` reasons: `too_few_steps`, `too_long`, `low_similarity`,
   `already_injected`), `proxy_error` (show the error), `skipped` (prompt too short). If `last` is
   null, no prompt has been recalled in this dsh process yet.
5. **Network claim** — check `~/.evomap/claim_url`. If it contains an HTTPS `evomap.ai`
   link, report that the node is awaiting claim and show the link without modifying it.
6. **Reuse reports** — from `reuse_reports`, the recent `delivered` reports with the Hub's
   verdict (`eligible`, `counted`, `weight`, and `reason` when not eligible, e.g. `daily_cap`
   or `same_owner`) and every `rejected` one with its `reason` and `status`. A rejected
   report means the Hub refused it as invalid; show it as a problem worth reporting. Both
   lists are empty until a turn with an injected strategy ends in this dsh process.
7. **Evolution memory** — use an existing
   `<workspace>/memory/evolution/memory_graph.jsonl` when present; otherwise inspect
   `~/.evolver/memory/evolution/memory_graph.jsonl`. Report the selected path and count of
   non-empty JSONL rows without printing their contents.
8. **Full engine** — if `engine.path_version` is null, say that `npm install -g @evomap/evolver`
   enables `/evolver-run`, `/evolver-review`, and `/evolver-solidify`.

Finish with one line on overall readiness and the single most useful next action, if any.
