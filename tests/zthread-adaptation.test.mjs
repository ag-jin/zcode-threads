#!/usr/bin/env node
// Regression tests for the ZCode 3.6.5 adaptation.
// Read-only: never creates sessions, never writes ZCode databases,
// never archives/deletes tasks, and never creates or removes Git worktrees.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const SKILL = join(new URL("..", import.meta.url).pathname, "scripts", "zthread.mjs");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "zcode-threads-test-"));
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function fakeDesktop(root) {
  // A throwaway "desktop" layout whose Info.plist claims a supported version
  // and whose bundled runtime contains the required protocol markers. The
  // real /Applications/ZCode.app is never touched.
  const app = join(root, "Applications", "ZCode.app");
  mkdirSync(join(app, "Contents", "Resources", "glm"), { recursive: true });
  const infoPath = join(app, "Contents", "Info.plist");
  writeFileSync(infoPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    "<key>CFBundleShortVersionString</key><string>3.6.5</string>",
    "</dict></plist>",
  ].join(""));
  const runtimePath = join(app, "Contents", "Resources", "glm", "zcode.cjs");
  writeFileSync(runtimePath, "app-server session/list session/read session/create session/send\n");
  return { infoPath, runtimePath };
}

function fakeEnv(dir, desktop) {
  return {
    ZCODE_THREADS_INFO_PLIST: desktop.infoPath,
    ZCODE_THREADS_CLI_PATH: desktop.runtimePath,
  };
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [SKILL, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  return result;
}

{
  const dir = tempDir();
  try {
    const missing = run(["check"], {
      env: {
        ZCODE_THREADS_INFO_PLIST: join(dir, "no-such", "Info.plist"),
        ZCODE_THREADS_CLI_PATH: join(dir, "no-such", "zcode.cjs"),
      },
    });
    assert.equal(missing.status, 1, "check fails when the desktop Info.plist is missing");
    assert.match(missing.stderr, /Info\.plist not found/);
  } finally {
    clean(dir);
  }
}

{
  const dir = tempDir();
  try {
    const desktop = fakeDesktop(dir);
    const result = run(["check"], { env: fakeEnv(dir, desktop) });
    assert.equal(result.status, 0, "check accepts a supported desktop version with required markers");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.compatible, true);
    assert.equal(parsed.version, "3.6.5");
    assert.deepEqual(parsed.verifiedVersions, ["3.5.3", "3.6.5"]);
    assert.equal(parsed.missingMarkers.length, 0);
  } finally {
    clean(dir);
  }
}

{
  const dir = tempDir();
  try {
    const desktop = fakeDesktop(dir);
    writeFileSync(desktop.runtimePath, "app-server session/list\n");
    const result = run(["check"], { env: fakeEnv(dir, desktop) });
    assert.equal(result.status, 2, "check fails closed when required runtime markers are missing");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.compatible, false);
    assert.ok(parsed.missingMarkers.length > 0, "missing markers are reported");
  } finally {
    clean(dir);
  }
}

{
  const dir = tempDir();
  try {
    const desktop = fakeDesktop(dir);
    writeFileSync(desktop.infoPath, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      "<key>CFBundleShortVersionString</key><string>4.0.0</string>",
      "</dict></plist>",
    ].join(""));
    const result = run(["check"], { env: fakeEnv(dir, desktop) });
    assert.equal(result.status, 2, "check fails closed for an unverified version");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.compatible, false);
    assert.match(parsed.reason, /not a verified supported version/);
  } finally {
    clean(dir);
  }
}

{
  const dir = tempDir();
  try {
    const missing = run(["list", "--workspace", join(dir, "does-not-exist"), "--limit", "5"]);
    assert.notEqual(missing.status, 0, "list must reject a missing workspace directory");
    assert.match(missing.stderr, /Workspace does not exist/);
  } finally {
    clean(dir);
  }
}

{
  const dir = tempDir();
  try {
    const file = join(dir, "file.txt");
    writeFileSync(file, "x");
    const result = run(["list", "--workspace", file]);
    assert.notEqual(result.status, 0, "list must reject a non-directory workspace");
    assert.match(result.stderr, /not a directory/);
  } finally {
    clean(dir);
  }
}

{
  // With the real installed desktop, an existing-but-unused workspace yields
  // an empty session list instead of failing: the compatibility gate passes
  // and the task-index query is read-only.
  const dir = tempDir();
  try {
    const workspace = join(dir, "existing");
    mkdirSync(workspace, { recursive: true });
    const result = run(["list", "--workspace", workspace, "--limit", "5"]);
    assert.equal(result.status, 0, "list succeeds against the installed desktop");
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.sessions, [], "unused workspace has no desktop tasks");
  } finally {
    clean(dir);
  }
}

{
  // GUI config must not be executable against a thread that does not exist.
  // Session verification is read-only and precedes any CDP dispatch, so the
  // command fails closed before touching the bridge.
  const dir = tempDir();
  try {
    const desktop = fakeDesktop(dir);
    const workspace = join(dir, "existing");
    mkdirSync(workspace, { recursive: true });
    const result = run(["gui-config", "--workspace", workspace, "--session", "sess_x", "--provider", "glm", "--model", "x"], {
      env: fakeEnv(dir, desktop),
    });
    assert.notEqual(result.status, 0, "gui-config must fail closed without an existing root session");
    assert.match(result.stderr, /Session sess_x was not found/i, "session verification precedes GUI dispatch");
  } finally {
    clean(dir);
  }
}

{
  // list-models falls back to the local provider configuration when the
  // target workspace is not open in the desktop renderer. The fixture
  // config is supplied through the test-only override and is never written
  // to the real ~/.zcode/v2/config.json.
  const dir = tempDir();
  try {
    const desktop = fakeDesktop(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      provider: {
        "p-one": {
          name: "我的渠道",
          kind: "openai-compatible",
          enabled: true,
          source: "custom",
          models: {
            "m-a": { name: "模型A", reasoning: { variants: ["off", "high"], defaultVariant: "high" } },
            "m-b": { name: "模型B" },
          },
        },
        "p-disabled": { name: "禁用渠道", enabled: false, models: { "m-x": { name: "模型X" } } },
      },
    }));
    const workspace = join(dir, "existing");
    mkdirSync(workspace, { recursive: true });
    const result = run(["list-models", "--workspace", workspace], {
      env: { ...fakeEnv(dir, desktop), ZCODE_THREADS_CONFIG_JSON: configPath },
    });
    assert.equal(result.status, 0, "list-models succeeds via local fallback");
    assert.match(result.stdout, /本地配置/, "text names the local configuration source");
    assert.match(result.stdout, /我的渠道/, "enabled custom provider is listed");
    assert.match(result.stdout, /模型A/, "model name is listed");
    assert.match(result.stdout, /off\/high/, "reasoning variants are listed");
    assert.doesNotMatch(result.stdout, /禁用渠道/, "disabled provider is excluded");
  } finally {
    clean(dir);
  }
}

{
  // --json returns the structured local fallback data instead of text.
  const dir = tempDir();
  try {
    const desktop = fakeDesktop(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      provider: {
        "p-one": { name: "我的渠道", kind: "openai-compatible", enabled: true, models: { "m-a": { name: "模型A" } } },
      },
    }));
    const workspace = join(dir, "existing");
    mkdirSync(workspace, { recursive: true });
    const result = run(["list-models", "--workspace", workspace, "--json"], {
      env: { ...fakeEnv(dir, desktop), ZCODE_THREADS_CONFIG_JSON: configPath },
    });
    assert.equal(result.status, 0, "list-models --json succeeds");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.source, "local-config");
    assert.equal(parsed.providers.length, 1);
    assert.equal(parsed.providers[0].providerId, "p-one");
    assert.equal(parsed.providers[0].models[0].modelId, "m-a");
  } finally {
    clean(dir);
  }
}

process.stdout.write("PASS: zcode-threads 3.6.5 regression tests\n");
