// Package-manager verification: packs the API tarball, installs it together
// with the pinned launcher into fresh fixtures through every available package
// manager (npm always; pnpm and yarn through the bare command or corepack),
// then verifies a real import + compile through default discovery.
//
// A manager that is not installed is skipped, not failed. npm must succeed.
// Exit code 0 only when npm verified successfully.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error(
    "pm-check.mjs must be run through an npm script (npm run pm:check)",
  );
}
const LAUNCHER_PIN = "@flukxr/typst-cli@typst-0.15.1";

function run(executable, args, cwd, timeoutMs = 300_000) {
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `timed out after ${timeoutMs}ms: ${[executable, ...args].join(" ")}`,
        ),
      );
    }, timeoutMs);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

// Resolve a manager invocation that spawns without a shell on every platform.
// On Windows, npm's `.cmd` shims cannot be spawned with `shell: false`, so the
// npm CLI runs through `node npm-cli.js` and pnpm/yarn through the corepack JS
// entry shipped with Node. On POSIX the bare commands are shebang scripts.
function managerInvocation(managerName) {
  if (managerName === "npm") {
    return [process.execPath, npmCli];
  }
  const corepackEntry = join(
    dirname(process.execPath),
    "node_modules",
    "corepack",
    "dist",
    "corepack.js",
  );
  return existsSync(corepackEntry)
    ? [process.execPath, corepackEntry, managerName]
    : [managerName];
}

async function findManager(managerName) {
  const invocation = managerInvocation(managerName);
  try {
    const probe = await run(
      invocation[0],
      [...invocation.slice(1), "--version"],
      repositoryRoot,
      120_000,
    );
    if (probe.exitCode === 0) {
      return {
        invocation,
        version: probe.stdout.toString("utf8").trim().split(/\r?\n/u)[0],
      };
    }
  } catch {
    // The manager is not installed (corepack will download it on first use).
  }
  return undefined;
}

function installArgs(managerName, tarball) {
  if (managerName === "npm") {
    return [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ];
  }
  if (managerName === "pnpm") {
    return [
      "add",
      "--ignore-scripts",
      "--no-lockfile",
      "--config.confirmModulesPurge=false",
      tarball,
    ];
  }
  if (managerName === "yarn") {
    // Yarn 1 (classic) drops plain Windows tarball paths and mangles the
    // `file:///` URL form; `file:` + a forward-slash path works everywhere.
    const posixPath = tarball.replaceAll("\\", "/");
    return ["add", "--ignore-scripts", `file:${posixPath}`];
  }
  throw new Error(`unsupported manager: ${managerName}`);
}

const SMOKE = `
import { createTypst } from "@flukxr/typst-api";
const client = await createTypst();
const version = await client.version();
const result = await client.compile({
  input: { kind: "source", data: "= pm check" },
  output: { kind: "memory" },
});
if (result.outputs.length !== 1 || result.process.exitCode !== 0) {
  throw new Error("compile failed");
}
console.log(version.version);
`;

async function verifyManager(managerName, invocation, tarball) {
  const fixture = await mkdtemp(join(tmpdir(), "typst-api-pm-"));
  try {
    await writeFile(
      join(fixture, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    const install = await run(
      invocation[0],
      [
        ...invocation.slice(1),
        ...installArgs(managerName, tarball),
        LAUNCHER_PIN,
      ],
      fixture,
    );
    if (install.exitCode !== 0) {
      return {
        ok: false,
        detail: `install failed\nexit=${install.exitCode}\nstderr:\n${install.stderr.toString()}`,
      };
    }
    const smoke = await run(
      process.execPath,
      ["--input-type=module", "--eval", SMOKE],
      fixture,
    );
    if (smoke.exitCode !== 0) {
      return {
        ok: false,
        detail: `smoke failed\nexit=${smoke.exitCode}\nstdout:\n${smoke.stdout.toString()}\nstderr:\n${smoke.stderr.toString()}`,
      };
    }
    return {
      ok: true,
      detail: `verified typst ${smoke.stdout.toString().trim()}`,
    };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "typst-api-pm-pack-"));
const results = [];
try {
  const pack = await run(
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
  assert.equal(pack.exitCode, 0, `npm pack failed\n${pack.stderr.toString()}`);
  const description = JSON.parse(pack.stdout.toString("utf8"));
  const packed = Array.isArray(description)
    ? description[0]
    : Object.values(description)[0];
  const tarball = join(temporaryRoot, packed.filename);

  const managers = ["npm", "pnpm", "yarn"];
  for (const managerName of managers) {
    const found = await findManager(managerName);
    if (!found) {
      results.push({
        name: managerName,
        ok: true,
        detail: "manager not installed; skipped",
      });
      continue;
    }
    const verified = await verifyManager(
      managerName,
      found.invocation,
      tarball,
    );
    results.push({
      name: managerName,
      invocation: found.invocation.join(" "),
      version: found.version,
      ...verified,
    });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

for (const result of results) {
  console.log(
    `${result.ok ? "PASS" : "FAIL"} ${result.name}${result.invocation ? ` (${result.invocation} ${result.version})` : ""}: ${result.detail}`,
  );
}

const npm = results.find((result) => result.name === "npm");
if (!npm || !npm.ok) {
  console.error("npm verification is mandatory and failed");
  process.exit(1);
}
const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`${failed.length} manager(s) failed`);
  process.exit(1);
}
