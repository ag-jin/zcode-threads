#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const DESKTOP_VERSION = "3.5.3";
const INFO_PLIST = "/Applications/ZCode.app/Contents/Info.plist";
const TASKS_INDEX_DB = `${homedir()}/.zcode/v2/tasks-index.sqlite`;
const SESSION_DB = `${homedir()}/.zcode/cli/db/db.sqlite`;
const PORT = 9333;
const REQUEST_TIMEOUT_MS = 5000;
const INDEX_TIMEOUT_MS = 5000;

class UserError extends Error {}

function fail(message) {
  throw new UserError(message);
}

function parseArguments(argumentsList) {
  const [action, ...optionsList] = argumentsList;
  const validActions = ["new", "send", "probe", "archive", "unarchive", "delete", "config"];
  if (!validActions.includes(action)) {
    fail(`Expected action: ${validActions.join(", ")}`);
  }

  const options = {};
  const allowed = action === "probe"
    ? new Set(["workspace"])
    : action === "config"
      ? new Set(["workspace", "session", "provider", "model", "thought-level"])
      : action === "new"
        ? new Set(["workspace", "prompt", "provider", "model", "thought-level"])
        : new Set(["workspace", "prompt", "session"]);
  for (let index = 0; index < optionsList.length; index += 1) {
    const argument = optionsList[index];
    if (!argument.startsWith("--")) {
      fail(`Unexpected argument: ${argument}`);
    }

    const name = argument.slice(2);
    if (!allowed.has(name) || Object.hasOwn(options, name)) {
      fail(`Unsupported or duplicate option: --${name}`);
    }
    const value = optionsList[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Option requires a value: --${name}`);
    }
    options[name] = value;
    index += 1;
  }

  if (!options.workspace) {
    fail("Missing required option: --workspace");
  }
  if ((action === "new" || action === "send") && !options.prompt) {
    fail("Missing required option: --prompt");
  }
  if ((action === "config" || action === "send" || action === "archive" || action === "unarchive" || action === "delete") && !options.session) {
    fail("Missing required option: --session");
  }
  const { ["thought-level"]: thoughtLevel, ...rest } = options;
  return { action, ...rest, thoughtLevel };
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
    fail("Could not determine the installed ZCode version");
  }
  return match[1];
}

function assertCompatibleDesktop() {
  const version = desktopVersion();
  if (version !== DESKTOP_VERSION) {
    fail(`ZCode ${version} is unsupported; this bridge requires ${DESKTOP_VERSION}`);
  }
}

function listenerRecords() {
  let output;
  try {
    output = execFileSync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-Fpcn"],
      { encoding: "utf8", timeout: REQUEST_TIMEOUT_MS },
    );
  } catch (error) {
    if (error.status === 1) {
      fail(`No process is listening on 127.0.0.1:${PORT}`);
    }
    throw error;
  }

  const records = [];
  let current = {};
  for (const line of output.split("\n")) {
    if (!line) continue;
    const key = line[0];
    const value = line.slice(1);
    if (key === "p") {
      if (current.pid) records.push(current);
      current = { pid: value, names: [] };
    } else if (key === "c") {
      current.command = value;
    } else if (key === "n") {
      current.names.push(value);
    }
  }
  if (current.pid) records.push(current);
  return records;
}

function assertLoopbackZCodeListener() {
  const records = listenerRecords();
  const matches = records.filter((record) =>
    record.names.some((name) => name === `127.0.0.1:${PORT}` || name === `[::1]:${PORT}`),
  );
  if (matches.length !== 1) {
    fail(`Expected exactly one loopback listener on port ${PORT}; found ${matches.length}`);
  }

  const record = matches[0];
  let executable;
  let processName;
  try {
    executable = execFileSync(
      "/bin/ps",
      ["-p", record.pid, "-o", "command="],
      { encoding: "utf8", timeout: REQUEST_TIMEOUT_MS },
    ).trim();
    processName = execFileSync(
      "/bin/ps",
      ["-p", record.pid, "-o", "comm="],
      { encoding: "utf8", timeout: REQUEST_TIMEOUT_MS },
    ).trim();
  } catch {
    fail(`Could not inspect the CDP listener process ${record.pid}`);
  }
  if (
    !executable.includes("/Applications/ZCode.app/Contents/MacOS/ZCode") &&
    processName !== "ZCode"
  ) {
    fail(`CDP listener ${record.pid} is not the installed ZCode desktop process`);
  }
  return { pid: record.pid, executable, processName };
}

async function fetchJson(path) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail(`Cannot reach the ZCode CDP endpoint on port ${PORT}: ${error.message}`);
  }
  if (!response.ok) {
    fail(`ZCode CDP endpoint returned HTTP ${response.status} for ${path}`);
  }
  return response.json();
}

async function cdpTargets() {
  const version = await fetchJson("/json/version");
  const browserIdentity = [version.Browser, version["User-Agent"], version.UserAgent]
    .filter(Boolean)
    .join(" ");
  if (!/ZCode/i.test(browserIdentity)) {
    fail("CDP endpoint did not identify itself as ZCode");
  }

  const targets = await fetchJson("/json/list");
  if (!Array.isArray(targets)) {
    fail("ZCode CDP target list is invalid");
  }
  return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to ZCode renderer")), REQUEST_TIMEOUT_MS);
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Could not connect to ZCode renderer"));
      }, { once: true });
    });

    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("ZCode renderer CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  command(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.error) {
      throw new Error(`CDP Runtime.evaluate failed: ${response.error.message ?? JSON.stringify(response.error)}`);
    }
    if (response.result?.exceptionDetails) {
      throw new Error(`ZCode renderer evaluation failed: ${response.result.exceptionDetails.text ?? "unknown exception"}`);
    }
    return response.result?.result?.value;
  }

  close() {
    this.socket.close();
  }
}

const SERVICE_PROBE = `
  (function () {
    const root = document.getElementById("root");
    const fiberKey = root && Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
    if (!fiberKey) return { found: false, reason: "no-react-root" };

    const directWorkspaceValues = (source) => [
      source?.workspacePath,
      source?.workspaceKey,
      source?.workspace?.path,
      source?.workspace?.directory,
      source?.workspaceState?.path,
    ].filter((value) => typeof value === "string");

    const absolutePaths = (source) => {
      const values = new Set();
      const seen = new Set();
      const queue = [{ value: source, depth: 0 }];
      while (queue.length && seen.size < 3000) {
        const { value, depth } = queue.shift();
        if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
        seen.add(value);
        let descriptors;
        try {
          descriptors = Object.getOwnPropertyDescriptors(value);
        } catch {
          continue;
        }
        for (const descriptor of Object.values(descriptors)) {
          if (!("value" in descriptor)) continue;
          const child = descriptor.value;
          if (typeof child === "string" && child.startsWith("/")) values.add(child);
          if (depth < 4 && child && (typeof child === "object" || typeof child === "function")) {
            queue.push({ value: child, depth: depth + 1 });
          }
        }
      }
      return [...values].sort();
    };

    const seen = new Set();
    const queue = [root[fiberKey]];
    const candidates = [];
    while (queue.length && seen.size < 120000) {
      const fiber = queue.shift();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      const scoped = props && props.workspaceScopedServices;
      const taskService = scoped && scoped.zcodeTaskService;
      if (taskService) {
        const scope = [];
        let ancestor = fiber;
        for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.return) {
          scope.push(ancestor.memoizedProps, ancestor.memoizedState);
        }
        const draftOptions = [props, ...scope]
          .map((value) => {
            const draft = value?.draftOptions;
            if (!draft || typeof draft !== "object") return null;
            const provider = typeof draft.provider === "string" ? draft.provider : undefined;
            const model = typeof draft.model === "string" && draft.model !== "default" ? draft.model : undefined;
            return provider || model ? { provider, model } : null;
          })
          .find(Boolean);
        const workspaceIdentity = typeof props?.workspaceIdentity === "string"
          ? props.workspaceIdentity
          : typeof scoped?.workspaceIdentity === "string"
            ? scoped.workspaceIdentity
            : null;
        candidates.push({
          workspaceCandidates: [...new Set([
            ...directWorkspaceValues(props),
            ...directWorkspaceValues(scoped),
            ...directWorkspaceValues(taskService),
            ...scope.flatMap((value) => directWorkspaceValues(value)),
            ...absolutePaths([props, scoped, taskService, ...scope]),
          ])].sort(),
          workspaceIdentity,
          draftOptions,
          canCreateTask: typeof taskService.createTask === "function",
          canSendPrompt: typeof taskService.sendPrompt === "function",
        });
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return { found: candidates.length > 0, candidates };
  })()
`;

function invocationExpression({ action, workspace, prompt, session }) {
  const request = JSON.stringify({ action, workspace, prompt, session });
  return `
    (async function () {
      const request = ${request};
      const root = document.getElementById("root");
      const fiberKey = root && Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
      if (!fiberKey) return { error: "no-react-root" };

      const directWorkspaceValues = (source) => [
        source?.workspacePath,
        source?.workspaceKey,
        source?.workspace?.path,
        source?.workspace?.directory,
        source?.workspaceState?.path,
      ].filter((value) => typeof value === "string");
      const directDraftOptions = (source) => {
        const draft = source?.draftOptions;
        if (!draft || typeof draft !== "object") return null;
        const provider = typeof draft.provider === "string" ? draft.provider : undefined;
        const model = typeof draft.model === "string" && draft.model !== "default" ? draft.model : undefined;
        return provider || model ? { provider, model } : null;
      };
      const absolutePaths = (source) => {
        const values = new Set();
        const seenObjects = new Set();
        const objectQueue = [{ value: source, depth: 0 }];
        while (objectQueue.length && seenObjects.size < 3000) {
          const { value, depth } = objectQueue.shift();
          if (!value || (typeof value !== "object" && typeof value !== "function") || seenObjects.has(value)) continue;
          seenObjects.add(value);
          let descriptors;
          try {
            descriptors = Object.getOwnPropertyDescriptors(value);
          } catch {
            continue;
          }
          for (const descriptor of Object.values(descriptors)) {
            if (!("value" in descriptor)) continue;
            const child = descriptor.value;
            if (typeof child === "string" && child.startsWith("/")) values.add(child);
            if (depth < 4 && child && (typeof child === "object" || typeof child === "function")) {
              objectQueue.push({ value: child, depth: depth + 1 });
            }
          }
        }
        return [...values];
      };
      const seen = new Set();
      const queue = [root[fiberKey]];
      const matchingServices = new Map();
      while (queue.length && seen.size < 120000) {
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        const scoped = props && props.workspaceScopedServices;
        const candidate = scoped && scoped.zcodeTaskService;
        if (candidate) {
          const scope = [];
          let ancestor = fiber;
          for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.return) {
            scope.push(ancestor.memoizedProps, ancestor.memoizedState);
          }
          const workspaces = new Set([
            ...directWorkspaceValues(props),
            ...directWorkspaceValues(scoped),
            ...directWorkspaceValues(candidate),
            ...scope.flatMap((value) => directWorkspaceValues(value)),
            ...absolutePaths([props, scoped, candidate, ...scope]),
          ]);
          if (workspaces.has(request.workspace)) {
            const draftOptions = [props, ...scope]
              .map((value) => directDraftOptions(value))
              .find(Boolean);
            const workspaceIdentity = typeof props?.workspaceIdentity === "string"
              ? props.workspaceIdentity
              : typeof scoped?.workspaceIdentity === "string"
                ? scoped.workspaceIdentity
                : null;
            matchingServices.set(candidate, { draftOptions, workspaceIdentity });
          }
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      if (matchingServices.size > 1) return { error: "multiple-matching-task-services" };
      const match = matchingServices.values().next().value;
      if (!match) return { error: "no-unique-workspace-task-service" };
      const taskService = [...matchingServices.keys()][0];
      try {
        if (request.action === "new") {
          const provider = match.draftOptions?.provider;
          const model = match.draftOptions?.model && match.draftOptions.model !== "default" ? match.draftOptions.model : undefined;
          const task = await taskService.createTask({
            workspacePath: request.workspace,
            ...(match.workspaceIdentity ? { workspaceIdentity: match.workspaceIdentity } : {}),
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
          });
          if (!task || !task.taskId) return { error: "createTask returned no taskId" };
          return { taskId: task.taskId, workspaceIdentity: task.workspaceIdentity || match.workspaceIdentity };
        }
        return { taskId: request.session, workspaceIdentity: match.workspaceIdentity };
      } catch (error) {
        return { error: String(error && error.message || error) };
      }
    })()
  `;
}

function createSessionExpression({ workspace, prompt, provider, model, thoughtLevel }) {
  const request = JSON.stringify({ workspace, prompt, provider, model, thoughtLevel });
  return `
    (async function () {
      const request = ${request};
      const root = document.getElementById("root");
      const fiberKey = root && Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
      if (!fiberKey) return { error: "no-react-root" };

      const directWorkspaceValues = (source) => [
        source?.workspacePath,
        source?.workspaceKey,
        source?.workspace?.path,
        source?.workspace?.directory,
        source?.workspaceState?.path,
      ].filter((value) => typeof value === "string");
      const directDraftOptions = (source) => {
        const draft = source?.draftOptions;
        if (!draft || typeof draft !== "object") return null;
        const provider = typeof draft.provider === "string" ? draft.provider : undefined;
        const model = typeof draft.model === "string" && draft.model !== "default" ? draft.model : undefined;
        return provider || model ? { provider, model } : null;
      };
      const absolutePaths = (source) => {
        const values = new Set();
        const seenObjects = new Set();
        const objectQueue = [{ value: source, depth: 0 }];
        while (objectQueue.length && seenObjects.size < 3000) {
          const { value, depth } = objectQueue.shift();
          if (!value || (typeof value !== "object" && typeof value !== "function") || seenObjects.has(value)) continue;
          seenObjects.add(value);
          let descriptors;
          try {
            descriptors = Object.getOwnPropertyDescriptors(value);
          } catch {
            continue;
          }
          for (const descriptor of Object.values(descriptors)) {
            if (!("value" in descriptor)) continue;
            const child = descriptor.value;
            if (typeof child === "string" && child.startsWith("/")) values.add(child);
            if (depth < 4 && child && (typeof child === "object" || typeof child === "function")) {
              objectQueue.push({ value: child, depth: depth + 1 });
            }
          }
        }
        return [...values];
      };
      const seen = new Set();
      const queue = [root[fiberKey]];
      const matchingAgents = new Map();
      while (queue.length && seen.size < 120000) {
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        const scoped = props && props.workspaceScopedServices;
        const agent = scoped && scoped.zcodeAgentService;
        if (agent) {
          const scope = [];
          let ancestor = fiber;
          for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.return) {
            scope.push(ancestor.memoizedProps, ancestor.memoizedState);
          }
          const workspaces = new Set([
            ...directWorkspaceValues(props),
            ...directWorkspaceValues(scoped),
            ...directWorkspaceValues(agent),
            ...scope.flatMap((value) => directWorkspaceValues(value)),
            ...absolutePaths([props, scoped, agent, ...scope]),
          ]);
          if (workspaces.has(request.workspace)) {
            const draftOptions = [props, ...scope].map((value) => directDraftOptions(value)).find(Boolean);
            const workspaceIdentity = typeof props?.workspaceIdentity === "string"
              ? props.workspaceIdentity
              : typeof scoped?.workspaceIdentity === "string"
                ? scoped.workspaceIdentity
                : null;
            matchingAgents.set(agent, { draftOptions, workspaceIdentity });
          }
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      if (matchingAgents.size > 1) return { error: "multiple-matching-agent-services" };
      const match = matchingAgents.values().next().value;
      if (!match) return { error: "no-unique-workspace-agent-service" };
      const agent = [...matchingAgents.keys()][0];

      const clientId = (() => { try { return localStorage.getItem("zcode-v4-client-id:v1"); } catch { return null; } })();
      if (!clientId) return { error: "no-registered-client-id" };
      if (typeof agent.sendConversationCommandV4 !== "function") return { error: "agent-missing-sendConversationCommandV4" };

      const provider = request.provider ?? match.draftOptions?.provider;
      let modelId = request.model && request.model !== "default" ? request.model : match.draftOptions?.model;
      if (modelId && modelId.indexOf("/") > 0) modelId = modelId.slice(modelId.indexOf("/") + 1);
      const workspaceId = (match.workspaceIdentity && match.workspaceIdentity.trim()) || request.workspace;

      const config = {
        ...(provider ? { provider } : {}),
        ...(modelId ? { model: modelId } : {}),
        ...(request.thoughtLevel ? { thought: request.thoughtLevel } : {}),
      };
      const envelope = {
        commandId: crypto.randomUUID(),
        clientId,
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId,
          firstInput: { text: request.prompt },
          ...(Object.keys(config).length ? { config } : {}),
        },
        issuedAt: Date.now(),
      };
      try {
        const res = await agent.sendConversationCommandV4({
          workspacePath: request.workspace,
          ...(match.workspaceIdentity ? { workspaceIdentity: match.workspaceIdentity } : {}),
          envelope,
        });
        const sessionId = res?.result?.sessionId ?? res?.sessionId;
        if (res?.status !== "accepted" || !sessionId) {
          return { error: "createSession not accepted: " + JSON.stringify(res).slice(0, 300) };
        }
        return { taskId: sessionId, workspaceIdentity: match.workspaceIdentity };
      } catch (error) {
        return { error: String(error && error.message || error) };
      }
    })()
  `;
}

function sendPromptExpression({ workspace, prompt, session, workspaceIdentity, traceId }) {
  const request = JSON.stringify({ workspace, prompt, session, workspaceIdentity, traceId });
  return `
    (async function () {
      const request = ${request};
      const root = document.getElementById("root");
      const fiberKey = root && Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
      if (!fiberKey) return { error: "no-react-root" };

      const directWorkspaceValues = (source) => [
        source?.workspacePath,
        source?.workspaceKey,
        source?.workspace?.path,
        source?.workspace?.directory,
        source?.workspaceState?.path,
      ].filter((value) => typeof value === "string");
      const absolutePaths = (source) => {
        const values = new Set();
        const seenObjects = new Set();
        const objectQueue = [{ value: source, depth: 0 }];
        while (objectQueue.length && seenObjects.size < 3000) {
          const { value, depth } = objectQueue.shift();
          if (!value || (typeof value !== "object" && typeof value !== "function") || seenObjects.has(value)) continue;
          seenObjects.add(value);
          let descriptors;
          try {
            descriptors = Object.getOwnPropertyDescriptors(value);
          } catch {
            continue;
          }
          for (const descriptor of Object.values(descriptors)) {
            if (!("value" in descriptor)) continue;
            const child = descriptor.value;
            if (typeof child === "string" && child.startsWith("/")) values.add(child);
            if (depth < 4 && child && (typeof child === "object" || typeof child === "function")) {
              objectQueue.push({ value: child, depth: depth + 1 });
            }
          }
        }
        return [...values];
      };
      const seen = new Set();
      const queue = [root[fiberKey]];
      const matchingServices = new Map();
      while (queue.length && seen.size < 120000) {
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        const scoped = props && props.workspaceScopedServices;
        const candidate = scoped && scoped.zcodeTaskService;
        if (candidate) {
          const scope = [];
          let ancestor = fiber;
          for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.return) {
            scope.push(ancestor.memoizedProps, ancestor.memoizedState);
          }
          const workspaces = new Set([
            ...directWorkspaceValues(props),
            ...directWorkspaceValues(scoped),
            ...directWorkspaceValues(candidate),
            ...scope.flatMap((value) => directWorkspaceValues(value)),
            ...absolutePaths([props, scoped, candidate, ...scope]),
          ]);
          if (workspaces.has(request.workspace)) {
            const workspaceIdentity = typeof props?.workspaceIdentity === "string"
              ? props.workspaceIdentity
              : typeof scoped?.workspaceIdentity === "string"
                ? scoped.workspaceIdentity
                : null;
            matchingServices.set(candidate, workspaceIdentity);
          }
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      if (matchingServices.size > 1) return { error: "multiple-matching-task-services" };
      const taskService = [...matchingServices.keys()][0];
      const matchedWorkspaceIdentity = matchingServices.get(taskService);
      if (!taskService) return { error: "no-unique-workspace-task-service" };
      if (matchedWorkspaceIdentity !== request.workspaceIdentity) {
        return { error: "workspace-identity-changed-before-send" };
      }
      try {
        await taskService.sendPrompt({
          taskId: request.session,
          traceId: request.traceId,
          content: request.prompt,
        });
        return { taskId: request.session };
      } catch (error) {
        return { error: String(error && error.message || error) };
      }
    })()
  `;
}

function archiveTaskExpression({ workspace, session, action, workspaceIdentity }) {
  const request = JSON.stringify({ workspace, session, action, workspaceIdentity });
  return `
    (async function () {
      const request = ${request};
      const root = document.getElementById("root");
      const fiberKey = root && Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
      if (!fiberKey) return { error: "no-react-root" };

      const directWorkspaceValues = (source) => [
        source?.workspacePath,
        source?.workspaceKey,
        source?.workspace?.path,
        source?.workspace?.directory,
        source?.workspaceState?.path,
      ].filter((value) => typeof value === "string");
      const absolutePaths = (source) => {
        const values = new Set();
        const seenObjects = new Set();
        const objectQueue = [{ value: source, depth: 0 }];
        while (objectQueue.length && seenObjects.size < 3000) {
          const { value, depth } = objectQueue.shift();
          if (!value || (typeof value !== "object" && typeof value !== "function") || seenObjects.has(value)) continue;
          seenObjects.add(value);
          let descriptors;
          try {
            descriptors = Object.getOwnPropertyDescriptors(value);
          } catch {
            continue;
          }
          for (const descriptor of Object.values(descriptors)) {
            if (!("value" in descriptor)) continue;
            const child = descriptor.value;
            if (typeof child === "string" && child.startsWith("/")) values.add(child);
            if (depth < 4 && child && (typeof child === "object" || typeof child === "function")) {
              objectQueue.push({ value: child, depth: depth + 1 });
            }
          }
        }
        return [...values];
      };
      const seen = new Set();
      const queue = [root[fiberKey]];
      const matchingServices = new Map();
      while (queue.length && seen.size < 120000) {
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        const scoped = props && props.workspaceScopedServices;
        const candidate = scoped && scoped.zcodeTaskService;
        if (candidate) {
          const scope = [];
          let ancestor = fiber;
          for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.return) {
            scope.push(ancestor.memoizedProps, ancestor.memoizedState);
          }
          const workspaces = new Set([
            ...directWorkspaceValues(props),
            ...directWorkspaceValues(scoped),
            ...directWorkspaceValues(candidate),
            ...scope.flatMap((value) => directWorkspaceValues(value)),
            ...absolutePaths([props, scoped, candidate, ...scope]),
          ]);
          if (workspaces.has(request.workspace)) {
            const identity = typeof props?.workspaceIdentity === "string"
              ? props.workspaceIdentity
              : typeof scoped?.workspaceIdentity === "string"
                ? scoped.workspaceIdentity
                : null;
            matchingServices.set(candidate, identity);
          }
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      if (matchingServices.size > 1) return { error: "multiple-matching-task-services" };
      const taskService = [...matchingServices.keys()][0];
      const matchedIdentity = matchingServices.get(taskService);
      if (!taskService) return { error: "no-unique-workspace-task-service" };
      if (request.workspaceIdentity !== undefined && matchedIdentity !== request.workspaceIdentity) {
        return { error: "workspace-identity-changed-before-archive" };
      }
      const methodName = request.action === "unarchive"
        ? "unarchiveTask"
        : request.action === "delete"
          ? "deleteTask"
          : "archiveTask";
      if (typeof taskService[methodName] !== "function") {
        return { error: "task-service-missing-method", methodName };
      }
      try {
        const payload = {
          taskId: request.session,
          workspacePath: request.workspace,
          ...(matchedIdentity ? { workspaceIdentity: matchedIdentity } : {}),
        };
        if (request.action === "delete") {
          await taskService[methodName](payload);
          return { taskId: request.session, deleted: true };
        }
        const updated = await taskService[methodName](payload);
        return { taskId: request.session, archived: request.action !== "unarchive", updated };
      } catch (error) {
        return { error: String(error && error.message || error) };
      }
    })()
  `;
}

function configTaskExpression({ workspace, session, provider, model, thoughtLevel }) {
  const request = JSON.stringify({ workspace, session, provider, model, thoughtLevel });
  return `
    (async function () {
      const request = ${request};
      const root = document.getElementById("root");
      const fiberKey = root && Object.keys(root).find((key) => key.startsWith("__reactContainer$"));
      if (!fiberKey) return { error: "no-react-root" };

      const directWorkspaceValues = (source) => [
        source?.workspacePath,
        source?.workspaceKey,
        source?.workspace?.path,
        source?.workspace?.directory,
        source?.workspaceState?.path,
      ].filter((value) => typeof value === "string");
      const absolutePaths = (source) => {
        const values = new Set();
        const seenObjects = new Set();
        const objectQueue = [{ value: source, depth: 0 }];
        while (objectQueue.length && seenObjects.size < 3000) {
          const { value, depth } = objectQueue.shift();
          if (!value || (typeof value !== "object" && typeof value !== "function") || seenObjects.has(value)) continue;
          seenObjects.add(value);
          let descriptors;
          try {
            descriptors = Object.getOwnPropertyDescriptors(value);
          } catch {
            continue;
          }
          for (const descriptor of Object.values(descriptors)) {
            if (!("value" in descriptor)) continue;
            const child = descriptor.value;
            if (typeof child === "string" && child.startsWith("/")) values.add(child);
            if (depth < 4 && child && (typeof child === "object" || typeof child === "function")) {
              objectQueue.push({ value: child, depth: depth + 1 });
            }
          }
        }
        return [...values];
      };
      const seen = new Set();
      const queue = [root[fiberKey]];
      const matchingServices = new Map();
      while (queue.length && seen.size < 120000) {
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        const scoped = props && props.workspaceScopedServices;
        const candidate = scoped && scoped.zcodeTaskService;
        if (candidate) {
          const scope = [];
          let ancestor = fiber;
          for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.return) {
            scope.push(ancestor.memoizedProps, ancestor.memoizedState);
          }
          const workspaces = new Set([
            ...directWorkspaceValues(props),
            ...directWorkspaceValues(scoped),
            ...directWorkspaceValues(candidate),
            ...scope.flatMap((value) => directWorkspaceValues(value)),
            ...absolutePaths([props, scoped, candidate, ...scope]),
          ]);
          if (workspaces.has(request.workspace)) {
            const identity = typeof props?.workspaceIdentity === "string"
              ? props.workspaceIdentity
              : typeof scoped?.workspaceIdentity === "string"
                ? scoped.workspaceIdentity
                : null;
            matchingServices.set(candidate, identity);
          }
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      if (matchingServices.size > 1) return { error: "multiple-matching-task-services" };
      const taskService = [...matchingServices.keys()][0];
      if (!taskService) return { error: "no-unique-workspace-task-service" };

      const changes = {};
      try {
        if (request.model) {
          if (typeof taskService.setModel !== "function") return { error: "task-service-missing-setModel" };
          const modelRef = request.provider
            ? { providerId: request.provider, modelId: request.model }
            : (() => {
                const sep = request.model.indexOf("/");
                return sep > 0
                  ? { providerId: request.model.slice(0, sep), modelId: request.model.slice(sep + 1) }
                  : { providerId: "glm", modelId: request.model };
              })();
          const opts = await taskService.setModel({
            taskId: request.session,
            workspacePath: request.workspace,
            modelRef,
          });
          const modelOpt = opts?.find((o) => o.id === "model");
          changes.model = modelOpt?.currentValue ?? null;
        }
        if (request.thoughtLevel) {
          if (typeof taskService.setConfigOption !== "function") return { error: "task-service-missing-setConfigOption" };
          await taskService.setConfigOption({
            taskId: request.session,
            workspacePath: request.workspace,
            configId: "thought_level",
            value: request.thoughtLevel,
            traceId: crypto.randomUUID(),
          });
          const opts = await taskService.getTaskConfigOptions({
            taskId: request.session,
            workspacePath: request.workspace,
          });
          const tlOpt = opts?.find((o) => o.id === "thought_level");
          changes.thoughtLevel = tlOpt?.currentValue ?? null;
        }
        return { taskId: request.session, changes };
      } catch (error) {
        return { error: String(error && error.message || error), changes };
      }
    })()
  `;
}

async function probeWorkspaceRenderers(workspace) {
  const pages = await cdpTargets();
  const reports = [];

  for (const page of pages) {
    const connection = new CdpConnection(page.webSocketDebuggerUrl);
    try {
      await connection.open();
      const probe = await connection.evaluate(SERVICE_PROBE);
      const services = (probe?.candidates ?? []).map((candidate) => ({
        workspaceCandidates: candidate.workspaceCandidates,
        workspaceIdentity: candidate.workspaceIdentity,
        draftOptions: candidate.draftOptions,
        canCreateTask: candidate.canCreateTask,
        canSendPrompt: candidate.canSendPrompt,
      }));
      const matchingServices = services.filter((candidate) =>
        candidate.canCreateTask && candidate.canSendPrompt && candidate.workspaceCandidates.includes(workspace),
      );
      reports.push({
        targetId: page.id,
        title: page.title || null,
        reactRootFound: probe?.found === true,
        serviceCount: services.length,
        matchingServiceCount: matchingServices.length,
        services,
      });
    } catch (error) {
      reports.push({
        targetId: page.id,
        title: page.title || null,
        error: error.message,
      });
    } finally {
      connection.close();
    }
  }

  return reports;
}

async function selectWorkspaceRenderer(workspace) {
  const pages = await cdpTargets();
  const candidates = [];

  for (const page of pages) {
    const connection = new CdpConnection(page.webSocketDebuggerUrl);
    try {
      await connection.open();
      const probe = await connection.evaluate(SERVICE_PROBE);
      const matchingServices = (probe?.candidates ?? []).filter((candidate) =>
        candidate.canCreateTask && candidate.canSendPrompt && candidate.workspaceCandidates.includes(workspace),
      );
      if (matchingServices.length > 0) {
        candidates.push({ page, connection, matchingServices: matchingServices.length });
      } else {
        connection.close();
      }
    } catch {
      connection.close();
    }
  }

  if (candidates.length !== 1 || candidates[0].matchingServices !== 1) {
    for (const candidate of candidates) candidate.connection.close();
    fail(`Expected exactly one ZCode renderer and task service for workspace ${workspace}; found ${candidates.length}`);
  }
  return candidates[0].connection;
}

function taskIndexEntry(taskId, workspace) {
  if (!existsSync(TASKS_INDEX_DB)) {
    fail(`ZCode task index not found: ${TASKS_INDEX_DB}`);
  }
  const database = new DatabaseSync(TASKS_INDEX_DB, { readOnly: true });
  try {
    return database.prepare(
      `SELECT task_id, workspace_path, archived, deleted
       FROM tasks
       WHERE task_id = ? AND workspace_path = ?`,
    ).get(taskId, workspace);
  } finally {
    database.close();
  }
}

function rootInteractiveSessionEntry(taskId, workspace) {
  if (!existsSync(SESSION_DB)) {
    fail(`ZCode session store not found: ${SESSION_DB}`);
  }
  const database = new DatabaseSync(SESSION_DB, { readOnly: true });
  try {
    return database.prepare(
      `SELECT id, task_type, parent_id, directory
       FROM session
       WHERE id = ?
         AND directory = ?
         AND task_type = 'interactive'
         AND parent_id IS NULL`,
    ).get(taskId, workspace);
  } finally {
    database.close();
  }
}

function activeVisibleTask(taskId, workspace) {
  const task = taskIndexEntry(taskId, workspace);
  return task && task.archived === 0 && task.deleted === 0 ? task : null;
}

async function assertCreatedTask(taskId, workspace) {
  const deadline = Date.now() + INDEX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (activeVisibleTask(taskId, workspace)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(
    `ZCode did not persist ${taskId} as an active GUI task in ${workspace} within ${INDEX_TIMEOUT_MS}ms`,
  );
}

async function assertPersistedRootTask(taskId, workspace) {
  const deadline = Date.now() + INDEX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const task = activeVisibleTask(taskId, workspace);
    const session = rootInteractiveSessionEntry(taskId, workspace);
    if (task && session) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(
    `ZCode did not persist ${taskId} as an active GUI task and root interactive session in ${workspace} within ${INDEX_TIMEOUT_MS}ms after accepting the prompt`,
  );
}

function taskIndexArchivedState(taskId, workspace) {
  if (!existsSync(TASKS_INDEX_DB)) {
    fail(`ZCode task index not found: ${TASKS_INDEX_DB}`);
  }
  const database = new DatabaseSync(TASKS_INDEX_DB, { readOnly: true });
  try {
    return database.prepare(
      `SELECT task_id, workspace_path, archived, deleted
       FROM tasks
       WHERE task_id = ? AND workspace_path = ?`,
    ).get(taskId, workspace);
  } finally {
    database.close();
  }
}

async function assertArchivedState(taskId, workspace, expectArchived) {
  const deadline = Date.now() + INDEX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const task = taskIndexArchivedState(taskId, workspace);
    if (task && !task.deleted && (task.archived === 1) === expectArchived) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(
    `ZCode did not reflect the ${expectArchived ? "archived" : "unarchived"} state for ${taskId} in ${workspace} within ${INDEX_TIMEOUT_MS}ms`,
  );
}

async function assertDeletedState(taskId, workspace) {
  const deadline = Date.now() + INDEX_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const task = taskIndexArchivedState(taskId, workspace);
    if (task && task.deleted === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(
    `ZCode did not reflect the deleted state for ${taskId} in ${workspace} within ${INDEX_TIMEOUT_MS}ms`,
  );
}

async function main() {
  const request = parseArguments(process.argv.slice(2));
  assertCompatibleDesktop();
  const listener = assertLoopbackZCodeListener();
  if (request.action === "probe") {
    const renderers = await probeWorkspaceRenderers(request.workspace);
    const matchingRendererCount = renderers.filter((renderer) => renderer.matchingServiceCount > 0).length;
    process.stdout.write(`${JSON.stringify({
      status: matchingRendererCount === 1 ? "gui-bridge-ready" : "gui-bridge-not-ready",
      action: request.action,
      workspace: request.workspace,
      cdpPort: PORT,
      listenerPid: listener.pid,
      matchingRendererCount,
      renderers,
    }, null, 2)}\n`);
    process.exitCode = matchingRendererCount === 1 ? 0 : 1;
    return;
  }

  const connection = await selectWorkspaceRenderer(request.workspace);
  try {
    if (request.action === "archive" || request.action === "unarchive" || request.action === "delete") {
      const result = await connection.evaluate(archiveTaskExpression({
        workspace: request.workspace,
        session: request.session,
        action: request.action,
      }));
      if (!result?.taskId) {
        fail(result?.error ?? `ZCode GUI task service did not ${request.action} ${request.session}`);
      }
      if (request.action === "delete") {
        await assertDeletedState(result.taskId, request.workspace);
        process.stdout.write(`${JSON.stringify({
          status: "gui-task-deleted",
          action: request.action,
          sessionId: result.taskId,
          workspace: request.workspace,
          cdpPort: PORT,
          listenerPid: listener.pid,
        }, null, 2)}\n`);
      } else {
        await assertArchivedState(result.taskId, request.workspace, request.action === "archive");
        process.stdout.write(`${JSON.stringify({
          status: request.action === "archive" ? "gui-task-archived" : "gui-task-unarchived",
          action: request.action,
          sessionId: result.taskId,
          workspace: request.workspace,
          cdpPort: PORT,
          listenerPid: listener.pid,
        }, null, 2)}\n`);
      }
      return;
    }

    if (request.action === "config") {
      const result = await connection.evaluate(configTaskExpression({
        workspace: request.workspace,
        session: request.session,
        provider: request.provider,
        model: request.model,
        thoughtLevel: request.thoughtLevel,
      }));
      if (!result?.taskId) {
        fail(result?.error ?? `ZCode GUI task service did not configure ${request.session}`);
      }
      process.stdout.write(`${JSON.stringify({
        status: "gui-task-configured",
        action: request.action,
        sessionId: result.taskId,
        workspace: request.workspace,
        changes: result.changes ?? {},
        cdpPort: PORT,
        listenerPid: listener.pid,
      }, null, 2)}\n`);
      return;
    }

    if (request.action === "new") {
      const result = await connection.evaluate(createSessionExpression({
        workspace: request.workspace,
        prompt: request.prompt,
        provider: request.provider,
        model: request.model,
        thoughtLevel: request.thoughtLevel,
      }));
      if (!result?.taskId) {
        fail(result?.error ?? "ZCode agent service returned no session ID");
      }
      await assertPersistedRootTask(result.taskId, request.workspace);
      process.stdout.write(`${JSON.stringify({
        status: "gui-task-visible",
        action: request.action,
        sessionId: result.taskId,
        workspace: request.workspace,
        cdpPort: PORT,
        listenerPid: listener.pid,
      }, null, 2)}\n`);
      return;
    }

    // Fallback (send to an existing session via legacy path)
    const result = await connection.evaluate(invocationExpression(request));
    if (!result?.taskId) {
      fail(result?.error ?? "ZCode GUI task service returned no task ID");
    }
    await assertCreatedTask(result.taskId, request.workspace);

    const sendResult = await connection.evaluate(sendPromptExpression({
      workspace: request.workspace,
      prompt: request.prompt,
      session: result.taskId,
      workspaceIdentity: result.workspaceIdentity,
      traceId: randomUUID(),
    }));
    if (!sendResult?.taskId) {
      fail(sendResult?.error ?? "ZCode GUI task service did not accept the prompt");
    }
    await assertPersistedRootTask(result.taskId, request.workspace);
    process.stdout.write(`${JSON.stringify({
      status: "gui-task-visible",
      action: request.action,
      sessionId: result.taskId,
      workspace: request.workspace,
      cdpPort: PORT,
      listenerPid: listener.pid,
    }, null, 2)}\n`);
  } finally {
    connection.close();
  }
}

main().catch((error) => {
  process.stderr.write(`zcode-threads-gui: ${error.message}\n`);
  process.exitCode = 1;
});
