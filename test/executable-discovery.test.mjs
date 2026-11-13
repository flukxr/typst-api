import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverTypstExecutable } from "../dist/index.js";
import {
  discoverTypstExecutableWithDependencies,
  TypstExecutableIntegrityError,
  TypstExecutableLauncherError,
  TypstExecutableNotExecutableError,
  TypstExecutableNotFoundError,
  TypstExecutableNotRegularFileError,
  TypstExecutablePackageError,
  TypstExecutableProbeError,
} from "../dist/core/executable.js";

const isWindows = process.platform === "win32";

async function fixtureDirectory() {
  return await mkdtemp(path.join(os.tmpdir(), "typst-api-discovery-"));
}

async function fixtureExecutable(
  directory,
  name = isWindows ? "typst.exe" : "typst",
) {
  const executable = path.join(directory, name);
  await writeFile(executable, "fixture");
  if (!isWindows) await chmod(executable, 0o755);
  return executable;
}

test("explicit discovery wins and normalises relative paths against cwd", async () => {
  const directory = await fixtureDirectory();
  try {
    const executable = await fixtureExecutable(directory);
    const parent = path.dirname(directory);
    const result = await discoverTypstExecutable({
      executable: path.relative(parent, executable),
      cwd: parent,
      envMode: "replace",
      env: {},
      discovery: { package: false, environment: false, path: false },
    });
    assert.equal(result.source, "explicit");
    assert.equal(
      result.executable,
      path.normalize(path.resolve(parent, path.relative(parent, executable))),
    );
    assert.equal(result.cwd, path.resolve(parent));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("discovery priority is explicit, package, environment, then PATH", async () => {
  const directory = await fixtureDirectory();
  try {
    const explicit = await fixtureExecutable(
      directory,
      isWindows ? "explicit.exe" : "explicit",
    );
    const packaged = await fixtureExecutable(
      directory,
      isWindows ? "packaged.exe" : "packaged",
    );
    const configured = await fixtureExecutable(
      directory,
      isWindows ? "configured.exe" : "configured",
    );
    const pathExecutable = await fixtureExecutable(directory);
    let loaderCalls = 0;
    const explicitResult = await discoverTypstExecutableWithDependencies(
      {
        executable: explicit,
        cwd: directory,
        envMode: "replace",
        env: { TYPST_PATH: configured, PATH: directory },
      },
      {
        loadLauncher: () => {
          loaderCalls += 1;
          throw new Error(
            "package must not be loaded after explicit selection",
          );
        },
      },
    );
    assert.equal(explicitResult.source, "explicit");
    assert.equal(loaderCalls, 0);

    const packageResult = await discoverTypstExecutableWithDependencies(
      {
        cwd: directory,
        envMode: "replace",
        env: { TYPST_PATH: configured, PATH: directory },
      },
      {
        loadLauncher: () => ({ typstPath: packaged, version: "0.15.1" }),
        probe: async (candidate, cwd) => ({
          executable: candidate,
          args: ["--version"],
          cwd,
          exitCode: 0,
          signal: null,
          stdout: Buffer.from("typst 0.15.1\n"),
          stderr: Buffer.alloc(0),
          durationMs: 1,
        }),
      },
    );
    assert.equal(packageResult.source, "package");
    assert.equal(packageResult.executable, path.normalize(packaged));

    // With package discovery disabled, TYPST_PATH wins over the PATH fixture.
    const environmentResult = await discoverTypstExecutable({
      cwd: directory,
      envMode: "replace",
      env: { TYPST_PATH: configured, PATH: directory },
      discovery: { package: false },
    });
    assert.equal(environmentResult.source, "environment");
    assert.notEqual(
      environmentResult.executable,
      path.normalize(pathExecutable),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("each implicit discovery switch can be disabled independently", async () => {
  const directory = await fixtureDirectory();
  try {
    const executable = await fixtureExecutable(directory);
    let packageCalls = 0;
    const packageDisabled = await discoverTypstExecutableWithDependencies(
      {
        cwd: directory,
        envMode: "replace",
        env: { PATH: directory },
        discovery: { package: false, environment: false },
      },
      {
        loadLauncher: () => {
          packageCalls += 1;
          return { typstPath: executable, version: "0.15.1" };
        },
      },
    );
    assert.equal(packageDisabled.source, "path");
    assert.equal(packageCalls, 0);

    await assert.rejects(
      discoverTypstExecutable({
        cwd: directory,
        envMode: "replace",
        env: { TYPST_PATH: executable, PATH: directory },
        discovery: { package: false, environment: false, path: false },
      }),
      (error) =>
        error instanceof TypstExecutableNotFoundError &&
        error.attempts.length === 0 &&
        error.message.includes("all implicit discovery sources are disabled"),
    );

    const environmentDisabled = await discoverTypstExecutable({
      cwd: directory,
      envMode: "replace",
      env: { TYPST_PATH: executable, PATH: directory },
      discovery: { package: false, environment: false },
    });
    assert.equal(environmentDisabled.source, "path");

    await assert.rejects(
      discoverTypstExecutable({
        cwd: directory,
        envMode: "replace",
        env: { TYPST_PATH: "missing", PATH: directory },
        discovery: { package: false, path: false },
      }),
      TypstExecutableNotFoundError,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("TYPST_PATH is authoritative and uses the effective cwd", async () => {
  const directory = await fixtureDirectory();
  try {
    const executable = await fixtureExecutable(directory);
    const result = await discoverTypstExecutable({
      cwd: directory,
      envMode: "replace",
      env: { TYPST_PATH: path.basename(executable) },
      discovery: { package: false, path: false },
    });
    assert.equal(result.source, "environment");
    assert.equal(
      isWindows ? result.executable.toLowerCase() : result.executable,
      isWindows
        ? path.normalize(executable).toLowerCase()
        : path.normalize(executable),
    );

    await assert.rejects(
      discoverTypstExecutable({
        cwd: directory,
        envMode: "replace",
        env: { TYPST_PATH: "missing-typst" },
        discovery: { package: false, path: true },
      }),
      (error) =>
        error instanceof TypstExecutableNotFoundError &&
        error.source === "environment",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("merge and replace environment modes control PATH lookup", async () => {
  const directory = await fixtureDirectory();
  try {
    await fixtureExecutable(directory);
    const merged = await discoverTypstExecutable({
      cwd: directory,
      envMode: "merge",
      env: { PATH: directory },
      discovery: { package: false, environment: false },
    });
    assert.equal(merged.source, "path");
    const replaced = await discoverTypstExecutable({
      cwd: directory,
      envMode: "replace",
      env: { PATH: directory },
      discovery: { package: false, environment: false },
    });
    assert.equal(replaced.source, "path");
    assert.equal(replaced.env.PATH, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("merge inherits an existing environment key while replace excludes it", async () => {
  const directory = await fixtureDirectory();
  try {
    await fixtureExecutable(directory);
    const inheritedKey = Object.keys(process.env).find(
      (key) =>
        process.env[key] !== undefined &&
        key.toUpperCase() !== "PATH" &&
        key.toUpperCase() !== "PATHEXT" &&
        key.toUpperCase() !== "TYPST_PATH",
    );
    assert.ok(
      inheritedKey,
      "the test process should expose an inherited environment key",
    );
    const inheritedValue = process.env[inheritedKey];
    const merged = await discoverTypstExecutable({
      cwd: directory,
      envMode: "merge",
      env: { PATH: directory },
      discovery: { package: false, environment: false },
    });
    assert.equal(merged.env[inheritedKey], inheritedValue);
    const replaced = await discoverTypstExecutable({
      cwd: directory,
      envMode: "replace",
      env: { PATH: directory },
      discovery: { package: false, environment: false },
    });
    assert.equal(replaced.env[inheritedKey], undefined);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("Windows environment lookup is case-insensitive", async (context) => {
  if (!isWindows) {
    context.skip("case-insensitive environment semantics are Windows-specific");
    return;
  }
  const directory = await fixtureDirectory();
  try {
    await fixtureExecutable(directory);
    const pathResult = await discoverTypstExecutable({
      cwd: directory,
      envMode: "replace",
      env: { pAtH: directory },
      discovery: { package: false, environment: false },
    });
    assert.equal(pathResult.source, "path");
    const environmentExecutable = await fixtureExecutable(
      directory,
      "configured.exe",
    );
    const environmentResult = await discoverTypstExecutable({
      cwd: directory,
      envMode: "replace",
      env: { tYpSt_PaTh: environmentExecutable },
      discovery: { package: false, path: false },
    });
    assert.equal(environmentResult.source, "environment");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("spaces, Unicode, and configured directories retain distinct diagnostics", async () => {
  const root = await fixtureDirectory();
  const directory = path.join(root, "space and Ω");
  await mkdir(directory);
  try {
    const executable = await fixtureExecutable(directory);
    const result = await discoverTypstExecutable({
      cwd: directory,
      envMode: "replace",
      env: { PATH: directory },
      discovery: { package: false, environment: false },
    });
    assert.equal(result.source, "path");
    assert.equal(
      isWindows ? result.executable.toLowerCase() : result.executable,
      isWindows
        ? path.normalize(executable).toLowerCase()
        : path.normalize(executable),
    );

    await assert.rejects(
      discoverTypstExecutable({
        executable: directory,
        discovery: { package: false, environment: false, path: false },
      }),
      TypstExecutableNotRegularFileError,
    );
    await assert.rejects(
      discoverTypstExecutable({
        executable: path.join(directory, "missing typst"),
        discovery: { package: false, environment: false, path: false },
      }),
      TypstExecutableNotFoundError,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("PATH search handles empty entries, relative entries, and PATHEXT", async () => {
  const directory = await fixtureDirectory();
  try {
    const name = isWindows ? "typst.ExE" : "typst";
    const executable = await fixtureExecutable(directory, name);
    const result = await discoverTypstExecutableWithDependencies(
      {
        cwd: directory,
        envMode: "replace",
        env: isWindows
          ? { PATH: ".;missing", PATHEXT: ".cmd;.EXE" }
          : { PATH: ".:missing" },
        discovery: { package: false, environment: false },
      },
      { platform: process.platform },
    );
    assert.equal(result.source, "path");
    assert.equal(
      result.executable,
      isWindows
        ? path.normalize(path.join(directory, "typst.EXE"))
        : path.normalize(executable),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test(
  "Windows PATH search skips batch and extensionless shims for a later typst.exe",
  { skip: !isWindows },
  async () => {
    const shims = await fixtureDirectory();
    const binaries = await fixtureDirectory();
    try {
      // The layout a global `npm install -g @flukxr/typst-cli` produces.
      await fixtureExecutable(shims, "typst");
      await fixtureExecutable(shims, "typst.cmd");
      await fixtureExecutable(shims, "typst.ps1");
      const executable = await fixtureExecutable(binaries, "typst.exe");
      const result = await discoverTypstExecutableWithDependencies(
        {
          cwd: shims,
          envMode: "replace",
          env: {
            PATH: `${shims};${binaries}`,
            PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
          },
          discovery: { package: false, environment: false },
        },
        { platform: process.platform },
      );
      // Windows paths are case-insensitive; the extension follows PATHEXT.
      assert.equal(
        result.executable.toLowerCase(),
        path.normalize(executable).toLowerCase(),
      );
    } finally {
      await rm(shims, { force: true, recursive: true });
      await rm(binaries, { force: true, recursive: true });
    }
  },
);

test(
  "Windows rejects an explicit batch shim with a typed, explanatory error",
  { skip: !isWindows },
  async () => {
    const directory = await fixtureDirectory();
    try {
      const shim = await fixtureExecutable(directory, "typst.cmd");
      await assert.rejects(
        discoverTypstExecutable({
          executable: shim,
          discovery: { package: false, environment: false, path: false },
        }),
        (error) =>
          error instanceof TypstExecutableNotExecutableError &&
          /\.exe or \.com/.test(error.message),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test("package absence falls through, while malformed/nested failures do not", async () => {
  const directory = await fixtureDirectory();
  try {
    const executable = await fixtureExecutable(directory);
    const absent = Object.assign(
      new Error("Cannot find module '@flukxr/typst-cli'"),
      {
        code: "MODULE_NOT_FOUND",
      },
    );
    const result = await discoverTypstExecutableWithDependencies(
      {
        cwd: directory,
        envMode: "replace",
        env: { TYPST_PATH: executable },
        discovery: { path: false },
      },
      {
        loadLauncher: () => {
          throw absent;
        },
      },
    );
    assert.equal(result.source, "environment");

    const nested = Object.assign(
      new Error("Cannot find module 'missing-dependency'"),
      {
        code: "MODULE_NOT_FOUND",
      },
    );
    await assert.rejects(
      discoverTypstExecutableWithDependencies(
        {
          envMode: "replace",
          env: {},
          discovery: { environment: false, path: false },
        },
        {
          loadLauncher: () => {
            throw nested;
          },
        },
      ),
      TypstExecutablePackageError,
    );

    await assert.rejects(
      discoverTypstExecutableWithDependencies(
        {
          envMode: "replace",
          env: {},
          discovery: { environment: false, path: false },
        },
        { loadLauncher: () => ({ typstPath: executable, version: "0.15.1" }) },
      ),
      TypstExecutableProbeError,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("package probe retains raw output and rejects exact-version mismatch", async () => {
  const directory = await fixtureDirectory();
  try {
    const executable = await fixtureExecutable(directory);
    const probe = {
      executable,
      args: ["--version"],
      cwd: directory,
      exitCode: 0,
      signal: null,
      stdout: Buffer.from("typst 0.15.0\n"),
      stderr: Buffer.from("warning\n"),
      durationMs: 3,
    };
    await assert.rejects(
      discoverTypstExecutableWithDependencies(
        {
          envMode: "replace",
          env: {},
          discovery: { environment: false, path: false },
        },
        {
          loadLauncher: () => ({ typstPath: executable, version: "0.15.1" }),
          probe: async () => probe,
        },
      ),
      (error) =>
        error instanceof TypstExecutableIntegrityError &&
        error.actualVersion === "0.15.0" &&
        error.probe?.stdout.toString() === "typst 0.15.0\n" &&
        error.probe?.stderr.toString() === "warning\n",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("package launcher success validates exact output and keeps launcher metadata", async () => {
  const directory = await fixtureDirectory();
  try {
    const executable = await fixtureExecutable(directory);
    const result = await discoverTypstExecutableWithDependencies(
      {
        cwd: directory,
        envMode: "replace",
        env: {},
        discovery: { environment: false, path: false },
      },
      {
        loadLauncher: () => ({ typstPath: executable, version: "0.15.1" }),
        probe: async (candidate, cwd) => ({
          executable: candidate,
          args: ["--version"],
          cwd,
          exitCode: 0,
          signal: null,
          stdout: Buffer.from("typst 0.15.1\n"),
          stderr: Buffer.alloc(0),
          durationMs: 1,
        }),
      },
    );
    assert.equal(result.source, "package");
    assert.equal(result.launcher?.declaredVersion, "0.15.1");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("malformed launcher and unparseable/non-zero probes are typed failures", async () => {
  const directory = await fixtureDirectory();
  try {
    const executable = await fixtureExecutable(directory);
    const base = {
      envMode: "replace",
      env: {},
      discovery: { environment: false, path: false },
    };
    await assert.rejects(
      discoverTypstExecutableWithDependencies(base, {
        loadLauncher: () => ({ typstPath: executable }),
      }),
      TypstExecutableLauncherError,
    );
    await assert.rejects(
      discoverTypstExecutableWithDependencies(base, {
        loadLauncher: () => ({ typstPath: executable, version: "0.15.1" }),
        probe: async (candidate, cwd) => ({
          executable: candidate,
          args: ["--version"],
          cwd,
          exitCode: 0,
          signal: null,
          stdout: Buffer.from("not a version\n"),
          stderr: Buffer.from("raw stderr\n"),
          durationMs: 1,
        }),
      }),
      (error) =>
        error instanceof TypstExecutableProbeError &&
        error.probe?.stderr.toString() === "raw stderr\n",
    );
    await assert.rejects(
      discoverTypstExecutableWithDependencies(base, {
        loadLauncher: () => ({ typstPath: executable, version: "0.15.1" }),
        probe: async (candidate, cwd) => ({
          executable: candidate,
          args: ["--version"],
          cwd,
          exitCode: 7,
          signal: null,
          stdout: Buffer.from("typst 0.15.1\n"),
          stderr: Buffer.from("failed\n"),
          durationMs: 1,
        }),
      }),
      (error) =>
        error instanceof TypstExecutableProbeError &&
        error.probe?.exitCode === 7,
    );
    await assert.rejects(
      discoverTypstExecutableWithDependencies(base, {
        loadLauncher: () => ({ typstPath: executable, version: "0.15.1" }),
        probe: async () => {
          throw new Error("injected probe failure");
        },
      }),
      (error) =>
        error instanceof TypstExecutableProbeError &&
        error.probe?.error?.message === "injected probe failure",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("POSIX executable mode errors are distinct", async (context) => {
  if (isWindows) {
    context.skip("Windows does not expose POSIX executable mode bits");
    return;
  }
  const directory = await fixtureDirectory();
  try {
    const executable = await fixtureExecutable(directory);
    await chmod(executable, 0o644);
    await assert.rejects(
      discoverTypstExecutable({
        executable,
        discovery: { package: false, environment: false, path: false },
      }),
      TypstExecutableNotExecutableError,
    );
    const info = await stat(executable);
    assert.equal(info.isFile(), true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
