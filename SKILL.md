---
name: zcode-threads
description: Diagnose and manage ZCode desktop thread visibility and lifecycle in one explicitly selected workspace. Use when a thread is missing from the GUI, appears unexpectedly archived or deleted, or when the user asks to list, archive, unarchive, delete, create, send to, or set the model or reasoning difficulty (thought level) of desktop-visible threads. Reading a thread's context is handled by the built-in ReadSessionContext tool (triggered by #sess_* references), not this skill; this skill's read command is a fallback only.
---

# ZCode Threads

Diagnose the **desktop visibility** and manage the lifecycle of ZCode threads: archive, unarchive, delete, list, and create GUI-visible threads. This skill complements the built-in `#sess_*` reference mechanism - it does not replace it.

## Division of labor

| Need | Use | Why |
|------|-----|-----|
| Read a thread's context | Built-in `#sess_xxx` → `ReadSessionContext` tool | The `#sess_` reference is parsed from user input (`/#(sess_[A-Za-z0-9_-]+)/g`) and injected as a system-reminder. `ReadSessionContext` calls `sessionStore.getSession()` + `sessionStore.messages()` - no archive filtering, works on any session ID. This is the primary read path. |
| Create a headless thread | `zcode --prompt "..."` | The built-in CLI creates a session in the session store. It does **not** appear in the desktop task list. |
| Create a GUI-visible thread (optionally with model / reasoning difficulty) | This skill: `prepare-gui-new` → `execute-gui-new` | Sends a V4 `createSession` command through `zcodeAgentService.sendConversationCommandV4`, reusing the renderer's registered `clientId`. The session and its first turn are created atomically and the task is immediately visible and usable. |
| Send a follow-up to a thread | `zcode --resume <sess> --prompt "..."` | Built-in headless resume. |
| Send a GUI-visible follow-up | This skill: `prepare-gui-send` → `execute-gui-send` | Appends through the desktop renderer. |
| **Archive a thread** | **This skill only**: `prepare-gui-archive` → `execute-gui-archive` | The built-in `session/*` protocol has no archive method. Only `zcodeTaskService.archiveTask` (desktop renderer) can archive. |
| **Unarchive a thread** | **This skill only**: `prepare-gui-unarchive` → `execute-gui-unarchive` | Only `zcodeTaskService.unarchiveTask`. |
| **Delete a thread** | **This skill only**: `prepare-gui-delete` -> `execute-gui-delete` | Only `zcodeTaskService.deleteTask`. Irreversible. |
| **Set a thread's model / reasoning difficulty** | **This skill only**: `prepare-gui-config` -> `execute-gui-config` | `zcodeTaskService.setModel` and `setConfigOption`. Applies to an existing, working GUI thread. |
| **Find a GUI-missing thread** | **This skill only**: `diagnose` | Compares the local session store with the desktop task index and reports whether the thread is active, archived, deleted, session-only, or index-only. |
| **List archived or deleted threads** | **This skill only**: `list-archived` / `list-deleted` | Reads desktop task-index rows by their actual GUI lifecycle state. |
| List live GUI threads | This skill: `list` | Reads the task index's `archived=0, deleted=0` rows, which is the desktop visibility source of truth. |

## When to use this skill

Trigger this skill when the user:
- Asks to **archive**, **unarchive**, or **clean up** threads.
- Asks to **list archived** or **old** threads.
- Reports that a thread is **missing**, **not shown**, or has **disappeared** from the ZCode desktop GUI.
- Asks to create a thread that must be **visible in the desktop task list** (not headless).
- Asks to **change the model** or **reasoning difficulty / thought level** of an existing GUI thread.

**Do not** trigger this skill when the user:
- References `#sess_xxx` - that is the built-in `ReadSessionContext` path, already handled.
- Asks to read a thread's messages - use `ReadSessionContext` with a focused query instead.
- Asks to create a headless thread - use `zcode --prompt` directly.

## Safety rules

- Require `--workspace <absolute-path>` for every command.
- `list`, `list-archived`, `list-deleted`, `diagnose`, and `read` are read-only. They open the session store or task index with read-only SQLite connections and never modify `~/.zcode/cli/db/db.sqlite`, its WAL files, `~/.zcode/v2/tasks-index.sqlite`, or ZCode configuration.
- Never write to `~/.zcode/cli/db/db.sqlite`, `~/.zcode/v2/tasks-index.sqlite`, or ZCode configuration directly. Mutation happens only through the installed, version-locked GUI bridge.
- The GUI bridge uses only the loopback-only ZCode CDP endpoint on port `9333`, validates the desktop process and a unique workspace renderer, and calls the renderer's desktop-owned `zcodeTaskService`. Do not substitute another CDP endpoint, a direct GUI automation path, or a SQLite write.
- Do not run any `execute-*` command until the user has explicitly confirmed the exact workspace, target session, prompt (when applicable), CDP port, and the one-time confirmation token shown by the matching `prepare-*` command. Tokens expire after 15 minutes and are consumed before execution starts.
- Archive and unarchive require a root `interactive` session that is already a visible GUI task (present in the desktop task index with `archived=0, deleted=0`). Headless sessions are rejected at the prepare stage.
- If the runtime compatibility check fails, stop and provide a handoff prompt. Do not emulate a write through SQLite.

## Commands

```bash
Z="$HOME/.zcode/skills/zcode-threads/scripts/zthread.mjs"

# ── READ-ONLY ──
node "$Z" check
node "$Z" list            --workspace "/absolute/workspace/path" --limit 20
node "$Z" list-archived   --workspace "/absolute/workspace/path" --limit 20
node "$Z" list-deleted    --workspace "/absolute/workspace/path" --limit 20
node "$Z" diagnose        --workspace "/absolute/workspace/path" --session sess_xxx
node "$Z" read            --workspace "/absolute/workspace/path" --session sess_xxx --turns 8 --max-chars 1200

# ── CREATE (GUI-visible) ──
node "$Z" prepare-gui-new --workspace "/absolute/workspace/path" --prompt "..."
node "$Z" prepare-gui-new --workspace "/absolute/workspace/path" --prompt "..." --provider "provider-id" --model "model-id" --thought-level "high"
node "$Z" execute-gui-new --workspace "/absolute/workspace/path" --prompt "..." --provider "provider-id" --model "model-id" --thought-level "high" --confirmation ztc_xxx

# ── SET MODEL / REASONING DIFFICULTY (existing thread) ──
node "$Z" prepare-gui-config --workspace "/absolute/workspace/path" --session sess_xxx --provider "provider-id" --model "model-id" --thought-level "high"
node "$Z" execute-gui-config --workspace "/absolute/workspace/path" --session sess_xxx --provider "provider-id" --model "model-id" --thought-level "high" --confirmation ztc_xxx

# ── ARCHIVE / UNARCHIVE / DELETE ──
node "$Z" prepare-gui-archive   --workspace "/absolute/workspace/path" --session sess_xxx
node "$Z" execute-gui-archive   --workspace "/absolute/workspace/path" --session sess_xxx --confirmation ztc_xxx

node "$Z" prepare-gui-unarchive --workspace "/absolute/workspace/path" --session sess_xxx
node "$Z" execute-gui-unarchive --workspace "/absolute/workspace/path" --session sess_xxx --confirmation ztc_xxx

node "$Z" prepare-gui-delete    --workspace "/absolute/workspace/path" --session sess_xxx
node "$Z" execute-gui-delete    --workspace "/absolute/workspace/path" --session sess_xxx --confirmation ztc_xxx

# ── Optional CDP port guard ──
# The port guard runs every 30s via LaunchAgent. When ZCode is running without
# the CDP port, it automatically restarts ZCode with --remote-debugging-port=9333
# using `open -a` (macOS native launch). Install/uninstall via:
node "$Z" guard-install | guard-status | guard-uninstall
```

## How to use it

### A thread disappeared from the GUI

1. Run `diagnose --workspace <abs> --session <sess_id>` if the session ID is known. It reports the desktop task-index state and the session-store state separately.
2. Interpret `classification` from the output:
   - `desktop-active`: the task index says it belongs in the live desktop list. Reopen the workspace or restart ZCode, then run `diagnose` again. Do not mutate either SQLite database.
   - `desktop-archived`: it is not in the live list. Use `list-archived`, then `prepare-gui-unarchive` and ask the user to explicitly confirm the exact task before executing.
   - `desktop-deleted`: the desktop task was deleted. The original GUI card cannot be restored; the session text may still be available through `#sess_xxx` or `read`.
   - `session-only`: the conversation exists locally but has no desktop task-index card, which is typical of a headless CLI session. It can be read or resumed headlessly, but it cannot be turned back into its original GUI card by writing SQLite.
   - `task-index-only`: the GUI task record exists without a local session record. Treat this as a local consistency problem; do not delete or rewrite either record.
3. When the session ID is unknown, compare `list`, `list-archived`, and `list-deleted` by title and timestamps. These commands report the desktop task index, not `session.time_archived`.

`time_archived` in the session store is supporting evidence only. The desktop task index's `archived` and `deleted` flags determine GUI lifecycle state.

### Archive

1. Run `list` to find the live thread to archive. Note its `sess_xxx` ID.
2. Run `prepare-gui-archive --workspace <abs> --session <sess_id>`. It returns the action, side effects, and a 15-minute confirmation token.
3. Confirm with the user that the named root task should be archived.
4. Run `execute-gui-archive … --confirmation <token>`. The bridge calls `zcodeTaskService.archiveTask`, which sets `archived = 1` in the task index and emits a `task_archived` event, then verifies the archived state is reflected in the index.
5. Verify with `list-archived` - the thread should now appear there.

### Unarchive

Same flow with `prepare-gui-unarchive` / `execute-gui-unarchive`. Calls `unarchiveTask`, sets `archived = 0`, emits `task_unarchived`.

### Delete

Same flow with `prepare-gui-delete` / `execute-gui-delete`. Calls `deleteTask`, sets `deleted = 1` in the task index. This is **irreversible** - the thread disappears from both live and archived lists. The session store record is not removed, but the thread is hidden from the desktop task list permanently.

### List archived threads

`list`, `list-archived`, and `list-deleted` read the desktop task index and cross-reference the session store for metadata where available. `list` selects `archived=0 AND deleted=0`; `list-archived` selects `archived=1 AND deleted=0`; and `list-deleted` selects `deleted=1`. The session store's `time_archived` is not treated as the GUI source of truth.

### Create a GUI-visible thread (with optional model / reasoning difficulty)

Use `prepare-gui-new` / `execute-gui-new` when the thread must appear in the desktop task list. `--prompt` is the first message and is required. The thread is created through a V4 `createSession` command with `firstInput`, so the session and its first agent turn are created atomically and the thread is immediately usable.

- Select a model with `--provider <provider-id> --model <model-id>` together. Model IDs are provider-scoped, so both are required.
- Select reasoning difficulty with `--thought-level <level>` (ZCode's "thought level"). Valid values are model-specific; common ones are `low`, `medium`, `high`, `xhigh`, `max`, `nothink`.
- Omit all three to inherit the active GUI draft's provider/model.

**Why this works (and the earlier failure):** ZCode's V4 command channel checks that a command envelope's `clientId` matches the one registered during the connection handshake (variable `T`). A bare `zcodeTaskService.createTask` from CDP produced a task card whose session never initialized, so the thread could not talk. The bridge now calls `zcodeAgentService.sendConversationCommandV4` with `clientId` read from the renderer's own `localStorage["zcode-v4-client-id:v1"]` — the same value the desktop already handshaked — so the guard passes and the session is created for real. This mirrors how the mobile/remote-control feature registers a client before creating threads.

### Set an existing thread's model and reasoning difficulty

Use `prepare-gui-config` / `execute-gui-config` on an existing GUI thread. It calls `zcodeTaskService.setModel` and `setConfigOption` to change the thread's configuration for future turns; it does not start a turn.

- Select a model with `--provider <provider-id> --model <model-id>` together. Model IDs are provider-scoped, so both are required.
- Select reasoning difficulty with `--thought-level <level>`. ZCode calls this a thought level. Valid values are model-specific; read the thread's current options with the GUI or `getTaskConfigOptions` before choosing. Observed values include `low`, `medium`, `high`, `xhigh`, `max`, and `nothink`, but not every model supports all of them.
- Supply at least one of `--model` (with `--provider`) or `--thought-level`.

Run `prepare-gui-config` first; the provider, model, and thought level are part of the confirmation token, so `execute-gui-config` must repeat the same values. The `changes` field in the result echoes the applied values read back from the thread.

### Read a thread's messages (fallback)

Prefer the built-in `#sess_xxx` reference + `ReadSessionContext` tool. Use this skill's `read` command only when you need raw text parts without token summarization, or when `ReadSessionContext` is unavailable.

## Fallback

When `check` fails (ZCode runtime incompatible), do not attempt create, send, or archive. Prepare a manual handoff with the workspace, target session, and intended action for the user to perform in ZCode manually.
