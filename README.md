<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver for DeepSeek Harness</h1>

Gives dsh agents a persistent evolution memory and a native bridge to the
[EvoMap network](https://evomap.ai): behind each prompt it injects one reusable strategy
that fits, records how every turn ended, and adds `evolver_*` tools and `/evolver-*`
commands.

## Install

Install into every profile you use. `dst` runs the `dsh-tui` profile.

```bash
dsh plugin --profile dsh-tui add -w github:EvoMap/evolver-dsh-plugin
dsh plugin --profile web add -w github:EvoMap/evolver-dsh-plugin
dsh plugin --profile headless add -w github:EvoMap/evolver-dsh-plugin
```

Restart dsh afterwards. To update, run the same command again.

### DSH Desktop

The npm `dsh` refuses to manage the `desktop` profile. Use the CLI bundled in the app, with
the app's own pnpm 11 (the profile was installed with it, so another pnpm major fails with
`ERR_PNPM_UNEXPECTED_STORE`):

```bash
APP="/Applications/DSH Desktop.app/Contents"
SHIM=$(mktemp -d)
printf '#!/bin/sh\nexec node "%s/Resources/app/node_modules/pnpm/bin/pnpm.cjs" "$@"\n' "$APP" > "$SHIM/pnpm"
chmod +x "$SHIM/pnpm"
PATH="$SHIM:$PATH" CI=true ELECTRON_RUN_AS_NODE=1 "$APP/MacOS/DSH Desktop" \
  "$APP/Resources/app/lib/desktop-cli.js" \
  plugin --profile desktop add -w github:EvoMap/evolver-dsh-plugin </dev/null
```

Then restart DSH Desktop. If pnpm reports `Ignored build scripts: koffi`, set `koffi: true`
under `allowBuilds` in `~/.dsh/profiles/desktop/pnpm-workspace.yaml` and run the command
again.

## Connect the EvoMap network (optional)

Local memory works without an account. To reuse strategies from the network:

```bash
npm install -g @evomap/evolver
```

1. Run `evolver` once inside a git repository. It starts the local Proxy and prints a
   claim link.
2. Open the link while signed in to [evomap.ai](https://evomap.ai).
3. Run `/evolver-status` in dsh to confirm the Proxy and node.

Network recall needs `@evomap/evolver` 2.0.39 or newer.

## Requirements

Node.js 22.13+, git (for turn capture), dsh 0.1.5+.

Settings and their defaults are in [`src/config.js`](src/config.js).

## Development

```bash
npm ci
npm test
```

## License

MIT © EvoMap.
