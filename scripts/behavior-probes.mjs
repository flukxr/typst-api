import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { repositorySnapshotRoot } from "./snapshot-root.mjs";
import { compareExactVersions } from "./release-inventory.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE_ROOT = path.join(ROOT, ".cache", "typst-cli");

function parseArgs(argv) {
  const options = {
    versions: null,
    probes: null,
    executable: null,
    snapshotRoot: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--probes")
      options.probes = argv[++index]?.split(",").filter(Boolean);
    else if (token === "--versions")
      options.versions = argv[++index]?.split(",").filter(Boolean);
    else if (token === "--executable") options.executable = argv[++index];
    else if (token === "--snapshot-root") options.snapshotRoot = argv[++index];
    else if (token.startsWith("--snapshot-root="))
      options.snapshotRoot = token.slice("--snapshot-root=".length);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

function runProcess(executable, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 60_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      spawnError = {
        name: error.name,
        message: error.message,
        code: error.code,
      };
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        args,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        spawnError,
        timedOut,
      });
    });
  });
}

/** Resolve an installed binary for an exact version from the sweep cache. */
async function resolveCachedExecutable(version) {
  const directory = path.join(CACHE_ROOT, version);
  try {
    const revisions = await fs.readdir(directory);
    // Newest packaging revision first; `-npm.<n>` is compared numerically.
    const revisionNumber = (name) =>
      Number(/-npm\.(\d+)$/u.exec(name)?.[1] ?? -1);
    revisions.sort(
      (left, right) => revisionNumber(right) - revisionNumber(left),
    );
    for (const revision of revisions) {
      const workspace = path.join(directory, revision);
      const launcherPath = path.join(
        workspace,
        "node_modules",
        "@flukxr",
        "typst-cli",
      );
      try {
        const require = createRequire(path.join(launcherPath, "loader.cjs"));
        const launcher = require("@flukxr/typst-cli");
        return launcher.typstPath;
      } catch {}
    }
  } catch {}
  throw new Error(
    `No cached binary for ${version}; run the sweep first: npm run sweep:historical -- ${version}`,
  );
}

function stdoutBase64(stdout, sanitize) {
  if (stdout === undefined) return "";
  const text = stdout.toString("utf8");
  if (text.includes("\uFFFD")) return stdout.toString("base64");
  return Buffer.from(sanitize(text), "utf8").toString("base64");
}

function writeResult(snapshotDir, name, result, work, extra = {}) {
  const sanitize = (value) =>
    typeof value === "string" ? value.split(work).join("<workdir>") : value;
  const body = {
    name,
    ...extra,
    args: (result.args ?? []).map((arg) => sanitize(arg)),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
    stdout: sanitize(result.stdout?.toString("utf8") ?? ""),
    stderr: sanitize(result.stderr?.toString("utf8") ?? ""),
    // Text output is stored with the work directory replaced, so the base64
    // copy must use the same sanitized bytes to stay deterministic. Binary
    // output (PDF, PNG) is kept byte for byte.
    stdoutBase64: stdoutBase64(result.stdout, sanitize),
  };
  return fs.writeFile(
    path.join(snapshotDir, `${name}.json`),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Run a long-lived `typst watch` process and observe its lifecycle.
 *
 * The watch process never exits on its own, so this runner terminates the
 * process tree after the observable lifecycle is complete. It records whether
 * the initial compile cycle and a recompile after a source edit both completed
 * (line-based "compiling ..." / "compiled successfully" detection) and returns
 * the raw stdout/stderr plus termination metadata for the probe snapshot.
 */
function runWatchLifecycle(typstPath, args, cwd, onEdit) {
  return new Promise((resolve) => {
    const child = spawn(typstPath, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let buffer = "";
    let spawnError = null;
    let timedOut = false;
    let initialCycle = false;
    let recompiled = false;
    let editing = false;
    let finished = false;

    const finish = (extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      const record = {
        args,
        exitCode: null,
        signal: "SIGTERM",
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        spawnError,
        timedOut,
        initialCycle,
        recompiled,
        ...extra,
      };
      // The child owns its cwd until it exits; wait for the close event (or a
      // short grace period) so temporary cleanup cannot race the terminating
      // process on Windows, where kill() is a terminate request.
      const grace = setTimeout(() => resolve(record), 5_000);
      child.once("close", () => {
        clearTimeout(grace);
        resolve(record);
      });
    };

    const timer = setTimeout(() => finish({ timedOut: true }), 60_000);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (/compiled successfully/u.test(line)) {
          if (!initialCycle) {
            initialCycle = true;
            // A too-fast edit is missed by the watcher on old versions, so the
            // edit is deferred until the watcher has settled.
            setTimeout(() => {
              editing = true;
              void onEdit().finally(() => {});
            }, 750);
          } else if (editing) {
            recompiled = true;
            finish({});
          }
        }
      }
    });
    child.on("error", (error) => {
      spawnError = {
        name: error.name,
        message: error.message,
        code: error.code,
      };
      finish({});
    });
  });
}

/** Font families bundled inside the Typst binary across releases. */
const EMBEDDED_FONT_FAMILIES = new Set([
  "DejaVu Sans Mono",
  "Libertinus Serif",
  "Linux Libertine",
  "New Computer Modern",
  "New Computer Modern Math",
]);

const PROBES = [
  {
    name: "compile-pdf-stdout",
    since: "0.12.0",
    describe: "PDF output to stdout produces a PDF byte stream.",
    async run(typstPath, version, work) {
      const source = path.join(work, "doc.typ");
      await fs.writeFile(source, "= Hello\n\nWorld.", "utf8");
      const result = await runProcess(
        typstPath,
        ["compile", source, "-"],
        work,
      );
      const magic = result.stdout.subarray(0, 5).toString("latin1");
      return {
        ...result,
        stdout: result.stdout, // raw bytes retained
        stderr: result.stderr,
        stdoutMagic: magic,
        pdfOnStdout: result.exitCode === 0 && magic === "%PDF-",
      };
    },
  },
  {
    name: "compile-bundle-stdout",
    since: "0.15.0",
    describe: "Bundle output cannot be written to standard output.",
    async run(typstPath, version, work) {
      const source = path.join(work, "bundle.typ");
      await fs.writeFile(source, '#document("paper.pdf")[= Paper]', "utf8");
      const result = await runProcess(
        typstPath,
        ["compile", source, "-", "--format", "bundle", "--features", "bundle"],
        work,
      );
      return {
        ...result,
        stdout: result.stdout,
        stderr: result.stderr,
        rejectsStdout:
          result.exitCode !== 0 &&
          result.stderr.toString("utf8").includes("standard output"),
      };
    },
  },
  {
    name: "root-restriction",
    since: "0.6.0",
    describe: "Absolute paths outside the configured --root are blocked.",
    async run(typstPath, version, work) {
      const project = path.join(work, "project");
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(path.join(work, "secret.typ"), "= Secret", "utf8");
      await fs.writeFile(
        path.join(project, "main.typ"),
        '#include "/secret.typ"',
        "utf8",
      );
      const main = path.join(project, "main.typ");
      const output = path.join(project, "out.pdf");
      // `--root` is a root-level option before 0.7.0 and a command-level
      // option from 0.7.0; the probe places it per exact version.
      const rootLevel = compareExactVersions(version, "0.7.0") < 0;
      const args = rootLevel
        ? ["--root", project, "compile", main, output]
        : ["compile", "--root", project, main, output];
      const result = await runProcess(typstPath, args, work);
      return {
        ...result,
        stdout: result.stdout,
        stderr: result.stderr,
        blocksOutsideRoot: result.exitCode !== 0,
      };
    },
  },
  {
    name: "color-option",
    since: "0.11.0",
    describe:
      "The --color option forces or suppresses ANSI color regardless of TTY.",
    async run(typstPath, version, work) {
      const source = path.join(work, "bad.typ");
      await fs.writeFile(source, "#let x = ;", "utf8");
      const force = await runProcess(
        typstPath,
        ["--color=always", "compile", source, "out.pdf"],
        work,
      );
      const suppress = await runProcess(
        typstPath,
        ["--color=never", "compile", source, "out.pdf"],
        work,
      );
      const auto = await runProcess(
        typstPath,
        ["compile", source, "out.pdf"],
        work,
      );
      const ansiPattern = /\x1b\[/u;
      const forceText = force.stderr.toString("utf8");
      const suppressText = suppress.stderr.toString("utf8");
      const autoText = auto.stderr.toString("utf8");
      return {
        ...force,
        stdout: force.stdout,
        stderr: force.stderr,
        forcedColor: ansiPattern.test(forceText),
        suppressedColor: !ansiPattern.test(suppressText),
        autoNonTtyColor: ansiPattern.test(autoText),
        autoExitCode: auto.exitCode,
        suppressExitCode: suppress.exitCode,
      };
    },
  },
  {
    name: "output-format",
    since: "0.1.0",
    describe:
      "Raw human-readable output the API parses on a best-effort basis: a warning, an error, and the font list.",
    async run(typstPath, version, work) {
      const sanitize = (buffer) =>
        buffer.toString("utf8").split(work).join("<workdir>");
      const warningSource = path.join(work, "warning.typ");
      await fs.writeFile(
        warningSource,
        '#text(font: "No Such Font Family Zz")[Hello]',
        "utf8",
      );
      const warning = await runProcess(
        typstPath,
        ["compile", warningSource, path.join(work, "warning.pdf")],
        work,
      );
      const errorSource = path.join(work, "error.typ");
      await fs.writeFile(errorSource, "#let x = (", "utf8");
      const error = await runProcess(
        typstPath,
        ["compile", errorSource, path.join(work, "error.pdf")],
        work,
      );
      // The font list must not record the collecting machine's installed
      // fonts. From 0.12.0 system fonts are excluded by the compiler; older
      // releases have no switch, so only the fonts embedded in Typst are kept.
      const ignoresSystemFonts = compareExactVersions(version, "0.12.0") >= 0;
      const fonts = await runProcess(
        typstPath,
        ignoresSystemFonts ? ["fonts", "--ignore-system-fonts"] : ["fonts"],
        work,
      );
      if (!ignoresSystemFonts) {
        const embedded = fonts.stdout
          .toString("utf8")
          .split(/\r?\n/u)
          .filter((line) => EMBEDDED_FONT_FAMILIES.has(line.trim()));
        fonts.stdout = Buffer.from(`${embedded.join("\n")}\n`, "utf8");
      }
      return {
        args: ["compile", "<warning|error>", "fonts"],
        exitCode: error.exitCode,
        signal: error.signal,
        timedOut: warning.timedOut || error.timedOut || fonts.timedOut,
        spawnError: warning.spawnError ?? error.spawnError ?? fonts.spawnError,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        warningExitCode: warning.exitCode,
        warningStderr: sanitize(warning.stderr),
        errorExitCode: error.exitCode,
        errorStderr: sanitize(error.stderr),
        fontsExitCode: fonts.exitCode,
        fontsStdout: sanitize(fonts.stdout),
      };
    },
  },
  {
    name: "watch-lifecycle",
    since: "0.1.0",
    describe:
      "Watch completes an initial cycle, recompiles after an edit, and terminates on demand.",
    async run(typstPath, version, work) {
      const project = path.join(work, "project");
      await fs.mkdir(project, { recursive: true });
      const source = path.join(project, "doc.typ");
      const output = path.join(project, "out.pdf");
      await fs.writeFile(source, "= Hello\n\nWorld.", "utf8");
      const result = await runWatchLifecycle(
        typstPath,
        ["watch", source, output],
        project,
        () => fs.writeFile(source, "= Hello\n\nChanged.", "utf8"),
      );
      let outputWritten = false;
      try {
        const details = await fs.stat(output);
        outputWritten = details.size > 0;
      } catch {}
      return {
        ...result,
        stdout: result.stdout,
        stderr: result.stderr,
        initialCycle: result.initialCycle,
        recompiled: result.recompiled,
        outputWritten,
        timedOut: result.timedOut,
      };
    },
  },
  {
    name: "dependency-output",
    since: "0.12.0",
    describe:
      "Compilation writes a dependency list that includes the input file.",
    async run(typstPath, version, work) {
      const source = path.join(work, "doc.typ");
      const part = path.join(work, "part.typ");
      await fs.writeFile(source, '= Hello\n#include "part.typ"', "utf8");
      await fs.writeFile(part, "Part.", "utf8");
      const modern = compareExactVersions(version, "0.14.0") >= 0;
      const depsFile = path.join(work, modern ? "deps.json" : "deps.make");
      const args = modern
        ? ["compile", source, "out.pdf", "--deps", depsFile]
        : ["compile", source, "out.pdf", "--make-deps", depsFile];
      const result = await runProcess(typstPath, args, work);
      let depsText = "";
      try {
        depsText = await fs.readFile(depsFile, "utf8");
      } catch {}
      return {
        ...result,
        stdout: result.stdout,
        stderr: result.stderr,
        depsFileExists: depsText.length > 0,
        listsInputFile:
          depsText.includes("doc.typ") || depsText.includes("part.typ"),
        depsFormat: modern ? "json" : "make",
      };
    },
  },
  {
    name: "deps-stdout-make-regression",
    since: "0.14.0",
    describe:
      "Make dependency output combined with stdout output errors without a side-effect file.",
    async run(typstPath, version, work) {
      const source = path.join(work, "doc.typ");
      await fs.writeFile(source, "= Hello", "utf8");
      const depsFile = path.join(work, "out.make");
      const result = await runProcess(
        typstPath,
        ["compile", source, "-", "--deps", depsFile, "--deps-format", "make"],
        work,
      );
      let sideEffectFile = false;
      try {
        const details = await fs.stat(depsFile);
        sideEffectFile = details.isFile() && details.size === 0;
      } catch {}
      return {
        ...result,
        stdout: result.stdout,
        stderr: result.stderr,
        rejects: result.exitCode !== 0,
        emptyMakeSideEffect: sideEffectFile,
      };
    },
  },
];

const options = parseArgs(process.argv.slice(2));

const releaseDocument = JSON.parse(
  await fs.readFile(path.join(ROOT, "data", "typst-releases.json"), "utf8"),
);
const versions =
  options.versions ??
  releaseDocument.releases.map((release) => release.version);

const SNAPSHOT_ROOT = repositorySnapshotRoot(options.snapshotRoot ?? undefined);

for (const version of versions) {
  const snapshotDir = path.join(SNAPSHOT_ROOT, version, "behavior");
  await fs.mkdir(snapshotDir, { recursive: true });
  // Resolve the binary first so a missing one cannot leak the work directory.
  let typstPath = options.executable;
  if (!typstPath) typstPath = await resolveCachedExecutable(version);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "typst-api-probes-"));
  const summary = {};
  try {
    for (const probe of PROBES) {
      if (options.probes !== null && !options.probes.includes(probe.name))
        continue;
      if (compareExactVersions(version, probe.since) < 0) {
        summary[probe.name] = "not-applicable";
        continue;
      }
      const result = await probe.run(typstPath, version, work);
      const applicableKeys = Object.keys(result).filter(
        (key) =>
          ![
            "exitCode",
            "signal",
            "args",
            "stdout",
            "stderr",
            "timedOut",
            "spawnError",
          ].includes(key),
      );
      const observed = Object.fromEntries(
        applicableKeys.map((key) => [key, result[key]]),
      );
      await writeResult(snapshotDir, probe.name, result, work, {
        typstVersion: version,
        platform: process.platform,
        arch: process.arch,
        observed,
      });
      summary[probe.name] = "collected";
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
  console.log(`${version}: ${JSON.stringify(summary)}`);
}
