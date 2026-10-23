<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver for DeepSeek Harness</h1>

<p align="center">EvoMap 出品 · <a href="README.md">English</a> · 简体中文</p>

**越用越聪明的 harness。**

大多数 agent 都是金鱼记忆：上一个会话刚踩过的坑，下一个会话照样踩；昨天已经调通的方案，今天又从头推导一遍，token 就这样一遍遍烧在同样的弯路上。

Evolver 让你的 dsh 智能体自己进化。每一次成功都会变成下一次的捷径，每一次失败都会变成下一次的避坑指南。

- **每条 prompt 前，带一条验证过的策略上场。** Evolver 从你的本地经验和 [EvoMap 网络](https://evomap.ai)里召回最贴合当前任务的一条，注入给智能体，不用你手动翻历史。
- **用证据打分，而不是凭感觉。** 回合结束后，Evolver 会看智能体有没有跑测试、构建、lint 或类型检查，最后一次检查是通过还是失败；下一次会话里，这一轮的改动是被保留还是被撤回；你的下一句话是在推翻它还是认可它。
- **优胜劣汰。** 每份复用结论都带着证据等级回报 EvoMap 网络，网络按证据为它加权。有效的策略越来越常被召回，被证伪的策略逐渐沉下去。
- **一个智能体踩过的坑，整个网络都绕开。** 经验在你的每个会话之间流转，也在所有接入 EvoMap 的智能体之间流转。

不注册账号也能用本地记忆；接入网络后，你的 harness 就和整个网络一起进化。除了召回的步骤，Evolver 不往模型上下文里放任何东西：每个回合结束时上报，会话结束时把验证过的工作沉淀下来；`/evolver-*` 命令（status、search、distill、sync、review、run、solidify、evolve）由插件直接执行，不经过模型。

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

本地记忆不需要账号就能用。网络复用经由本地 Evolver Proxy，插件会在每个 dsh 进程里于后台自动准备一次：

- 没装 `evolver`，或版本低于 2.0.39：执行 `npm install -g @evomap/evolver@latest`，然后执行 `evolver lifecycle start`（升级后用 `restart`）。
- `evolver` 版本够新但 Proxy 没有响应：执行 `evolver lifecycle start`。

做了什么、或者为什么没做成（比如没有全局 npm 安装的写权限），都会以一次性通知告诉智能体。完成连接：

1. 登录 [evomap.ai](https://evomap.ai) 后，打开 Proxy 写在 `~/.evomap/claim_url` 里的认领链接。
2. 在 dsh 里执行 `/evolver-status`，确认 Proxy 和节点状态正常。

网络召回需要 `@evomap/evolver` 2.0.39 或更新版本。复用上报里的证据只有经 2.0.42 之后的 Proxy 才能送到 Hub；更旧的 Proxy 会丢掉证据，Hub 把这些上报按无证据计。

## 复用上报

每一轮注入过的策略都会经 Proxy 的 `POST /asset/reuse-result` 上报，请求体为 `{asset_id, outcome, task_id, reason, evidence}`，Hub 按证据给上报加权：

| 上报 | 时机 | `task_id` | `evidence` |
|---|---|---|---|
| 回合结束 | 回合结束时 | `dsh:<会话>:<回合>` | 本回合跑过测试、构建、lint 或类型检查时 `tier` 为 `L1`，否则为 `none`；`applied`；最后一次检查的 `check` `{kind, passed, fail_then_pass}`；`aborted`；`stage: immediate` |
| 追问补报 | 下一条提示词表示结果不对，或表示认可 | `…:correction` | `tier: L3`、`applied`、`stage: correction` |
| 留存回访 | 同一项目的下一个会话发现本回合的改动被保留或被撤销 | `…:retention` | `tier: L2`、`applied`、`stage: retention` |
| 中止 | 回合结束前会话消失或被强杀（被强杀会话的上报在下次会话开始时发出） | `dsh:<session>:<turn>` | `tier: none`、`applied: partial`、`aborted: true`、`stage: immediate` |

- **`applied`** 把策略的编号步骤与本回合的 shell 命令、涉及的路径、编辑写入的代码（每回合最多 20 万字符，只留在内存里）和最终回答比对：半数以上步骤出现记 `used`，少于半数记 `partial`，一条都没有记 `unused`。回合没留下可比对的内容，或策略没有编号步骤时，按 tier `none` 加 `applied: partial` 上报，两边都不计权重，reason 里写 `applied: unknown`。
- **检查**指运行测试、构建、lint 或类型检查的 `bash` 命令。结果报错或输出里有失败信息都算失败，因为经 `tail` 管道的失败运行退出码仍是 0。判断 `fail_then_pass` 时会先去掉输出管道（`| tail -9`）和重定向（`2>&1`）再比较命令。
- **outcome** 跟随最后一次检查；没有检查时跟随回合的结束方式。
- **投递**：上报先存进 `~/.evolver/state/reports-outbox.json`，在每次回合结束、追问和会话开始时重试，保留 8 天。Hub 只要给出答复就算送达，包括 `duplicate_report` 和不计分的回执（`same_owner`、`daily_cap`）。Hub 判为无效的（`terminal: true`，或旧版 Proxy 返回的 `hub 400` / `hub 422`）记为被拒，不再重发。`hub 404`、`hub 5xx` 和网络失败会重试。
- `/evolver-status` 会列出最近上报的 Hub 判定（`eligible`、`counted`、`weight`）以及每条被拒上报的原因。带证据的上报还会在本地 root event 日志里记一次。
- reason 只写回合、采用判定和检查类型，不含提示词、命令、代码或 diff；召回前会先去掉提示词里的密钥和令牌。

## 环境要求

Node.js 22.13+、dsh 0.1.5+。

配置项及默认值见 [`src/config.js`](src/config.js)。

## 开发

```bash
npm ci
npm test
```

## 许可证

MIT © EvoMap.
