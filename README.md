<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver for DeepSeek Harness</h1>

Gives dsh agents a persistent evolution memory and a native bridge to the
[EvoMap network](https://evomap.ai): behind each prompt it injects one reusable strategy
that fits, records how every turn ended, and adds `evolver_*` tools and `/evolver-*`
commands.

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
2. Choose **Add source**, enter `https://evomap.ai/a2a/dsh/catalog-source.json`, and select it.
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
