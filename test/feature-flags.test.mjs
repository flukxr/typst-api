import assert from "node:assert/strict";
import test from "node:test";

import {
  FEATURE_FLAGS,
  featureArgs,
  featureFlagRequired,
  withImpliedFeature,
} from "../dist/commands/shared.js";

// The real table: every flag is required from its exact first release, with
// the immediately preceding release still rejecting it.
for (const [feature, before, since] of [
  ["html", "0.12.0", "0.13.0"],
  ["a11y-extras", "0.13.1", "0.14.0"],
  ["bundle", "0.14.2", "0.15.0"],
]) {
  test(`${feature} flag is required from exact ${since}`, () => {
    assert.equal(FEATURE_FLAGS[feature].since, since);
    assert.equal(featureFlagRequired(before, feature), false);
    assert.equal(featureFlagRequired(since, feature), true);
    assert.equal(featureFlagRequired("0.15.1", feature), true);
  });
}

test("html and bundle outputs imply their flag only where it exists", () => {
  assert.deepEqual(withImpliedFeature({}, "html", "0.13.0").features, ["html"]);
  assert.deepEqual(withImpliedFeature({}, "bundle", "0.15.0").features, [
    "bundle",
  ]);
  // Before the feature exists nothing is implied; the capability gate rejects.
  assert.equal(withImpliedFeature({}, "html", "0.12.0").features, undefined);
  // An explicit flag is not duplicated, other outputs imply nothing.
  assert.deepEqual(
    withImpliedFeature({ features: ["html"] }, "html", "0.15.1").features,
    ["html"],
  );
  assert.equal(withImpliedFeature({}, "pdf", "0.15.1").features, undefined);
});

// A stabilised feature, simulated with a table in which html became stable
// in a future 0.16.0: from there on the flag is neither implied nor passed.
const STABLE_HTML = {
  ...FEATURE_FLAGS,
  html: { since: "0.13.0", stableIn: "0.16.0" },
};

test("a stabilised feature is no longer implied or serialized", () => {
  assert.equal(featureFlagRequired("0.15.1", "html", STABLE_HTML), true);
  assert.equal(featureFlagRequired("0.16.0", "html", STABLE_HTML), false);

  assert.deepEqual(
    withImpliedFeature({}, "html", "0.15.1", STABLE_HTML).features,
    ["html"],
  );
  assert.equal(
    withImpliedFeature({}, "html", "0.16.0", STABLE_HTML).features,
    undefined,
  );

  assert.deepEqual(featureArgs("0.15.1", ["html"], STABLE_HTML), [
    "--features",
    "html",
  ]);
  // An explicit flag of a stable feature is dropped instead of breaking.
  assert.deepEqual(featureArgs("0.16.0", ["html"], STABLE_HTML), []);
  assert.deepEqual(featureArgs("0.16.0", ["html", "bundle"], STABLE_HTML), [
    "--features",
    "bundle",
  ]);
});

test("featureArgs emits nothing for an empty or missing list", () => {
  assert.deepEqual(featureArgs("0.15.1", undefined), []);
  assert.deepEqual(featureArgs("0.15.1", []), []);
  assert.deepEqual(featureArgs("0.15.1", ["html", "a11y-extras"]), [
    "--features",
    "html,a11y-extras",
  ]);
});
