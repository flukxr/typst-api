import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TypstInvalidArgumentError,
  TypstSpawnError,
  TypstWatchError,
} from "../dist/index.js";
import { TypstClientImpl } from "../dist/client/index.js";
import { result, node } from "./helpers/mock-typst.mjs";

/**
 * Stand in for the `typst watch` binary. The watch command spawns
 * `executable watch <input> <output>`, so a node script named `watch` placed
 * in the working directory is executed with the real child environment and
 * dumps it to a file the test can inspect.
 */
function dumpEnvironmentScript() {
  return [
    "require('node:fs').writeFileSync(",
    "  require('node:path').join(process.cwd(), 'env-dump.json'),",
    "  JSON.stringify(process.env),",
    ");",
  ].join("\n");
}

function watchClient(directory, baseEnv, versionEnvironment = {}) {
  const client = new TypstClientImpl(
    {
      executable: node,
      source: "explicit",
      cwd: directory,
      env: { ...process.env, ...baseEnv, ...versionEnvironment },
    },
    {},
  );
  client.run = async (args) => {
    if (args[0] === "--version") {
      return result(args, "Typst 0.15.1");
    }
    return result(args);
  };
  return client;
}

async function watchWithEnv(baseEnv, optionsEnv, envMode) {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-watch-env-"));
  try {
    writeFileSync(join(directory, "watch"), dumpEnvironmentScript());
    const client = watchClient(directory, baseEnv);
    const watcher = await client.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
      env: optionsEnv,
      ...(envMode === undefined ? {} : { envMode }),
    });
    const result = await watcher.closed;
    assert.equal(result.exitCode, 0);
    const dumpPath = join(directory, "env-dump.json");
    assert.ok(
      readFileSync(dumpPath, "utf8").length > 0,
      "child must dump its environment",
    );
    return JSON.parse(readFileSync(dumpPath, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("watch layers options env over the client environment by default", async () => {
  const dumped = await watchWithEnv({ MARKER_BASE: "base" }, { MARKER: "1" });
  assert.equal(dumped.MARKER, "1");
  assert.equal(dumped.MARKER_BASE, "base");
});

test("watch envMode replace drops the inherited client environment", async () => {
  const dumped = await watchWithEnv(
    { MARKER_BASE: "base" },
    { MARKER: "1" },
    "replace",
  );
  assert.equal(dumped.MARKER, "1");
  assert.equal(dumped.MARKER_BASE, undefined);
});

test("watch emits a typed error when the process dies on its own", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-watch-crash-"));
  try {
    writeFileSync(
      join(directory, "watch"),
      "process.stderr.write('boom: cannot watch\\n'); setTimeout(() => process.exit(3), 100);",
    );
    const client = watchClient(directory, {});
    const watcher = await client.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
    });
    const errors = [];
    const events = [];
    watcher.on("error", (error) => {
      errors.push(error);
      events.push("error");
    });
    watcher.on("close", () => events.push("close"));
    const result = await watcher.closed;
    assert.equal(result.exitCode, 3);
    assert.equal(result.stderr.toString(), "boom: cannot watch\n");
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof TypstWatchError);
    assert.equal(errors[0].code, "ERR_TYPST_WATCH");
    assert.equal(errors[0].process.exitCode, 3);
    assert.equal(errors[0].process.stderr.toString(), "boom: cannot watch\n");
    assert.deepEqual(events, ["error", "close"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watch emits error before close on timeout and abort", async () => {
  const timeoutDirectory = mkdtempSync(
    join(tmpdir(), "typst-api-watch-timeout-"),
  );
  try {
    writeFileSync(
      join(timeoutDirectory, "watch"),
      "setInterval(() => undefined, 1000);",
    );
    const timeoutClient = watchClient(timeoutDirectory, {});
    const timedOut = await timeoutClient.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
      timeoutMs: 300,
      terminationGraceMs: 100,
    });
    const timeoutEvents = [];
    timedOut.on("error", () => timeoutEvents.push("error"));
    timedOut.on("close", () => timeoutEvents.push("close"));
    const timeoutResult = await timedOut.closed;
    assert.equal(timeoutResult.timedOut, true);
    assert.deepEqual(timeoutEvents, ["error", "close"]);
  } finally {
    rmSync(timeoutDirectory, { recursive: true, force: true });
  }

  const abortDirectory = mkdtempSync(join(tmpdir(), "typst-api-watch-abort-"));
  try {
    writeFileSync(
      join(abortDirectory, "watch"),
      "setInterval(() => undefined, 1000);",
    );
    const controller = new AbortController();
    const abortClient = watchClient(abortDirectory, {});
    const aborted = await abortClient.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
      signal: controller.signal,
      terminationGraceMs: 100,
    });
    const abortEvents = [];
    aborted.on("error", () => abortEvents.push("error"));
    aborted.on("close", () => abortEvents.push("close"));
    controller.abort(new Error("test abort"));
    const abortResult = await aborted.closed;
    assert.equal(abortResult.aborted, true);
    assert.deepEqual(abortEvents, ["error", "close"]);
  } finally {
    rmSync(abortDirectory, { recursive: true, force: true });
  }
});

test("watch close() does not surface a failure as an error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-watch-close-"));
  try {
    writeFileSync(
      join(directory, "watch"),
      "process.stderr.write('idle\\n'); setInterval(() => undefined, 1000);",
    );
    const client = watchClient(directory, {});
    const watcher = await client.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
    });
    const errors = [];
    watcher.on("error", (error) => errors.push(error));
    const result = await watcher.close();
    assert.ok(result.exitCode !== null || result.signal !== null);
    assert.equal(errors.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watch natural success emits close without an error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-watch-success-"));
  try {
    writeFileSync(join(directory, "watch"), "process.exit(0);");
    const client = watchClient(directory, {});
    const watcher = await client.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
    });
    const events = [];
    watcher.on("error", () => events.push("error"));
    watcher.on("close", () => events.push("close"));
    const result = await watcher.closed;
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.deepEqual(events, ["close"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watch explicit close is idempotent and emits close only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-watch-dispose-"));
  try {
    writeFileSync(
      join(directory, "watch"),
      "setInterval(() => undefined, 1000);",
    );
    const client = watchClient(directory, {});
    const watcher = await client.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
    });
    const events = [];
    watcher.on("error", () => events.push("error"));
    watcher.on("close", () => events.push("close"));
    const first = await watcher.close();
    const second = await watcher.close();
    await watcher[Symbol.asyncDispose]();
    await watcher[Symbol.asyncDispose]();
    assert.equal(first, second);
    assert.deepEqual(events, ["close"]);
    assert.equal(await watcher.closed, first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watch spawn failure emits error before close", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-watch-spawn-"));
  try {
    const client = new TypstClientImpl(
      {
        executable: "definitely-not-a-real-typst-executable-xyz",
        source: "explicit",
        cwd: directory,
        env: process.env,
      },
      {},
    );
    client.run = async (args) => result(args, "Typst 0.15.1");
    const watcher = await client.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
    });
    const events = [];
    let spawnError;
    watcher.on("error", (error) => {
      spawnError = error;
      events.push("error");
    });
    watcher.on("close", () => events.push("close"));
    const publicResult = await watcher.closed;
    assert.equal(publicResult.exitCode, null);
    assert.ok(spawnError instanceof TypstSpawnError);
    assert.deepEqual(events, ["error", "close"]);
    assert.equal(await watcher.close(), publicResult);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watch synchronous spawn failure emits error before close", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-watch-spawn-sync-"));
  try {
    const client = new TypstClientImpl(
      {
        // A null byte makes child_process.spawn() throw synchronously.
        executable: `${node}\u0000invalid`,
        source: "explicit",
        cwd: directory,
        env: process.env,
      },
      {},
    );
    client.run = async (args) => result(args, "Typst 0.15.1");
    const watcher = await client.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
    });
    const events = [];
    let spawnError;
    watcher.on("error", (error) => {
      spawnError = error;
      events.push("error");
    });
    watcher.on("close", () => events.push("close"));
    const publicResult = await watcher.closed;
    assert.equal(publicResult.exitCode, null);
    assert.ok(spawnError instanceof TypstSpawnError);
    assert.deepEqual(events, ["error", "close"]);
    assert.equal(await watcher.close(), publicResult);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("watch validates run options before staging a temporary source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-watch-validate-"));
  const tempRoot = mkdtempSync(join(tmpdir(), "typst-api-watch-tmp-"));
  const saved = {
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    TMPDIR: process.env.TMPDIR,
  };
  try {
    process.env.TMP = process.env.TEMP = process.env.TMPDIR = tempRoot;
    const client = watchClient(directory, {});
    for (const bad of [
      { timeoutMs: -1 },
      { terminationGraceMs: Number.NaN },
      { signal: {} },
      { cwd: "" },
    ]) {
      await assert.rejects(
        client.watch({
          input: { kind: "source", data: "= Hello" },
          output: { kind: "file", path: "out.pdf" },
          ...bad,
        }),
        TypstInvalidArgumentError,
      );
    }
    assert.deepEqual(readdirSync(tempRoot), []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a throwing listener neither skips other listeners nor is swallowed", async () => {
  const { invokeListeners } = await import("../dist/core/listeners.js");
  const rethrown = [];
  const original = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (callback) => {
    try {
      callback();
    } catch (error) {
      rethrown.push(error);
    }
  };
  try {
    const calls = [];
    const failure = new Error("listener bug");
    invokeListeners(
      [
        (value) => calls.push(`a:${value}`),
        () => {
          throw failure;
        },
        (value) => calls.push(`c:${value}`),
      ],
      1,
    );
    assert.deepEqual(calls, ["a:1", "c:1"]);
    assert.deepEqual(rethrown, [failure]);
  } finally {
    globalThis.queueMicrotask = original;
  }
});
