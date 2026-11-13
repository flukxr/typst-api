import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadCapabilityRegistry } from "../dist/capabilities/registry.js";

test("runtime loads the committed seed file as the default registry", () => {
  const registry = loadCapabilityRegistry(
    fileURLToPath(new URL("../data/capabilities.seed.json", import.meta.url)),
  );
  assert.equal(registry.status, "verified");
  assert.equal(registry.features["commands.compile"].since, "0.1.0");
});

test("a replaced data file changes the loaded capability registry", () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-registry-data-"));
  try {
    const seed = join(directory, "capabilities.seed.json");
    writeFileSync(
      seed,
      JSON.stringify({
        $schema: "../schemas/capabilities.schema.json",
        status: "verified",
        verification: {
          milestone: "M0",
          platform: "win32",
          arch: "x64",
        },
        warning: "Replacement registry used by a test.",
        checkedAt: "2026-01-01",
        features: {
          "commands.compile": {
            since: "0.9.0",
          },
          "options.pretty": {
            since: "0.15.0",
          },
        },
      }),
    );
    const registry = loadCapabilityRegistry(seed);
    assert.equal(registry.status, "verified");
    // The replacement boundary wins over the committed seed's 0.1.0.
    assert.equal(registry.features["commands.compile"].since, "0.9.0");
    // A feature absent from the committed seed is present here.
    assert.equal(registry.features["options.pretty"].since, "0.15.0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed or missing data falls back to the compiled registry", () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-registry-bad-"));
  try {
    const missing = join(directory, "missing.json");
    assert.equal(loadCapabilityRegistry(missing).status, "verified");
    const invalid = join(directory, "invalid.json");
    writeFileSync(invalid, "not json");
    assert.equal(loadCapabilityRegistry(invalid).status, "verified");
    const seedStatus = join(directory, "seed.json");
    writeFileSync(
      seedStatus,
      JSON.stringify({
        status: "seed",
        features: { "commands.compile": { since: "0.1.0" } },
      }),
    );
    assert.equal(loadCapabilityRegistry(seedStatus).status, "verified");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
