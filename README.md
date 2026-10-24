<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver for DeepSeek Harness</h1>

<p align="center">By EvoMap · English · <a href="README.zh.md">简体中文</a></p>

**A harness that gets smarter the more you use it.**

Most agents have goldfish memory. They fall into the same hole the last session fell into, and re-derive yesterday's working fix from scratch, burning tokens on the same detours again and again.

Evolver lets your dsh agent evolve itself. Every success becomes a shortcut for next time, and every failure becomes a warning.

- **Each prompt starts with a proven strategy.** Evolver recalls the one that best fits the task from your local history and the [EvoMap network](https://evomap.ai) and hands it to the agent. No digging through old sessions.
- **Graded on evidence, not a hunch.** After the turn, Evolver looks at whether the agent ran a test, build, lint or type check and whether the last one passed; whether the next session kept or reverted the turn's edits; and whether your next reply pushed back or approved.
- **Survival of the fittest.** Every verdict goes back to the EvoMap network with its evidence tier, and the network weighs it by that evidence. Strategies that work get recalled more often; ones proven wrong sink.
- **One agent's mistake, every agent's detour.** What is learned moves between your own sessions and across every agent connected to EvoMap.

Local memory works without an account; once connected, your harness evolves with the whole network. Nothing of Evolver but the recalled steps enters the model's context: reports go out at every turn end, the session's verified work is distilled when the session ends, and the `/evolver-*` commands (status, search, distill, sync, review, run, solidify, evolve) run in the plugin, not through the model. Set `skillEnabled: true` in the plugin config to also offer the agent the `capability-evolver` skill, which explains all this; its catalog line then rides every turn.

## Install

The plugin is published on npm as [`@evomap/dsh-evolver`](https://www.npmjs.com/package/@evomap/dsh-evolver).
Each dsh profile loads its own plugins, so install it into every profile you use (`dst`
runs `dsh-tui`):

```bash
dsh plugin --profile dsh-tui add -w @evomap/dsh-evolver@latest
dsh plugin --profile web add -w @evomap/dsh-evolver@latest
dsh plugin --profile headless add -w @evomap/dsh-evolver@latest
```

Restart dsh afterwards. Run the same command again to update: `@latest` makes pnpm move
past the version already in the profile's lockfile.

### DSH Desktop

Install from the app's plugin market, on any platform:

1. Open the plugin market in DSH Desktop and go to **Sources**.
2. Choose **Add source**, enter `https://evomap.ai/dsh/catalog-source.json`, and select it.
3. Find **Evolver** under **Installable** and choose **Install**.

The market installs the latest release from npm. To update, uninstall it under
**Installed** and install it again.

#### From the command line

The `desktop` profile belongs to the app, so the npm `dsh` will not touch it.

**Windows:** open the terminal inside DSH Desktop and run

```bash
dsh plugin add -w @evomap/dsh-evolver@latest
```

**macOS:** run the app's bundled CLI with the app's own pnpm, passing the same
`minimumReleaseAge=0` the app uses so a fresh release is not held back:

```bash
APP="/Applications/DSH Desktop.app/Contents"
SHIM=$(mktemp -d)
printf '#!/bin/sh\nexec node "%s/Resources/app/node_modules/pnpm/bin/pnpm.cjs" --config.minimumReleaseAge=0 "$@"\n' "$APP" > "$SHIM/pnpm"
chmod +x "$SHIM/pnpm"
PATH="$SHIM:$PATH" CI=true ELECTRON_RUN_AS_NODE=1 "$APP/MacOS/DSH Desktop" \
  "$APP/Resources/app/lib/desktop-cli.js" \
  plugin --profile desktop add -w @evomap/dsh-evolver@latest </dev/null
```

Restart DSH Desktop afterwards. If pnpm stops with `Ignored build scripts: koffi`, set
`koffi: true` under `allowBuilds` in `~/.dsh/profiles/desktop/pnpm-workspace.yaml` and run
the command again.

### Moving from a GitHub install

A profile installed from `github:EvoMap/evolver-dsh-plugin` keeps that source when you run
`add` again. Remove it first, then add the npm package. For example:

```bash
dsh plugin --profile dsh-tui remove @evomap/dsh-evolver
dsh plugin --profile dsh-tui add -w @evomap/dsh-evolver@latest
```

## Connect the EvoMap network (optional)

Local memory works without an account. Network reuse runs through the local Evolver
Proxy, which the plugin sets up on its own once per dsh process, in the background:

- `evolver` missing, or older than 2.0.39: it runs `npm install -g @evomap/evolver@latest`,
  then `evolver lifecycle start` (or `restart` after an upgrade).
- `evolver` current but its Proxy not answering: it runs `evolver lifecycle start`.

What it did, or why it could not (for example a global npm install without write
permission), reaches the agent as a one-time notice. To finish connecting:

1. Open the claim link the Proxy writes to `~/.evomap/claim_url` while signed in to
   [evomap.ai](https://evomap.ai).
2. Run `/evolver-status` in dsh to confirm the Proxy and node.

Network recall needs `@evomap/evolver` 2.0.39 or newer. The evidence on reuse reports
reaches the Hub only through a Proxy newer than 2.0.42; an older one drops it, and the Hub
counts those reports as unevidenced.

## Session-end distillation

A turn that ended completed, used tools, passed its last check and reused no injected strategy leaves a
candidate in `~/.evolver/state/distill-pending.json`; a later verified turn replaces it, and a next prompt
that reads as a correction drops it. When the session ends, one call to the session's own model writes a
Gene from a digest of that turn (task, commands, touched paths, checks, final answer — never the whole
history) and sends it to the Proxy's `POST /conversation/distill` with `persist: true`, `publish: false`
and its own token cost as `distill_usage`. Keys and tokens are stripped from the candidate first, paths and
a manual focus included. A candidate stays on disk until it is distilled (three failed tries give it up);
one whose session is over — ended with a failed try, or killed with its dsh process — is claimed by the next
session that starts, one process at a time, while an idle session keeps its own. `/evolver-distill` does the
same at once.

## Reuse reports

Every strategy injected into a turn is reported through the Proxy's
`POST /asset/reuse-result` as `{asset_id, outcome, task_id, reason, evidence}`. The Hub
weighs each report by its evidence:

| Report | When | `task_id` | `evidence` |
|---|---|---|---|
| Turn end | the turn ends | `dsh:<session>:<turn>` | `tier` `L1` when the turn ran a test, build, lint or type check, else `none`; `applied`; `check` `{kind, passed, fail_then_pass}` of the last check; `aborted`; `stage: immediate` |
| Correction | the next prompt says the answer did not hold, or approves it | `…:correction` | `tier: L3`, `applied`, `stage: correction` |
| Retention | the next session in the same project finds the turn's edits kept or reverted | `…:retention` | `tier: L2`, `applied`, `stage: retention` |
| Aborted | the session goes away, or is killed, before the turn ends (a killed session's go out at the next session start, once its dsh process is gone) | `dsh:<session>:<turn>` | `tier: none`, `applied: partial`, `aborted: true`, `stage: immediate` |

- **`applied`** compares the strategy's numbered steps with the turn's shell commands,
  touched paths, the code its edits wrote (200,000 characters a turn, kept in memory only)
  and the final answer: `used` when half the steps show up, `partial` when fewer do,
  `unused` when none do. A turn that left nothing to compare, or a strategy without
  numbered steps, is sent as tier `none` with `applied: partial`, which weighs nothing
  either way, and its reason says `applied: unknown`.
- **Checks** are `bash` commands that run tests, builds, linters or type checkers. A check
  fails on an error result or on failure output, since a failing run piped through `tail`
  still exits zero. `fail_then_pass` compares commands with output pipes (`| tail -9`) and
  redirects (`2>&1`) removed.
- The **outcome** follows the last check; without one it follows how the turn ended.
- **Delivery.** Reports wait in `~/.evolver/state/reports-outbox.json` and are retried at
  every turn end, follow-up prompt and session start for 8 days. A report is settled once
  the Hub answers it, `duplicate_report` and ineligible (`same_owner`, `daily_cap`) ones
  included. One the Hub refuses as invalid (`terminal: true`, or `hub 400` / `hub 422`
  from an older Proxy) is settled as rejected and never resent. `hub 404`, `hub 5xx` and
  network failures are retried.
- `/evolver-status` lists the Hub's verdict (`eligible`, `counted`, `weight`) on recent
  reports and the reason for each rejected one. Reports with evidence are also written to
  the local root event log once.
- Reasons name the turn, the applied verdict and the check kind, never the prompt, a
  command, code or a diff, and the prompt loses keys and tokens before recall sends it.

## Requirements

Node.js 22.13+, dsh 0.1.5+.

Settings and their defaults are in [`src/config.js`](src/config.js).

## Development

```bash
npm ci
npm test
```

## License

MIT © EvoMap.
