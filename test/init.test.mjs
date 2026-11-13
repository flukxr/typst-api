import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  TypstInitConflictError,
  TypstInitError,
  TypstInvalidArgumentError,
  UnsupportedTypstFeatureError,
  UnsupportedTypstVersionError,
} from "../dist/index.js";
import { result, client, node } from "./helpers/mock-typst.mjs";

test("init serializes template, directory, and package paths", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(
      args,
      "Successfully created new project from @preview/charged-ieee",
    );
  });
  const outcome = await typst.init({
    template: "@preview/charged-ieee:0.1.0",
    directory: "my-project",
    packagePath: "pkgs",
    packageCachePath: "cache",
  });
  assert.deepEqual(seen[0], [
    "init",
    "--package-path",
    "pkgs",
    "--package-cache-path",
    "cache",
    "@preview/charged-ieee:0.1.0",
    "my-project",
  ]);
  assert.equal(outcome.compilerVersion, "0.15.1");
  assert.equal(outcome.process.exitCode, 0);
});

test("init gates the command at the exact 0.11.0 boundary", async () => {
  const before = client("0.10.0", () => result(["init"]));
  await assert.rejects(
    before.init({ template: "@preview/charged-ieee" }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "init" &&
      error.requiredVersion === "0.11.0" &&
      error.actualVersion === "0.10.0",
  );

  let seen;
  const at = client("0.11.0", (args) => {
    seen = args;
    return result(args, "ok");
  });
  const outcome = await at.init({ template: "@preview/charged-ieee" });
  assert.deepEqual(seen, ["init", "@preview/charged-ieee"]);
  assert.ok(outcome.directory === undefined);
});

test("init gates package paths at the exact 0.12.0 boundary", async () => {
  const before = client("0.11.1", () => result(["init"], "ok"));
  await assert.rejects(
    before.init({
      template: "@preview/charged-ieee",
      packagePath: "pkgs",
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "packagePath" &&
      error.requiredVersion === "0.12.0",
  );
  await assert.rejects(
    before.init({
      template: "@preview/charged-ieee",
      packageCachePath: "cache",
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "packageCachePath" &&
      error.requiredVersion === "0.12.0",
  );

  let seen;
  const at = client("0.12.0", (args) => {
    seen = args;
    return result(args, "ok");
  });
  await at.init({
    template: "@preview/charged-ieee",
    packagePath: "pkgs",
    packageCachePath: "cache",
  });
  assert.deepEqual(seen.slice(0, 5), [
    "init",
    "--package-path",
    "pkgs",
    "--package-cache-path",
    "cache",
  ]);
});

test("init resolves a provided directory and reports it in the result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-init-test-"));
  try {
    let seen;
    const typst = client("0.15.1", (args) => {
      seen = args;
      return result(args, "ok");
    });
    const outcome = await typst.init({
      template: "@preview/charged-ieee",
      directory: "sub/dir",
      cwd: directory,
    });
    assert.equal(seen.at(-1), "sub/dir");
    assert.equal(outcome.directory, join(directory, "sub", "dir"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init rejects an already-existing destination before spawn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-init-conflict-"));
  try {
    mkdirSync(join(directory, "exists"));
    let calls = 0;
    const typst = client("0.15.1", (args) => {
      calls += 1;
      return result(args, "ok");
    });
    await assert.rejects(
      typst.init({
        template: "@preview/charged-ieee",
        directory: join(directory, "exists"),
      }),
      (error) => {
        assert.ok(error instanceof TypstInitConflictError);
        assert.equal(error.code, "ERR_TYPST_INIT_CONFLICT");
        assert.equal(error.resolved, join(directory, "exists"));
        return true;
      },
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init throws a typed error for unsuccessful exits with raw evidence", async () => {
  const stderr = "error: package @preview/charged-ieee is not a template\n";
  const typst = client("0.15.1", (args) => result(args, "", 1, stderr));
  await assert.rejects(
    typst.init({ template: "@preview/charged-ieee" }),
    (error) =>
      error instanceof TypstInitError &&
      error.code === "ERR_TYPST_INIT" &&
      error.compilerVersion === "0.15.1" &&
      error.process.exitCode === 1 &&
      error.process.stderr.toString("utf8") === stderr,
  );
});

test("init rejects unknown future versions before spawn", async () => {
  const unknown = client("0.16.0", () => result(["init"], "ok"));
  await assert.rejects(
    unknown.init({ template: "@preview/charged-ieee" }),
    (error) =>
      error instanceof UnsupportedTypstVersionError &&
      error.actualVersion === "0.16.0",
  );
});

test("init rejects malformed options before spawn", async () => {
  for (const options of [
    null,
    [],
    "init",
    { template: "" },
    { template: "a\0b" },
    { template: "@preview/charged-ieee", directory: "" },
    { template: "@preview/charged-ieee", packagePath: "" },
    { template: "@preview/charged-ieee", packageCachePath: "\0" },
    { template: "@preview/charged-ieee", timeoutMs: -1 },
    { template: "@preview/charged-ieee", envMode: "upsert" },
  ]) {
    const typst = client("0.15.1", () => result(["init"], "ok"));
    await assert.rejects(
      typst.init(options),
      TypstInvalidArgumentError,
      JSON.stringify(options),
    );
  }
});

test("init forwards run options to the process runner", async () => {
  const seenOptions = [];
  const typst = client("0.15.1", (_args, options) => {
    seenOptions.push(options);
    return result(["init"], "ok");
  });
  const signal = new AbortController().signal;
  await typst.init({
    template: "@preview/charged-ieee",
    cwd: "custom-dir",
    env: { INIT_ONLY: "1" },
    timeoutMs: 5_000,
    terminationGraceMs: 200,
    signal,
  });
  assert.equal(seenOptions[0].cwd, "custom-dir");
  assert.equal(seenOptions[0].env.INIT_ONLY, "1");
  assert.equal(seenOptions[0].timeoutMs, 5_000);
  assert.equal(seenOptions[0].terminationGraceMs, 200);
  assert.equal(seenOptions[0].signal, signal);
});
