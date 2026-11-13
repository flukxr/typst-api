import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("package-smoke.mjs must be run through an npm script");
}

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      // A nested npm pack must write a real tarball even when the enclosing
      // npm invocation inherited a --dry-run flag (e.g. prepack during
      // `npm pack --dry-run`).
      env: { ...process.env, npm_config_dry_run: "false" },
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
      });
    });
  });
}

function assertSucceeded(result, description) {
  assert.equal(
    result.exitCode,
    0,
    `${description} failed\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`,
  );
  assert.equal(result.signal, null, `${description} exited by signal`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "typst-api-package-smoke-"));
try {
  const packResult = await run(
    process.execPath,
    [
      npmCli,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporaryRoot,
    ],
    repositoryRoot,
  );
  assertSucceeded(packResult, "npm pack");

  const packDescription = JSON.parse(packResult.stdout.toString("utf8"));
  const packed = Array.isArray(packDescription)
    ? packDescription[0]
    : Object.values(packDescription)[0];
  assert.ok(packed, "npm pack did not describe the generated tarball");
  const packedPaths = new Set(packed.files.map((file) => file.path));
  for (const requiredPath of [
    "README.md",
    "LICENSE",
    "data/capabilities.seed.json",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json",
  ]) {
    assert.ok(
      packedPaths.has(requiredPath),
      `packed tarball is missing ${requiredPath}`,
    );
  }
  assert.ok(
    [...packedPaths].every(
      (path) =>
        path === "README.md" ||
        path === "package.json" ||
        path === "LICENSE" ||
        path.startsWith("data/") ||
        path.startsWith("dist/"),
    ),
    "packed tarball contains an unexpected file",
  );

  const fixture = join(temporaryRoot, "fixture");
  await mkdir(fixture);
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );

  const tarball = join(temporaryRoot, packed.filename);
  const installResult = await run(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    fixture,
  );
  assertSucceeded(installResult, "fixture install");

  const importResult = await run(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("@flukxr/typst-api");'],
    fixture,
  );
  assertSucceeded(importResult, "fixture import");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
