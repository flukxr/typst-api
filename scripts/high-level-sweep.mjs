import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compareExactVersions } from "./release-inventory.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RELEASES_PATH = path.join(ROOT, "data", "typst-releases.json");
const CACHE_ROOT = path.join(ROOT, ".cache", "typst-cli");
const DIST_ENTRY = pathToFileURL(path.join(ROOT, "dist", "index.js")).href;

const PARSE_ARGV = process.argv.slice(2);
const REQUESTED = PARSE_ARGV.includes("--all")
  ? null
  : PARSE_ARGV.filter((token) => !token.startsWith("--"));
const OUT_PATH_ARG = PARSE_ARGV.find((token) => token.startsWith("--out="));
const OUT_PATH = OUT_PATH_ARG
  ? path.resolve(OUT_PATH_ARG.slice("--out=".length))
  : path.join(ROOT, "data", "high-level-sweep.json");
function runProcess(executable, args, options = {}) {
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
    }, options.timeoutMs ?? 300_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
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
        timedOut,
      });
    });
    child.stdin.end(options.stdin);
  });
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

function highestPackagingVersion(typstVersion, publishedVersions) {
  const escaped = typstVersion.replaceAll(".", "\\.");
  const pattern = new RegExp(`^${escaped}-npm\\.(\\d+)$`);
  const matches = publishedVersions
    .map((version) => {
      const match = pattern.exec(version);
      return match ? { version, revision: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.revision - left.revision);
  return matches[0]?.version ?? null;
}

async function ensureInstalled(typstVersion, fullPackageVersion) {
  const workspace = path.join(CACHE_ROOT, typstVersion, fullPackageVersion);
  const marker = path.join(
    workspace,
    "node_modules",
    "@flukxr",
    "typst-cli",
    "package.json",
  );
  await fs.mkdir(workspace, { recursive: true });
  try {
    await fs.access(marker);
    return workspace;
  } catch {}
  await fs.writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
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
    throw new Error(
      `Failed to install @flukxr/typst-cli@${fullPackageVersion}`,
    );
  }
  return workspace;
}

function resolveLauncher(workspace) {
  const require = createRequire(path.join(workspace, "loader.cjs"));
  const launcher = require("@flukxr/typst-cli");
  return { typstPath: launcher.typstPath, declaredVersion: launcher.version };
}

function check(value) {
  return value === true ? true : value === false ? false : "unsupported";
}

async function sweepVersion(typstVersion, fullPackageVersion) {
  const workspace = await ensureInstalled(typstVersion, fullPackageVersion);
  const launcher = resolveLauncher(workspace);
  const api = await import(DIST_ENTRY);
  const typst = await api.createTypst({
    executable: launcher.typstPath,
    discovery: { package: false, environment: false, path: false },
  });

  const checks = {};

  try {
    const version = await typst.version();
    checks.version = version.version === typstVersion;
  } catch {
    checks.version = false;
  }

  try {
    const pdf = await typst.compile({
      input: { kind: "source", data: "= Hello\n\nWorld." },
      output: { kind: "memory" },
    });
    checks.compileSourcePdf =
      pdf.outputs[0]?.kind === "memory" &&
      pdf.outputs[0].data.subarray(0, 5).toString("latin1") === "%PDF-";
  } catch {
    checks.compileSourcePdf = false;
  }

  try {
    const fonts = await typst.fonts();
    checks.fonts = fonts.raw.trim().length > 0;
  } catch {
    checks.fonts = false;
  }

  try {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "typst-api-sweep-watch-"),
    );
    try {
      const source = path.join(directory, "document.typ");
      await fs.writeFile(source, "= Hello\n\nWorld.", "utf8");
      const watcher = await typst.watch({
        input: { kind: "file", path: source },
        output: { kind: "file", path: path.join(directory, "out.pdf") },
      });
      const firstReady = new Promise((resolve) => {
        watcher.on("ready", (cycle) => resolve(cycle));
      });
      const first = await Promise.race([
        firstReady,
        new Promise((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
      let second = null;
      if (first !== null) {
        const secondCycle = new Promise((resolve) => {
          watcher.on("cycle", (cycle) => resolve(cycle));
        });
        // A too-fast edit can be missed by the watcher; defer it so the
        // watcher has settled after the initial cycle.
        setTimeout(() => {
          void fs.writeFile(source, "= Hello\n\nChanged.", "utf8");
        }, 750);
        second = await Promise.race([
          secondCycle,
          new Promise((resolve) => setTimeout(() => resolve(null), 15_000)),
        ]);
      }
      const closed = await watcher.close();
      const output = await fs.readFile(path.join(directory, "out.pdf"));
      checks.watch =
        first !== null &&
        second !== null &&
        (closed.exitCode !== null || closed.signal !== null) &&
        output.subarray(0, 5).toString("latin1") === "%PDF-";
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } catch {
    checks.watch = false;
  }

  if (compareExactVersions(typstVersion, "0.7.0") >= 0) {
    try {
      const query = await typst.query({
        input: { kind: "source", data: "= First\n#pagebreak()\n== Second" },
        selector: "heading",
      });
      checks.query =
        query.elements.length === 2 && query.elements[0]?.func === "heading";
    } catch {
      checks.query = false;
    }
  } else {
    checks.query = "unsupported";
  }

  if (compareExactVersions(typstVersion, "0.14.0") >= 0) {
    try {
      const info = await typst.info({ format: "json" });
      checks.info = typeof info.data === "object" && info.data !== null;
    } catch {
      checks.info = false;
    }
  } else {
    checks.info = "unsupported";
  }

  if (compareExactVersions(typstVersion, "0.15.0") >= 0) {
    try {
      const evalResult = await typst.eval("1 + 2");
      checks.eval = evalResult.value === 3;
    } catch {
      checks.eval = false;
    }
    try {
      const bundle = await typst.compile({
        input: {
          kind: "source",
          data: '#document("paper.pdf")[= Paper]',
        },
        output: { kind: "memory" },
        format: "bundle",
        features: ["bundle"],
      });
      checks.bundle =
        bundle.outputs.length >= 1 &&
        bundle.outputs[0].relativePath === "paper.pdf";
    } catch {
      checks.bundle = false;
    }
    try {
      const standards = await typst.compile({
        input: { kind: "source", data: "= Hello" },
        output: { kind: "memory" },
        pdfStandards: ["1.7", "a-2b"],
      });
      checks.multiplePdfStandards = standards.outputs[0]?.kind === "memory";
    } catch {
      checks.multiplePdfStandards = false;
    }
  } else {
    checks.eval = "unsupported";
    checks.bundle = "unsupported";
    checks.multiplePdfStandards = "unsupported";
  }

  const failed = Object.values(checks).some((value) => value === false);
  return {
    status: failed ? "failed" : "tested",
    packageVersion: fullPackageVersion,
    declaredVersion: launcher.declaredVersion,
    checks: Object.fromEntries(
      Object.entries(checks).map(([name, value]) => [name, check(value)]),
    ),
  };
}

const releaseDocument = JSON.parse(await fs.readFile(RELEASES_PATH, "utf8"));
let versions = releaseDocument.releases.map((release) => release.version);
if (REQUESTED !== null && REQUESTED.length > 0) {
  versions = versions.filter((version) => REQUESTED.includes(version));
  const missing = REQUESTED.filter((version) => !versions.includes(version));
  if (missing.length > 0) {
    throw new Error(`Unknown release(s): ${missing.join(", ")}`);
  }
}

const publishedVersions = await listPublishedPackageVersions();
const results = {};
for (const typstVersion of versions) {
  const fullPackageVersion = highestPackagingVersion(
    typstVersion,
    publishedVersions,
  );
  if (!fullPackageVersion) {
    results[typstVersion] = {
      status: "unavailable",
      reason: "No matching @flukxr/typst-cli package version was found on npm.",
    };
    console.log(`[unavailable] ${typstVersion}`);
    continue;
  }
  try {
    results[typstVersion] = await sweepVersion(
      typstVersion,
      fullPackageVersion,
    );
    console.log(`[${results[typstVersion].status}] ${typstVersion}`);
  } catch (error) {
    results[typstVersion] = {
      status: "unavailable",
      reason: error.message,
    };
    console.log(`[unavailable] ${typstVersion}: ${error.message}`);
  }
}

let contiguousTestedThrough = null;
for (const version of [...versions].sort(compareExactVersions)) {
  if (results[version]?.status !== "tested") break;
  contiguousTestedThrough = version;
}

const output = {
  policy:
    "High-level API sweep results. A version is `tested` only when every applicable high-level check passed against the installed binary; `failed` means a check failed with real evidence; `unavailable` means the binary could not be installed or resolved on this platform. No version is inferred to be tested.",
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  runAt: new Date().toISOString().slice(0, 10),
  results,
  contiguousTestedThrough,
};

await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
await fs.writeFile(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);
