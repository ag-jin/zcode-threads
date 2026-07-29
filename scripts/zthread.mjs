#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const DESKTOP_VERSION = "3.5.3";
const INFO_PLIST = "/Applications/ZCode.app/Contents/Info.plist";
const CLI_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const SESSION_DB = `${homedir()}/.zcode/cli/db/db.sqlite`;
const TASKS_INDEX_DB = `${homedir()}/.zcode/v2/tasks-index.sqlite`;
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PENDING_ACTIONS_DIR = join(SKILL_ROOT, ".pending-actions");
const GUI_BRIDGE_PATH = join(SKILL_ROOT, "scripts", "zthread-gui.mjs");
const GUARD_SCRIPT_PATH = join(SKILL_ROOT, "scripts", "zcode-port-guard.sh");
const GUARD_PLIST_PATH = `${homedir()}/Library/LaunchAgents/com.zcode.portguard.plist`;
const GUARD_LABEL = "com.zcode.portguard";
const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;
const REQUIRED_MARKERS = [
  "app-server",
  "session/list",
  "session/read",
  "session/create",
  "session/send",
];

const HELP = `Usage:
  node zthread.mjs check
  node zthread.mjs list --workspace <absolute-path> [--limit <1-100>]
  node zthread.mjs list-archived --workspace <absolute-path> [--limit <1-100>]
  node zthread.mjs list-deleted --workspace <absolute-path> [--limit <1-100>]
  node zthread.mjs diagnose --workspace <absolute-path> --session <session-id>
  node zthread.mjs read --workspace <absolute-path> --session <session-id> [--turns <1-50>] [--max-chars <1-4000>]
  node zthread.mjs prepare-new --workspace <absolute-path> --prompt <text> [--mode <mode>]
  node zthread.mjs prepare-send --workspace <absolute-path> --session <sess-id> --prompt <text> [--mode <mode>]
  node zthread.mjs execute-new --workspace <absolute-path> --prompt <text> [--mode <mode>] --confirmation <ztc-token>
  node zthread.mjs prepare-gui-new --workspace <absolute-path> --prompt <text> [--provider <id> --model <id>] [--thought-level <level>]
  node zthread.mjs prepare-gui-send --workspace <absolute-path> --session <sess-id> --prompt <text>
  node zthread.mjs prepare-gui-archive --workspace <absolute-path> --session <sess-id>
  node zthread.mjs prepare-gui-unarchive --workspace <absolute-path> --session <sess-id>
  node zthread.mjs prepare-gui-delete --workspace <absolute-path> --session <sess-id>
  node zthread.mjs prepare-gui-config --workspace <absolute-path> --session <sess-id> [--provider <id> --model <id>] [--thought-level <level>]
  node zthread.mjs execute-gui-new --workspace <absolute-path> --prompt <text> [--provider <id> --model <id>] [--thought-level <level>] --confirmation <ztc-token>
  node zthread.mjs execute-gui-send --workspace <absolute-path> --session <sess-id> --prompt <text> --confirmation <ztc-token>
  node zthread.mjs execute-gui-archive --workspace <absolute-path> --session <sess-id> --confirmation <ztc-token>
  node zthread.mjs execute-gui-unarchive --workspace <absolute-path> --session <sess-id> --confirmation <ztc-token>
  node zthread.mjs execute-gui-delete --workspace <absolute-path> --session <sess-id> --confirmation <ztc-token>
  node zthread.mjs execute-gui-config --workspace <absolute-path> --session <sess-id> [--provider <id> --model <id>] [--thought-level <level>] --confirmation <ztc-token>
  node zthread.mjs guard-install | guard-status | guard-uninstall

list, list-archived, list-deleted, diagnose, and read use a read-only SQLite connection. prepare commands do not create a session or start a turn.
execute commands can create a session or start a turn and require the exact token shown by the matching prepare command.
gui commands require a loopback-only ZCode CDP endpoint on port 9333 and run through the active desktop renderer, so successful GUI tasks become immediately visible.`;

class UserError extends Error {}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, details = {}) {
  throw new UserError(message, { cause: details });
}

function parseOptions(argumentsList, allowed) {
  const options = {};

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument.startsWith("--")) {
      fail(`Unexpected argument: ${argument}`);
    }

    const name = argument.slice(2);
    if (!allowed.has(name)) {
      fail(`Unsupported option: --${name}`);
    }
    if (Object.hasOwn(options, name)) {
      fail(`Option may only be supplied once: --${name}`);
    }

    const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Option requires a value: --${name}`);
    }

    options[name] = value;
    index += 1;
  }

  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) {
    fail(`Missing required option: --${name}`);
  }
  return value;
}

function boundedInteger(value, option, fallback, minimum, maximum) {
  if (value === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    fail(`--${option} must be an integer between ${minimum} and ${maximum}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`--${option} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function workspaceFrom(options) {
  const input = required(options, "workspace");
  if (!isAbsolute(input)) {
    fail("--workspace must be an absolute path");
  }

  const workspace = resolve(input);
  let stats;
  try {
    stats = statSync(workspace);
  } catch {
    fail(`Workspace does not exist: ${workspace}`);
  }

  if (!stats.isDirectory()) {
    fail(`Workspace is not a directory: ${workspace}`);
  }
  return workspace;
}

function promptFrom(options) {
  const prompt = required(options, "prompt");
  if (prompt.includes("\0")) {
    fail("--prompt must not contain a null byte");
  }
  return prompt;
}

function modeFrom(options) {
  const mode = options.mode ?? "build";
  if (mode.length > 80 || /[\u0000-\u001f\u007f]/.test(mode)) {
    fail("--mode must be a non-control string of at most 80 characters");
  }
  return mode;
}

function guiSettingFrom(options, name, maximum) {
  const value = options[name];
  if (value === undefined) return undefined;
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`--${name} must be a non-control string of at most ${maximum} characters`);
  }
  return value;
}

function guiNewSettingsFrom(options) {
  const provider = guiSettingFrom(options, "provider", 120);
  const model = guiSettingFrom(options, "model", 200);
  if (Boolean(provider) !== Boolean(model)) {
    fail("--provider and --model must be supplied together for a GUI task");
  }
  const thoughtLevel = guiSettingFrom(options, "thought-level", 80);
  return { provider, model, thoughtLevel };
}

function sessionIdFrom(options, { resumable = false } = {}) {
  const session = required(options, "session");
  const expression = resumable ? /^sess_[A-Za-z0-9._-]+$/ : /^[A-Za-z0-9._-]+$/;
  if (!expression.test(session)) {
    const expected = resumable ? "a resumable sess_ session ID" : "a session ID";
    fail(`--session must be ${expected}`);
  }
  return session;
}

function desktopVersion() {
  if (!existsSync(INFO_PLIST)) {
    fail(`ZCode Info.plist not found: ${INFO_PLIST}`);
  }

  const content = readFileSync(INFO_PLIST, "utf8");
  const match = content.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
  );
  if (!match) {
    fail("Could not read ZCode desktop version from Info.plist");
  }
  return match[1];
}

function capabilities() {
  const version = desktopVersion();
  if (!existsSync(CLI_PATH)) {
    return {
      compatible: false,
      version,
      expectedVersion: DESKTOP_VERSION,
      missingMarkers: REQUIRED_MARKERS,
      reason: `Bundled ZCode runtime not found: ${CLI_PATH}`,
    };
  }

  const runtime = readFileSync(CLI_PATH, "utf8");
  const missingMarkers = REQUIRED_MARKERS.filter((marker) => !runtime.includes(marker));
  const compatible = version === DESKTOP_VERSION && missingMarkers.length === 0;
  const reason = compatible
    ? null
    : version !== DESKTOP_VERSION
      ? `ZCode desktop version ${version} does not match the supported version ${DESKTOP_VERSION}`
      : `Bundled runtime is missing required markers: ${missingMarkers.join(", ")}`;

  return {
    compatible,
    version,
    expectedVersion: DESKTOP_VERSION,
    cliPath: CLI_PATH,
    missingMarkers,
    reason,
  };
}

function manualHandoff({ action, workspace, session, prompt, mode, provider, model, thoughtLevel, reason }) {
  const goal = action === "new"
    ? "在目标工作区新建 ZCode 执行线程。"
    : action === "gui-archive"
      ? "在目标工作区归档 ZCode 执行线程。"
      : action === "gui-unarchive"
        ? "在目标工作区取消归档 ZCode 执行线程。"
        : "向目标 ZCode 执行线程发送消息。";
  return {
    status: "manual-handoff-required",
    reason,
    handoff: [
      "# 执行线程任务包",
      "",
      "- task_card: `未提供`",
      "- board_task_ids: `[]`",
      `- target_project: \`${workspace}\``,
      `- target_thread: \`${session ?? "新建线程"}\``,
      "- dispatch_mode: `manual-paste`",
      `- zcode_mode: \`${mode ?? "未提供"}\``,
      "- plan_review_status: `未提供`",
      "",
      "## 本次目标",
      "",
      goal,
      ...(prompt === undefined
        ? []
        : ["", "## Prompt", "", prompt, ""]),
      "",
      "## 下一步",
      "",
      "在指定工作区手动打开 ZCode，并把以上 prompt 粘贴到目标线程。",
    ].join("\n"),
  };
}

function requireCompatible(action) {
  const check = capabilities();
  if (!check.compatible) {
    const error = new UserError(check.reason ?? "ZCode runtime is incompatible");
    error.capabilities = check;
    error.action = action;
    throw error;
  }
  return check;
}

function openReadOnlyDatabase() {
  if (!existsSync(SESSION_DB)) {
    fail(`ZCode session database not found: ${SESSION_DB}`);
  }
  return new DatabaseSync(SESSION_DB, { readOnly: true });
}

function openReadOnlyTaskIndex() {
  if (!existsSync(TASKS_INDEX_DB)) {
    fail(`ZCode task index not found: ${TASKS_INDEX_DB}`);
  }
  return new DatabaseSync(TASKS_INDEX_DB, { readOnly: true });
}

function taskIndexTask(workspace, session) {
  const database = openReadOnlyTaskIndex();
  try {
    return database
      .prepare(
        `SELECT task_id, workspace_path, archived, deleted, title, created_at, updated_at
         FROM tasks
         WHERE task_id = ? AND workspace_path = ?`,
      )
      .get(session, workspace) ?? null;
  } finally {
    database.close();
  }
}

function findSession(database, workspace, session) {
  return database
    .prepare(
      `SELECT id, title, task_type, parent_id, directory, time_created, time_updated, time_archived
       FROM session
       WHERE id = ? AND directory = ?`,
    )
    .get(session, workspace);
}

function sessionMetadata(row) {
  return {
    id: row.id,
    title: row.title ?? "",
    type: row.task_type ?? null,
    parentId: row.parent_id ?? null,
    workspace: row.directory,
    createdAt: row.time_created ?? null,
    updatedAt: row.time_updated ?? null,
    archivedAt: row.time_archived ?? null,
  };
}

function actionPayload({ action, workspace, session, prompt, mode, provider, model, thoughtLevel }) {
  return {
    action,
    workspace,
    ...(session ? { session } : {}),
    ...(prompt === undefined ? {} : { prompt }),
    ...(mode === undefined ? {} : { mode }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(thoughtLevel === undefined ? {} : { thoughtLevel }),
  };
}

function requestFingerprint(request) {
  return createHash("sha256").update(JSON.stringify(actionPayload(request))).digest("hex");
}

function actionDescriptor(request, confirmation) {
  const payload = actionPayload(request);
  const guiAction = payload.action.startsWith("gui-");
  const createAction = payload.action.endsWith("new");
  const archiveAction = payload.action === "gui-archive" || payload.action === "gui-unarchive";
  const deleteAction = payload.action === "gui-delete";
  const configAction = payload.action === "gui-config";

  const configSummary = [
    ...(payload.model ? [`model=${payload.provider ? `${payload.provider}/` : ""}${payload.model}`] : []),
    ...(payload.thoughtLevel ? [`thought_level=${payload.thoughtLevel}`] : []),
  ].join(", ");

  const sideEffects = configAction
    ? [
        "Connects to the loopback-only ZCode CDP endpoint",
        `Changes the named root task's configuration (${configSummary || "no fields"}) through the active ZCode desktop renderer`,
        "Applies to future turns in that task; does not start a turn",
      ]
    : deleteAction
    ? [
        "Connects to the loopback-only ZCode CDP endpoint",
        "Deletes the named root task through the active ZCode desktop renderer (sets deleted=1)",
        "This is irreversible; the task disappears from both live and archived lists",
      ]
    : archiveAction
    ? [
        "Connects to the loopback-only ZCode CDP endpoint",
        payload.action === "gui-archive"
          ? "Marks the named root task archived through the active ZCode desktop renderer"
          : "Marks the named root task unarchived through the active ZCode desktop renderer",
        "Updates the desktop task index and emits a task_archived/task_unarchived event",
      ]
    : guiAction
      ? createAction
        ? [
            "Connects to the loopback-only ZCode CDP endpoint",
            `Creates a visible root task via V4 createSession${configSummary ? ` (${configSummary})` : ""} through the active ZCode desktop renderer`,
            "Sends the first prompt and starts a ZCode agent turn",
          ]
        : [
            "Connects to the loopback-only ZCode CDP endpoint",
            "Appends a prompt through the active ZCode desktop renderer",
            "Starts a ZCode agent turn in the visible root task",
          ]
      : createAction
        ? ["Starts a headless ZCode turn", "May create a new local ZCode session"]
        : ["Starts a headless ZCode turn in the named existing session", "May append messages to that local ZCode session"];

  return {
    ...payload,
    confirmation,
    sideEffects,
  };
}

function pendingActionPath(confirmation) {
  if (!/^ztc_[A-Za-z0-9_-]{32}$/.test(confirmation)) {
    fail("--confirmation is not a valid prepare token");
  }
  return join(PENDING_ACTIONS_DIR, `${confirmation}.json`);
}

function ensurePendingActionsDirectory() {
  mkdirSync(PENDING_ACTIONS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(PENDING_ACTIONS_DIR, 0o700);
}

function createPendingAction(request) {
  ensurePendingActionsDirectory();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const confirmation = `ztc_${randomBytes(24).toString("base64url")}`;
    const path = pendingActionPath(confirmation);
    const temporaryPath = join(
      PENDING_ACTIONS_DIR,
      `.${confirmation}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const createdAt = Date.now();
    const record = {
      version: 1,
      requestFingerprint: requestFingerprint(request),
      createdAt,
      expiresAt: createdAt + PENDING_ACTION_TTL_MS,
    };

    try {
      writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      linkSync(temporaryPath, path);
      rmSync(temporaryPath, { force: true });
      return { confirmation, expiresAt: record.expiresAt };
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  fail("Could not create a unique confirmation token");
}

function claimPendingAction(confirmation, request) {
  ensurePendingActionsDirectory();
  const pendingPath = pendingActionPath(confirmation);
  const claimedPath = join(
    PENDING_ACTIONS_DIR,
    `.${confirmation}.${process.pid}.${randomBytes(8).toString("hex")}.claim`,
  );

  try {
    try {
      renameSync(pendingPath, claimedPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        fail("Confirmation token was not prepared, has expired, or was already used");
      }
      throw error;
    }

    let record;
    try {
      record = JSON.parse(readFileSync(claimedPath, "utf8"));
    } catch {
      fail("Prepared confirmation record is invalid");
    }

    if (
      record.version !== 1 ||
      typeof record.expiresAt !== "number" ||
      typeof record.requestFingerprint !== "string"
    ) {
      fail("Prepared confirmation record is invalid");
    }
    if (Date.now() > record.expiresAt) {
      fail("Confirmation token expired; run the matching prepare command again");
    }
    if (record.requestFingerprint !== requestFingerprint(request)) {
      fail("Confirmation token does not match this exact action, workspace, session, prompt, and mode");
    }
  } finally {
    rmSync(claimedPath, { force: true });
  }
}

function prepareAction(request) {
  const prepared = createPendingAction(request);
  const descriptor = actionDescriptor(request, prepared.confirmation);

  return {
    status: "confirmation-required",
    ...descriptor,
    expiresAt: new Date(prepared.expiresAt).toISOString(),
    nextCommand:
      request.action.startsWith("gui-")
        ? `execute-${request.action}`
        : request.action === "new"
          ? "execute-new"
          : "execute-send",
    instruction:
      "Do not execute until the user explicitly confirms every field above. The token expires in 15 minutes and is consumed before the action starts.",
  };
}

function verifySessionWorkspace(workspace, session) {
  const database = openReadOnlyDatabase();
  try {
    const row = findSession(database, workspace, session);
    if (!row) {
      fail(`Session ${session} was not found in workspace ${workspace}`);
    }
    return sessionMetadata(row);
  } finally {
    database.close();
  }
}

function desktopState(task) {
  if (task.deleted === 1) return "deleted";
  if (task.archived === 1) return "archived";
  return "active";
}

function verifyGuiTask(workspace, session, expectedState) {
  const task = taskIndexTask(workspace, session);
  const state = task ? desktopState(task) : "missing";
  if (state === "missing") {
    fail(`GUI action requires ${session} to have a desktop task-index record in ${workspace}.`);
  }
  if (expectedState && state !== expectedState) {
    fail(`GUI action requires ${session} to be ${expectedState}; the desktop task index reports ${state}. Run diagnose before changing it.`);
  }
  return task;
}

function verifyGuiRootSession(workspace, session, expectedState) {
  const metadata = verifySessionWorkspace(workspace, session);
  if (metadata.type !== "interactive" || metadata.parentId !== null) {
    fail(
      `GUI action requires a root interactive task; ${session} is ${metadata.type ?? "unknown"} with parent ${metadata.parentId ?? "none"}.`,
    );
  }
  verifyGuiTask(workspace, session, expectedState);
  return metadata;
}

function sessionRowForTask(database, workspace, taskId) {
  return database
    .prepare(
      `SELECT id, title, task_type, parent_id, directory, time_created, time_updated, time_archived
       FROM session
       WHERE id = ? AND directory = ?`,
    )
    .get(taskId, workspace) ?? null;
}

function taskMetadata(task, session) {
  const state = desktopState(task);
  return {
    id: task.task_id,
    title: task.title ?? session?.title ?? "",
    type: session?.task_type ?? null,
    parentId: session?.parent_id ?? null,
    workspace: task.workspace_path,
    createdAt: task.created_at ?? session?.time_created ?? null,
    updatedAt: task.updated_at ?? session?.time_updated ?? null,
    desktopState: state,
    archivedAt: state === "archived" ? task.updated_at ?? null : null,
    inSessionStore: session !== null,
    sessionArchivedAt: session?.time_archived ?? null,
  };
}

function listTasks(workspace, limit, state) {
  const database = openReadOnlyTaskIndex();
  let taskRows;
  try {
    const where = state === "active"
      ? "archived = 0 AND deleted = 0"
      : state === "archived"
        ? "archived = 1 AND deleted = 0"
        : "deleted = 1";
    taskRows = database
      .prepare(
        `SELECT task_id, workspace_path, archived, deleted, title, created_at, updated_at
         FROM tasks
         WHERE workspace_path = ? AND ${where}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(workspace, limit);
  } finally {
    database.close();
  }

  if (taskRows.length === 0) return [];

  const sessionDb = openReadOnlyDatabase();
  try {
    return taskRows.map((task) => taskMetadata(task, sessionRowForTask(sessionDb, workspace, task.task_id)));
  } finally {
    sessionDb.close();
  }
}

function diagnoseSession(workspace, session) {
  const sessionDb = openReadOnlyDatabase();
  let sessionRow;
  try {
    sessionRow = findSession(sessionDb, workspace, session) ?? null;
  } finally {
    sessionDb.close();
  }
  const task = taskIndexTask(workspace, session);
  const taskState = task ? desktopState(task) : null;
  const classification = taskState && !sessionRow
    ? "task-index-only"
    : taskState
      ? `desktop-${taskState}`
      : sessionRow
        ? "session-only"
        : "not-found";
  const guidance = classification === "desktop-active"
    ? "The task index says this thread belongs in the live GUI list. Reopen the workspace or restart ZCode, then diagnose again; do not write either SQLite database."
    : classification === "desktop-archived"
      ? "The task is archived and omitted from the live GUI list. It can be unarchived through prepare-gui-unarchive after explicit user confirmation."
      : classification === "desktop-deleted"
        ? "The desktop task was deleted. Its GUI card cannot be restored; read the preserved session through #sess_ or read when available."
        : classification === "session-only"
          ? "The session exists without a desktop task-index card, typical of a headless CLI session. It can be read or resumed headlessly but not restored as its original GUI card."
          : classification === "task-index-only"
            ? "The desktop task-index record exists without a local session record. Treat this as a local consistency problem; do not delete or rewrite either record."
            : "No session-store record or desktop task-index record exists for this workspace and session ID.";

  return {
    workspace,
    session,
    classification,
    guidance,
    desktopTask: task
      ? {
          id: task.task_id,
          state: taskState,
          title: task.title ?? "",
          createdAt: task.created_at ?? null,
          updatedAt: task.updated_at ?? null,
        }
      : null,
    sessionStore: sessionRow ? sessionMetadata(sessionRow) : null,
    stateMismatch: Boolean(
      taskState
      && sessionRow
      && ((taskState === "archived") !== (sessionRow.time_archived !== null)),
    ),
  };
}

function readSession(workspace, session, turns, maxChars) {
  const database = openReadOnlyDatabase();
  try {
    const sessionRow = findSession(database, workspace, session);
    if (!sessionRow) {
      fail(`Session ${session} was not found in workspace ${workspace}`);
    }

    const newestFirst = database
      .prepare(
        `SELECT COALESCE(json_extract(message.data, '$.role'), '?') AS role,
                json_extract(part.data, '$.text') AS text,
                part.time_created AS created_at,
                part.id AS id
         FROM part
         JOIN message ON message.id = part.message_id
         WHERE part.session_id = ?
           AND json_extract(part.data, '$.type') = 'text'
           AND json_type(part.data, '$.text') = 'text'
         ORDER BY part.time_created DESC, part.id DESC
         LIMIT ?`,
      )
      .all(session, turns);

    const parts = newestFirst.reverse().map((part) => ({
      role: part.role,
      text:
        part.text.length > maxChars
          ? `${part.text.slice(0, maxChars)}...[truncated]`
          : part.text,
      createdAt: part.created_at,
    }));

    return {
      session: sessionMetadata(sessionRow),
      returnedTextParts: parts.length,
      parts,
      omitted: ["reasoning", "tool arguments", "attachments", "non-text parts"],
    };
  } finally {
    database.close();
  }
}

function runGuiAction(descriptor) {
  if (!existsSync(GUI_BRIDGE_PATH)) {
    fail(`ZCode GUI bridge not found: ${GUI_BRIDGE_PATH}`);
  }

  const archiveAction = descriptor.action === "gui-archive" || descriptor.action === "gui-unarchive" || descriptor.action === "gui-delete";
  const configAction = descriptor.action === "gui-config";
  const bridgeAction = archiveAction
    ? descriptor.action === "gui-archive" ? "archive"
      : descriptor.action === "gui-unarchive" ? "unarchive"
      : "delete"
    : configAction ? "config"
    : descriptor.action === "gui-new" ? "new" : "send";
  const args = [
    GUI_BRIDGE_PATH,
    bridgeAction,
    "--workspace",
    descriptor.workspace,
  ];
  if (archiveAction) {
    args.push("--session", descriptor.session);
  } else if (configAction) {
    args.push("--session", descriptor.session);
    if (descriptor.provider !== undefined) args.push("--provider", descriptor.provider);
    if (descriptor.model !== undefined) args.push("--model", descriptor.model);
    if (descriptor.thoughtLevel !== undefined) args.push("--thought-level", descriptor.thoughtLevel);
  } else {
    args.push("--prompt", descriptor.prompt);
    if (bridgeAction === "send") {
      args.push("--session", descriptor.session);
    } else if (bridgeAction === "new") {
      if (descriptor.provider !== undefined) args.push("--provider", descriptor.provider);
      if (descriptor.model !== undefined) args.push("--model", descriptor.model);
      if (descriptor.thoughtLevel !== undefined) args.push("--thought-level", descriptor.thoughtLevel);
    }
  }

  printJson({
    status: "starting-confirmed-gui-action",
    action: descriptor.action,
    workspace: descriptor.workspace,
    ...(descriptor.session ? { session: descriptor.session } : {}),
    ...(descriptor.prompt ? { prompt: descriptor.prompt } : {}),
    ...(descriptor.mode ? { mode: descriptor.mode } : {}),
    ...(descriptor.provider !== undefined ? { provider: descriptor.provider } : {}),
    ...(descriptor.model !== undefined ? { model: descriptor.model } : {}),
    ...(descriptor.thoughtLevel !== undefined ? { thoughtLevel: descriptor.thoughtLevel } : {}),
    cdpPort: 9333,
    sideEffects: descriptor.sideEffects,
  });

  const result = spawnSync(process.execPath, args, {
    cwd: descriptor.workspace,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

function launchctl(argumentsList) {
  const result = spawnSync("/bin/launchctl", argumentsList, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(result.stderr.trim() || `launchctl ${argumentsList.join(" ")} failed`);
  }
  return result.stdout;
}

function guardPlistContent() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${GUARD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${GUARD_SCRIPT_PATH}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${join(SKILL_ROOT, "wakes", "portguard.launchd.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(SKILL_ROOT, "wakes", "portguard.launchd.log")}</string>
</dict>
</plist>
`;
}

function guardInstall() {
  if (!existsSync(GUARD_SCRIPT_PATH)) {
    fail(`ZCode port guard not found: ${GUARD_SCRIPT_PATH}`);
  }
  mkdirSync(dirname(GUARD_PLIST_PATH), { recursive: true, mode: 0o700 });
  mkdirSync(join(SKILL_ROOT, "wakes"), { recursive: true, mode: 0o700 });

  if (existsSync(GUARD_PLIST_PATH)) {
    const existing = readFileSync(GUARD_PLIST_PATH, "utf8");
    if (existing !== guardPlistContent()) {
      fail(`Existing ${GUARD_LABEL} plist is not owned by zcode-threads; refusing to overwrite it`);
    }
  } else {
    writeFileSync(GUARD_PLIST_PATH, guardPlistContent(), { mode: 0o600, flag: "wx" });
  }

  const domain = `gui/${process.getuid()}`;
  try {
    launchctl(["bootout", domain, GUARD_PLIST_PATH]);
  } catch {
    // The job may not have been loaded yet.
  }
  launchctl(["bootstrap", domain, GUARD_PLIST_PATH]);
  printJson({ status: "guard-installed", label: GUARD_LABEL, plist: GUARD_PLIST_PATH, cdpPort: 9333 });
}

function guardStatus() {
  const plistExists = existsSync(GUARD_PLIST_PATH);
  const plistOwned = plistExists && readFileSync(GUARD_PLIST_PATH, "utf8") === guardPlistContent();
  const domain = `gui/${process.getuid()}`;
  const result = spawnSync("/bin/launchctl", ["print", `${domain}/${GUARD_LABEL}`], { encoding: "utf8" });
  printJson({
    label: GUARD_LABEL,
    plist: GUARD_PLIST_PATH,
    plistExists,
    plistOwned,
    loaded: result.status === 0,
    cdpPort: 9333,
  });
}

function guardUninstall() {
  if (!existsSync(GUARD_PLIST_PATH)) {
    printJson({ status: "guard-not-installed", label: GUARD_LABEL });
    return;
  }
  if (readFileSync(GUARD_PLIST_PATH, "utf8") !== guardPlistContent()) {
    fail(`Existing ${GUARD_LABEL} plist is not owned by zcode-threads; refusing to remove it`);
  }
  const domain = `gui/${process.getuid()}`;
  try {
    launchctl(["bootout", domain, GUARD_PLIST_PATH]);
  } catch {
    // The job could already be unloaded.
  }
  rmSync(GUARD_PLIST_PATH);
  printJson({ status: "guard-uninstalled", label: GUARD_LABEL });
}

function runAction(descriptor) {
  const args =
    descriptor.action === "new"
      ? ["--prompt", descriptor.prompt, "--cwd", descriptor.workspace, "--mode", descriptor.mode, "--json"]
      : [
          "--resume",
          descriptor.session,
          "--prompt",
          descriptor.prompt,
          "--cwd",
          descriptor.workspace,
          "--mode",
          descriptor.mode,
          "--json",
        ];

  printJson({
    status: "starting-confirmed-action",
    action: descriptor.action,
    workspace: descriptor.workspace,
    ...(descriptor.session ? { session: descriptor.session } : {}),
    mode: descriptor.mode,
    sideEffects: descriptor.sideEffects,
  });

  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: descriptor.workspace,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

function commandOptions(command, argumentsList) {
  switch (command) {
    case "list":
    case "list-archived":
    case "list-deleted":
      return parseOptions(argumentsList, new Set(["workspace", "limit"]));
    case "diagnose":
      return parseOptions(argumentsList, new Set(["workspace", "session"]));
    case "read":
      return parseOptions(argumentsList, new Set(["workspace", "session", "turns", "max-chars"]));
    case "prepare-new":
    case "execute-new":
      return parseOptions(argumentsList, new Set(["workspace", "prompt", "mode", "confirmation"]));
    case "prepare-send":
    case "execute-send":
      return parseOptions(argumentsList, new Set(["workspace", "session", "prompt", "mode", "confirmation"]));
    case "prepare-gui-new":
    case "execute-gui-new":
      return parseOptions(argumentsList, new Set(["workspace", "prompt", "provider", "model", "thought-level", "confirmation"]));
    case "prepare-gui-config":
    case "execute-gui-config":
      return parseOptions(argumentsList, new Set(["workspace", "session", "provider", "model", "thought-level", "confirmation"]));
    case "prepare-gui-send":
    case "execute-gui-send":
      return parseOptions(argumentsList, new Set(["workspace", "session", "prompt", "confirmation"]));
    case "prepare-gui-archive":
    case "execute-gui-archive":
    case "prepare-gui-unarchive":
    case "execute-gui-unarchive":
    case "prepare-gui-delete":
    case "execute-gui-delete":
      return parseOptions(argumentsList, new Set(["workspace", "session", "confirmation"]));
    case "guard-install":
    case "guard-status":
    case "guard-uninstall":
      if (argumentsList.length > 0) {
        fail(`${command} does not accept options`);
      }
      return {};
    case "check":
      if (argumentsList.length > 0) {
        fail("check does not accept options");
      }
      return {};
    default:
      fail(`Unknown command: ${command}`);
  }
}

function execute(command, options) {
  if (command === "check") {
    const check = capabilities();
    printJson(check);
    if (!check.compatible) {
      process.exitCode = 2;
    }
    return;
  }

  if (command === "list") {
    requireCompatible(command);
    const workspace = workspaceFrom(options);
    const limit = boundedInteger(options.limit, "limit", 20, 1, 100);
    printJson({ workspace, sessions: listTasks(workspace, limit, "active") });
    return;
  }

  if (command === "list-archived") {
    requireCompatible(command);
    const workspace = workspaceFrom(options);
    const limit = boundedInteger(options.limit, "limit", 20, 1, 100);
    printJson({ workspace, archivedSessions: listTasks(workspace, limit, "archived") });
    return;
  }

  if (command === "list-deleted") {
    requireCompatible(command);
    const workspace = workspaceFrom(options);
    const limit = boundedInteger(options.limit, "limit", 20, 1, 100);
    printJson({ workspace, deletedSessions: listTasks(workspace, limit, "deleted") });
    return;
  }

  if (command === "diagnose") {
    requireCompatible(command);
    const workspace = workspaceFrom(options);
    const session = sessionIdFrom(options, { resumable: true });
    printJson(diagnoseSession(workspace, session));
    return;
  }

  if (command === "read") {
    requireCompatible(command);
    const workspace = workspaceFrom(options);
    const session = sessionIdFrom(options);
    const turns = boundedInteger(options.turns, "turns", 8, 1, 50);
    const maxChars = boundedInteger(options["max-chars"], "max-chars", 1200, 1, 4000);
    printJson(readSession(workspace, session, turns, maxChars));
    return;
  }

  if (command === "guard-install") {
    guardInstall();
    return;
  }
  if (command === "guard-status") {
    guardStatus();
    return;
  }
  if (command === "guard-uninstall") {
    guardUninstall();
    return;
  }

  const guiAction = command.includes("gui-");
  const archiveCommand = command === "prepare-gui-archive" || command === "execute-gui-archive"
    || command === "prepare-gui-unarchive" || command === "execute-gui-unarchive"
    || command === "prepare-gui-delete" || command === "execute-gui-delete";
  const configCommand = command === "prepare-gui-config" || command === "execute-gui-config";
  let action;
  if (archiveCommand) {
    action = command.includes("unarchive") ? "gui-unarchive"
      : command.includes("delete") ? "gui-delete"
      : "gui-archive";
  } else if (configCommand) {
    action = "gui-config";
  } else if (command.endsWith("new")) {
    action = guiAction ? "gui-new" : "new";
  } else {
    action = guiAction ? "gui-send" : "send";
  }
  const workspace = workspaceFrom(options);
  const prompt = (archiveCommand || configCommand) ? undefined : promptFrom(options);
  const mode = (guiAction || archiveCommand || configCommand) ? undefined : modeFrom(options);
  const session = (action.endsWith("send") || archiveCommand || configCommand) ? sessionIdFrom(options, { resumable: true }) : undefined;
  const guiConfigSettings = (configCommand || action === "gui-new") ? guiNewSettingsFrom(options) : {};
  if (configCommand && guiConfigSettings.model === undefined && guiConfigSettings.thoughtLevel === undefined) {
    fail("gui-config requires --model (with --provider) and/or --thought-level");
  }
  const request = {
    action,
    workspace,
    session,
    ...(prompt ? { prompt } : {}),
    ...(mode ? { mode } : {}),
    ...guiConfigSettings,
  };

  try {
    requireCompatible(command);
  } catch (error) {
    if (error.capabilities) {
      printJson({
        capabilities: error.capabilities,
        ...manualHandoff({
          ...request,
          reason: error.message,
        }),
      });
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (action.endsWith("send")) {
    if (action === "gui-send") {
      verifyGuiTask(workspace, session, "active");
    } else {
      verifySessionWorkspace(workspace, session);
    }
  } else if (configCommand) {
    verifyGuiRootSession(workspace, session, "active");
  } else if (archiveCommand) {
    if (action === "gui-delete") {
      verifyGuiTask(workspace, session, undefined);
    } else {
      const expectedState = action === "gui-archive"
        ? "active"
        : action === "gui-unarchive"
          ? "archived"
          : undefined;
      verifyGuiRootSession(workspace, session, expectedState);
    }
  }

  if (command.startsWith("prepare-")) {
    printJson(prepareAction(request));
    return;
  }

  const confirmation = required(options, "confirmation");
  claimPendingAction(confirmation, request);
  const descriptor = actionDescriptor(request, confirmation);
  if (action.startsWith("gui-")) {
    runGuiAction(descriptor);
    return;
  }
  runAction(descriptor);
}

function main() {
  const [command, ...argumentsList] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  try {
    const options = commandOptions(command, argumentsList);
    execute(command, options);
  } catch (error) {
    if (error instanceof UserError) {
      process.stderr.write(`zcode-threads: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`zcode-threads: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}

main();
