import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TypstAbortError,
  TypstInvalidArgumentError,
  TypstSpawnError,
  TypstTimeoutError,
} from "../dist/index.js";
import { spawnStreamProcess } from "../dist/core/stream-process.js";

const node = process.execPath;

function longLivedScript(durationMs) {
  return [
    "-e",
    `process.stdout.write("first\\n"); process.stderr.write("cycle\\n"); setTimeout(() => process.exit(0), ${durationMs})`,
  ];
}

function waitFor(handle, event) {
  return new Promise((resolve) => {
    const unsubscribe = handle.on(event, (...args) => {
      unsubscribe();
      resolve(args);
    });
  });
}

function recordLifecycle(handle) {
  const events = [];
  handle.on("error", (error) => events.push(["error", error]));
  handle.on("close", (result) => events.push(["close", result]));
  return events;
}

function lifecycleKinds(events) {
  return events.map(([kind]) => kind);
}

function runNodeProbe(probePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probePath], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    );
  });
}

test("streams raw stdout/stderr chunks with stream tags", async () => {
  const handle = spawnStreamProcess(node, [
    "-e",
    'process.stdout.write("out-a"); process.stdout.write("out-b"); process.stderr.write("err")',
  ]);
  const chunks = [];
  handle.on("output", (chunk) => chunks.push(chunk));
  // The child exits on its own after writing; await its natural close so the
  // output is fully flushed before the record is compared. A forced close()
  // can terminate the child before a non-blocking stdout write has drained.
  const result = await new Promise((resolve) => {
    handle.on("close", resolve);
  });
  // The OS may coalesce the two stdout writes into a single chunk, so the
  // chunk count is not stable; assert on stream tags and per-stream content.
  assert.deepEqual([...new Set(chunks.map((c) => c.stream))].sort(), [
    "stderr",
    "stdout",
  ]);
  assert.equal(
    chunks
      .filter((c) => c.stream === "stdout")
      .map((c) => c.chunk.toString())
      .join(""),
    "out-aout-b",
  );
  assert.equal(
    chunks
      .filter((c) => c.stream === "stderr")
      .map((c) => c.chunk.toString())
      .join(""),
    "err",
  );
  assert.equal(result.stdout.toString(), "out-aout-b");
  assert.equal(result.stderr.toString(), "err");
  assert.equal(result.exitCode, 0);
});

test("close terminates a long-lived process and settles once", async () => {
  const handle = spawnStreamProcess(node, longLivedScript(60_000));
  await waitFor(handle, "start");
  const first = await handle.close();
  const second = await handle.close();
  assert.equal(first, second);
  assert.equal(
    first.exitCode !== null || first.signal !== null,
    true,
    "expected a terminated process record",
  );
  assert.equal(first.timedOut, false);
  assert.equal(first.aborted, false);
});

test("closed resolves with the same record as close and the close event", async () => {
  const handle = spawnStreamProcess(node, longLivedScript(60_000));
  await waitFor(handle, "start");
  const closeEvent = new Promise((resolve) => {
    handle.on("close", resolve);
  });
  const closed = handle.closed;
  const closedResult = await handle.close();
  assert.equal(await closed, closedResult);
  assert.equal(await closeEvent, closedResult);
});

test("closed resolves on natural exit without an explicit close", async () => {
  const handle = spawnStreamProcess(node, ["-e", "process.exit(3)"]);
  const result = await handle.closed;
  assert.equal(result.exitCode, 3);
  assert.equal(await handle.close(), result);
});

test("closed resolves on timeout with the timed-out record", async () => {
  const handle = spawnStreamProcess(node, longLivedScript(60_000), {
    timeoutMs: 200,
    terminationGraceMs: 100,
  });
  const result = await handle.closed;
  assert.equal(result.timedOut, true);
});

test("closed resolves on abort with the aborted record", async () => {
  const controller = new AbortController();
  const handle = spawnStreamProcess(node, longLivedScript(60_000), {
    signal: controller.signal,
    terminationGraceMs: 100,
  });
  const closed = handle.closed;
  controller.abort(new Error("user cancelled"));
  const result = await closed;
  assert.equal(result.aborted, true);
});

test("closed resolves on spawn failure with the partial record", async () => {
  const handle = spawnStreamProcess(
    "definitely-not-a-real-typst-executable-xyz",
    ["watch"],
  );
  const result = await handle.closed;
  assert.equal(result.exitCode, null);
});

test("timeout delivers a typed error and then close", async () => {
  const handle = spawnStreamProcess(node, longLivedScript(60_000), {
    timeoutMs: 200,
    terminationGraceMs: 100,
  });
  const events = [];
  handle.on("error", (error) => events.push(["error", error]));
  handle.on("close", (result) => events.push(["close", result]));
  const [result] = await waitFor(handle, "close");
  assert.deepEqual(
    events.map(([kind]) => kind),
    ["error", "close"],
  );
  assert.ok(events[0][1] instanceof TypstTimeoutError);
  assert.equal(result.timedOut, true);
  assert.equal(events[0][1].process.timedOut, true);
  assert.equal(events[1][1], result);
  // No late duplicate lifecycle event may arrive after settlement.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(lifecycleKinds(events), ["error", "close"]);
});

test("abort delivers a typed error and terminates the tree", async () => {
  const controller = new AbortController();
  const handle = spawnStreamProcess(node, longLivedScript(60_000), {
    signal: controller.signal,
    terminationGraceMs: 100,
  });
  const events = [];
  handle.on("error", (error) => events.push(["error", error]));
  handle.on("close", (result) => events.push(["close", result]));
  const closed = waitFor(handle, "close");
  controller.abort(new Error("user cancelled"));
  const [result] = await closed;
  assert.deepEqual(
    events.map(([kind]) => kind),
    ["error", "close"],
  );
  assert.ok(events[0][1] instanceof TypstAbortError);
  assert.equal(result.aborted, true);
  assert.equal(events[0][1].cause?.message, "user cancelled");
  assert.equal(events[1][1], result);
});

test("spawn failures deliver a typed error with a partial record", async () => {
  const handle = spawnStreamProcess(
    "definitely-not-a-real-typst-executable-xyz",
    ["watch"],
  );
  const events = [];
  handle.on("error", (error) => events.push(["error", error]));
  handle.on("close", (result) => events.push(["close", result]));
  const [result] = await waitFor(handle, "close");
  assert.deepEqual(
    events.map(([kind]) => kind),
    ["error", "close"],
  );
  assert.ok(events[0][1] instanceof TypstSpawnError);
  assert.equal(result.exitCode, null);
  assert.equal(events[1][1], result);
});

test("a synchronous spawn() failure delivers error before close", async () => {
  // Null bytes make child_process.spawn() throw synchronously, so no
  // ChildProcess exists and the runner must synthesise the lifecycle itself.
  const handle = spawnStreamProcess(node, ["-e", "0", String.fromCharCode(0)]);
  const events = recordLifecycle(handle);
  const [result] = await waitFor(handle, "close");
  assert.equal(handle.pid, undefined);
  assert.equal(result.exitCode, null);
  assert.deepEqual(lifecycleKinds(events), ["error", "close"]);
  assert.ok(events[0][1] instanceof TypstSpawnError);
  assert.equal(events[1][1], result);
  assert.equal(await handle.closed, result);
  assert.equal(await handle.close(), result);
});

test("normal natural exit delivers close without an error", async () => {
  const handle = spawnStreamProcess(node, ["-e", "process.exit(0)"]);
  const events = recordLifecycle(handle);
  const [result] = await waitFor(handle, "close");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(lifecycleKinds(events), ["close"]);
  assert.equal(events[0][1], result);
  assert.equal(await handle.closed, result);
});

test("explicit close emits close once and repeated disposal settles identically", async () => {
  const handle = spawnStreamProcess(node, longLivedScript(60_000));
  await waitFor(handle, "start");
  const events = recordLifecycle(handle);
  const first = await handle.close();
  const second = await handle.close();
  await handle[Symbol.asyncDispose]();
  await handle[Symbol.asyncDispose]();
  assert.equal(first, second);
  assert.deepEqual(lifecycleKinds(events), ["close"]);
  assert.equal(events[0][1], first);
  assert.equal(await handle.closed, first);
});

test("an already-aborted signal delivers error before close once", async () => {
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted"));
  const handle = spawnStreamProcess(node, longLivedScript(60_000), {
    signal: controller.signal,
    terminationGraceMs: 100,
  });
  const events = recordLifecycle(handle);
  const result = await handle.closed;
  assert.equal(result.aborted, true);
  assert.deepEqual(lifecycleKinds(events), ["error", "close"]);
  assert.ok(events[0][1] instanceof TypstAbortError);
  assert.equal(events[0][1].cause?.message, "pre-aborted");
  assert.equal(events[1][1], result);
});

test("throwing lifecycle listeners cannot strand settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "typst-api-listener-throw-"));
  const probePath = join(directory, "probe.mjs");
  const moduleUrl = new URL("../dist/core/stream-process.js", import.meta.url)
    .href;
  await writeFile(
    probePath,
    `import { spawnStreamProcess } from ${JSON.stringify(moduleUrl)};

const observed = { uncaught: [], unhandledRejections: [] };
process.on("uncaughtException", (error) => observed.uncaught.push(error.message));
process.on("unhandledRejection", (error) =>
  observed.unhandledRejections.push(String(error)),
);

const guard = (promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("settlement timed out")), 2000),
    ),
  ]);

const probe = async () => {
  // A listener throwing from the synchronous error emission must still let the
  // runner settle and resolve closed/close().
  const syncFailure = spawnStreamProcess(process.execPath, [
    "-e",
    "0",
    String.fromCharCode(0),
  ]);
  const errorEvents = [];
  syncFailure.on("error", () => {
    errorEvents.push("error");
    throw new Error("error listener failed");
  });
  syncFailure.on("close", () => errorEvents.push("close"));
  const syncResult = await guard(syncFailure.closed);
  const syncClose = await guard(syncFailure.close());

  // A throwing close listener must not prevent the settlement promises from
  // resolving; the listener error still surfaces to the host as uncaught.
  const naturalExit = spawnStreamProcess(process.execPath, [
    "-e",
    "process.exit(0)",
  ]);
  const closeEvents = [];
  naturalExit.on("close", () => {
    closeEvents.push("close");
    throw new Error("close listener failed");
  });
  const naturalResult = await guard(naturalExit.closed);
  const naturalClose = await guard(naturalExit.close());

  return {
    sync: {
      events: errorEvents,
      same: syncResult === syncClose,
      exitCode: syncResult.exitCode,
    },
    natural: {
      events: closeEvents,
      same: naturalResult === naturalClose,
      exitCode: naturalResult.exitCode,
    },
  };
};

let payload;
try {
  payload = { ...observed, ...(await probe()) };
} catch (error) {
  payload = { ...observed, failure: String(error?.message ?? error) };
}
await new Promise((resolve) => setTimeout(resolve, 50));
process.stdout.write(JSON.stringify(payload));
process.exitCode = payload.failure === undefined ? 0 : 1;
`,
  );
  try {
    const probe = await runNodeProbe(probePath);
    const observed = JSON.parse(probe.stdout);
    assert.equal(
      probe.exitCode,
      0,
      `listener probe failed: ${JSON.stringify(observed)} ${probe.stderr}`,
    );
    assert.deepEqual(observed.uncaught, [
      "error listener failed",
      "close listener failed",
    ]);
    assert.deepEqual(observed.unhandledRejections, []);
    assert.deepEqual(observed.sync.events, ["error", "close"]);
    assert.equal(observed.sync.same, true);
    assert.equal(observed.sync.exitCode, null);
    assert.deepEqual(observed.natural.events, ["close"]);
    assert.equal(observed.natural.same, true);
    assert.equal(observed.natural.exitCode, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects malformed options before spawn", async () => {
  assert.throws(() => spawnStreamProcess("", []), TypstInvalidArgumentError);
  assert.throws(
    () => spawnStreamProcess(node, [42]),
    TypstInvalidArgumentError,
  );
  assert.throws(
    () => spawnStreamProcess(node, [], { timeoutMs: -1 }),
    TypstInvalidArgumentError,
  );
  assert.throws(
    () => spawnStreamProcess(node, [], { envMode: "upsert" }),
    TypstInvalidArgumentError,
  );
  assert.throws(
    () => spawnStreamProcess(node, [], { signal: {} }),
    TypstInvalidArgumentError,
  );
  const handle = spawnStreamProcess(node, []);
  assert.throws(
    () => handle.on("start", "not-a-function"),
    TypstInvalidArgumentError,
  );
  await handle.close();
});

test("natural exit settles close with the final record", async () => {
  const handle = spawnStreamProcess(node, ["-e", "process.exit(3)"]);
  const [result] = await waitFor(handle, "close");
  assert.equal(result.exitCode, 3);
  assert.equal(await handle.close(), result);
});

test("AsyncDisposable integration terminates the process", async () => {
  const handle = spawnStreamProcess(node, longLivedScript(60_000));
  await waitFor(handle, "start");
  await handle[Symbol.asyncDispose]();
  const result = await handle.close();
  assert.equal(
    result.exitCode !== null || result.signal !== null,
    true,
    "expected a terminated process record",
  );
});

test("bounded capture keeps the tail and reports truncation explicitly", async () => {
  const limit = 1024;
  const stdoutBytes = 16 * 16384;
  const stderrBytes = 4 * 16384;
  const logs = [];
  const script = `
    const outChunk = "A".repeat(16384);
    const errChunk = "B".repeat(16384);
    let out = 0;
    let err = 0;
    const write = () => {
      while (out < 16) {
        out += 1;
        if (!process.stdout.write(outChunk)) {
          return process.stdout.once("drain", write);
        }
      }
      while (err < 4) {
        err += 1;
        if (!process.stderr.write(errChunk)) {
          return process.stderr.once("drain", write);
        }
      }
    };
    write();
  `;
  const directory = await mkdtemp(join(tmpdir(), "typst-api-bounded-"));
  const childPath = join(directory, "child.mjs");
  await writeFile(childPath, script);
  try {
    const handle = spawnStreamProcess(node, [childPath], {
      maxBufferedOutputBytes: limit,
      onLog: (event) => logs.push(event),
    });
    const result = await handle.closed;
    assert.equal(result.stdout.length, limit);
    assert.equal(result.stderr.length, limit);
    assert.equal(result.stdoutBytes, stdoutBytes);
    assert.equal(result.stderrBytes, stderrBytes);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.equal(result.stdout.toString(), "A".repeat(limit));
    assert.equal(result.stderr.toString(), "B".repeat(limit));
    const truncations = logs.filter(
      (event) => event.kind === "output_truncated",
    );
    assert.equal(truncations.length, 2);
    for (const [index, stream] of ["stdout", "stderr"].entries()) {
      assert.equal(truncations[index].stream, stream);
      assert.ok(truncations[index].droppedBytes > 0);
      assert.ok(truncations[index].totalBytes > limit);
      assert.equal(
        truncations[index].droppedBytes,
        truncations[index].totalBytes - limit,
      );
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("maxBufferedOutputBytes: 0 retains no bytes but keeps totals", async () => {
  const handle = spawnStreamProcess(
    node,
    ["-e", 'process.stdout.write("payload"); process.stderr.write("error")'],
    { maxBufferedOutputBytes: 0 },
  );
  const result = await handle.closed;
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
  assert.equal(result.stdoutBytes, 7);
  assert.equal(result.stderrBytes, 5);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("streaming output order is preserved for many chunks", async () => {
  const count = 200;
  const script = `
    for (let i = 0; i < ${count}; i += 1) {
      process.stdout.write("o" + i + ";");
      process.stderr.write("e" + i + ";");
    }
  `;
  const handle = spawnStreamProcess(node, ["-e", script], {
    maxBufferedOutputBytes: 16,
  });
  const chunks = [];
  handle.on("output", (chunk) => chunks.push(chunk));
  const result = await handle.closed;
  const stdoutOrder = chunks
    .filter((chunk) => chunk.stream === "stdout")
    .map((chunk) => chunk.chunk.toString())
    .join("");
  const stderrOrder = chunks
    .filter((chunk) => chunk.stream === "stderr")
    .map((chunk) => chunk.chunk.toString())
    .join("");
  assert.equal(
    stdoutOrder,
    Array.from({ length: count }, (_, index) => `o${index};`).join(""),
  );
  assert.equal(
    stderrOrder,
    Array.from({ length: count }, (_, index) => `e${index};`).join(""),
  );
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.ok(result.stdout.length <= 16);
  assert.ok(result.stderr.length <= 16);
});

test("a long session with many output cycles does not grow memory with output", async () => {
  // 512 cycles × 64 KiB = 32 MiB of stdout. The probe runs with --expose-gc so
  // dropped chunks are collected before memory is measured; only the retained
  // tail may remain proportional to the capture limit.
  const cycles = 512;
  const blockSize = 64 * 1024;
  const targetBytes = cycles * blockSize;
  const limit = 256 * 1024;
  const directory = await mkdtemp(join(tmpdir(), "typst-api-stream-memory-"));
  const probePath = join(directory, "probe.mjs");
  const moduleUrl = new URL("../dist/core/stream-process.js", import.meta.url)
    .href;
  await writeFile(
    probePath,
    `import { spawnStreamProcess } from ${JSON.stringify(moduleUrl)};

const cycles = ${cycles};
const blockSize = ${blockSize};
const script = \`
  const block = "x".repeat(\${blockSize});
  let written = 0;
  const write = () => {
    while (written < \${cycles}) {
      const ok = process.stdout.write(block);
      written += 1;
      if (!ok) return process.stdout.once("drain", write);
    }
    process.stdout.end();
  };
  write();
\`;
const before = process.memoryUsage();
const handle = spawnStreamProcess(process.execPath, ["-e", script], {
  maxBufferedOutputBytes: ${limit},
});
const result = await handle.closed;
globalThis.gc?.();
globalThis.gc?.();
const after = process.memoryUsage();
const growth =
  after.heapUsed - before.heapUsed +
  (after.external - before.external);
process.stdout.write(
  JSON.stringify({
    exitCode: result.exitCode,
    stdoutBytes: result.stdoutBytes,
    retained: result.stdout.length,
    truncated: result.stdoutTruncated,
    growth,
  }),
);
`,
  );
  try {
    const probe = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--expose-gc", probePath], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode) =>
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        }),
      );
    });
    assert.equal(probe.exitCode, 0, `memory probe failed: ${probe.stderr}`);
    const measurement = JSON.parse(probe.stdout);
    assert.equal(measurement.exitCode, 0);
    assert.equal(measurement.stdoutBytes, targetBytes);
    assert.equal(measurement.retained, limit);
    assert.equal(measurement.truncated, true);
    assert.ok(
      measurement.growth < targetBytes / 2,
      `retained output grew memory by ${measurement.growth} bytes for ${targetBytes} emitted bytes`,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects invalid capture limits before spawn", () => {
  for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(
      () => spawnStreamProcess(node, [], { maxBufferedOutputBytes: value }),
      TypstInvalidArgumentError,
    );
  }
});
