import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  TypstVersionCommandError,
  TypstVersionOutputError,
  TypstVersionParseError,
  createTypst,
  parseTypstVersionOutput,
} from "../dist/index.js";
import { TypstClientImpl } from "../dist/client/index.js";
import { result, node } from "./helpers/mock-typst.mjs";

const packageVersion = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  ),
).version;

function discovered(versionEnvironment = {}) {
  return {
    executable: node,
    source: "explicit",
    cwd: process.cwd(),
    env: { ...process.env, ...versionEnvironment },
  };
}

test("strictly parses stable, prerelease, build, and commit identity", () => {
  assert.deepEqual(parseTypstVersionOutput("Typst 0.15.1 (8ace67d9)\n"), {
    raw: "Typst 0.15.1 (8ace67d9)\n",
    version: "0.15.1",
    stableVersion: "0.15.1",
    major: 0,
    minor: 15,
    patch: 1,
    prerelease: [],
    commit: "8ace67d9",
  });
  assert.deepEqual(
    parseTypstVersionOutput("typst 0.15.1-rc.1+local.2 (commit abc12345)"),
    {
      raw: "typst 0.15.1-rc.1+local.2 (commit abc12345)",
      version: "0.15.1-rc.1+local.2",
      stableVersion: "0.15.1",
      major: 0,
      minor: 15,
      patch: 1,
      prerelease: ["rc", 1],
      commit: "abc12345",
    },
  );
  assert.deepEqual(parseTypstVersionOutput("Typst 1.2.3+foo-bar"), {
    raw: "Typst 1.2.3+foo-bar",
    version: "1.2.3+foo-bar",
    stableVersion: "1.2.3",
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
  });
  assert.throws(
    () => parseTypstVersionOutput("Typst 0.15.1-rc.01"),
    TypstVersionOutputError,
  );
  assert.throws(
    () => parseTypstVersionOutput("Typst 0.15.1-rc.01"),
    TypstVersionOutputError,
  );
  assert.throws(
    () => parseTypstVersionOutput("0.15.1"),
    TypstVersionOutputError,
  );
});

test("version() reports the exact stable core separately from the full string", async () => {
  const typst = new TypstClientImpl(discovered(), {});
  typst.run = async (args) => result(args, "Typst 0.15.1-rc.1+local.2");
  const info = await typst.version();
  assert.equal(info.version, "0.15.1-rc.1+local.2");
  assert.equal(info.stableVersion, "0.15.1");
  assert.equal(info.major, 0);
  assert.equal(info.minor, 15);
  assert.equal(info.patch, 1);
});

test("createTypst discovers an explicit absolute executable and exposes M2 methods", async () => {
  const client = await createTypst({ executable: node });
  assert.equal(client.executable, node);
  assert.equal(client.executableSource, "explicit");
  assert.equal("compile" in client, true);
  assert.equal("fonts" in client, true);
  assert.equal("init" in client, true);
  assert.equal("query" in client, true);
  assert.equal("queryOne" in client, true);
  assert.equal("info" in client, true);
  assert.equal("completions" in client, true);
  assert.equal("watch" in client, true);
});

test("version caches concurrent success and preserves commit metadata", async () => {
  const client = new TypstClientImpl(discovered(), {});
  let calls = 0;
  client.run = async (args) => {
    calls += 1;
    return result(args, "Typst 0.15.1 (8ace67d9)\n");
  };

  const first = client.version();
  const second = client.version();
  assert.strictEqual(first, second);
  const [left, right] = await Promise.all([first, second]);
  assert.strictEqual(left, right);
  assert.equal(calls, 1);
  assert.equal(left.commit, "8ace67d9");
});

test("version command and parse failures retain raw process evidence", async () => {
  const nonZero = new TypstClientImpl(discovered(), {});
  nonZero.run = async (args) => result(args, "Typst 0.15.1\n", 2);
  await assert.rejects(nonZero.version(), (error) => {
    assert.equal(error instanceof TypstVersionCommandError, true);
    assert.equal(error.process.exitCode, 2);
    assert.equal(error.raw, "Typst 0.15.1\n");
    return true;
  });

  const malformed = new TypstClientImpl(discovered(), {});
  malformed.run = async (args) => result(args, "not a Typst version\n");
  await assert.rejects(malformed.version(), (error) => {
    assert.equal(error instanceof TypstVersionParseError, true);
    assert.equal(error.process.stdout.toString(), "not a Typst version\n");
    return true;
  });
});

test("a rejected version promise is cleared so a later probe can retry", async () => {
  const client = new TypstClientImpl(discovered(), {});
  let calls = 0;
  client.run = async (args) => {
    calls += 1;
    return calls === 1
      ? result(args, "malformed output")
      : result(args, "Typst 0.15.1");
  };
  await assert.rejects(client.version(), TypstVersionParseError);
  const retry = await client.version();
  assert.equal(retry.version, "0.15.1");
  assert.equal(calls, 2);
});

test("support apiVersion matches the shipped package version", async () => {
  const known = new TypstClientImpl(discovered(), {});
  known.run = async (args) => result(args, "Typst 0.15.0");
  const support = await known.support();
  // Fails when src/client/index.ts drifts from package.json.
  assert.equal(support.apiVersion, packageVersion);
});

test("support keeps 0.15.0 and 0.15.1 distinct and unknown versions conservative", async () => {
  const known = new TypstClientImpl(discovered(), {});
  known.run = async (args) => result(args, "Typst 0.15.0");
  const knownSupport = await known.support();
  assert.equal(knownSupport.apiVersion, packageVersion);
  assert.equal(knownSupport.level, "partial");
  const hasSweepEvidence =
    (process.platform === "win32" && process.arch === "x64") ||
    (process.platform === "linux" &&
      (process.arch === "x64" || process.arch === "arm64")) ||
    (process.platform === "darwin" && process.arch === "arm64");
  assert.equal(knownSupport.tested, hasSweepEvidence);
  assert.equal(
    knownSupport.coverage.fullySupportedThrough,
    hasSweepEvidence ? "0.15.1" : null,
  );
  assert.equal(knownSupport.coverage.supportByVersion["0.15.0"], "partial");
  assert.equal(knownSupport.coverage.supportByVersion["0.15.1"], "partial");
  assert.deepEqual(
    knownSupport.coverage.testedVersions,
    hasSweepEvidence ? knownSupport.coverage.knownVersions : [],
  );

  const unknown = new TypstClientImpl(discovered(), {});
  unknown.run = async (args) => result(args, "Typst 0.16.0");
  const unknownSupport = await unknown.support();
  assert.equal(unknownSupport.level, "unknown");
  assert.equal(unknownSupport.tested, false);
});

test("capabilities retain exact boundaries, blocked/experimental states, and opt-in probe evidence", async () => {
  const old = new TypstClientImpl(discovered(), {});
  old.run = async (args) => result(args, "Typst 0.15.0");
  const oldCaps = await old.capabilities();
  assert.equal(oldCaps.commands.eval.state, "supported");
  assert.equal(oldCaps.commands.eval.behaviorChanges[0].version, "0.15.1");
  assert.equal(oldCaps.commands.update.state, "unsupported");
  assert.equal(oldCaps.formats.bundle.state, "experimental");

  const before = new TypstClientImpl(discovered(), {});
  before.run = async (args) => result(args, "Typst 0.14.2");
  assert.equal(
    (await before.capabilities()).commands.eval.state,
    "unsupported",
  );

  const unknown = new TypstClientImpl(discovered(), {});
  let calls = 0;
  unknown.run = async (args) => {
    calls += 1;
    return args[0] === "--version"
      ? result(args, "Typst 0.16.0")
      : result(args, "help stdout", 7, "help stderr");
  };
  const caps = await unknown.capabilities({ probe: true });
  assert.equal(calls, 2);
  assert.equal(caps.level, "unknown");
  assert.equal(caps.commands.compile.state, "unknown");
  assert.equal(caps.evidence.probe.stdout.toString(), "help stdout");
  assert.equal(caps.evidence.probe.stderr.toString(), "help stderr");
  assert.equal(caps.evidence.probe.exitCode, 7);
  assert.equal(caps.evidence.probe.signal, null);
  assert.equal(caps.evidence.registry.status, "verified");
  assert.equal(
    (await unknown.capabilities()).evidence.probe.stdout.toString(),
    "help stdout",
  );
});

test("capabilities evidence names the verification host explicitly", async () => {
  const typst = new TypstClientImpl(discovered(), {});
  typst.run = async (args) => {
    if (args[0] === "--version") return result(args, "Typst 0.15.1");
    return result(args, "[]");
  };
  const caps = await typst.capabilities();
  const registry = caps.evidence.registry;
  assert.ok(registry !== undefined);
  // The evidence fields describe where the registry was verified, not the
  // consumer's current host, and the naming makes that explicit.
  assert.equal(typeof registry.verifiedOnPlatform, "string");
  assert.equal(typeof registry.verifiedOnArch, "string");
  assert.equal("milestone" in registry, false);
});

test("client run forwards stdio destinations", async () => {
  const client = new TypstClientImpl(discovered(), {});
  const result = await client.run(["-e", 'process.stdout.write("hidden")'], {
    stdio: { stdout: "ignore" },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 0);
});

test("client run layers call environment over the discovered effective environment", async () => {
  const base = discovered({
    TYPST_API_BASE: "base",
    TYPST_API_REMOVE: "remove",
  });
  const client = new TypstClientImpl(base, {});
  const child = await client.run(
    [
      "-e",
      "process.stdout.write(JSON.stringify({base:process.env.TYPST_API_BASE, removed:process.env.TYPST_API_REMOVE, call:process.env.TYPST_API_CALL}))",
    ],
    { env: { TYPST_API_CALL: "call", TYPST_API_REMOVE: undefined } },
  );
  assert.deepEqual(JSON.parse(child.stdout), {
    base: "base",
    call: "call",
  });

  const replaced = await client.run(
    [
      "-e",
      "process.stdout.write(JSON.stringify({base:process.env.TYPST_API_BASE ?? null, removed:process.env.TYPST_API_REMOVE ?? null, call:process.env.TYPST_API_CALL ?? null}))",
    ],
    { envMode: "replace", env: { TYPST_API_CALL: "replacement" } },
  );
  assert.deepEqual(JSON.parse(replaced.stdout), {
    base: null,
    removed: null,
    call: "replacement",
  });
});
