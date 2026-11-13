import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { compareSemver, parseStableSemver } from "./data-validation.mjs";
import { repositorySnapshotRoot } from "./snapshot-root.mjs";

const EXACT_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SOURCE_CANDIDATES = [
  "crates/typst-cli/src/args.rs",
  "cli/src/args.rs",
  "cli/src/main.rs",
];

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "@flukxr/typst-api-release-inventory",
    "x-github-api-version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

export function compareExactVersions(left, right) {
  return compareSemver(
    parseStableSemver(left, "left version"),
    parseStableSemver(right, "right version"),
  );
}

export function stableReleases(upstreamReleases) {
  if (!Array.isArray(upstreamReleases)) {
    throw new Error("Upstream release response must be an array");
  }

  const byVersion = new Map();
  for (const release of upstreamReleases) {
    if (
      release === null ||
      typeof release !== "object" ||
      release.draft === true ||
      release.prerelease === true
    ) {
      continue;
    }
    const match = EXACT_TAG.exec(release.tag_name);
    if (!match) continue;
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    if (byVersion.has(version)) {
      throw new Error(`Duplicate upstream stable release ${version}`);
    }
    byVersion.set(version, { ...release, version });
  }

  return [...byVersion.values()].sort((left, right) =>
    compareExactVersions(left.version, right.version),
  );
}

export function missingStableVersions(inventory, upstreamReleases) {
  const known = new Set(inventory.releases.map((release) => release.version));
  return stableReleases(upstreamReleases)
    .map((release) => release.version)
    .filter((version) => !known.has(version));
}

export function buildReleaseRecord(upstreamRelease, evidence) {
  const [release] = stableReleases([upstreamRelease]);
  if (!release) {
    throw new Error(
      "The requested upstream tag is not an exact stable release",
    );
  }
  const publishedAt = release.published_at ?? release.created_at;
  if (
    typeof publishedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(publishedAt)
  ) {
    throw new Error(
      `Upstream release ${release.version} has no precise publication date`,
    );
  }
  for (const key of ["officialChangelog", "sourceArgsFile"]) {
    if (
      typeof evidence[key] !== "string" ||
      !evidence[key].startsWith("https://")
    ) {
      throw new Error(`Missing verified HTTPS evidence: ${key}`);
    }
  }
  const parsed = parseStableSemver(release.version, "upstream release version");
  return {
    version: release.version,
    tag: release.tag_name,
    date: publishedAt.slice(0, 10),
    kind: parsed.patch > 0 ? "patch" : "minor",
    stable: true,
    snapshotRequired: true,
    officialChangelog: evidence.officialChangelog,
    sourceArgsFile: evidence.sourceArgsFile,
  };
}

export function addReleaseToDocuments(inventory, releaseGroups, releaseRecord) {
  const releases = [...inventory.releases];
  const existing = releases.find(
    (release) => release.version === releaseRecord.version,
  );
  if (!existing) releases.push(releaseRecord);
  releases.sort((left, right) =>
    compareExactVersions(left.version, right.version),
  );

  const groups = structuredClone(releaseGroups.groups);
  const grouped = groups.some((group) =>
    group.versions.includes(releaseRecord.version),
  );
  if (!grouped) {
    let pending = groups.find((group) => group.id === "pending-review");
    if (!pending) {
      pending = {
        id: "pending-review",
        versions: [],
        purpose:
          "New exact releases awaiting behavior, capability, and coverage review.",
      };
      groups.push(pending);
    }
    pending.versions.push(releaseRecord.version);
    pending.versions.sort(compareExactVersions);
  }

  return {
    inventory: { ...inventory, releases },
    releaseGroups: { ...releaseGroups, groups },
    added: existing === undefined,
  };
}

export async function fetchUpstreamReleases(fetchImpl = fetch) {
  const releases = [];
  const headers = githubHeaders();

  for (let page = 1; ; page += 1) {
    const url = `https://api.github.com/repos/typst/typst/releases?per_page=100&page=${page}`;
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed (${response.status})`);
    }
    const pageReleases = await response.json();
    if (!Array.isArray(pageReleases)) {
      throw new Error("GitHub releases response was not an array");
    }
    releases.push(...pageReleases);
    if (pageReleases.length < 100) break;
  }
  return releases;
}

async function urlExists(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: url.startsWith("https://api.github.com/")
      ? githubHeaders()
      : { "user-agent": "@flukxr/typst-api-release-inventory" },
  });
  await response.body?.cancel();
  return response.ok;
}

export async function resolveReleaseEvidence(version, fetchImpl = fetch) {
  parseStableSemver(version, "release version");
  const tag = `v${version}`;
  const officialChangelog = `https://typst.app/docs/changelog/${version}/`;
  if (!(await urlExists(officialChangelog, fetchImpl))) {
    throw new Error(`Official changelog is unavailable: ${officialChangelog}`);
  }

  for (const sourcePath of SOURCE_CANDIDATES) {
    const apiUrl = `https://api.github.com/repos/typst/typst/contents/${sourcePath}?ref=${tag}`;
    if (await urlExists(apiUrl, fetchImpl)) {
      return {
        officialChangelog,
        sourceArgsFile: `https://github.com/typst/typst/blob/${tag}/${sourcePath}`,
      };
    }
  }
  throw new Error(`No verified tagged CLI source was found for ${tag}`);
}

export async function runNodeScript(scriptPath, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (exitCode === 0) resolve();
      else
        reject(
          Object.assign(
            new Error(
              `${path.basename(scriptPath)} failed: exit=${exitCode}, signal=${signal}`,
            ),
            { exitCode },
          ),
        );
    });
  });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runProcess(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

export function findCapabilityChanges(previous, current) {
  const previousFeatures = previous?.features ?? {};
  const currentFeatures = current?.features ?? {};
  const names = new Set([
    ...Object.keys(previousFeatures),
    ...Object.keys(currentFeatures),
  ]);
  return [...names]
    .filter(
      (name) =>
        JSON.stringify(previousFeatures[name]) !==
        JSON.stringify(currentFeatures[name]),
    )
    .sort();
}

async function inspectCapabilityChanges(root, currentCapabilities) {
  let result;
  try {
    result = await runProcess(
      "git",
      ["show", "HEAD:data/capabilities.seed.json"],
      root,
    );
  } catch {
    return { comparison: "unavailable", changes: [] };
  }
  if (result.exitCode !== 0 || result.signal !== null) {
    return { comparison: "unavailable", changes: [] };
  }
  try {
    return {
      comparison: "HEAD",
      changes: findCapabilityChanges(
        JSON.parse(result.stdout.toString("utf8")),
        currentCapabilities,
      ),
    };
  } catch {
    return { comparison: "unavailable", changes: [] };
  }
}

export async function inspectReviewState(root, version, previousVersion) {
  const snapshotDirectory = path.join(repositorySnapshotRoot(), version);
  const manifestPath = path.join(snapshotDirectory, "manifest.json");
  let manifest = null;
  if (await pathExists(manifestPath)) {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  }
  const diffPath = previousVersion
    ? path.join(
        repositorySnapshotRoot(),
        "_diffs",
        `${previousVersion}__${version}.md`,
      )
    : null;
  const behaviorDirectory = path.join(snapshotDirectory, "behavior");
  let behaviorFiles = [];
  if (await pathExists(behaviorDirectory)) {
    behaviorFiles = (await fs.readdir(behaviorDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort();
  }
  const capabilities = await fs.readFile(
    path.join(root, "data", "capabilities.seed.json"),
  );
  const capabilityDocument = JSON.parse(capabilities.toString("utf8"));
  const capabilityChanges = await inspectCapabilityChanges(
    root,
    capabilityDocument,
  );

  return {
    snapshotStatus: manifest?.status ?? "missing",
    packageVersion: manifest?.packageVersion ?? null,
    diffReady: diffPath === null ? false : await pathExists(diffPath),
    behaviorFiles,
    capabilityChanges: capabilityChanges.changes,
    capabilityComparison: capabilityChanges.comparison,
    capabilitySeedSha256: createHash("sha256")
      .update(capabilities)
      .digest("hex"),
  };
}

export function renderReviewReport({
  release,
  previousVersion,
  state,
  collectionError,
  outputFormat,
}) {
  const snapshotReady = state.snapshotStatus === "collected";
  const behaviorStatus =
    state.behaviorFiles.length > 0
      ? "evidence present; review required"
      : "review required";
  const capabilityStatus =
    state.capabilityChanges.length > 0
      ? "changes present; review required"
      : "review required";
  const capabilityEvidence =
    state.capabilityChanges.length > 0
      ? state.capabilityChanges.join(", ")
      : state.capabilityComparison === "unavailable"
        ? `Comparison unavailable; seed SHA-256: ${state.capabilitySeedSha256}`
        : `No changes detected against ${state.capabilityComparison}; seed SHA-256: ${state.capabilitySeedSha256}`;
  const rows = [
    [
      "Exact inventory record",
      "ready",
      `data/typst-releases.json (${release.version})`,
    ],
    [
      "CLI snapshots",
      snapshotReady ? "ready" : state.snapshotStatus,
      state.packageVersion ?? collectionError ?? "No collected manifest",
    ],
    [
      "Consecutive snapshot diff",
      state.diffReady ? "ready" : "missing",
      previousVersion
        ? `snapshots/_diffs/${previousVersion}__${release.version}.md`
        : "No predecessor",
    ],
    [
      "Behavior probes",
      behaviorStatus,
      state.behaviorFiles.join(", ") || "No release-specific probes",
    ],
    ["Capability changes", capabilityStatus, capabilityEvidence],
    [
      "Output-format parsers",
      outputFormat === undefined || outputFormat.table === undefined
        ? "not checked"
        : outputFormat.regression
          ? "REGRESSION; fix the parsers before release"
          : "ready",
      "warnings, errors, font list and watch cycles parsed from raw output",
    ],
    [
      "Coverage status",
      "unknown",
      "Never advanced automatically; requires snapshot, behavior, capability, and platform review",
    ],
  ];
  const table = [
    "| Gate | Status | Evidence |",
    "|---|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];

  return [
    `# Exact release review: ${release.version}`,
    "",
    `- Upstream tag: [${release.tag}](https://github.com/typst/typst/releases/tag/${release.tag})`,
    `- Released: ${release.date}`,
    `- Immediate predecessor: ${previousVersion ?? "none"}`,
    `- Tagged CLI source: [source](${release.sourceArgsFile})`,
    `- Official changelog: [changelog](${release.officialChangelog})`,
    "",
    ...table,
    "",
    ...(outputFormat?.table === undefined
      ? []
      : ["## Output-format parsers", "", outputFormat.table.trimEnd(), ""]),
    "## Reviewer actions",
    "",
    "- [ ] Inspect the consecutive CLI snapshot diff.",
    "- [ ] Add changelog-relevant behavior probes and retain their raw stdout/stderr/exit metadata.",
    "- [ ] Record exact capability additions, removals, deprecations, and behavior changes.",
    "- [ ] Confirm platform coverage; keep unverified coverage unknown.",
    "- [ ] Move this version out of the `pending-review` release group when all gates are resolved.",
    "",
  ].join("\n");
}
