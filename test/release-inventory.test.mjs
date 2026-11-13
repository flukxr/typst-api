import assert from "node:assert/strict";
import test from "node:test";

import {
  addReleaseToDocuments,
  buildReleaseRecord,
  compareExactVersions,
  findCapabilityChanges,
  missingStableVersions,
  renderReviewReport,
  stableReleases,
} from "../scripts/release-inventory.mjs";

const evidence = {
  officialChangelog: "https://typst.app/docs/changelog/0.15.1/",
  sourceArgsFile:
    "https://github.com/typst/typst/blob/v0.15.1/crates/typst-cli/src/args.rs",
};

function upstream(version, overrides = {}) {
  return {
    tag_name: `v${version}`,
    published_at: "2026-01-02T03:04:05Z",
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

test("discovers exact stable patches independently", () => {
  const releases = stableReleases([
    upstream("0.15.1"),
    upstream("0.15.0"),
    upstream("0.16.0-rc.1"),
    upstream("0.16.0", { prerelease: true }),
    upstream("0.15.2", { draft: true }),
  ]);
  assert.deepEqual(
    releases.map((release) => release.version),
    ["0.15.0", "0.15.1"],
  );
  assert.equal(compareExactVersions("0.15.0", "0.15.1"), -1);
  assert.equal(compareExactVersions("0.15.1", "0.16.0"), -1);
});

test("reports a missing patch without collapsing it into the minor", () => {
  const inventory = { releases: [{ version: "0.15.0" }] };
  assert.deepEqual(
    missingStableVersions(inventory, [upstream("0.15.0"), upstream("0.15.1")]),
    ["0.15.1"],
  );
});

test("builds patch and minor records at adjacent boundaries", () => {
  assert.equal(buildReleaseRecord(upstream("0.15.1"), evidence).kind, "patch");
  assert.equal(
    buildReleaseRecord(upstream("0.16.0"), {
      officialChangelog: "https://typst.app/docs/changelog/0.16.0/",
      sourceArgsFile:
        "https://github.com/typst/typst/blob/v0.16.0/crates/typst-cli/src/args.rs",
    }).kind,
    "minor",
  );
});

test("inserts an exact release in order and makes review status explicit", () => {
  const result = addReleaseToDocuments(
    { releases: [{ version: "0.15.0" }, { version: "0.16.0" }] },
    {
      groups: [
        { id: "known", versions: ["0.15.0", "0.16.0"], purpose: "Known" },
      ],
    },
    buildReleaseRecord(upstream("0.15.1"), evidence),
  );
  assert.deepEqual(
    result.inventory.releases.map((release) => release.version),
    ["0.15.0", "0.15.1", "0.16.0"],
  );
  assert.deepEqual(result.releaseGroups.groups.at(-1), {
    id: "pending-review",
    versions: ["0.15.1"],
    purpose:
      "New exact releases awaiting behavior, capability, and coverage review.",
  });
});

test("renders conservative review gates", () => {
  const release = buildReleaseRecord(upstream("0.15.1"), evidence);
  const report = renderReviewReport({
    release,
    previousVersion: "0.15.0",
    state: {
      snapshotStatus: "collected",
      packageVersion: "0.15.1-npm.0",
      diffReady: true,
      behaviorFiles: [],
      capabilityChanges: [],
      capabilityComparison: "HEAD",
      capabilitySeedSha256: "abc123",
    },
    collectionError: null,
  });
  assert.match(report, /CLI snapshots \| ready/u);
  assert.match(report, /Behavior probes \| review required/u);
  assert.match(report, /Capability changes \| review required/u);
  assert.match(report, /Coverage status \| unknown/u);
  assert.match(report, /0\.15\.0__0\.15\.1\.md/u);
});

test("reports exact capability entries changed from the review base", () => {
  const previous = {
    features: {
      "commands.compile": { since: "0.1.0" },
      "commands.query": { since: "0.7.0" },
    },
  };
  const current = structuredClone(previous);
  current.features["commands.query"].deprecatedIn = "0.15.0";
  current.features["commands.eval"] = { since: "0.15.0" };
  assert.deepEqual(findCapabilityChanges(previous, current), [
    "commands.eval",
    "commands.query",
  ]);
});
