// Every runnable example is spawned with `node` and must exit 0 while leaving
// the expected side effects in TYPST_EXAMPLES_DIR. The suite skips when no real
// Typst executable can be discovered (same condition as the integration suite).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveRealTypst } from "./helpers/resolve-real-typst.mjs";

const real = await resolveRealTypst();
const skip =
  real === undefined
    ? "no real Typst executable found (set TYPST_API_TEST_EXECUTABLE or TYPST_PATH)"
    : false;

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function runExample(example, args = []) {
  return new Promise((resolve, reject) => {
    const outDir = mkdtempSync(join(tmpdir(), "typst-api-examples-"));
    const child = spawn(process.execPath, [example, ...args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        TYPST_EXAMPLES_DIR: outDir,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        outDir,
      });
    });
  });
}

const PDF_MAGIC = "%PDF-";

for (const [name, example, args, verify] of [
  [
    "compile-file example",
    "examples/compile-file.mjs",
    [],
    (result) => {
      const pdf = join(result.outDir, "document.pdf");
      assert.ok(existsSync(pdf), "document.pdf was not written");
      assert.equal(readFileSync(pdf).subarray(0, 5).toString(), PDF_MAGIC);
    },
  ],
  [
    "compile-source-buffer example",
    "examples/compile-source-buffer.mjs",
    [],
    (result) => {
      const pdf = join(result.outDir, "from-source.pdf");
      assert.ok(existsSync(pdf), "from-source.pdf was not written");
      assert.equal(readFileSync(pdf).subarray(0, 5).toString(), PDF_MAGIC);
    },
  ],
  [
    "custom-executable example",
    "examples/custom-executable.mjs",
    [real.executable],
    (result) => {
      assert.match(result.stdout.toString(), /version=\d+\.\d+\.\d+/u);
      assert.match(result.stdout.toString(), /executableSource=explicit/u);
    },
  ],
  [
    "watch example",
    "examples/watch.mjs",
    [],
    (result) => {
      assert.ok(
        existsSync(join(result.outDir, "out.pdf")),
        "out.pdf was not written",
      );
      assert.match(result.stdout.toString(), /initial cycle status=success/u);
      assert.match(
        result.stdout.toString(),
        /closed exitCode=(null|\d+) signal=(\w+)?/u,
      );
    },
  ],
  [
    "query example",
    "examples/query.mjs",
    [],
    (result) => {
      assert.match(result.stdout.toString(), /found heading/u);
      assert.match(result.stdout.toString(), /matched=2/u);
    },
  ],
  [
    "html example",
    "examples/html.mjs",
    [],
    (result) => {
      assert.match(result.stdout.toString(), /format=html/u);
    },
  ],
  [
    "project example",
    "examples/project.mjs",
    [],
    (result) => {
      assert.match(result.stdout.toString(), /project pdf bytes=\d+/u);
    },
  ],
  [
    "scripting example",
    "examples/scripting.mjs",
    [],
    (result) => {
      const stdout = result.stdout.toString();
      assert.match(stdout, /single .*invoice-1\.pdf/u);
      assert.match(stdout, /batch ok=2/u);
      assert.match(stdout, /buffer bytes=\d+/u);
      assert.match(stdout, /headings=1/u);
      for (const id of [1, 2, 3]) {
        assert.ok(
          existsSync(join(result.outDir, `invoice-${id}.pdf`)),
          `invoice-${id}.pdf was not written`,
        );
      }
    },
  ],
  [
    "bundle example",
    "examples/bundle.mjs",
    [],
    (result) => {
      assert.match(result.stdout.toString(), /index\.html bytes=\d+/u);
    },
  ],
]) {
  test(name, { skip, timeout: 60_000 }, async () => {
    const result = await runExample(join(repositoryRoot, example), args);
    try {
      assert.equal(
        result.exitCode,
        0,
        `${example} failed\nexitCode=${result.exitCode}\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`,
      );
      assert.equal(result.signal, null, `${example} exited by signal`);
      verify(result);
    } finally {
      rmSync(result.outDir, { recursive: true, force: true });
    }
  });
}
