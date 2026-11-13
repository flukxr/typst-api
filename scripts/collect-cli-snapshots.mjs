import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { repositorySnapshotRoot } from "./snapshot-root.mjs";

const HANDOFF_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const RELEASES_PATH = path.join(HANDOFF_ROOT, "data", "typst-releases.json");
const SNAPSHOT_ROOT = repositorySnapshotRoot();
const CACHE_ROOT = path.join(HANDOFF_ROOT, ".cache", "typst-cli");

const COMMAND_CANDIDATES = [
  "compile",
  "watch",
  "fonts",
  "query",
  "update",
  "init",
  "info",
  "completions",
  "eval",
];

function parseArgs(argv) {
  const result = {
    versions: null,
    from: null,
    to: null,
    force: false,
    strict: false,
    packageRevision: "latest",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--force") result.force = true;
    else if (token === "--strict") result.strict = true;
    else if (token === "--versions")
      result.versions = argv[++index]?.split(",").filter(Boolean);
    else if (token === "--from") result.from = argv[++index];
    else if (token === "--to") result.to = argv[++index];
    else if (token === "--package-revision")
      result.packageRevision = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }

  return result;
}

function parseStableSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Expected exact stable SemVer, got: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareStableSemver(left, right) {
  const a = parseStableSemver(left);
  const b = parseStableSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function selectVersions(releases, options) {
  let versions = releases.map((release) => release.version);

  if (options.versions) {
    const requested = new Set(options.versions);
    versions = versions.filter((version) => requested.has(version));
    const missing = [...requested].filter(
      (version) => !versions.includes(version),
    );
    if (missing.length)
      throw new Error(`Unknown release(s): ${missing.join(", ")}`);
  }

  if (options.from) {
    versions = versions.filter(
      (version) => compareStableSemver(version, options.from) >= 0,
    );
  }
  if (options.to) {
    versions = versions.filter(
      (version) => compareStableSemver(version, options.to) <= 0,
    );
  }

  return versions;
}

function runProcess(executable, args, options = {}) {
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    let spawnError = null;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 120_000);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        executable,
        args,
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
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    child.stdin.end(options.stdin);
  });
}

async function listPublishedPackageVersions() {
  const npm = npmInvocation();
  const result = await runProcess(
    npm.executable,
    [...npm.prefixArgs, "view", "@flukxr/typst-cli", "versions", "--json"],
    { timeoutMs: 120_000 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`npm view failed:\n${result.stderr || result.stdout}`);
  }

  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function npmInvocation() {
  if (process.env.npm_execpath) {
    return {
      executable: process.execPath,
      prefixArgs: [process.env.npm_execpath],
    };
  }

  return {
    executable: process.platform === "win32" ? "npm.cmd" : "npm",
    prefixArgs: [],
  };
}

function highestPackagingVersion(typstVersion, publishedVersions) {
  const escaped = typstVersion.replaceAll(".", "\\.");
  const pattern = new RegExp(`^${escaped}-npm\\.(\\d+)$`);
  const matches = publishedVersions
    .map((version) => {
      const match = pattern.exec(version);
      return match ? { version, revision: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.revision - a.revision);

  return matches[0]?.version ?? null;
}

async function ensureInstalled(typstVersion, fullPackageVersion) {
  const workspace = path.join(CACHE_ROOT, typstVersion, fullPackageVersion);
  const packageJson = path.join(workspace, "package.json");
  const installedMarker = path.join(
    workspace,
    "node_modules",
    "@flukxr",
    "typst-cli",
    "package.json",
  );

  await fs.mkdir(workspace, { recursive: true });

  try {
    await fs.access(installedMarker);
    return workspace;
  } catch {}

  await fs.writeFile(
    packageJson,
    JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
    "utf8",
  );

  const npm = npmInvocation();
  const install = await runProcess(
    npm.executable,
    [
      ...npm.prefixArgs,
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--save-exact",
      `@flukxr/typst-cli@${fullPackageVersion}`,
    ],
    { cwd: workspace, timeoutMs: 10 * 60_000 },
  );

  if (install.exitCode !== 0) {
    const error = new Error(
      `Failed to install @flukxr/typst-cli@${fullPackageVersion}`,
    );
    error.result = install;
    throw error;
  }

  return workspace;
}

function resolveLauncher(workspace) {
  const require = createRequire(path.join(workspace, "snapshot-loader.cjs"));
  const launcher = require("@flukxr/typst-cli");
  return {
    typstPath: launcher.typstPath,
    declaredVersion: launcher.version,
  };
}

async function writeProbe(snapshotDir, name, result) {
  const snapshotResult = {
    ...result,
    executable: path
      .relative(HANDOFF_ROOT, result.executable)
      .replaceAll(path.sep, "/"),
  };
  await fs.writeFile(
    path.join(snapshotDir, `${name}.json`),
    JSON.stringify(snapshotResult, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(snapshotDir, `${name}.stdout.txt`),
    result.stdout,
    "utf8",
  );
  await fs.writeFile(
    path.join(snapshotDir, `${name}.stderr.txt`),
    result.stderr,
    "utf8",
  );
}

async function collectVersion(typstVersion, fullPackageVersion, options) {
  const snapshotDir = path.join(SNAPSHOT_ROOT, typstVersion);

  if (!options.force) {
    try {
      await fs.access(path.join(snapshotDir, "manifest.json"));
      console.log(`[skip] ${typstVersion}: snapshot exists`);
      return;
    } catch {}
  }

  await fs.rm(snapshotDir, { recursive: true, force: true });
  await fs.mkdir(snapshotDir, { recursive: true });

  const manifest = {
    typstVersion,
    packageVersion: fullPackageVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    collectedAt: new Date().toISOString(),
    status: "pending",
    probes: {},
  };

  try {
    const workspace = await ensureInstalled(typstVersion, fullPackageVersion);
    const launcher = resolveLauncher(workspace);

    manifest.executable = path
      .relative(HANDOFF_ROOT, launcher.typstPath)
      .replaceAll(path.sep, "/");
    manifest.declaredVersion = launcher.declaredVersion;

    const probes = [
      ["version", ["--version"]],
      ["root-help", ["--help"]],
      ...COMMAND_CANDIDATES.map((command) => [
        `${command}-help`,
        [command, "--help"],
      ]),
    ];

    for (const [name, args] of probes) {
      const result = await runProcess(launcher.typstPath, args, {
        cwd: workspace,
        timeoutMs: 60_000,
      });
      manifest.probes[name] = {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        spawnError: result.spawnError,
      };
      await writeProbe(snapshotDir, name, result);
    }

    manifest.status = "collected";
  } catch (error) {
    manifest.status = "unavailable";
    manifest.error = {
      name: error.name,
      message: error.message,
      result: error.result ?? null,
    };
    if (options.strict) throw error;
  } finally {
    await fs.writeFile(
      path.join(snapshotDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
  }

  console.log(`[${manifest.status}] ${typstVersion} via ${fullPackageVersion}`);
}

const options = parseArgs(process.argv.slice(2));
const releaseDocument = JSON.parse(await fs.readFile(RELEASES_PATH, "utf8"));
const selected = selectVersions(releaseDocument.releases, options);

let publishedVersions = null;
if (options.packageRevision === "latest") {
  publishedVersions = await listPublishedPackageVersions();
}

for (const typstVersion of selected) {
  const fullPackageVersion =
    options.packageRevision === "latest"
      ? highestPackagingVersion(typstVersion, publishedVersions)
      : `${typstVersion}-npm.${Number(options.packageRevision)}`;

  if (!fullPackageVersion) {
    const snapshotDir = path.join(SNAPSHOT_ROOT, typstVersion);
    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.writeFile(
      path.join(snapshotDir, "manifest.json"),
      JSON.stringify(
        {
          typstVersion,
          status: "unavailable",
          reason:
            "No matching @flukxr/typst-cli package version was found on npm.",
          collectedAt: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`[unavailable] ${typstVersion}: no npm packaging version`);
    if (options.strict) process.exitCode = 1;
    continue;
  }

  await collectVersion(typstVersion, fullPackageVersion, options);
}
