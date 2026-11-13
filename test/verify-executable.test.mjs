import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TypstExecutableProbeError,
  discoverTypstExecutableWithDependencies,
} from "../dist/core/executable.js";

const isWindows = process.platform === "win32";

function fixtureExecutable(directory) {
  const executable = join(directory, isWindows ? "typst.exe" : "typst");
  writeFileSync(executable, "fixture");
  if (!isWindows) chmodSync(executable, 0o755);
  return executable;
}

function probeResult(stdout = "Typst 0.15.1\n", exitCode = 0) {
  return {
    executable: "typst",
    args: ["--version"],
    cwd: process.cwd(),
    exitCode,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    durationMs: 1,
  };
}

test("verifyExecutable probes the resolved explicit executable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-verify-exe-"));
  try {
    const executable = fixtureExecutable(directory);
    const result = await discoverTypstExecutableWithDependencies(
      {
        executable,
        verifyExecutable: true,
        discovery: { package: false, environment: false, path: false },
      },
      {
        probe: async () => probeResult(),
      },
    );
    assert.equal(result.source, "explicit");
    assert.equal(result.executable, executable);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verifyExecutable rejects an executable whose probe is not Typst", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-verify-bad-"));
  try {
    const executable = fixtureExecutable(directory);
    await assert.rejects(
      discoverTypstExecutableWithDependencies(
        {
          executable,
          verifyExecutable: true,
          discovery: { package: false, environment: false, path: false },
        },
        {
          probe: async () => probeResult("usage: some-program [options]\n", 0),
        },
      ),
      (error) =>
        error instanceof TypstExecutableProbeError &&
        error.executablePath === executable,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verifyExecutable rejects an executable whose probe fails to spawn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-verify-fail-"));
  try {
    const executable = fixtureExecutable(directory);
    await assert.rejects(
      discoverTypstExecutableWithDependencies(
        {
          executable,
          verifyExecutable: true,
          discovery: { package: false, environment: false, path: false },
        },
        {
          probe: async () => ({
            executable: "typst",
            args: ["--version"],
            cwd: process.cwd(),
            exitCode: null,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            durationMs: 0,
            error: { name: "ENOENT", message: "spawn failed" },
          }),
        },
      ),
      (error) => error instanceof TypstExecutableProbeError,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verifyExecutable is off by default and skips the probe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-verify-default-"));
  try {
    const executable = fixtureExecutable(directory);
    let probes = 0;
    const result = await discoverTypstExecutableWithDependencies(
      {
        executable,
        discovery: { package: false, environment: false, path: false },
      },
      {
        probe: async () => {
          probes += 1;
          return probeResult();
        },
      },
    );
    assert.equal(result.source, "explicit");
    assert.equal(probes, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
