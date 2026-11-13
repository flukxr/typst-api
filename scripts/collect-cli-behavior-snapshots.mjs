import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { repositorySnapshotRoot } from "./snapshot-root.mjs";

const HANDOFF_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const SNAPSHOT_ROOT = repositorySnapshotRoot();
const CACHE_ROOT = path.join(HANDOFF_ROOT, ".cache", "typst-cli");

const CASES = [
  {
    version: "0.14.2",
    name: "compile-timings-without-output",
    args: ["compile", "minimal.typ", "--timings"],
    fixture: true,
  },
  {
    version: "0.15.0",
    name: "compile-timings-without-output",
    args: ["compile", "minimal.typ", "--timings"],
    fixture: true,
  },
  {
    version: "0.15.0",
    name: "invalid-eval-expression",
    args: ["eval", "does-not-exist"],
  },
  {
    version: "0.15.1",
    name: "invalid-eval-expression",
    args: ["eval", "does-not-exist"],
  },
];

function runProcess(executable, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, signal) =>
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        spawnError: spawnError
          ? {
              name: spawnError.name,
              message: spawnError.message,
              code: spawnError.code,
            }
          : null,
      }),
    );
  });
}

function resolveExecutable(version, packageVersion) {
  const workspace = path.join(CACHE_ROOT, version, packageVersion);
  const require = createRequire(path.join(workspace, "behavior-loader.cjs"));
  return require("@flukxr/typst-cli").typstPath;
}

for (const behaviorCase of CASES) {
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(SNAPSHOT_ROOT, behaviorCase.version, "manifest.json"),
      "utf8",
    ),
  );
  const executable = resolveExecutable(
    behaviorCase.version,
    manifest.packageVersion,
  );
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "typst-api-m0-"));
  try {
    if (behaviorCase.fixture) {
      await fs.copyFile(
        path.join(HANDOFF_ROOT, "fixtures", "minimal.typ"),
        path.join(tempDir, "minimal.typ"),
      );
    }
    const result = await runProcess(executable, behaviorCase.args, tempDir);
    const outputDir = path.join(
      SNAPSHOT_ROOT,
      behaviorCase.version,
      "behavior",
    );
    await fs.mkdir(outputDir, { recursive: true });
    const record = {
      typstVersion: behaviorCase.version,
      packageVersion: manifest.packageVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      executable: path
        .relative(HANDOFF_ROOT, executable)
        .replaceAll(path.sep, "/"),
      args: behaviorCase.args,
      exitCode: result.exitCode,
      signal: result.signal,
      spawnError: result.spawnError,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    await fs.writeFile(
      path.join(outputDir, `${behaviorCase.name}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    await fs.writeFile(
      path.join(outputDir, `${behaviorCase.name}.stdout.txt`),
      result.stdout,
    );
    await fs.writeFile(
      path.join(outputDir, `${behaviorCase.name}.stderr.txt`),
      result.stderr,
    );
    console.log(
      `[collected] ${behaviorCase.version} ${behaviorCase.name}: exit ${result.exitCode}`,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
