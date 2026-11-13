import assert from "node:assert/strict";
import test from "node:test";

import {
  loadValidatedM0Data,
  validateCapabilities,
  validateHighLevelSweep,
} from "../scripts/data-validation.mjs";

const { capabilities, releases, highLevelSweep, sweepEvidence } =
  await loadValidatedM0Data();

test("accepts the committed capability seed", () => {
  assert.doesNotThrow(() => validateCapabilities(capabilities, releases));
});

test("rejects fields that are absent from the schema", () => {
  const invalid = structuredClone(capabilities);
  invalid.features["commands.compile"].guessed = true;
  assert.throws(
    () => validateCapabilities(invalid, releases),
    /schema validation failed/u,
  );
});

test("rejects non-exact stable versions", () => {
  const invalid = structuredClone(capabilities);
  invalid.features["commands.eval"].since = "0.15.01";
  assert.throws(
    () => validateCapabilities(invalid, releases),
    /schema validation failed/u,
  );
});

test("rejects capability boundary ordering errors", () => {
  const invalid = structuredClone(capabilities);
  const evalCapability = invalid.features["commands.eval"];
  delete invalid.features["commands.eval"];
  invalid.features = {
    "commands.eval": evalCapability,
    ...invalid.features,
  };
  assert.throws(
    () => validateCapabilities(invalid, releases),
    /capability boundary .* must not precede/u,
  );
});

test("rejects behavior changes that are not strictly ascending", () => {
  const invalid = structuredClone(capabilities);
  invalid.features["options.root"].behaviorChanges.reverse();
  assert.throws(
    () => validateCapabilities(invalid, releases),
    /behaviorChanges: versions must be strictly ascending/u,
  );
});

test("rejects replacement references to unknown capabilities", () => {
  const invalid = structuredClone(capabilities);
  invalid.features["commands.query"].replacement = "commands.missing";
  assert.throws(
    () => validateCapabilities(invalid, releases),
    /replacement references unknown feature commands\.missing/u,
  );
});

test("accepts the committed high-level sweep", () => {
  assert.doesNotThrow(() => validateHighLevelSweep(highLevelSweep, releases));
  assert.equal(highLevelSweep.contiguousTestedThrough, "0.15.1");
  assert.equal(
    Object.values(highLevelSweep.results).every(
      (record) => record.status === "tested",
    ),
    true,
  );
});

test("accepts every committed per-platform sweep evidence file", () => {
  const platforms = sweepEvidence.map(
    (record) => `${record.platform}/${record.arch}`,
  );
  assert.deepEqual(platforms.sort(), [
    "darwin/arm64",
    "linux/arm64",
    "linux/x64",
    "win32/x64",
  ]);
  for (const record of sweepEvidence) {
    assert.equal(record.contiguousTestedThrough, "0.15.1");
    const statuses = Object.values(record.results).map((r) => r.status);
    assert.equal(
      statuses.every((status) => status === "tested"),
      true,
      `${record.file}: expected every version tested`,
    );
  }
});

test("accepts a per-platform sweep record with an explicit label", () => {
  const linuxRecord = structuredClone(highLevelSweep);
  linuxRecord.platform = "linux";
  linuxRecord.arch = "x64";
  assert.doesNotThrow(() =>
    validateHighLevelSweep(linuxRecord, releases, "data/sweep/linux-x64.json"),
  );
  assert.throws(
    () =>
      validateHighLevelSweep(
        { ...linuxRecord, results: {} },
        releases,
        "data/sweep/linux-x64.json",
      ),
    /results must not be empty/u,
  );
});

test("rejects sweep statuses that are not evidence-backed", () => {
  const invalid = structuredClone(highLevelSweep);
  invalid.results["0.1.0"].status = "guessed";
  assert.throws(
    () => validateHighLevelSweep(invalid, releases),
    /unknown status/u,
  );
});

test("rejects a tested sweep version with a failed check", () => {
  const invalid = structuredClone(highLevelSweep);
  invalid.results["0.1.0"].checks.compileSourcePdf = false;
  assert.throws(
    () => validateHighLevelSweep(invalid, releases),
    /tested status but compileSourcePdf failed/u,
  );
});

test("rejects a contiguousTestedThrough that does not match the results", () => {
  const invalid = structuredClone(highLevelSweep);
  invalid.results["0.3.0"].status = "failed";
  invalid.contiguousTestedThrough = "0.15.1";
  assert.throws(
    () => validateHighLevelSweep(invalid, releases),
    /contiguousTestedThrough must be 0\.2\.0/u,
  );
});
