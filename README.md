# zcode-threads

`zcode-threads` 是一个仅支持 macOS 的 ZCode 技能，用于检查和管理在 ZCode 桌面任务列表中可见的线程。它提供只读的列表与诊断能力，以及需要显式确认的 GUI 操作：创建线程、发送消息、归档、取消归档、删除，设置模型或思考等级，并支持读取可用渠道+模型供用户选择。

## 前提条件

- macOS
- 已安装 ZCode Desktop `3.6.5`（已验证版本：`3.5.3`、`3.6.5`），位置为 `/Applications/ZCode.app`
- Node.js 22 或更高版本，包含实验性的 `node:sqlite` API
- 仅在执行桌面 GUI 操作时：ZCode 必须通过 `--remote-debugging-port=9333` 启动，并在 `127.0.0.1:9333` 提供仅本机可访问的 CDP 端点

脚本会在执行前核对已安装的 ZCode 版本和所需运行时标记；版本不匹配或运行时不兼容时**失败关闭**，不会尝试替代性写入。ZCode 升级后请按 [`ADAPTING.md`](ADAPTING.md) 重新适配。

## 安装

将仓库克隆到 ZCode 的技能目录：

```bash
git clone https://github.com/ag-jin/zcode-threads.git "$HOME/.zcode/skills/zcode-threads"
```

ZCode 通过 `SKILL.md` 发现技能。完整的触发条件、安全规则、支持命令和操作流程请阅读 [`SKILL.md`](SKILL.md)。

## 基本使用

先设置脚本路径和绝对工作区路径：

```bash
Z="$HOME/.zcode/skills/zcode-threads/scripts/zthread.mjs"
WS="/absolute/workspace/path"
```

只读检查：

```bash
node "$Z" check
node "$Z" list --workspace "$WS" --limit 20
node "$Z" list-archived --workspace "$WS" --limit 20
node "$Z" list-deleted --workspace "$WS" --limit 20
node "$Z" diagnose --workspace "$WS" --session sess_xxx
node "$Z" read --workspace "$WS" --session sess_xxx
```

读取可用渠道+模型供用户选择（`list-models`）：

```bash
node "$Z" list-models --workspace "$WS"
node "$Z" list-models --workspace "$WS" --json
```

- 工作区已在 ZCode 打开时：通过桌面渲染器的只读 RPC 返回完整目录（含内置模型、每模型思考等级、当前选择）。
- CDP 不可用或工作区未打开时：回退读取 `~/.zcode/v2/config.json` 的用户自定义渠道，并标注来源。

选定后创建或配置线程：

```bash
node "$Z" gui-new --workspace "$WS" --prompt "..." --provider <渠道名> --model <模型名> --thought-level <等级>
node "$Z" gui-config --workspace "$WS" --session sess_xxx --provider <渠道名> --model <模型名> --thought-level <等级>
```

渠道/模型名会自动解析为桌面实际的 providerId；只有声明了思考等级的模型才可调整思考等级（如 `off/high/max`）。

桌面 GUI 写操作采用两步确认协议（归档/取消归档/删除）。先执行 `prepare-*`，再使用返回的一次性令牌执行完全相同的 `execute-gui-*` 操作：

```bash
node "$Z" prepare-gui-archive --workspace "$WS" --session sess_xxx
node "$Z" execute-gui-archive --workspace "$WS" --session sess_xxx --confirmation ztc_xxx
```

创建、发送消息、取消归档、删除、配置模型和思考等级的命令请参阅 [`SKILL.md`](SKILL.md)。删除操作不可恢复。

## CDP 端口是否必需

**不是整个技能都需要 CDP 端口，但所有桌面 GUI 写操作都必须使用它。**

下列操作不连接 CDP 端口：

- `check`
- `list`、`list-archived`、`list-deleted`
- `diagnose`、`read`
- `list-models`（本地回退路径）
- 全部 `prepare-*` 命令
- 通过 ZCode 内置 CLI 执行的 headless `execute-new` 和 `execute-send`

这些命令只会检查本机安装、调用内置 CLI，或以只读方式打开本地 SQLite 数据库。

下列操作必须连接本机回环地址 `127.0.0.1:9333` 上的 ZCode CDP 端点：

- `execute-gui-new`
- `execute-gui-send`
- `execute-gui-archive`、`execute-gui-unarchive`、`execute-gui-delete`
- `execute-gui-config`
- `list-models`（桌面渲染器路径，工作区已打开时）

原因是这些命令需要通过当前运行的 ZCode 桌面渲染器调用其任务服务，确保创建的线程立即出现在桌面任务列表中，并由桌面应用更新任务索引。技能不会直接写入 ZCode 的 SQLite 数据库或配置文件。

若需要自动维持该端口，可选择安装端口守卫：

```bash
node "$Z" guard-install
```

该操作会创建一个当前用户的 LaunchAgent，每 30 秒检查一次；当 ZCode 未以 `--remote-debugging-port=9333` 运行时，它会重启 ZCode 并带上该参数。端口守卫是可选功能，不影响只读和 headless 命令。

## 工作区与 Git worktree

- `--workspace` 只接受**已存在**的目录；技能**不创建、不切换、不删除、不清理 Git worktree**。
- 想要为不同分支并行工作：先用 `git worktree add -b <branch> <path>` 创建目录，再在 ZCode 桌面打开该目录作为工作区，最后用该路径作为 `--workspace`。
- GUI 命令要求该精确目录已在唯一 ZCode 桌面渲染器中打开。

## 安全边界

- 只读命令以只读模式打开本地 SQLite 数据库。
- 技能绝不直接写入 ZCode 数据库或配置文件。
- GUI 写操作通过已运行 ZCode 的仅本机 CDP 端点调用桌面渲染器，并在返回成功前核对任务索引的最终状态（含 `workspace_key`/`workspace_identity`）。
- 所有 GUI 操作都要求绝对工作区路径；写操作还要求与 `prepare-*` 输出严格匹配、有效期 15 分钟的一次性确认令牌。
- 归档、取消归档和删除只接受桌面任务列表中已存在的根 `interactive` 线程；删除不可恢复。

脚本锁定已验证的 ZCode 桌面版本，不是面向其他版本的通用兼容层。

## 仓库内容

```text
SKILL.md                                    技能定义与操作说明
ADAPTING.md                                 ZCode 版本升级适配指南
scripts/zthread.mjs                         主命令行入口
scripts/zthread-gui.mjs                     仅本机 CDP 桌面桥接
scripts/zcode-port-guard.sh                 可选的 LaunchAgent 端口守卫
scripts/zcode-restart-with-cdp.sh           手动重启并启用 CDP 的辅助脚本
tests/zthread-adaptation.test.mjs           3.6.5 适配回归测试
tests/zcode-port-guard.test.sh              端口守卫行为测试
```

`wakes/` 下的运行日志和 `.pending-actions/` 下的一次性确认记录均已被忽略，永远不应提交到仓库。

## 测试

```bash
node tests/zthread-adaptation.test.mjs
bash tests/zcode-port-guard.test.sh
```

## 许可证

本项目采用 [MIT License](LICENSE) 开源。
