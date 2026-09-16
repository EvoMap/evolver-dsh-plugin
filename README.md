# Evolver for DeepSeek Harness

A native [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent a
persistent, auditable **evolution memory**, plus the EvoMap network's genes and capsules as
first-class dsh tools.

## What it does

| Seam | dsh hook | Behaviour |
| --- | --- | --- |
| Recall | `agent/session-start` → `agent.inject(form: 'recall')` | Injects up to 3 recent, workspace-scoped successful outcomes before the first turn. |
| Signal detection | `tools/result` on `write` / `edit` / `str_replace_editor` | Scans the written content for improvement signals and nudges the agent to record the outcome. |
| Capture | `session/event` → `turn/end` (`reason.kind === 'completed'`) | Derives signals, status and score from the turn's git diff, then appends to the memory graph and posts to the Hub when configured. |
| Tools | `ctx.tools.register` | `evolver_status`, `evolver_search_assets`, `evolver_fetch_asset`, `evolver_publish_asset`, `evolver_poll` — talking to the local Evolver Proxy, no MCP hop. |
| Skill | `ctx.skills.registerProvider` | `capability-evolver`, the recall-then-record workflow. |
| Commands | `ctx.commands.register` | `/evolver-status`, `/evolver-search`, `/evolver-run`, `/evolver-evolve`, `/evolver-distill`, `/evolver-solidify`, `/evolver-review`, `/evolver-sync`. |

`skills` and `commands` are optional services: on a profile that omits them, the tools and the three
lifecycle seams still work.

## Install

```bash
dsh plugin --profile web add -w --config.auto-install-peers=false @evomap/dsh-evolver
```

The package declares `dsh.bundle`, so the CLI appends it to the profile's bundle list and
activates the layer — no hand-editing of `cordis.patch.yml`. `-w` avoids pnpm's workspace-root
refusal, and `--config.auto-install-peers=false` keeps pnpm from resolving peers that are already
present in the profile.

From a checkout or a pinned commit instead:

```bash
dsh plugin --profile web add -w --config.auto-install-peers=false ./
dsh plugin --profile web add -w --config.auto-install-peers=false github:EvoMap/evolver-dsh-plugin#<sha40>
```

Verify the layer composed, then boot:

```bash
dsh --profile web --dump-config | grep -A2 'dsh-evolver'
dsh --profile web
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `projectDir` | `$DSH_PROJECT_DIR`, else `process.cwd()` | Workspace whose git diff and memory are used. |
| `proxyPort` | `$EVOMAP_PROXY_PORT`, else `19820` | Fallback port when `~/.evolver/settings.json` has no Proxy url. |
| `editToolNames` | `['write', 'edit', 'str_replace_editor']` | Tools whose results are scanned for signals. |

Environment: `MEMORY_GRAPH_PATH`, `EVOLVER_WORKSPACE_ID`, `EVOLVER_HOOK_LOG_DIR`,
`EVOMAP_HUB_URL` / `A2A_HUB_URL`, `EVOMAP_API_KEY` / `A2A_NODE_SECRET`,
`EVOMAP_NODE_ID` / `A2A_NODE_ID`.

The Proxy is a separate local process started by the `@evomap/evolver` CLI — run `evolver` once
inside a git repo. This plugin never spawns it; when it is down, the tools return an actionable
error and the memory seams keep working.

## Requirements

Evolution memory is derived from git diffs, so a **git workspace is required** for recall and
capture. In a non-git folder the plugin says so once at session start and stays quiet afterwards.

## Test

```bash
npm test
```

## License

MIT
