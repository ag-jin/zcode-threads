# ZCode 版本升级适配指南

本技能通过 ZCode 桌面渲染器的**内部接口**（CDP 桥接）工作，这些接口不是公开 API，ZCode 每次升级都可能改变。因此技能采用**失败关闭**策略：只接受已验证的桌面版本，未验证版本一律拒绝运行（包括只读命令），而不是盲目放行。

当前已验证版本：`3.5.3`、`3.6.5`。

## 触发条件

ZCode 升级后运行 `check`：

```bash
node "$Z" check
```

返回 `compatible: false` 且原因包含 `not a verified supported version` 时，需要按本指南适配。

## 适配步骤（按顺序）

### 1. 记录新版本与运行环境

```bash
plutil -extract CFBundleShortVersionString raw -o - /Applications/ZCode.app/Contents/Info.plist
node -v
```

### 2. 只读验证（不需要改代码）

这些命令只读本地 SQLite / 安装文件，可用于快速判断接口是否仍兼容：

```bash
node "$Z" list --workspace "<已打开工作区>" --limit 5
node "$Z" diagnose --workspace "<已打开工作区>" --session sess_xxx
node "$Z" read --workspace "<已打开工作区>" --session sess_xxx --turns 3
node "$Z" list-models --workspace "<已打开工作区>" --json
```

- `list-models` 验证 `zcodeSessionService.readWorkspaceState` RPC 是否仍有效（渠道+模型+思考等级数据源）。
- 若这些命令失败，说明本地数据库 schema 或 CLI 协议已变化，先修这里。

### 3. GUI 桥接验证

```bash
node "$Z" list-models --workspace "<已在桌面打开的工作区>"
node "/path/to/zthread-gui.mjs" probe --workspace "<已在桌面打开的工作区>"
```

- `probe` 验证 CDP 端点、渲染器发现与工作区服务匹配。
- 若渲染器服务名或 CDP 端点变化，`probe` 会明确失败。

### 4. 更新已验证版本集合

在两个文件里把新版本加入 `VERIFIED_DESKTOP_VERSIONS`（并更新 `DESKTOP_VERSION` 为最新）：

- `scripts/zthread.mjs`
- `scripts/zthread-gui.mjs`

```js
const DESKTOP_VERSION = "3.7.0"; // 新版本
const VERIFIED_DESKTOP_VERSIONS = new Set(["3.5.3", "3.6.5", "3.7.0"]);
```

只做这一步而不做第 2、3、5 步是危险的：版本闸门被放开，但未经验证的写操作可能静默失败或写错状态。

### 5. 受控冒烟测试（GUI 写操作）

只在一个**一次性、非关键**工作区执行，按顺序验证全部写路径：

```bash
# 创建（使用确认可用的渠道+模型，避免不可用模型）
node "$Z" list-models --workspace "<工作区>"
node "$Z" gui-new --workspace "<工作区>" --prompt "冒烟测试" --provider <渠道名> --model <模型名> --thought-level <等级>
# 记录返回的 sessionId，继续：
node "$Z" gui-send --workspace "<工作区>" --session sess_xxx --prompt "第二条"
node "$Z" gui-config --workspace "<工作区>" --session sess_xxx --provider <另一渠道> --model <另一模型> --thought-level <等级>
node "$Z" prepare-gui-archive  --workspace "<工作区>" --session sess_xxx
node "$Z" execute-gui-archive  --workspace "<工作区>" --session sess_xxx --confirmation ztc_xxx
node "$Z" prepare-gui-unarchive --workspace "<工作区>" --session sess_xxx
node "$Z" execute-gui-unarchive --workspace "<工作区>" --session sess_xxx --confirmation ztc_xxx
node "$Z" prepare-gui-delete    --workspace "<工作区>" --session sess_xxx
node "$Z" execute-gui-delete    --workspace "<工作区>" --session sess_xxx --confirmation ztc_xxx
```

每步核对返回的 `status`，并用只读命令回读确认持久化结果（任务索引 `workspace_key`/`workspace_identity`/`model` 字段）。

### 6. 全量测试与语法检查

```bash
node tests/zthread-adaptation.test.mjs
bash tests/zcode-port-guard.test.sh
node --check scripts/zthread.mjs
node --check scripts/zthread-gui.mjs
bash -n scripts/zcode-port-guard.sh
bash -n scripts/zcode-restart-with-cdp.sh
```

## 依赖的接口清单（3.6.5 实测）

| 依赖 | 位置/形态 | 适配时验证方式 |
|---|---|---|
| 桌面版本 | `/Applications/ZCode.app/Contents/Info.plist` `CFBundleShortVersionString` | `check` |
| 运行时标记 | `Resources/glm/zcode.cjs` 包含 `app-server`、`session/list`、`session/read`、`session/create`、`session/send` | `check` |
| CDP 端点 | 仅本机 `127.0.0.1:9333`，`/json/version` 标识为 ZCode，`/json/list` 含 page target | GUI `probe` |
| 会话服务 | 渲染器 `zcodeSessionService`：`readWorkspaceState`、`setModel`、`setThoughtLevel`、`setMode` | `list-models` / `gui-config` |
| 任务服务 | 渲染器 `zcodeTaskService`：`archiveTask`、`unarchiveTask`、`deleteTask` | 归档/删除冒烟 |
| Agent 服务 | 渲染器 `zcodeAgentService`：`sendConversationCommandV4` + `localStorage["zcode-v4-client-id:v1"]` | `gui-new` 冒烟 |
| 任务索引 | `~/.zcode/v2/tasks-index.sqlite`：`workspace_key`、`workspace_path`、`workspace_identity`、`task_id`、`archived`、`deleted`、`model` | 只读回读 |
| 会话存储 | `~/.zcode/cli/db/db.sqlite`：`id`、`directory`、`task_type`、`parent_id`、`time_archived` | `diagnose` |
| 模型引用 | 3.6.5 起 providerId 为 UUID；`--provider/--model` 名字由桥接通过 `readWorkspaceState` 的 `settings.model.available` 解析 | `gui-new`/`gui-config` |
| 思考等级 | 每模型 `modelCatalog.providers[].models[].reasoning.levels`；无声明（null）的模型不可调 | `list-models --json` |

## 已知不存在的接口（勿调用）

以下 RPC 名在 3.6.5 会抛 `Method not found`，适配时不要依赖：

- `zcodeSessionService.listModels`
- `zcodeSessionService.listThoughtLevels`
- `zcodeSessionService.getSessionConfig`

## 3.5.3 → 3.6.5 适配记录（本次）

| 变化 | 处理 |
|---|---|
| 配置接口从 `zcodeTaskService.setModel/setConfigOption` 迁移到 `zcodeSessionService.setModel/setThoughtLevel` | 重写 `configTaskExpression`，用会话服务 + 设置对象回读 |
| 任务索引主键加入 `workspace_key`，新增 `workspace_identity` 列 | 查询附带身份字段，仍以用户输入的绝对路径为边界 |
| 模型引用改为 UUID providerId | 桥接内通过 `readWorkspaceState` 的 `settings.model.available` 做名字→UUID 解析；歧义或找不到时明确报错 |
| 未指定思考等级时无 reasoning 声明的模型固定默认 variant（如 `$high`） | 文档说明，不当作故障 |
| 3.6.5 存在 `session/setModel`、`session/setThoughtLevel`、`session/setMode` 协议路由 | 未依赖，仅供排查时参考 |

## 安全边界（适配时不可破坏）

- 只读命令以只读模式打开本地 SQLite，绝不直接写库或配置。
- GUI 写操作只通过本机 loopback CDP 的桌面渲染器执行，并回读任务索引确认结果。
- 归档/取消归档/删除保持两步确认（`prepare-*` → `execute-*`），令牌 15 分钟有效且一次性。
- `--workspace` 只接受已存在目录；技能**不创建、不切换、不删除 Git worktree**。
- GUI 命令要求目标工作区已在唯一桌面渲染器中打开。
- 未验证版本失败关闭，不提供 SQLite 直写兜底。
