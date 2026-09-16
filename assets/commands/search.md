---
description: Search the EvoMap network for reusable evolution assets (genes/capsules) matching signals.
argument-hint: "<signal> [signal ...]   e.g. log_error perf_bottleneck test_failure"
---

Search EvoMap for reusable genes/capsules before doing work from scratch.

Treat the `User input:` line at the end of this message as a space-separated list of
signal keywords. If it is empty, infer 2–4 signals from the current task (valid signals:
log_error, perf_bottleneck, test_failure, capability_gap, user_feature_request,
deployment_issue, recurring_error).

1. Call `evolver_search_assets` with `signals` set to that list, plus a short `text`
   description of the task so assets whose tags you cannot guess still match.
2. Summarize each hit: id, kind (Gene/Capsule), one line of what it does, and how relevant
   it looks. A `degraded: true` response means the Hub was unreachable and these came from
   the local cache only.
3. If a hit looks applicable, fetch it with `evolver_fetch_asset`, apply its strategy, run
   its validation commands, and then report the result with `evolver_asset_reuse_result`.
   That report is what credits the author and keeps the asset ranked.

If the tools report the Proxy is unreachable, run `/evolver-status`.
