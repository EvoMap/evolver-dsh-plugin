<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver for DeepSeek Harness</h1>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

为 dsh 智能体提供持久的进化记忆，并原生接入 [EvoMap 网络](https://evomap.ai)：在每条提示词后面注入一条合适的可复用策略，记录每一轮的结果，并提供 `evolver_*` 工具和 `/evolver-*` 命令。

## 安装

插件已发布到 npm：[`@evomap/dsh-evolver`](https://www.npmjs.com/package/@evomap/dsh-evolver)。每个 dsh profile 各自加载自己的插件，用到哪个 profile 就装到哪个（`dst` 用的是 `dsh-tui`）：

```bash
dsh plugin --profile dsh-tui add -w @evomap/dsh-evolver@latest
dsh plugin --profile web add -w @evomap/dsh-evolver@latest
dsh plugin --profile headless add -w @evomap/dsh-evolver@latest
```

装完后重启 dsh。升级时重新执行同一条命令即可：`@latest` 会让 pnpm 越过 profile 锁文件里已有的版本，装上最新版。

### DSH Desktop

在应用的插件市场里安装，所有平台通用：

1. 打开 DSH Desktop 的插件市场，进入 **来源**。
2. 点击 **添加来源**，填入 `https://evomap.ai/dsh/catalog-source.json`，并选中这个来源。
3. 在 **可安装** 里找到 **Evolver**，点击 **安装**。

插件市场会安装 npm 上的最新版本。升级时，先在 **已安装** 里卸载，再重新安装一次。

#### 用命令行安装

`desktop` profile 由应用自己管理，npm 安装的 `dsh` 不会操作它。

**Windows**：打开 DSH Desktop 内置的终端，执行

```bash
dsh plugin add -w @evomap/dsh-evolver@latest
```

**macOS**：用应用自带的命令行入口和它自带的 pnpm 安装，并加上应用自己使用的 `minimumReleaseAge=0`，避免刚发布的版本被拦下：

```bash
APP="/Applications/DSH Desktop.app/Contents"
SHIM=$(mktemp -d)
printf '#!/bin/sh\nexec node "%s/Resources/app/node_modules/pnpm/bin/pnpm.cjs" --config.minimumReleaseAge=0 "$@"\n' "$APP" > "$SHIM/pnpm"
chmod +x "$SHIM/pnpm"
PATH="$SHIM:$PATH" CI=true ELECTRON_RUN_AS_NODE=1 "$APP/MacOS/DSH Desktop" \
  "$APP/Resources/app/lib/desktop-cli.js" \
  plugin --profile desktop add -w @evomap/dsh-evolver@latest </dev/null
```

装完后重启 DSH Desktop。如果 pnpm 提示 `Ignored build scripts: koffi`，在 `~/.dsh/profiles/desktop/pnpm-workspace.yaml` 的 `allowBuilds` 下设置 `koffi: true`，再执行一次命令。

### 从 GitHub 安装迁移过来

从 `github:EvoMap/evolver-dsh-plugin` 安装的 profile，再次执行 `add` 时会保留 GitHub 来源。需要先卸载，再从 npm 安装，例如：

```bash
dsh plugin --profile dsh-tui remove @evomap/dsh-evolver
dsh plugin --profile dsh-tui add -w @evomap/dsh-evolver@latest
```

## 连接 EvoMap 网络（可选）

本地记忆不需要账号就能用。要复用网络上的策略：

```bash
npm install -g @evomap/evolver
```

1. 在任意 git 仓库里运行一次 `evolver`。它会启动本地 Proxy，并打印一个认领链接。
2. 登录 [evomap.ai](https://evomap.ai) 后打开这个链接。
3. 在 dsh 里执行 `/evolver-status`，确认 Proxy 和节点状态正常。

网络召回需要 `@evomap/evolver` 2.0.39 或更新版本。

## 环境要求

Node.js 22.13+、git（用于记录每轮结果）、dsh 0.1.5+。

配置项及默认值见 [`src/config.js`](src/config.js)。

## 开发

```bash
npm ci
npm test
```

## 许可证

MIT © EvoMap.
