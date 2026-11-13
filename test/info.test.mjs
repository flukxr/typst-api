import assert from "node:assert/strict";
import test from "node:test";

import {
  TypstInfoError,
  TypstInvalidArgumentError,
  UnsupportedTypstFeatureError,
  UnsupportedTypstVersionError,
} from "../dist/index.js";
import { result, client, node } from "./helpers/mock-typst.mjs";

const INFO_JSON = JSON.stringify({
  version: "0.15.1",
  target: "x86_64-pc-windows-msvc",
});

test("info returns the raw output text and process record", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, "Operating System: Windows\nVersion: 0.15.1\n");
  });
  const outcome = await typst.info();
  assert.deepEqual(seen[0], ["info"]);
  assert.equal(outcome.raw, "Operating System: Windows\nVersion: 0.15.1\n");
  assert.equal(outcome.data, undefined);
  assert.equal(outcome.compilerVersion, "0.15.1");
  assert.equal(outcome.process.exitCode, 0);
});

test("info serializes format and pretty flags", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, INFO_JSON);
  });
  const outcome = await typst.info({ format: "json", pretty: true });
  assert.deepEqual(seen[0], ["info", "--format", "json", "--pretty"]);
  assert.deepEqual(outcome.data, {
    version: "0.15.1",
    target: "x86_64-pc-windows-msvc",
  });
  assert.equal(outcome.raw, INFO_JSON);
});

test("info gates the command at the exact 0.14.0 boundary", async () => {
  const before = client("0.13.1", () => result(["info"], ""));
  await assert.rejects(
    before.info(),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "info" &&
      error.requiredVersion === "0.14.0" &&
      error.actualVersion === "0.13.1",
  );

  const at = client("0.14.0", (args) => result(args, "ok"));
  const outcome = await at.info();
  assert.equal(outcome.raw, "ok");
});

test("info throws a typed error for unsuccessful exits with raw evidence", async () => {
  const stderr = "error: failed to collect environment info\n";
  const typst = client("0.15.1", (args) => result(args, "", 2, stderr));
  await assert.rejects(
    typst.info(),
    (error) =>
      error instanceof TypstInfoError &&
      error.code === "ERR_TYPST_INFO" &&
      error.compilerVersion === "0.15.1" &&
      error.process.exitCode === 2 &&
      error.process.stderr.toString("utf8") === stderr,
  );
});

test("info uses stderr text as raw when stdout is empty", async () => {
  const stderr = "Operating System: Linux\n";
  const typst = client("0.15.1", (args) => result(args, "", 0, stderr));
  const outcome = await typst.info();
  assert.equal(outcome.raw, stderr);
});

test("info rejects unknown future versions before spawn", async () => {
  const unknown = client("0.16.0", () => result(["info"], ""));
  await assert.rejects(
    unknown.info(),
    (error) =>
      error instanceof UnsupportedTypstVersionError &&
      error.actualVersion === "0.16.0",
  );
});

test("info rejects malformed options before spawn", async () => {
  for (const options of [
    null,
    [],
    "info",
    { format: "xml" },
    { format: 1 },
    { pretty: "yes" },
    { pretty: 1 },
    { timeoutMs: -1 },
    { envMode: "upsert" },
  ]) {
    const typst = client("0.15.1", () => result(["info"], ""));
    await assert.rejects(
      typst.info(options),
      TypstInvalidArgumentError,
      JSON.stringify(options),
    );
  }
});

test("info forwards run options to the process runner", async () => {
  const seenOptions = [];
  const typst = client("0.15.1", (_args, options) => {
    seenOptions.push(options);
    return result(["info"], "ok");
  });
  const signal = new AbortController().signal;
  await typst.info({
    cwd: "custom-dir",
    env: { INFO_ONLY: "1" },
    timeoutMs: 5_000,
    terminationGraceMs: 200,
    signal,
  });
  assert.equal(seenOptions[0].cwd, "custom-dir");
  assert.equal(seenOptions[0].env.INFO_ONLY, "1");
  assert.equal(seenOptions[0].timeoutMs, 5_000);
  assert.equal(seenOptions[0].terminationGraceMs, 200);
  assert.equal(seenOptions[0].signal, signal);
});
