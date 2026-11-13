import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TypstInvalidArgumentError,
  UnsupportedTypstVersionError,
  createTypst,
} from "../dist/index.js";
import {
  result,
  client as mockClient,
  node,
  writeOutput,
} from "./helpers/mock-typst.mjs";

const client = (version, policy, onCompile) =>
  mockClient(version, onCompile, { unknownVersionPolicy: policy });

test("createTypst rejects malformed unknownVersionPolicy values", async () => {
  await assert.rejects(
    createTypst({ unknownVersionPolicy: "guess" }),
    TypstInvalidArgumentError,
  );
});

test("reject policy keeps throwing on unknown compiler versions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-policy-reject-"));
  try {
    const typst = client("0.99.0", "reject", (args) => {
      writeOutput(args);
      return result(args, "PDF");
    });
    await assert.rejects(
      typst.compile({
        input: { kind: "file", path: "document.typ" },
        output: { kind: "file", path: "out.pdf" },
      }),
      (error) =>
        error instanceof UnsupportedTypstVersionError &&
        error.actualVersion === "0.99.0",
    );
    const support = await typst.support();
    assert.equal(support.level, "unknown");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("assume-latest-known compiles but keeps support unknown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-policy-assume-"));
  try {
    const typst = client("0.99.0", "assume-latest-known", (args) => {
      writeOutput(args);
      return result(args, "PDF");
    });
    const output = await typst.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "out.pdf") },
    });
    assert.equal(output.outputs[0].kind, "file");
    assert.equal(output.compilerVersion, "0.99.0");

    const support = await typst.support();
    assert.notEqual(support.level, "full");
    assert.equal(support.level, "unknown");

    const report = await typst.diagnose();
    assert.ok(
      report.issues.some((issue) => issue.code === "ASSUMED_VERSION_RULES"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("assume-latest-known still gates features to the assumed version", async () => {
  const calls = [];
  const typst = client("0.99.0", "assume-latest-known", (args) => {
    calls.push([...args]);
    writeOutput(args);
    return result(args, "PDF");
  });
  // `pretty` exists only from exact 0.15.0, so the assumed 0.15.1 rules allow
  // it; but the argument list must be built against the assumed version rules.
  await typst.compile({
    input: { kind: "file", path: "document.typ" },
    output: { kind: "file", path: "out.pdf" },
    pretty: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("--pretty"), true);
});

test("assume-latest-known orders prereleases and build metadata exactly", async () => {
  const { resolveVersionForRules, KNOWN_TYPST_VERSIONS } =
    await import("../dist/client/support-data.js");
  const policy = "assume-latest-known";
  // A prerelease precedes its stable core: 0.13.0-rc.1 must use 0.12.0 rules,
  // never the newest known release.
  assert.equal(resolveVersionForRules("0.13.0-rc.1", policy), "0.12.0");
  // Build metadata does not change precedence.
  assert.equal(resolveVersionForRules("0.13.0+abc", policy), "0.13.0");
  // A future stable uses the newest known rules.
  assert.equal(
    resolveVersionForRules("99.0.0", policy),
    KNOWN_TYPST_VERSIONS.at(-1),
  );
  // Nothing is older than the first release candidate of 0.1.0.
  assert.equal(resolveVersionForRules("0.1.0-rc.1", policy), undefined);
  // An unorderable core has no safe rule set.
  assert.equal(resolveVersionForRules("nightly", policy), undefined);
  assert.equal(resolveVersionForRules("0.13.0-rc.1", "reject"), undefined);
});
