import assert from "node:assert/strict";
import test from "node:test";

import {
  TypstCompletionsError,
  TypstInvalidArgumentError,
  UnsupportedTypstFeatureError,
  UnsupportedTypstVersionError,
} from "../dist/index.js";
import { result, client, node } from "./helpers/mock-typst.mjs";

test("completions serializes the shell as a single argument", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, "#compdef typst");
  });
  const outcome = await typst.completions("zsh");
  assert.deepEqual(seen[0], ["completions", "zsh"]);
  assert.equal(outcome.raw, "#compdef typst");
  assert.equal(outcome.compilerVersion, "0.15.1");
  assert.equal(outcome.process.exitCode, 0);
});

test("completions accepts every documented shell", async () => {
  for (const shell of ["bash", "elvish", "fish", "powershell", "zsh"]) {
    const typst = client("0.15.1", (args) => result(args, "script"));
    const outcome = await typst.completions(shell);
    assert.equal(outcome.raw, "script", shell);
  }
});

test("completions gates the command at the exact 0.14.0 boundary", async () => {
  const before = client("0.13.1", () => result(["completions"], ""));
  await assert.rejects(
    before.completions("bash"),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "completions" &&
      error.requiredVersion === "0.14.0" &&
      error.actualVersion === "0.13.1",
  );

  const at = client("0.14.0", (args) => result(args, "script"));
  const outcome = await at.completions("fish");
  assert.equal(outcome.raw, "script");
});

test("completions throws a typed error for unsuccessful exits with raw evidence", async () => {
  const stderr = "error: unknown shell\n";
  const typst = client("0.15.1", (args) => result(args, "", 2, stderr));
  await assert.rejects(
    typst.completions("zsh"),
    (error) =>
      error instanceof TypstCompletionsError &&
      error.code === "ERR_TYPST_COMPLETIONS" &&
      error.compilerVersion === "0.15.1" &&
      error.process.exitCode === 2 &&
      error.process.stderr.toString("utf8") === stderr,
  );
});

test("completions uses stderr text as raw when stdout is empty", async () => {
  const stderr = "# bash completions\n";
  const typst = client("0.15.1", (args) => result(args, "", 0, stderr));
  const outcome = await typst.completions("bash");
  assert.equal(outcome.raw, stderr);
});

test("completions rejects unknown shells before spawn", async () => {
  const typst = client("0.15.1", () => result(["completions"], ""));
  await assert.rejects(typst.completions("csh"), TypstInvalidArgumentError);
  await assert.rejects(typst.completions(""), TypstInvalidArgumentError);
  await assert.rejects(typst.completions("BASH"), TypstInvalidArgumentError);
});

test("completions rejects unknown future versions before spawn", async () => {
  const unknown = client("0.16.0", () => result(["completions"], ""));
  await assert.rejects(
    unknown.completions("zsh"),
    (error) =>
      error instanceof UnsupportedTypstVersionError &&
      error.actualVersion === "0.16.0",
  );
});

test("completions rejects malformed options before spawn", async () => {
  for (const options of [
    null,
    [],
    "completions",
    { timeoutMs: -1 },
    { envMode: "upsert" },
  ]) {
    const typst = client("0.15.1", () => result(["completions"], ""));
    await assert.rejects(
      typst.completions("zsh", options),
      TypstInvalidArgumentError,
      JSON.stringify(options),
    );
  }
});

test("completions forwards run options to the process runner", async () => {
  const seenOptions = [];
  const typst = client("0.15.1", (_args, options) => {
    seenOptions.push(options);
    return result(["completions"], "script");
  });
  const signal = new AbortController().signal;
  await typst.completions("zsh", {
    cwd: "custom-dir",
    env: { COMPLETIONS_ONLY: "1" },
    timeoutMs: 5_000,
    terminationGraceMs: 200,
    signal,
  });
  assert.equal(seenOptions[0].cwd, "custom-dir");
  assert.equal(seenOptions[0].env.COMPLETIONS_ONLY, "1");
  assert.equal(seenOptions[0].timeoutMs, 5_000);
  assert.equal(seenOptions[0].terminationGraceMs, 200);
  assert.equal(seenOptions[0].signal, signal);
});
