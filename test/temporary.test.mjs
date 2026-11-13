import assert from "node:assert/strict";
import { access, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTemporaryScope, withTemporaryScope } from "../dist/core/temp.js";
import { runProcess } from "../dist/core/process.js";
import {
  TypstAbortError,
  TypstSpawnError,
  TypstTimeoutError,
} from "../dist/core/errors.js";

const node = process.execPath;
const script = (source) => ["-e", source];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("creates unique package-owned roots and nested Unicode/space-safe artifacts", async () => {
  const first = await createTemporaryScope();
  const second = await createTemporaryScope();
  try {
    assert.notEqual(first.root, second.root);
    assert.equal(path.dirname(first.root), os.tmpdir());
    assert.equal(path.basename(first.root).startsWith("typst-api-"), true);

    const directory = await first.createDirectory("nested folder/深い");
    const file = await first.createFile(
      "nested folder/深い/source file.typ",
      "= temporary",
    );
    assert.equal((await stat(directory)).isDirectory(), true);
    assert.equal((await stat(file)).isFile(), true);
    assert.equal(first.path("nested folder/深い/source file.typ"), file);
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
  }
});

test("cleanup recursively removes artifacts, tolerates missing roots, and is idempotent", async () => {
  const scope = await createTemporaryScope();
  const root = scope.root;
  const file = await scope.createFile("nested/file.txt", "data");
  await rm(file, { force: true });
  await scope.cleanup();
  await scope.cleanup();
  assert.equal(await exists(root), false);

  // A root removed by another actor is still a successful cleanup.
  const missing = await createTemporaryScope();
  const missingRoot = missing.root;
  await rm(missingRoot, { recursive: true, force: true });
  await missing.cleanup();
  assert.equal(await exists(missingRoot), false);
});

test("path traversal and absolute paths cannot escape the owned root", async () => {
  const scope = await createTemporaryScope();
  try {
    await assert.rejects(scope.createFile("../outside.txt"), TypeError);
    await assert.rejects(scope.createDirectory("../../outside"), TypeError);
    await assert.rejects(
      scope.createFile(path.resolve(scope.root, "outside")),
      TypeError,
    );
    assert.equal(scope.path("."), scope.root);
  } finally {
    await scope.cleanup();
  }
});

test("disposed scopes reject path resolution and artifact creation", async () => {
  const scope = await createTemporaryScope();
  await scope.cleanup();
  assert.equal(scope.disposed, true);
  assert.throws(() => scope.path("again"), /disposed/);
  await assert.rejects(scope.createDirectory("again"), /disposed/);
  await assert.rejects(scope.createFile("again.txt"), /disposed/);
});

test("withTemporaryScope returns callback values and cleans up on success", async () => {
  let root;
  const value = await withTemporaryScope(async (scope) => {
    root = scope.root;
    await scope.createFile("result.txt", "ok");
    return { answer: 42 };
  });
  assert.deepEqual(value, { answer: 42 });
  assert.equal(await exists(root), false);
});

test("withTemporaryScope preserves the original callback error identity", async () => {
  const expected = new Error("operation failed");
  let root;
  await assert.rejects(
    withTemporaryScope(async (scope) => {
      root = scope.root;
      await scope.createFile("failure.txt", "x");
      throw expected;
    }),
    (error) => error === expected,
  );
  assert.equal(await exists(root), false);
});

test("cleanup failure is reported only when the callback succeeded", async () => {
  let successRoot;
  const cleanupFailure = new Error("cleanup failed");
  await assert.rejects(
    withTemporaryScope(
      async (scope) => {
        successRoot = scope.root;
        return "value";
      },
      {
        remove: async () => {
          throw cleanupFailure;
        },
      },
    ),
    (error) => error === cleanupFailure,
  );
  await rm(successRoot, { recursive: true, force: true });

  const operationFailure = new Error("operation failed first");
  let failureRoot;
  await assert.rejects(
    withTemporaryScope(
      async (scope) => {
        failureRoot = scope.root;
        throw operationFailure;
      },
      {
        remove: async () => {
          throw cleanupFailure;
        },
      },
    ),
    (error) => error === operationFailure,
  );
  await rm(failureRoot, { recursive: true, force: true });
});

test("scope cleanup covers spawn failures", async () => {
  let root;
  let caught;
  await assert.rejects(
    withTemporaryScope(async (scope) => {
      root = scope.root;
      await scope.createFile("spawn.txt");
      await runProcess("typst-api-temporary-command-that-does-not-exist");
    }),
    (error) => {
      caught = error;
      return error instanceof TypstSpawnError;
    },
  );
  assert.equal(caught instanceof TypstSpawnError, true);
  assert.equal(await exists(root), false);
});

test("scope cleanup covers timeout and abort failures", async () => {
  let timeoutRoot;
  let timeoutError;
  await assert.rejects(
    withTemporaryScope(async (scope) => {
      timeoutRoot = scope.root;
      await scope.createFile("timeout.txt");
      await runProcess(node, script("setTimeout(() => {}, 10000)"), {
        timeoutMs: 80,
        terminationGraceMs: 10,
      });
    }),
    (error) => {
      timeoutError = error;
      return error instanceof TypstTimeoutError;
    },
  );
  assert.equal(timeoutError instanceof TypstTimeoutError, true);
  assert.equal(await exists(timeoutRoot), false);

  let abortRoot;
  let abortError;
  await assert.rejects(
    withTemporaryScope(async (scope) => {
      abortRoot = scope.root;
      await scope.createFile("abort.txt");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      await runProcess(node, script("setTimeout(() => {}, 10000)"), {
        signal: controller.signal,
        terminationGraceMs: 10,
      });
    }),
    (error) => {
      abortError = error;
      return error instanceof TypstAbortError;
    },
  );
  assert.equal(abortError instanceof TypstAbortError, true);
  assert.equal(await exists(abortRoot), false);
});
