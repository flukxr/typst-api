import fs from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";

const DATA_URL = new URL("../data/", import.meta.url);
const CAPABILITIES_SCHEMA_URL = new URL(
  "../schemas/capabilities.schema.json",
  import.meta.url,
);
const FEATURE_GROUP_ORDER = new Map([
  ["commands", 0],
  ["formats", 1],
  ["options", 2],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPlainObject(value, context) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${context}: expected object`,
  );
}

async function readJsonUrl(url, context) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch (error) {
    throw new Error(`${context}: invalid JSON`, { cause: error });
  }
}

export async function readDataJson(name) {
  return readJsonUrl(new URL(name, DATA_URL), name);
}

export function parseStableSemver(value, context) {
  assert(
    typeof value === "string",
    `${context}: expected exact stable SemVer, got ${JSON.stringify(value)}`,
  );
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  assert(
    match,
    `${context}: expected exact stable SemVer, got ${JSON.stringify(value)}`,
  );
  const parsed = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  assert(
    Object.values(parsed).every(Number.isSafeInteger),
    `${context}: SemVer component exceeds the safe integer range`,
  );
  return parsed;
}

export function compareSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function validateReleases(document) {
  assertPlainObject(document, "typst-releases.json");
  assert(
    Array.isArray(document.releases),
    "typst-releases.json: releases must be an array",
  );
  const seen = new Set();
  let previous = null;

  for (const [index, release] of document.releases.entries()) {
    const context = `typst-releases.json: releases[${index}]`;
    assertPlainObject(release, context);
    const parsed = parseStableSemver(release.version, `${context}.version`);
    assert(!seen.has(release.version), `${context}: duplicate release`);
    seen.add(release.version);
    assert(
      release.tag === `v${release.version}`,
      `${context}: tag must match exact version`,
    );
    assert(
      /^\d{4}-\d{2}-\d{2}$/u.test(release.date),
      `${context}: invalid date`,
    );
    assert(
      release.stable === true,
      `${context}: M0 inventory must contain stable releases only`,
    );
    assert(
      release.snapshotRequired === true,
      `${context}: snapshotRequired must be true`,
    );
    assert(
      release.kind === (parsed.patch > 0 ? "patch" : "minor"),
      `${context}: incorrect kind`,
    );
    for (const key of ["officialChangelog", "sourceArgsFile"]) {
      assert(
        typeof release[key] === "string",
        `${context}.${key}: expected URL`,
      );
      assert(
        /^https:\/\//u.test(release[key]),
        `${context}.${key}: expected HTTPS URL`,
      );
    }
    if (previous) {
      assert(
        compareSemver(previous.parsed, parsed) < 0,
        `typst-releases.json: releases must be strictly ascending: ${previous.version} then ${release.version}`,
      );
    }
    previous = { version: release.version, parsed };
  }

  for (const requiredPatch of [
    "0.11.1",
    "0.13.1",
    "0.14.1",
    "0.14.2",
    "0.15.1",
  ]) {
    assert(
      seen.has(requiredPatch),
      `typst-releases.json: missing first-class patch release ${requiredPatch}`,
    );
  }
  return seen;
}

const capabilitiesSchema = await readJsonUrl(
  CAPABILITIES_SCHEMA_URL,
  "capabilities.schema.json",
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateCapabilitiesSchema = ajv.compile(capabilitiesSchema);

function schemaErrors() {
  return (validateCapabilitiesSchema.errors ?? [])
    .map((error) => {
      const location = error.instancePath || "/";
      return `${location} ${error.message}`;
    })
    .join("; ");
}

function exactVersion(document, key) {
  const value = document[key];
  return value === undefined || value === null ? null : value;
}

export function validateCapabilities(document, releases) {
  assert(
    validateCapabilitiesSchema(document),
    `capabilities.seed.json: schema validation failed: ${schemaErrors()}`,
  );

  let previousGroup = -1;
  let previousBoundary = null;
  let previousFeature = null;
  const featureNames = new Set(Object.keys(document.features));

  for (const [featureName, capability] of Object.entries(document.features)) {
    const context = `capabilities.seed.json: features.${featureName}`;
    const groupName = featureName.slice(0, featureName.indexOf("."));
    const group = FEATURE_GROUP_ORDER.get(groupName);
    assert(group !== undefined, `${context}: unknown feature group`);
    assert(
      group >= previousGroup,
      `${context}: feature groups must be ordered commands, formats, options`,
    );
    if (group !== previousGroup) previousBoundary = null;
    previousGroup = group;

    for (const key of [
      "since",
      "knownPresentBy",
      "deprecatedIn",
      "removedIn",
    ]) {
      const version = exactVersion(capability, key);
      if (version === null) continue;
      parseStableSemver(version, `${context}.${key}`);
      assert(
        releases.has(version),
        `${context}.${key}: unknown release ${version}`,
      );
    }

    const boundary =
      exactVersion(capability, "since") ??
      exactVersion(capability, "knownPresentBy");
    if (boundary !== null) {
      const parsedBoundary = parseStableSemver(boundary, `${context}.boundary`);
      if (previousBoundary !== null) {
        assert(
          compareSemver(previousBoundary.parsed, parsedBoundary) <= 0,
          `${context}: capability boundary ${boundary} must not precede ${previousFeature} at ${previousBoundary.version}`,
        );
      }
      previousBoundary = { version: boundary, parsed: parsedBoundary };
      previousFeature = featureName;
    }

    const since = exactVersion(capability, "since");
    const knownPresentBy = exactVersion(capability, "knownPresentBy");
    const deprecatedIn = exactVersion(capability, "deprecatedIn");
    const removedIn = exactVersion(capability, "removedIn");
    if (since !== null && knownPresentBy !== null) {
      assert(
        compareSemver(
          parseStableSemver(since, `${context}.since`),
          parseStableSemver(knownPresentBy, `${context}.knownPresentBy`),
        ) <= 0,
        `${context}: since must not follow knownPresentBy`,
      );
    }
    const availability = since ?? knownPresentBy;
    if (availability !== null && deprecatedIn !== null) {
      assert(
        compareSemver(
          parseStableSemver(availability, `${context}.availability`),
          parseStableSemver(deprecatedIn, `${context}.deprecatedIn`),
        ) <= 0,
        `${context}: deprecatedIn must not precede availability`,
      );
    }
    if (removedIn !== null) {
      const lowerBound = deprecatedIn ?? availability;
      if (lowerBound !== null) {
        assert(
          compareSemver(
            parseStableSemver(lowerBound, `${context}.lowerBound`),
            parseStableSemver(removedIn, `${context}.removedIn`),
          ) <= 0,
          `${context}: removedIn must not precede availability or deprecation`,
        );
      }
    }

    let previousChange = null;
    for (const [index, change] of (
      capability.behaviorChanges ?? []
    ).entries()) {
      const changeContext = `${context}.behaviorChanges[${index}]`;
      const parsed = parseStableSemver(
        change.version,
        `${changeContext}.version`,
      );
      assert(
        releases.has(change.version),
        `${changeContext}.version: unknown release ${change.version}`,
      );
      if (previousChange !== null) {
        assert(
          compareSemver(previousChange.parsed, parsed) < 0,
          `${context}.behaviorChanges: versions must be strictly ascending`,
        );
      }
      if (availability !== null) {
        assert(
          compareSemver(
            parseStableSemver(availability, `${context}.availability`),
            parsed,
          ) <= 0,
          `${changeContext}: behavior change must not precede availability`,
        );
      }
      previousChange = { version: change.version, parsed };
    }
  }

  for (const [featureName, capability] of Object.entries(document.features)) {
    if (capability.replacement !== undefined) {
      assert(
        featureNames.has(capability.replacement),
        `capabilities.seed.json: features.${featureName}.replacement references unknown feature ${capability.replacement}`,
      );
    }
  }
}

export function validateReleaseGroups(document, releases) {
  assertPlainObject(document, "release-groups.json");
  assert(
    Array.isArray(document.groups),
    "release-groups.json: groups must be an array",
  );
  const ids = new Set();
  const groupedVersions = new Set();
  for (const [index, group] of document.groups.entries()) {
    const context = `release-groups.json: groups[${index}]`;
    assertPlainObject(group, context);
    assert(
      typeof group.id === "string" && group.id,
      `${context}.id: expected non-empty string`,
    );
    assert(!ids.has(group.id), `${context}: duplicate id ${group.id}`);
    ids.add(group.id);
    assert(
      Array.isArray(group.versions) && group.versions.length > 0,
      `${context}.versions: expected non-empty array`,
    );
    assert(
      typeof group.purpose === "string" && group.purpose,
      `${context}.purpose: expected non-empty string`,
    );
    for (const version of group.versions) {
      parseStableSemver(version, `${context}.versions`);
      assert(releases.has(version), `${context}: unknown release ${version}`);
      assert(
        !groupedVersions.has(version),
        `${context}: release ${version} appears in multiple groups`,
      );
      groupedVersions.add(version);
    }
  }
  const missing = [...releases].filter(
    (version) => !groupedVersions.has(version),
  );
  assert(
    missing.length === 0,
    `release-groups.json: ungrouped releases: ${missing.join(", ")}`,
  );
}

export function validatePackageRevisions(document, releases) {
  assertPlainObject(document, "package-revisions.json");
  assert(
    typeof document.policy === "string" && document.policy,
    "package-revisions.json: policy is required",
  );
  assert(
    document.default === "latest" || Number.isSafeInteger(document.default),
    "package-revisions.json: default must be latest or a non-negative integer",
  );
  if (Number.isSafeInteger(document.default)) {
    assert(
      document.default >= 0,
      "package-revisions.json: default must be non-negative",
    );
  }
  assertPlainObject(document.overrides, "package-revisions.json: overrides");
  for (const [version, revision] of Object.entries(document.overrides)) {
    parseStableSemver(version, "package-revisions.json: override key");
    assert(
      releases.has(version),
      `package-revisions.json: override references unknown release ${version}`,
    );
    assert(
      Number.isSafeInteger(revision) && revision >= 0,
      `package-revisions.json: override for ${version} must be a non-negative integer`,
    );
  }
}

export function validateHighLevelSweep(
  document,
  releases,
  label = "high-level-sweep.json",
) {
  assertPlainObject(document, label);
  assert(
    typeof document.policy === "string" && document.policy,
    `${label}: policy is required`,
  );
  assert(
    typeof document.platform === "string" && document.platform,
    `${label}: platform is required`,
  );
  assert(
    typeof document.arch === "string" && document.arch,
    `${label}: arch is required`,
  );
  assert(
    /^\d{4}-\d{2}-\d{2}$/u.test(document.runAt ?? ""),
    `${label}: runAt must be a date`,
  );
  assertPlainObject(document.results, `${label}: results`);
  const sweptVersions = Object.keys(document.results);
  assert(sweptVersions.length > 0, `${label}: results must not be empty`);
  for (const [version, record] of Object.entries(document.results)) {
    parseStableSemver(version, `${label}: result key`);
    assert(releases.has(version), `${label}: unknown release ${version}`);
    assertPlainObject(record, `${label}: results.${version}`);
    assert(
      record.status === "tested" ||
        record.status === "failed" ||
        record.status === "unavailable",
      `${label}: results.${version}: unknown status ${record.status}`,
    );
    if (record.status === "unavailable") {
      assert(
        typeof record.reason === "string" && record.reason,
        `${label}: results.${version}: unavailable requires a reason`,
      );
      continue;
    }
    assert(
      typeof record.packageVersion === "string",
      `${label}: results.${version}: packageVersion is required`,
    );
    assertPlainObject(record.checks, `${label}: results.${version}.checks`);
    const applicable = [
      "version",
      "compileSourcePdf",
      "fonts",
      "watch",
      "query",
      "info",
      "eval",
      "bundle",
      "multiplePdfStandards",
    ];
    for (const name of applicable) {
      const value = record.checks[name];
      assert(
        value === true || value === false || value === "unsupported",
        `${label}: results.${version}.checks.${name}: must be true, false, or "unsupported"`,
      );
    }
    if (record.status === "tested") {
      for (const name of applicable) {
        assert(
          record.checks[name] !== false,
          `${label}: results.${version}: tested status but ${name} failed`,
        );
      }
    }
  }

  let contiguousTestedThrough = null;
  const ordered = [...releases]
    .filter((version) => sweptVersions.includes(version))
    .sort(compareSemverParsed);
  for (const version of ordered) {
    if (document.results[version]?.status !== "tested") break;
    contiguousTestedThrough = version;
  }
  assert(
    document.contiguousTestedThrough === contiguousTestedThrough,
    `${label}: contiguousTestedThrough must be ${contiguousTestedThrough}, got ${document.contiguousTestedThrough}`,
  );
}

/**
 * Validate every committed per-platform sweep evidence file under
 * `data/sweep/<platform>-<arch>.json`. These records back
 * `coverage.testedVersions` and `fullySupportedThrough` on the matching host.
 * The file name must encode the platform/arch, and the document must agree.
 */
export async function validateSweepEvidenceFiles(releases) {
  const sweepDir = new URL("sweep/", DATA_URL);
  let entries;
  try {
    entries = await fs.readdir(sweepDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = entries.filter((name) => name.endsWith(".json")).sort();
  const validated = [];
  for (const name of files) {
    const label = `data/sweep/${name}`;
    const document = await readJsonUrl(new URL(name, sweepDir), label);
    validateHighLevelSweep(document, releases, label);
    const stem = name.slice(0, -".json".length);
    const separator = stem.lastIndexOf("-");
    const platform = stem.slice(0, separator);
    const arch = stem.slice(separator + 1);
    assert(
      document.platform === platform && document.arch === arch,
      `${label}: filename must match platform/arch (${document.platform}/${document.arch})`,
    );
    validated.push({
      file: label,
      platform: document.platform,
      arch: document.arch,
      contiguousTestedThrough: document.contiguousTestedThrough,
      results: document.results,
    });
  }
  return validated;
}

function compareSemverParsed(left, right) {
  const a = parseStableSemver(left, "compare version");
  const b = parseStableSemver(right, "compare version");
  return compareSemver(a, b);
}

export async function loadValidatedM0Data() {
  const [
    releaseDocument,
    capabilities,
    releaseGroups,
    packageRevisions,
    highLevelSweep,
  ] = await Promise.all([
    readDataJson("typst-releases.json"),
    readDataJson("capabilities.seed.json"),
    readDataJson("release-groups.json"),
    readDataJson("package-revisions.json"),
    readDataJson("high-level-sweep.json"),
  ]);

  const releases = validateReleases(releaseDocument);
  validateCapabilities(capabilities, releases);
  validateReleaseGroups(releaseGroups, releases);
  validatePackageRevisions(packageRevisions, releases);
  validateHighLevelSweep(highLevelSweep, releases);
  const sweepEvidence = await validateSweepEvidenceFiles(releases);

  return {
    releaseDocument,
    capabilities,
    releaseGroups,
    packageRevisions,
    highLevelSweep,
    sweepEvidence,
    releases,
  };
}
