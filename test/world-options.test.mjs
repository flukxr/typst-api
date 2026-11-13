import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";

import {
  TypstInvalidArgumentError,
  UnsupportedTypstFeatureError,
  createTypst,
} from "../dist/index.js";
import { result, client, node } from "./helpers/mock-typst.mjs";

const input = { kind: "file", path: "document.typ" };

/** Run a command with world options and return the spawned arguments. */
async function argsFor(command, version, options) {
  let seen;
  const typst = client(version, (args) => {
    seen = args;
    if (command === "compile") return result(args, "%PDF-");
    return result(args, "[]");
  });
  if (command === "compile") await typst.compile({ input, ...options });
  else await typst.query({ input, selector: "heading", ...options });
  return seen;
}

// Boundaries verified against the real binaries: --ignore-system-fonts is
// absent in 0.11.1 and present in 0.12.0; --ignore-embedded-fonts is absent
// in 0.13.1 and present in 0.14.0, for compile, query and watch.
for (const command of ["compile", "query"]) {
  test(`${command} gates ignoreSystemFonts at exact 0.12.0`, async () => {
    await assert.rejects(
      argsFor(command, "0.11.1", { ignoreSystemFonts: true }),
      (error) =>
        error instanceof UnsupportedTypstFeatureError &&
        error.requiredVersion === "0.12.0",
    );
    const args = await argsFor(command, "0.12.0", { ignoreSystemFonts: true });
    assert.equal(args.includes("--ignore-system-fonts"), true);
  });

  test(`${command} gates ignoreEmbeddedFonts at exact 0.14.0`, async () => {
    await assert.rejects(
      argsFor(command, "0.13.1", { ignoreEmbeddedFonts: true }),
      (error) =>
        error instanceof UnsupportedTypstFeatureError &&
        error.requiredVersion === "0.14.0",
    );
    const args = await argsFor(command, "0.14.0", {
      ignoreEmbeddedFonts: true,
    });
    assert.equal(args.includes("--ignore-embedded-fonts"), true);
  });
}

test("watch serializes both font switches after the subcommand", async () => {
  const { prepareWatchInvocation } = await import("../dist/commands/watch.js");
  const prepared = await prepareWatchInvocation(undefined, "0.14.0", "pdf", {
    input,
    ignoreSystemFonts: true,
    ignoreEmbeddedFonts: true,
  });
  const watchIndex = prepared.args.indexOf("watch");
  assert.ok(prepared.args.indexOf("--ignore-system-fonts") > watchIndex);
  assert.ok(prepared.args.indexOf("--ignore-embedded-fonts") > watchIndex);
});

test("creationTimestamp is seconds and rejects millisecond values", async () => {
  await assert.rejects(
    argsFor("compile", "0.15.1", { creationTimestamp: 1_731_500_000_000 }),
    (error) =>
      error instanceof TypstInvalidArgumentError &&
      /milliseconds/u.test(error.message),
  );
  const seconds = await argsFor("compile", "0.15.1", {
    creationTimestamp: 1_731_500_000,
  });
  assert.equal(
    seconds[seconds.indexOf("--creation-timestamp") + 1],
    "1731500000",
  );
  const date = await argsFor("compile", "0.15.1", {
    creationTimestamp: new Date("2024-11-13T12:00:00.999Z"),
  });
  assert.equal(date[date.indexOf("--creation-timestamp") + 1], "1731499200");
});

test("client defaults layer under command options and merge inputs", async () => {
  let seen;
  const typst = client(
    "0.15.1",
    (args) => {
      seen = args;
      return result(args, "[]");
    },
    {
      defaults: {
        root: "project",
        fontPaths: ["fonts"],
        inputs: { a: "default", b: "default" },
      },
    },
  );
  await typst.query({
    input,
    selector: "heading",
    inputs: { b: "call" },
    fontPaths: ["other"],
  });
  assert.equal(seen[seen.indexOf("--root") + 1], "project");
  assert.equal(seen.includes("fonts"), false);
  assert.equal(seen.includes("other"), true);
  assert.equal(seen.includes("a=default"), true);
  assert.equal(seen.includes("b=call"), true);
  assert.equal(seen.includes("b=default"), false);
});

test("a default root is not applied to a project input", async () => {
  let seen;
  const typst = client(
    "0.15.1",
    (args) => {
      seen = args;
      return result(args, "[]");
    },
    { defaults: { root: "project" } },
  );
  await typst.query({
    input: { kind: "project", files: { "main.typ": "= Hi" } },
    selector: "heading",
  });
  assert.notEqual(seen[seen.indexOf("--root") + 1], "project");
});

test("createTypst validates defaults eagerly", async () => {
  for (const defaults of [
    null,
    [],
    { jobs: 0 },
    { features: [42] },
    { creationTimestamp: Date.now() },
    { ignoreSystemFonts: "yes" },
  ]) {
    await assert.rejects(
      createTypst({ executable: node, defaults }),
      TypstInvalidArgumentError,
    );
  }
});

test("project inputs are validated before spawn", async () => {
  const typst = client("0.15.1", () => {
    throw new Error("must not spawn");
  });
  for (const project of [
    { kind: "project", files: {} },
    { kind: "project", files: { "../escape.typ": "x" } },
    { kind: "project", files: { "/abs.typ": "x" } },
    { kind: "project", files: { "main.typ": 42 } },
    { kind: "project", files: { "other.typ": "x" } },
    { kind: "project", files: { "a.typ": "x" }, main: "b.typ" },
  ]) {
    await assert.rejects(typst.pdf(project), TypstInvalidArgumentError);
  }
  await assert.rejects(
    typst.watch({ input: { kind: "project", files: { "main.typ": "x" } } }),
    (error) =>
      error instanceof TypstInvalidArgumentError &&
      /project inputs are not supported/u.test(error.message),
  );
});

test("format shortcuts reject options that belong to compile()", async () => {
  const typst = client("0.15.1", () => {
    throw new Error("must not spawn");
  });
  for (const key of ["output", "format", "depsPath"]) {
    await assert.rejects(
      typst.pdf(input, { [key]: "x" }),
      (error) =>
        error instanceof TypstInvalidArgumentError &&
        error.message.includes(key),
    );
  }
});

test("format shortcuts unwrap results", async () => {
  const typst = client("0.15.1", (args) => {
    if (args.includes("png")) {
      writeFileSync(args.at(-1).replace("{p}-of-{t}", "1-of-2"), "P1");
      writeFileSync(args.at(-1).replace("{p}-of-{t}", "2-of-2"), "P2");
      return result(args);
    }
    return result(args, "%PDF-1.7");
  });
  const pdf = await typst.pdf(input);
  assert.equal(pdf.toString(), "%PDF-1.7");
  const pages = await typst.png(input, { pages: ["1-2"] });
  assert.deepEqual(
    pages.map((page) => page.toString()),
    ["P1", "P2"],
  );
});
