// Runs the package's best-effort parsers over the raw output recorded in the
// snapshot corpus and reports, per exact release, whether each parser still
// recognises the compiler's human-readable output.
//
// A parser that worked on the previous release and stops working on the next
// one is a format regression: the API would silently return empty `warnings`,
// no `diagnostics`, no font families or no watch cycles for that release.
//
// Usage:
//   node scripts/check-output-format.mjs [--versions X.Y.Z,...] [--snapshot-root DIR] [--markdown]
// Requires `npm run build`. Exits 1 when a checked release regresses against
// its immediate predecessor, and 2 when the check itself cannot run.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { repositorySnapshotRoot } from "./snapshot-root.mjs";

process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv) {
  const options = {
    versions: null,
    snapshotRoot: null,
    markdown: false,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--versions")
      options.versions = argv[++index]?.split(",").filter(Boolean);
    else if (token.startsWith("--versions="))
      options.versions = token.slice(11).split(",").filter(Boolean);
    else if (token === "--snapshot-root") options.snapshotRoot = argv[++index];
    else if (token.startsWith("--snapshot-root="))
      options.snapshotRoot = token.slice("--snapshot-root=".length);
    else if (token === "--markdown") options.markdown = true;
    else if (token === "--out") options.out = argv[++index];
    else if (token.startsWith("--out=")) options.out = token.slice(6);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

async function importDist(relative) {
  const file = path.join(ROOT, "dist", relative);
  try {
    await fs.access(file);
  } catch {
    throw new Error(`${relative} is missing; run \`npm run build\` first.`);
  }
  return await import(pathToFileURL(file).href);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

const { compareExactStableVersions: compareVersions } =
  await importDist("core/version.js");
const { parseDiagnostics } = await importDist("core/diagnostics.js");
const { parseFontFamilies } = await importDist("commands/fonts.js");
const { createCycleDetector } = await importDist("commands/watch.js");

/** One check per parser; `undefined` means the evidence is missing. */
function checkRelease(outputFormat, watchLifecycle) {
  const result = {};
  if (outputFormat !== undefined) {
    const observed = outputFormat.observed ?? {};
    // An empty stream means this release emitted nothing to parse, which is
    // not a parser failure.
    const warningText = observed.warningStderr ?? "";
    result.warnings =
      warningText.trim().length === 0
        ? null
        : parseDiagnostics(warningText).diagnostics.some(
            (item) => item.severity === "warning" && item.message.length > 0,
          );
    const errors = parseDiagnostics(observed.errorStderr ?? "").diagnostics;
    result.errors = errors.some(
      (item) => item.severity === "error" && item.spans.length > 0,
    );
    const families = parseFontFamilies(observed.fontsStdout ?? "");
    result.fonts = families !== undefined && families.length > 0;
  }
  if (watchLifecycle !== undefined) {
    const cycles = [];
    const detect = createCycleDetector((cycle) => cycles.push(cycle));
    detect({
      stream: "stderr",
      chunk: Buffer.from(watchLifecycle.stderr ?? "", "utf8"),
    });
    result.watchCycles = cycles.some((cycle) => cycle.status === "success");
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
const snapshotRoot = path.resolve(
  options.snapshotRoot ?? repositorySnapshotRoot(),
);
const entries = await fs.readdir(snapshotRoot, { withFileTypes: true });
const allVersions = entries
  .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/u.test(entry.name))
  .map((entry) => entry.name)
  .sort(compareVersions);

const results = new Map();
for (const version of allVersions) {
  const behavior = path.join(snapshotRoot, version, "behavior");
  results.set(
    version,
    checkRelease(
      await readJson(path.join(behavior, "output-format.json")),
      await readJson(path.join(behavior, "watch-lifecycle.json")),
    ),
  );
}

const checked = options.versions ?? allVersions;
const PARSERS = ["warnings", "errors", "fonts", "watchCycles"];
const rows = [];
let regressions = 0;
for (const version of checked) {
  if (!results.has(version)) throw new Error(`No snapshot for ${version}.`);
  const previous = allVersions[allVersions.indexOf(version) - 1];
  const current = results.get(version);
  const before = previous === undefined ? {} : results.get(previous);
  const cells = PARSERS.map((parser) => {
    const now = current[parser];
    const then = before[parser];
    if (now === undefined) return "no evidence";
    if (now === null) return "nothing emitted";
    if (now) return "ok";
    if (then === true) {
      regressions += 1;
      return `REGRESSION (worked on ${previous})`;
    }
    return "not recognised";
  });
  rows.push([version, ...cells]);
}

const markdown = [
  `| Release | ${PARSERS.join(" | ")} |`,
  `| --- | ${PARSERS.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.join(" | ")} |`),
].join("\n");
if (options.out !== null) {
  await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await fs.writeFile(options.out, `${markdown}\n`, "utf8");
}
if (options.markdown) console.log(markdown);
else for (const row of rows) console.log(row.join("\t"));
if (regressions > 0) {
  console.error(
    `\n${regressions} parser regression(s): the API would silently lose parsed output on these releases.`,
  );
  process.exitCode = 1;
}
