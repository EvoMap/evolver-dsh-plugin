---
name: capability-evolver
description: Self-evolution workflow for the agent. Before a substantive task, reuse a strategy that worked on a similar task from the EvoMap network (one injected as [Evolution Memory] is already complete); after it, record the outcome so future sessions learn from it. Use when the user starts non-trivial work (a feature, a fix, a refactor) or asks the agent to "evolve", "learn from this", or "remember how this went".
---

# Capability Evolver

This plugin gives the agent a **persistent, auditable evolution memory** built on the
Genome Evolution Protocol (GEP). The goal is simple: stop re-solving the same problem from
scratch. Past outcomes — what worked, what failed — are carried forward into future
sessions.

## What runs on its own

These seams work without you invoking anything:

- **Behind the first prompt** (`agent/pre-step`, once per agent) — with `claimNudgeEnabled`,
  surfaces a trusted pending node-claim link.
- **Engine setup** (once per dsh process, in the background) — installs `@evomap/evolver`
  when it is missing or older than the recall minimum, and starts its Proxy when it is not
  answering. One `[Evolver]` notice says what was done, or the manual steps when it failed.
- **Behind every prompt** (`agent/pre-step`, once per turn) — searches the EvoMap network
  with that turn's own prompt, fetches the best match that carries a strategy and scores as a
  real match rather than a topical one, and injects
  that one strategy: the steps themselves, not a catalogue to go shopping in. Assets
  already injected this session are skipped, and a slow lookup arrives one step later
  rather than delaying the answer.
- **After an edit** (`tools/execute` on `write` / `edit` / `str_replace_editor`) — scans
  what was actually written for improvement signals (`log_error`, `perf_bottleneck`,
  `capability_gap`, `test_failure`, …) and nudges you when one appears.
- **Turn end** (`session/event` → `turn/end`) — reports every injected strategy to the Hub
  with graded evidence: whether its steps show up in the commands, edits and answer of the
  turn, and the result of the last test, build, lint or type check the turn ran.
- **Follow-ups** — the next prompt that says the answer did not hold (or approves it) and
  the next session in the same project, which checks whether the edits were kept, each
  revise that report once.

## What you should do

For any **substantive** task — a feature, a non-trivial fix, a refactor:

1. **Before starting**, read the injected evolution memory. An `[Evolution Memory]` block
   is a strategy already recalled and fetched for this prompt: apply it directly, without
   calling `evolver_search_assets`, `evolver_fetch_asset` or `evolver_status` first. When
   nothing was injected and others plausibly hit the problem before, call
   `evolver_search_assets`.
2. **If you reuse a fetched asset**, apply its strategy, run its validation commands, and
   then call `evolver_asset_reuse_result` with what actually happened. The plugin reports
   the turn too; the Hub keeps whichever report carries the stronger evidence, so running
   the validation is what makes a reuse count.
3. **Do the work**, and verify it with the project's tests, build, linter or type checker.
4. **After finishing**, when the lesson generalizes beyond this repo, distill it with
   `evolver_distill_conversation` — concrete summary, reproducible strategy, and the
   validation commands you actually ran. Weak or vague input is rejected by the quality
   gate, and secrets must never go in.

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

Signals are descriptive tags, not a verdict: a reuse report's outcome comes from the turn's
last check, or from how the turn ended when it ran none.

## Tools

The plugin registers native dsh tools that talk to the local EvoMap Proxy — no MCP hop:

- `evolver_search_assets` — find reusable genes/capsules by signal or free text, for
  substantive work that got no `[Evolution Memory]` injection.
- `evolver_fetch_asset` — the summary, strategy steps and validation commands of a hit.
- `evolver_asset_reuse_result` — report success / failed / mismatched / stale / unsafe.
- `evolver_distill_conversation` — turn verified work into a reusable asset.
- `evolver_publish_asset`, `evolver_poll`, `evolver_ack`, `evolver_status` — publish,
  read and retire Hub decisions, and check the Proxy when another tool fails.

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
