import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addReleaseToDocuments,
  buildReleaseRecord,
  fetchUpstreamReleases,
  inspectReviewState,
  missingStableVersions,
  renderReviewReport,
  resolveReleaseEvidence,
  runNodeScript,
  stableReleases,
} from "./release-inventory.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const INVENTORY_PATH = path.join(ROOT, "data", "typst-releases.json");
const GROUPS_PATH = path.join(ROOT, "data", "release-groups.json");

function usage() {
  return [
    "Usage:",
    "  node scripts/update-release-inventory.mjs --check [--upstream-file file.json]",
    "  node scripts/update-release-inventory.mjs --prepare X.Y.Z [--upstream-file file.json] [--no-collect]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    mode: null,
    version: null,
    upstreamFile: null,
    collect: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") options.mode = "check";
    else if (token === "--prepare") {
      options.mode = "prepare";
      options.version = argv[++index];
    } else if (token === "--upstream-file")
      options.upstreamFile = argv[++index];
    else if (token === "--no-collect") options.collect = false;
    else if (token === "--help" || token === "-h") options.mode = "help";
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (options.mode === "prepare" && !options.version) {
    throw new Error("--prepare requires an exact stable version");
  }
  if (options.mode === null)
    throw new Error("Choose --check or --prepare X.Y.Z");
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function upstreamData(options) {
  if (options.upstreamFile) return readJson(path.resolve(options.upstreamFile));
  return fetchUpstreamReleases();
}

async function check(options) {
  const [inventory, upstream] = await Promise.all([
    readJson(INVENTORY_PATH),
    upstreamData(options),
  ]);
  const missing = missingStableVersions(inventory, upstream);
  if (missing.length === 0) {
    console.log(
      "Release inventory contains every discovered exact stable release.",
    );
    return;
  }
  console.error(`Missing exact stable release(s): ${missing.join(", ")}`);
  process.exitCode = 1;
}

async function prepare(options) {
  const [inventory, releaseGroups, upstream] = await Promise.all([
    readJson(INVENTORY_PATH),
    readJson(GROUPS_PATH),
    upstreamData(options),
  ]);
  const upstreamRelease = stableReleases(upstream).find(
    (release) => release.version === options.version,
  );
  if (!upstreamRelease) {
    throw new Error(
      `Exact stable upstream release not found: ${options.version}`,
    );
  }
  const fixtureEvidence = options.upstreamFile
    ? upstreamRelease.evidence
    : null;
  const evidence =
    fixtureEvidence ?? (await resolveReleaseEvidence(options.version));
  const release = buildReleaseRecord(upstreamRelease, evidence);
  const updated = addReleaseToDocuments(inventory, releaseGroups, release);
  updated.inventory.checkedAt = new Date().toISOString().slice(0, 10);
  await writeJson(INVENTORY_PATH, updated.inventory);
  await writeJson(GROUPS_PATH, updated.releaseGroups);

  const versions = updated.inventory.releases.map((item) => item.version);
  const index = versions.indexOf(options.version);
  const previousVersion = index > 0 ? versions[index - 1] : null;
  let collectionError = null;
  if (options.collect) {
    try {
      await runNodeScript(
        path.join(ROOT, "scripts", "collect-cli-snapshots.mjs"),
        ["--versions", options.version],
        ROOT,
      );
      await runNodeScript(
        path.join(ROOT, "scripts", "normalize-cli-snapshots.mjs"),
        [],
        ROOT,
      );
      await runNodeScript(
        path.join(ROOT, "scripts", "compare-cli-snapshots.mjs"),
        [],
        ROOT,
      );
      await runNodeScript(
        path.join(ROOT, "scripts", "behavior-probes.mjs"),
        ["--versions", options.version],
        ROOT,
      );
      // Regenerate the CLI flag inventory so the review shows every flag and
      // value the new release adds or stops documenting.
      await runNodeScript(
        path.join(ROOT, "scripts", "generate-cli-flags.mjs"),
        [],
        ROOT,
      );
    } catch (error) {
      collectionError = error.message;
    }
  }

  // Run the package's own best-effort parsers over the new release's raw
  // output. A parser that worked on the predecessor and fails now means the
  // compiler changed a human-readable format the API depends on.
  const outputFormatFile = path.join(
    ROOT,
    ".cache",
    `output-format-${options.version}.md`,
  );
  let outputFormat;
  // A report left over from an earlier run must never be mistaken for this one.
  await fs.rm(outputFormatFile, { force: true });
  try {
    await runNodeScript(
      path.join(ROOT, "scripts", "check-output-format.mjs"),
      ["--versions", options.version, "--out", outputFormatFile],
      ROOT,
    );
    outputFormat = { regression: false };
  } catch (error) {
    // Exit 1 is a parser regression; anything else means the check could not
    // run (missing build or snapshot) and is reported as not checked.
    outputFormat =
      error.exitCode === 1
        ? { regression: true }
        : { regression: false, error: error.message };
  }
  try {
    outputFormat.table = await fs.readFile(outputFormatFile, "utf8");
  } catch {
    outputFormat.table = undefined;
  }

  await runNodeScript(
    path.join(ROOT, "scripts", "validate-data.mjs"),
    [],
    ROOT,
  );
  const state = await inspectReviewState(
    ROOT,
    options.version,
    previousVersion,
  );
  const report = renderReviewReport({
    release,
    previousVersion,
    state,
    collectionError,
    outputFormat,
  });
  const reviewDirectory = path.join(ROOT, "release-reviews");
  await fs.mkdir(reviewDirectory, { recursive: true });
  const reviewPath = path.join(reviewDirectory, `${options.version}.md`);
  await fs.writeFile(reviewPath, report, "utf8");

  const action = updated.added ? "Prepared" : "Refreshed";
  console.log(
    `${action} exact release review: ${path.relative(ROOT, reviewPath)}`,
  );
  if (collectionError) {
    console.error(`Snapshot collection incomplete: ${collectionError}`);
    process.exitCode = 1;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.mode === "help") console.log(usage());
else if (options.mode === "check") await check(options);
else await prepare(options);
