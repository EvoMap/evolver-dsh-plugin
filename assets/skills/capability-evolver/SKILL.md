---
name: capability-evolver
description: Self-evolution workflow for the agent. Before a substantive task, recall what worked on similar past tasks from evolution memory; after it, record the outcome so future sessions learn from it. Use when the user starts non-trivial work (a feature, a fix, a refactor) or asks the agent to "evolve", "learn from this", or "remember how this went".
---

# Capability Evolver

This plugin gives the agent a **persistent, auditable evolution memory** built on the
Genome Evolution Protocol (GEP). The goal is simple: stop re-solving the same problem from
scratch. Past outcomes — what worked, what failed — are carried forward into future
sessions.

## What runs on its own

Three seams work without you invoking anything:

- **Behind the first prompt** (`agent/pre-step`, once per agent) — injects, directly after
  the message that opened the work, up to 3 recent successes and failures for *this
  session's git workspace*. With `claimNudgeEnabled`, a trusted pending node-claim link is
  surfaced here too.
- **Behind every prompt** (`agent/pre-step`, once per turn) — searches the EvoMap network
  with that turn's own prompt, fetches the best match that carries a strategy, and injects
  that one strategy: the steps themselves, not a catalogue to go shopping in. Assets
  already injected this session are skipped, and a slow lookup arrives one step later
  rather than delaying the answer. Report what the reuse produced with
  `evolver_asset_reuse_result`.
- **After an edit** (`tools/result` on `write` / `edit` / `str_replace_editor`) — scans
  what was actually written for improvement signals (`log_error`, `perf_bottleneck`,
  `capability_gap`, `test_failure`, …) and nudges you when one appears.
- **Turn end** (`session/event` → `turn/end`) — collects staged, unstaged and
  untracked work, classifies the outcome from how the turn ended, and appends it to the
  memory graph with session/workspace provenance. Failed turns are retained; a completed
  turn with no new work records nothing, and unchanged work is not recorded twice.

Memory lands in `~/.evolver/memory/evolution/memory_graph.jsonl`, or in the project's
`memory/evolution/` inside an evolver-managed repository.

## What you should do

For any **substantive** task — a feature, a non-trivial fix, a refactor:

1. **Before starting**, read the injected evolution memory. If a recent success matches,
   reuse that approach; if a recent failure matches, avoid repeating it. For anything that
   others plausibly hit before, also call `evolver_search_assets`.
2. **If you reuse a fetched asset**, apply its strategy, run its validation commands, and
   then call `evolver_asset_reuse_result` with what actually happened. That report is the
   only thing that credits the author and keeps good assets ranked.
3. **Do the work**, and verify it.
4. **After finishing**, the turn-end seam records the local outcome for you. When the
   lesson generalizes beyond this repo, distill it with `evolver_distill_conversation` —
   concrete summary, reproducible strategy, and the validation commands you actually ran.
   Weak or vague input is rejected by the quality gate, and secrets must never go in.

Trivial or purely conversational turns don't need any of this — skip it.

## Signals

| Signal | Fires on |
|---|---|
| `log_error` | errors, exceptions, failures described in the change |
| `perf_bottleneck` | timeout / slow / latency / OOM |
| `capability_gap` | "not supported" / "not implemented" |
| `user_feature_request` | adding a feature / new module |
| `test_failure` | reported failing tests or assertions |
| `deployment_issue` | build / CI / pipeline / rollback |
| `recurring_error` | "same error" / "still failing" / "keeps failing" |

Signals are descriptive tags, not a verdict: whether a turn is recorded as a success or a
failure comes from how the turn itself ended.

## Tools

The plugin registers native dsh tools that talk to the local EvoMap Proxy — no MCP hop:

- `evolver_search_assets` — find reusable genes/capsules by signal or free text. **Call
  this before substantive work.**
- `evolver_fetch_asset` — the summary, strategy steps and validation commands of a hit.
- `evolver_asset_reuse_result` — report success / failed / mismatched / stale / unsafe.
- `evolver_distill_conversation` — turn verified work into a reusable asset.
- `evolver_publish_asset`, `evolver_poll`, `evolver_ack`, `evolver_status` — publish,
  read and retire Hub decisions, and check the Proxy.

They degrade gracefully when the Proxy isn't running: the memory seams keep working.
The current Proxy does not expose Recipe search/expression routes, so asset search is the
supported fallback until that upstream capability ships.

## Full pipeline (optional)

The **full evolution engine** — automated log analysis and the review-and-solidify cycle
that proposes and applies code improvements — is a separate CLI:

```bash
npm install -g @evomap/evolver
```

It also provides the Proxy the tools above talk to. The `/evolver-run`, `/evolver-review`
and `/evolver-solidify` commands drive it; this plugin never invokes it on its own.
