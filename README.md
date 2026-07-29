# zcode-threads

A macOS-only ZCode skill for inspecting and managing desktop-visible ZCode threads. It provides read-only listing and diagnosis plus explicitly confirmed GUI actions to create, send to, archive, unarchive, delete, and configure threads.

## Requirements

- macOS
- ZCode Desktop 3.5.3, installed at `/Applications/ZCode.app`
- Node.js 22 or later, including the experimental `node:sqlite` API
- A loopback-only ZCode CDP endpoint on port `9333` for GUI actions

The bridge checks the installed desktop version and required runtime markers before it takes an action. A version mismatch fails closed.

## Install

Clone the repository into the ZCode skills directory:

```bash
git clone https://github.com/ag-jin/zcode-threads.git "$HOME/.zcode/skills/zcode-threads"
```

ZCode discovers the skill from `SKILL.md`. Read that file for activation guidance, safety rules, supported commands, and operational procedures.

## Use

Set the command path and an absolute workspace path:

```bash
Z="$HOME/.zcode/skills/zcode-threads/scripts/zthread.mjs"
WS="/absolute/workspace/path"
```

Read-only inspection:

```bash
node "$Z" check
node "$Z" list --workspace "$WS" --limit 20
node "$Z" list-archived --workspace "$WS" --limit 20
node "$Z" list-deleted --workspace "$WS" --limit 20
node "$Z" diagnose --workspace "$WS" --session sess_xxx
```

GUI mutations always use a two-step confirmation protocol. The execute command must repeat the exact prepared action and one-time token:

```bash
node "$Z" prepare-gui-archive --workspace "$WS" --session sess_xxx
node "$Z" execute-gui-archive --workspace "$WS" --session sess_xxx --confirmation ztc_xxx
```

See [`SKILL.md`](SKILL.md) for create, send, unarchive, delete, and model or thought-level configuration commands. Deletion is irreversible.

## Safety and Scope

- Read-only commands open local SQLite databases in read-only mode.
- The skill never writes ZCode databases or configuration files directly.
- GUI mutations use ZCode's active desktop renderer through its loopback CDP endpoint and verify the resulting task-index state.
- Every GUI action requires an absolute workspace path, and mutations require an explicit matching confirmation token that expires after 15 minutes.
- The optional port guard is opt-in. `guard-install` creates a user LaunchAgent that restarts ZCode with `--remote-debugging-port=9333` when necessary.

The scripts are version-locked to ZCode Desktop 3.5.3. They are not a general compatibility layer for other releases.

## Repository Contents

```text
SKILL.md                                    ZCode skill definition and operating guide
scripts/zthread.mjs                         Main command-line interface
scripts/zthread-gui.mjs                     Loopback CDP desktop bridge
scripts/zcode-port-guard.sh                 Optional LaunchAgent port guard
scripts/zcode-restart-with-cdp.sh           Manual CDP restart helper
```

Runtime logs under `wakes/` and one-time action records under `.pending-actions/` are intentionally ignored and never belong in commits.

## License

This project is licensed under the [MIT License](LICENSE).
