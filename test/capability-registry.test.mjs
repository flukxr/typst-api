import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../dist/capabilities/registry.js";

test("retains verified registry evidence in generated build input", () => {
  assert.equal(CAPABILITY_REGISTRY.status, "verified");
  assert.deepEqual(CAPABILITY_REGISTRY.verification, {
    milestone: "M0",
    platform: "win32",
    arch: "x64",
  });
  assert.equal(CAPABILITY_REGISTRY.checkedAt, "2026-07-18");
  assert.equal(CAPABILITY_REGISTRY.evidence.platform, "win32-x64");
  assert.equal(CAPABILITY_REGISTRY.evidence.behaviorProbes.length, 3);
});

test("generates all capability definitions without collapsing patch boundaries", () => {
  assert.equal(Object.keys(CAPABILITY_REGISTRY.features).length, 40);
  assert.deepEqual(CAPABILITY_REGISTRY.features["commands.eval"], {
    since: "0.15.0",
    behaviorChanges: [
      {
        version: "0.15.1",
        change: "Evaluation failures return exit code 1.",
      },
    ],
  });
  assert.equal(
    CAPABILITY_REGISTRY.features["commands.query"].deprecatedIn,
    "0.15.0",
  );
  assert.equal(
    CAPABILITY_REGISTRY.features["formats.html"].requiredFeature,
    "html",
  );
  assert.deepEqual(CAPABILITY_REGISTRY.features["options.makeDeps"], {
    since: "0.12.0",
    deprecatedIn: "0.14.0",
    replacement: "options.deps",
    compatStrategy:
      "Use --make-deps (Makefile only) before 0.14.0; use --deps with --deps-format from 0.14.0.",
  });
  assert.equal(
    CAPABILITY_REGISTRY.features["options.watchServer"].since,
    "0.13.0",
  );
});

test("preserves deterministic semantic feature ordering", () => {
  const names = Object.keys(CAPABILITY_REGISTRY.features);
  assert.deepEqual(names.slice(0, 4), [
    "commands.compile",
    "commands.watch",
    "commands.fonts",
    "commands.query",
  ]);
  assert.equal(names[9], "formats.pdf");
  assert.equal(names[14], "options.root");
  assert.equal(names.at(-1), "options.evalTarget");
});
