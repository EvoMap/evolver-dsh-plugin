<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver for DeepSeek Harness</h1>

Give dsh agents a **persistent, auditable evolution memory** and a native bridge to the
**EvoMap network**. The plugin injects one reusable strategy behind each prompt it fits,
observes successful edits, records every turn result, and lets agents search, reuse,
report, distill, and publish evolution assets without an MCP hop.

Powered by the [Genome Evolution Protocol](https://evomap.ai) and
[`@evomap/evolver`](https://github.com/EvoMap/evolver).

> **Status:** pre-release `0.1.0`. Local memory, commands, Skill, and the current
> Proxy-backed asset loop are implemented. The npm package is published only when the
> first matching release tag is created.

## What it does

| Seam | dsh event | Behaviour |
| --- | --- | --- |
| Asset priming | `agent/pre-step`, once per turn | Searches the Proxy with that turn's own prompt — only the text the person typed — fetches the two leading matches that clear the similarity line and have a strategy, in one call, and injects the strategy of the first that actually came back. Ids the Hub declined to deliver are remembered for a day and skipped, so a slot is not spent twice on one. A lookup slower than the wait budget is injected into the next step instead of holding the current one. Assets already injected in this session are skipped. |
| Signal detection | successful `tools/result` for `write`, `edit`, or `str_replace_editor` | Tags the turn with improvement signals and injects one bounded notice per file/signal set. |
| Reuse feedback | `session/event` → `turn/end` | Reports each strategy injected during that turn to the Proxy with the turn's outcome, marked as automatic and unconfirmed. Injected asset ids are written to `~/.evolver/state/` as they are injected and read back at report time, so a report survives the process dying in between. Reports are keyed on the asset id alone. An asset the model reported itself with `evolver_asset_reuse_result` is left alone. |
| Verdict correction | `agent/pre-step` | When the prompt that opens a later turn in the same session plainly says the last answer did not hold, the verdicts already sent for that session are revised to `failed` — each asset at most once, since the Hub counts every report it receives. |
| Capture | `session/event` → `turn/end` | Collects staged, unstaged, and untracked work asynchronously; records the real turn outcome once; drains at `session/flush`. |
| Tools | `ctx.tools.register` | Connects directly to the local Evolver Proxy for status, search, fetch, reuse feedback, distillation, publication, and mailbox polling. |
| Skill | `ctx.skills.registerProvider` | Provides `capability-evolver`, the reuse → verify → record loop. |
| Commands | `ctx.commands.register` | Adds `/evolver-status`, `/evolver-search`, `/evolver-run`, `/evolver-evolve`, `/evolver-distill`, `/evolver-solidify`, `/evolver-review`, and `/evolver-sync`. |

Every session resolves its own `session.header.cwd`; a long-lived Web process can serve
multiple repositories without sharing their memory or diffs. Memory entries include the
workspace, session, turn, turn reason, and diff fingerprint.

## Install

Until the first npm release, install from a pinned repository commit:

```bash
dsh plugin --profile web add -w github:EvoMap/evolver-dsh-plugin#<sha40>
```

Or install from a local checkout:

```bash
dsh plugin --profile web add -w ./
```

After `@evomap/dsh-evolver@0.1.0` is published:

```bash
dsh plugin --profile web add -w @evomap/dsh-evolver
```

The package declares `dsh.bundle`, so dsh adds it to the selected profile without manual
`cordis.patch.yml` edits. Verify and boot the profile:

```bash
dsh --profile web --dump-config | grep -A2 'dsh-evolver'
dsh --profile web
```

## Connect the EvoMap network

Local memory works without an account or network connection. To enable network assets:

1. Install the engine: `npm install -g @evomap/evolver`.
2. Run `evolver` once inside a git repository. It starts the local Proxy and prints a
   claim link for a fresh node.
3. Open the claim link while signed in to [evomap.ai](https://evomap.ai). The `/evolver-status`
   command reports a pending link without adding it to the model context. Set
   `claimNudgeEnabled: true` only if periodic reminders are desired.
4. Run `/evolver-status` to confirm the Proxy and node state.

The Proxy is a separate loopback process. This plugin never spawns it and never sends its
bearer token to a non-loopback address.

## Native tools

| Tool | Purpose |
| --- | --- |
| `evolver_status` | Inspect Proxy and mailbox state. |
| `evolver_search_assets` | Search Genes, Capsules, Evolution Events, or AntiGenes by signals or text. |
| `evolver_fetch_asset` | Fetch reusable summary, strategy, validation, or content. |
| `evolver_asset_reuse_result` | Report the verified reuse outcome and credit the author. |
| `evolver_distill_conversation` | Persist a verified conversation lesson locally and optionally submit it. |
| `evolver_publish_asset` | Queue Genes or Capsules for Hub review. |
| `evolver_poll` | Read inbound mailbox messages without consuming them. |
| `evolver_ack` | Retire processed mailbox messages by id. |

The current local Proxy does not expose Recipe search or expression routes. Asset search
is therefore the supported fallback in this release; Recipe-first support belongs in a
future plugin release after those Proxy routes ship.

## Modes

### Local memory

The default mode needs only git. Outcomes go to an existing project-managed
`memory/evolution/memory_graph.jsonl`, otherwise to
`~/.evolver/memory/evolution/memory_graph.jsonl`. Unsafe project symlinks are rejected.

Per-workspace bookkeeping — the workspace id and the capture state — lives under
`~/.evolver/state/`, keyed by a hash of the workspace root. Nothing is written into your
repository, so there is no `.evolver/` directory to gitignore. A `workspace-id` left in a
repository by an earlier version is still honoured and copied forward on first use.

### Proxy-backed network

Running `evolver` starts the Proxy. The plugin reads its rotating loopback URL and token
from `~/.evolver/settings.json` on every request. If the Proxy is unavailable, native tools
return an actionable error while local memory continues working.

### Direct Hub outcome recording

Set all three values to additionally post turn outcomes to the Hub:

```bash
export EVOMAP_HUB_URL="https://evomap.ai"
export EVOMAP_API_KEY="…"
export EVOMAP_NODE_ID="…"
```

Remote Hub recording requires HTTPS. Loopback HTTP remains available for local testing.
Local memory is written before the network attempt.

## Configuration

The plugin exports a validated Schemastery `Config`; invalid values fail at load time.

| Field | Default | Meaning |
| --- | --- | --- |
| `projectDir` | session cwd, then `$DSH_PROJECT_DIR`, then process cwd | Explicitly override workspace resolution for every session. |
| `proxyPort` | `$EVOMAP_PROXY_PORT`, then `19820` | Loopback Proxy fallback port. |
| `editToolNames` | `['write', 'edit', 'str_replace_editor']` | Successful edit tools scanned for signals. |
| `gitTimeoutMs` | `5000` | Deadline for each asynchronous git command. |
| `gitMaxBufferBytes` | `10485760` | Maximum stdout retained from one git command. |
| `proxyTimeoutMs` | `8000` | Native Proxy tool deadline. |
| `hubTimeoutMs` | `8000` | Direct outcome-recording deadline. |
| `assetPrimeEnabled` | `true` | Look one reusable strategy up per turn and inject it behind that turn's prompt. |
| `assetPrimeMinSimilarity` | `0.3` | Lowest search similarity worth injecting; among the hits that clear it, the highest-scoring one is used. The score swings with phrasing, so the floor is low: measured on a live Hub, one React question scored 0.88 and 0.40 depending on wording, while boilerplate and off-topic hits sat at 0.19–0.22. A Proxy that reports no score is not filtered. |
| `assetPrimeWaitMs` | `6000` | How long a step may wait for that lookup, so a strategy lands behind the prompt it was selected for rather than after the model has already chosen what to do. The budget has to cover two serial Proxy round trips: measured against a live Hub over six prompts, the lookup took 4.8s–9.4s with a 5.1s median, so `4000` never once won and `6000` clears the median and most of the spread. Past it the step proceeds and the strategy, when it lands, is injected into the next step. |
| `assetPrimeTimeoutMs` | `8000` | Deadline for each Proxy call in that lookup. A cold search plus fetch runs into seconds, so this is generous; `assetPrimeWaitMs` is what protects the response. |
| `claimNudgeEnabled` | `false` | Inject a trusted pending claim link behind the first prompt. `/evolver-status` remains available when off. |
| `claimNudgeTtlMs` | `43200000` | Minimum interval between enabled pending-claim notices. |
| `captureDedupeTtlMs` | `86400000` | Durable duplicate-capture suppression window. |
| `captureLockStaleMs` | `60000` | Age after which a crash-left capture lock may be recovered. |
| `captureLockWaitMs` | `65000` | Maximum lock wait; must be greater than `captureLockStaleMs`. |
| `untrackedHashMaxBytes` | `1048576` | Maximum sampled bytes used to fingerprint one untracked file. |

Environment overrides: `MEMORY_GRAPH_PATH`, `EVOLVER_WORKSPACE_ID`,
`EVOLVER_HOOK_LOG_DIR`, `EVOLVER_SESSION_STATE_DIR`, `EVOMAP_PROXY_PORT`,
`EVOMAP_HUB_URL` / `A2A_HUB_URL`, `EVOMAP_API_KEY` / `A2A_NODE_SECRET`, and
`EVOMAP_NODE_ID` / `A2A_NODE_ID`.

## Requirements

- Node.js 22.13 or newer.
- Git for turn capture.
- dsh `0.1.5-rc.2` or `0.1.6-alpha.1`.
- Optional network tools: a local Proxy from `@evomap/evolver`.

In a non-git directory the plugin emits one notice per directory, does not create workspace
state, and records nothing. Network strategies are still injected there — they do not
depend on git.

## Development

```bash
npm ci
npm test
npm pack --dry-run
```

CI validates Node 22 and 24 plus the declared DSH compatibility lines. The release workflow
publishes only a tag whose version matches `package.json`; this task does not create that tag.

## License

MIT © EvoMap.
