// Shared helper: resolve a real Typst executable for integration-flavored
// tests. Candidates are checked in the same order as the API's discovery:
// explicit env, launcher package, then PATH.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
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

export async function resolveRealTypst() {
  const candidates = [];
  if (process.env.TYPST_API_TEST_EXECUTABLE) {
    candidates.push(process.env.TYPST_API_TEST_EXECUTABLE);
  }
  if (process.env.TYPST_PATH) {
    candidates.push(process.env.TYPST_PATH);
  }
  // The optional `@flukxr/typst-cli` development dependency exposes the real
  // executable path directly; on Windows the npm `.cmd` shim cannot be spawned
  // with `shell: false`, so this is preferred over PATH discovery there.
  try {
    const require = createRequire(import.meta.url);
    const launcher = require("@flukxr/typst-cli");
    if (typeof launcher.typstPath === "string" && launcher.typstPath) {
      candidates.push(launcher.typstPath);
    }
  } catch {
    // The launcher package is optional in the test environment.
  }
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const found = await run(lookup, ["typst"]).then(
    (result) =>
      result.exitCode === 0
        ? result.stdout.toString("utf8").trim().split(/\r?\n/u)[0]
        : undefined,
    () => undefined,
  );
  if (found) candidates.push(found);

  for (const candidate of candidates) {
    const probe = await run(candidate, ["--version"]).then(
      (result) => result,
      () => undefined,
    );
    if (probe && probe.exitCode === 0) {
      return {
        executable: candidate,
        version: probe.stdout.toString("utf8").trim(),
      };
    }
  }
  return undefined;
}
