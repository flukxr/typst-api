import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProcess } from "../dist/core/process.js";
import {
  TypstAbortError,
  TypstInvalidArgumentError,
  TypstProcessError,
  TypstSpawnError,
  TypstTimeoutError,
} from "../dist/core/errors.js";

const node = process.execPath;

function script(source) {
  return ["-e", source];
}

test("captures exact stdout/stderr and natural non-zero exit metadata", async () => {
  const args = script(
    'process.stdout.write("out\\0"); process.stderr.write("err\\xff", "latin1"); process.exit(7)',
  );
  const result = await runProcess(node, args);

  assert.equal(result.executable, node);
  assert.deepEqual(result.args, args);
  assert.notStrictEqual(result.args, args);
  assert.equal(Object.isFrozen(result.args), true);
  assert.equal(result.cwd, process.cwd());
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout, Buffer.from("out\0"));
  assert.deepEqual(result.stderr, Buffer.from([0x65, 0x72, 0x72, 0xff]));
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(Number.isFinite(result.durationMs), true);
  assert.equal(result.durationMs >= 0, true);
});

test("passes every argument literally without shell interpretation", async () => {
  const value = '$(echo injected) & ; | "quoted"';
  const result = await runProcess(
    node,
    script("process.stdout.write(process.argv[1])").concat(value),
  );
  assert.equal(result.stdout.toString(), value);
});

test("supports string and large Uint8Array stdin with EOF", async () => {
  const reader =
    "let n=0; process.stdin.on('data', c => n += c.length); process.stdin.on('end', () => process.stdout.write(String(n)));";
  const stringResult = await runProcess(node, script(reader), {
    stdin: "hello stdin",
  });
  assert.equal(stringResult.stdout.toString(), "11");

  const bytes = new Uint8Array(2 * 1024 * 1024);
  bytes.fill(0x61);
  const bytesResult = await runProcess(node, script(reader), { stdin: bytes });
  assert.equal(bytesResult.stdout.toString(), String(bytes.byteLength));
});

test("stdio routes, ignores, and captures child streams", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "typst-api-stdio-"));
  try {
    const file = path.join(directory, "stdout.txt");
    const fd = openSync(file, "w");
    try {
      const result = await runProcess(
        node,
        script(
          'process.stdout.write("to-file"); process.stderr.write("ignored")',
        ),
        { stdio: { stdout: fd, stderr: "ignore" } },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.length, 0);
      assert.equal(result.stderr.length, 0);
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(file, "utf8"), "to-file");

    const piped = await runProcess(
      node,
      script('process.stdout.write("captured"); process.stderr.write("error")'),
      { stdio: { stdout: "pipe", stderr: "pipe" } },
    );
    assert.equal(piped.stdout.toString(), "captured");
    assert.equal(piped.stderr.toString(), "error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid stdio wiring and hidden stdin data fail before spawn", async () => {
  for (const stdio of [
    null,
    "pipe",
    { stdout: "bogus" },
    { stderr: -1 },
    { stdout: 1.5 },
    { stdin: {} },
  ]) {
    await assert.rejects(
      runProcess(node, [], { stdio }),
      TypstInvalidArgumentError,
    );
  }
  await assert.rejects(
    runProcess(node, [], {
      stdin: "payload",
      stdio: { stdin: "ignore" },
    }),
    TypstInvalidArgumentError,
  );
});

test("merges environment values and removes inherited values with undefined", async () => {
  const overrideKey = "TYPST_API_PROCESS_OVERRIDE";
  const removeKey = "TYPST_API_PROCESS_REMOVE";
  const oldOverride = process.env[overrideKey];
  const oldRemove = process.env[removeKey];
  process.env[overrideKey] = "parent-value";
  process.env[removeKey] = "remove-me";
  try {
    const result = await runProcess(
      node,
      script(
        `process.stdout.write(JSON.stringify({override:process.env.${overrideKey}, removed:process.env.${removeKey}}))`,
      ),
      {
        env: { [overrideKey]: "child-value", [removeKey]: undefined },
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      override: "child-value",
    });
  } finally {
    if (oldOverride === undefined) delete process.env[overrideKey];
    else process.env[overrideKey] = oldOverride;
    if (oldRemove === undefined) delete process.env[removeKey];
    else process.env[removeKey] = oldRemove;
  }
});

test("uses an absolute custom cwd with spaces and Unicode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "typst api cwd ✨ "));
  try {
    const result = await runProcess(
      node,
      script("process.stdout.write(process.cwd())"),
      { cwd: directory },
    );
    const expectedCwd = path.resolve(directory);
    assert.equal(result.cwd, expectedCwd);
    assert.equal(result.stdout.toString(), expectedCwd);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replace environment does not inherit parent values", async () => {
  const result = await runProcess(
    node,
    script(
      "process.stdout.write(JSON.stringify({present:process.env.TYPST_API_PROCESS_REPLACE}))",
    ),
    {
      envMode: "replace",
      env: { TYPST_API_PROCESS_REPLACE: "only" },
    },
  );
  assert.deepEqual(JSON.parse(result.stdout), { present: "only" });
});

test("spawn failures are typed and retain a normalised partial record", async () => {
  await assert.rejects(
    runProcess("typst-api-process-command-that-does-not-exist", ["raw"]),
    (error) => {
      assert.equal(error instanceof TypstSpawnError, true);
      assert.equal(error instanceof TypstProcessError, true);
      assert.equal(error.code, "ERR_TYPST_SPAWN");
      assert.deepEqual(error.process.args, ["raw"]);
      assert.equal(error.process.exitCode, null);
      assert.equal(error.process.signal, null);
      assert.equal(error.process.timedOut, false);
      assert.equal(error.process.aborted, false);
      return true;
    },
  );
});

test("timeout preserves partial output and sets only timedOut", async () => {
  await assert.rejects(
    runProcess(
      node,
      script(
        "process.stdout.write('before'); process.stderr.write('warning'); setTimeout(() => {}, 10000)",
      ),
      { timeoutMs: 500, terminationGraceMs: 100 },
    ),
    (error) => {
      assert.equal(error instanceof TypstTimeoutError, true);
      assert.equal(error.process.stdout.toString(), "before");
      assert.equal(error.process.stderr.toString(), "warning");
      assert.equal(error.process.timedOut, true);
      assert.equal(error.process.aborted, false);
      return true;
    },
  );
});

test("timeout escalates after grace when SIGTERM is ignored", async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(
      node,
      script("process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000)"),
      // Generous timeout so the child has installed its SIGTERM handler before
      // the timeout fires even on a loaded CI runner or during the verify
      // chain under `npm pack`; a too-short timeout lets SIGTERM terminate the
      // child before the handler exists.
      { timeoutMs: 3000, terminationGraceMs: 500 },
    ),
    TypstTimeoutError,
  );
  // The timeout fired (>= 1000ms) and graceful termination was ignored, so
  // escalation to forced termination waited the grace period (~1500ms total).
  assert.equal(Date.now() - started >= 1200, true);
});

test(
  "natural signal exit resolves with signal metadata on POSIX",
  {
    skip:
      process.platform === "win32"
        ? "POSIX signals are unavailable on Windows"
        : false,
  },
  async () => {
    const result = await runProcess(
      node,
      script("process.kill(process.pid, 'SIGTERM')"),
    );
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
  },
);

test("timeout wins a later abort race without changing flags", async () => {
  const controller = new AbortController();
  // The timeout is measured from spawn; under a loaded test run a spawn can
  // take seconds on Windows, so the "late" abort keeps a wide margin. The
  // timer is cleared as soon as the timeout settles the run.
  const lateAbort = setTimeout(() => controller.abort(), 10_000);
  try {
    await assert.rejects(
      runProcess(node, script("setTimeout(() => {}, 10000)"), {
        timeoutMs: 80,
        terminationGraceMs: 20,
        signal: controller.signal,
      }),
      (error) => {
        assert.equal(error instanceof TypstTimeoutError, true);
        assert.equal(error.process.timedOut, true);
        assert.equal(error.process.aborted, false);
        return true;
      },
    );
    assert.equal(controller.signal.aborted, false);
  } finally {
    clearTimeout(lateAbort);
  }
});

test("abort wins an earlier timeout race without changing flags", async () => {
  const controller = new AbortController();
  const earlyAbort = setTimeout(() => controller.abort(), 40);
  try {
    await assert.rejects(
      runProcess(node, script("setTimeout(() => {}, 10000)"), {
        timeoutMs: 5_000,
        terminationGraceMs: 20,
        signal: controller.signal,
      }),
      (error) => {
        assert.equal(error instanceof TypstAbortError, true);
        assert.equal(error.process.timedOut, false);
        assert.equal(error.process.aborted, true);
        return true;
      },
    );
    assert.equal(controller.signal.aborted, true);
  } finally {
    clearTimeout(earlyAbort);
  }
});

test("abort and pre-abort use typed errors with one-shot flags", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    runProcess(node, script("setTimeout(() => {}, 1000)"), {
      signal: preAborted.signal,
    }),
    (error) => {
      assert.equal(error instanceof TypstAbortError, true);
      assert.equal(error.process.aborted, true);
      assert.equal(error.process.timedOut, false);
      assert.equal(error.process.exitCode, null);
      return true;
    },
  );

  const controller = new AbortController();
  const pending = runProcess(node, script("setTimeout(() => {}, 10000)"), {
    signal: controller.signal,
    terminationGraceMs: 30,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => {
    assert.equal(error instanceof TypstAbortError, true);
    assert.equal(error.process.aborted, true);
    assert.equal(error.process.timedOut, false);
    return true;
  });
});

test("invalid timing options fail before spawn", async () => {
  for (const options of [
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { terminationGraceMs: -1 },
    { terminationGraceMs: Number.NaN },
  ]) {
    await assert.rejects(
      runProcess(node, [], options),
      TypstInvalidArgumentError,
    );
  }
});
