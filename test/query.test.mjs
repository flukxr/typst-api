import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import test from "node:test";

import {
  TypstInvalidArgumentError,
  TypstQueryError,
  TypstQueryParseError,
  UnsupportedTypstFeatureError,
  UnsupportedTypstVersionError,
} from "../dist/index.js";
import { result, client, node } from "./helpers/mock-typst.mjs";

const HEADINGS_JSON = JSON.stringify([
  { func: "heading", level: 1 },
  { func: "heading", level: 2 },
]);

test("query serializes selector and input as separate arguments", async () => {
  const seen = [];
  const typst = client("0.14.2", (args) => {
    seen.push(args);
    return result(args, HEADINGS_JSON);
  });
  const outcome = await typst.query({
    input: { kind: "file", path: "document.typ" },
    selector: "heading",
  });
  assert.deepEqual(seen[0], ["query", "document.typ", "heading"]);
  assert.deepEqual(outcome.elements, [
    { func: "heading", level: 1 },
    { func: "heading", level: 2 },
  ]);
  assert.equal(outcome.raw, HEADINGS_JSON);
  assert.equal(outcome.compilerVersion, "0.14.2");
});

test("query accepts a string input as a file path shorthand", async () => {
  const native = [];
  const typst = client("0.14.2", (args) => {
    native.push(args);
    return result(args, HEADINGS_JSON);
  });
  await typst.query({ input: "document.typ", selector: "heading" });
  assert.deepEqual(native[0], ["query", "document.typ", "heading"]);

  const evalRoute = [];
  const modern = client("0.15.1", (args) => {
    evalRoute.push(args);
    return result(args, "[]");
  });
  await modern.query({ input: "document.typ", selector: "heading" });
  assert.deepEqual(evalRoute[0], [
    "eval",
    "query(heading)",
    "--in",
    "document.typ",
  ]);
});

test("queryOne adds --one and returns the single element", async () => {
  const seen = [];
  const typst = client("0.14.2", (args) => {
    seen.push(args);
    return result(args, '{"func":"metadata","value":"title"}');
  });
  const outcome = await typst.queryOne({
    input: { kind: "file", path: "document.typ" },
    selector: "<document-title>",
  });
  assert.deepEqual(seen[0], [
    "query",
    "document.typ",
    "<document-title>",
    "--one",
  ]);
  assert.deepEqual(outcome.element, { func: "metadata", value: "title" });
});

test("query gates the command at the exact 0.7.0 boundary", async () => {
  const before = client("0.6.0", () => result(["query"], HEADINGS_JSON));
  await assert.rejects(
    before.query({
      input: { kind: "file", path: "document.typ" },
      selector: "heading",
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "query" &&
      error.requiredVersion === "0.7.0",
  );

  const at = client("0.7.0", (args) => result(args, HEADINGS_JSON));
  const outcome = await at.query({
    input: { kind: "file", path: "document.typ" },
    selector: "heading",
  });
  assert.equal(outcome.elements.length, 2);
});

test("query routes 0.15.0+ through eval with equivalent results", async () => {
  const seen = [];
  const modern = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, HEADINGS_JSON);
  });
  const outcome = await modern.query({
    input: { kind: "file", path: "document.typ" },
    selector: "heading",
  });
  assert.deepEqual(seen[0], ["eval", "query(heading)", "--in", "document.typ"]);
  assert.deepEqual(outcome.elements, [
    { func: "heading", level: 1 },
    { func: "heading", level: 2 },
  ]);
  assert.equal(outcome.compilerVersion, "0.15.1");

  const oneSeen = [];
  const oneTypst = client("0.15.1", (args) => {
    oneSeen.push(args);
    return result(args, '[{"func":"metadata","value":"title"}]');
  });
  const one = await oneTypst.queryOne({
    input: { kind: "file", path: "document.typ" },
    selector: "<document-title>",
  });
  assert.deepEqual(oneSeen[0], [
    "eval",
    "query(<document-title>)",
    "--in",
    "document.typ",
  ]);
  assert.deepEqual(one.element, { func: "metadata", value: "title" });
});

test("queryOne via eval rejects when the result is not exactly one element", async () => {
  const modern = client("0.15.1", (args) => result(args, HEADINGS_JSON));
  await assert.rejects(
    modern.queryOne({
      input: { kind: "file", path: "document.typ" },
      selector: "heading",
    }),
    (error) =>
      error instanceof TypstQueryError &&
      error.code === "ERR_TYPST_QUERY" &&
      error.compilerVersion === "0.15.1" &&
      error.message.includes("expected exactly one element, found 2"),
  );
});

test("query via eval normalises field extraction in JavaScript", async () => {
  const seen = [];
  const modern = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, HEADINGS_JSON);
  });
  const outcome = await modern.query({
    input: { kind: "file", path: "document.typ" },
    selector: "heading",
    field: "level",
  });
  // The field is not passed to the compiler; it is extracted in JavaScript.
  assert.equal(seen[0].includes("--field"), false);
  assert.deepEqual(outcome.elements, [1, 2]);
});

test("query via eval handles the 0.15.0 exit-0 failure transition", async () => {
  const stderr = "error: unknown variable: nope\n  ┌─ <input-expression>:1:0\n";
  // 0.15.0 exits 0 with empty stdout on a failed evaluation.
  const old = client("0.15.0", (args) => result(args, "", 0, stderr));
  await assert.rejects(
    old.query({
      input: { kind: "file", path: "document.typ" },
      selector: "does-not-exist",
    }),
    (error) =>
      error instanceof TypstQueryError &&
      error.code === "ERR_TYPST_QUERY" &&
      error.compilerVersion === "0.15.0" &&
      error.process.exitCode === 0 &&
      error.process.stderr.toString("utf8") === stderr,
  );
  // 0.15.1 exits 1 and keeps the same raw evidence.
  const fixed = client("0.15.1", (args) => result(args, "", 1, stderr));
  await assert.rejects(
    fixed.query({
      input: { kind: "file", path: "document.typ" },
      selector: "does-not-exist",
    }),
    (error) =>
      error instanceof TypstQueryError &&
      error.process.exitCode === 1 &&
      error.process.stderr.toString("utf8") === stderr,
  );
});

test("query via eval serializes version-gated options on the eval command", async () => {
  const seen = [];
  const modern = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, "[]");
  });
  await modern.query({
    input: { kind: "file", path: "document.typ" },
    selector: "heading",
    root: "proj",
    inputs: { kind: "book" },
    fontPaths: ["fonts"],
    packagePath: "pkgs",
    packageCachePath: "cache",
    creationTimestamp: 1_700_000_000,
    jobs: 2,
    features: ["html"],
    target: "html",
    pretty: true,
  });
  assert.deepEqual(seen[0], [
    "eval",
    "query(heading)",
    "--in",
    "document.typ",
    "--root",
    "proj",
    "--font-path",
    "fonts",
    "--input",
    "kind=book",
    "--package-path",
    "pkgs",
    "--package-cache-path",
    "cache",
    "--creation-timestamp",
    "1700000000",
    "--jobs",
    "2",
    "--features",
    "html",
    "--target",
    "html",
    "--pretty",
  ]);
});

test("query gates the bundle target at exact 0.15.0 on the eval route", async () => {
  const before = client("0.14.2", () => result(["query"], "[]"));
  await assert.rejects(
    before.query({
      input: { kind: "file", path: "document.typ" },
      selector: "heading",
      target: "bundle",
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "target-bundle" &&
      error.requiredVersion === "0.15.0",
  );
  const at = client("0.15.0", (args) => result(args, "[]"));
  await at.query({
    input: { kind: "file", path: "document.typ" },
    selector: "heading",
    target: "bundle",
    features: ["bundle"],
  });
});

test("query uses stdin for source input from 0.11.0 and temp files before", async () => {
  const seen = [];
  let inputPath;
  const modern = client("0.11.0", (args, options) => {
    seen.push(args);
    inputPath = args.at(-2);
    return result(args, "[]");
  });
  await modern.query({
    input: { kind: "source", data: "= hello" },
    selector: "heading",
  });
  assert.equal(inputPath, "-");
  assert.equal(seen[0].at(-2), "-");
  assert.equal(seen[0].at(-1), "heading");

  const legacy = client("0.10.0", (args) => {
    seen.push(args);
    return result(args, "[]");
  });
  await legacy.query({
    input: { kind: "source", data: "= hello" },
    selector: "heading",
  });
  assert.notEqual(seen[1].at(-2), "-");
  assert.equal(existsSync(seen[1].at(-2)), false);
});

test("query serializes version-gated options", async () => {
  const seen = [];
  const typst = client("0.14.2", (args) => {
    seen.push(args);
    return result(args, HEADINGS_JSON);
  });
  await typst.query({
    input: { kind: "file", path: "document.typ" },
    selector: "heading",
    root: "proj",
    inputs: { kind: "book" },
    fontPaths: ["fonts"],
    packagePath: "pkgs",
    packageCachePath: "cache",
    creationTimestamp: 1_700_000_000,
    jobs: 2,
    features: ["html"],
    target: "paged",
    field: "level",
    pretty: true,
  });
  assert.deepEqual(seen[0], [
    "query",
    "--root",
    "proj",
    "--font-path",
    "fonts",
    "--input",
    "kind=book",
    "--package-path",
    "pkgs",
    "--package-cache-path",
    "cache",
    "--creation-timestamp",
    "1700000000",
    "--jobs",
    "2",
    "--features",
    "html",
    "--target",
    "paged",
    "--field",
    "level",
    "--pretty",
    "document.typ",
    "heading",
  ]);
});

test("query gates inputs at 0.11.0, package/jobs at 0.12.0, features at 0.13.0, target at 0.14.0", async () => {
  const input = { kind: "file", path: "document.typ" };
  const selector = "heading";

  const gated = [
    ["0.10.0", { inputs: { a: "b" } }, "inputs", "0.11.0"],
    ["0.11.1", { packagePath: "pkgs" }, "packagePath", "0.12.0"],
    ["0.11.1", { packageCachePath: "c" }, "packageCachePath", "0.12.0"],
    ["0.11.1", { jobs: 2 }, "jobs", "0.12.0"],
    ["0.12.0", { features: ["html"] }, "features", "0.13.0"],
    ["0.13.1", { target: "paged" }, "target", "0.14.0"],
  ];
  for (const [version, options, feature, required] of gated) {
    const typst = client(version, () => result(["query"], "[]"));
    await assert.rejects(
      typst.query({ input, selector, ...options }),
      (error) =>
        error instanceof UnsupportedTypstFeatureError &&
        error.feature === feature &&
        error.requiredVersion === required &&
        error.actualVersion === version,
      `${version} ${feature}`,
    );
  }

  const boundary = client("0.14.0", (args) => result(args, HEADINGS_JSON));
  const outcome = await boundary.query({
    input,
    selector,
    target: "html",
    features: ["html"],
  });
  assert.equal(outcome.elements.length, 2);
});

test("query gates creationTimestamp at exact 0.12.0", async () => {
  const before = client("0.11.1", () => result(["query"], "[]"));
  await assert.rejects(
    before.query({
      input: { kind: "file", path: "document.typ" },
      selector: "heading",
      creationTimestamp: 1_700_000_000,
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.requiredVersion === "0.12.0",
  );
  const at = client("0.12.0", (args) => result(args, "[]"));
  await at.query({
    input: { kind: "file", path: "document.typ" },
    selector: "heading",
    creationTimestamp: new Date(1_700_000_000_000),
  });
});

test("query throws a typed error for unsuccessful exits with raw evidence", async () => {
  const stderr = "error: expected exactly one element, found 2\n";
  const typst = client("0.14.2", (args) => result(args, "", 1, stderr));
  await assert.rejects(
    typst.queryOne({
      input: { kind: "file", path: "document.typ" },
      selector: "heading",
    }),
    (error) =>
      error instanceof TypstQueryError &&
      error.code === "ERR_TYPST_QUERY" &&
      error.compilerVersion === "0.14.2" &&
      error.process.exitCode === 1 &&
      error.process.stderr.toString("utf8") === stderr,
  );
});

test("query throws a parse error with raw output for undecodable JSON", async () => {
  const typst = client("0.14.2", () => result(["query"], "not json"));
  await assert.rejects(
    typst.query({
      input: { kind: "file", path: "document.typ" },
      selector: "heading",
    }),
    (error) =>
      error instanceof TypstQueryParseError &&
      error.code === "ERR_TYPST_QUERY_PARSE" &&
      error.rawOutput === "not json" &&
      error.process.stdout.toString("utf8") === "not json",
  );
});

test("query throws a parse error when the successful output is not an array", async () => {
  const typst = client("0.14.2", () => result(["query"], '{"func":"heading"}'));
  await assert.rejects(
    typst.query({
      input: { kind: "file", path: "document.typ" },
      selector: "heading",
    }),
    (error) =>
      error instanceof TypstQueryParseError &&
      error.message.includes("not a JSON array"),
  );
});

test("queryOne accepts a single non-array JSON value", async () => {
  const typst = client("0.14.2", () => result(["query"], "42"));
  const outcome = await typst.queryOne({
    input: { kind: "file", path: "document.typ" },
    selector: "<count>",
  });
  assert.equal(outcome.element, 42);
});

test("query rejects unknown future versions before spawn", async () => {
  const unknown = client("0.16.0", () => result(["query"], "[]"));
  await assert.rejects(
    unknown.query({
      input: { kind: "file", path: "document.typ" },
      selector: "heading",
    }),
    (error) =>
      error instanceof UnsupportedTypstVersionError &&
      error.actualVersion === "0.16.0",
  );
});

test("query rejects malformed options before spawn", async () => {
  const base = {
    input: { kind: "file", path: "document.typ" },
    selector: "heading",
  };
  for (const options of [
    null,
    [],
    "query",
    { ...base, input: { kind: "file", path: "" } },
    { ...base, input: { kind: "source", data: 42 } },
    { ...base, selector: "" },
    { ...base, selector: 42 },
    { ...base, fontPaths: "fonts" },
    { ...base, features: [""] },
    { ...base, target: "html2" },
    { ...base, jobs: 0 },
    { ...base, pretty: "yes" },
    { ...base, inputs: [] },
    { ...base, field: "" },
  ]) {
    const typst = client("0.14.2", () => result(["query"], "[]"));
    await assert.rejects(
      typst.query(options),
      TypstInvalidArgumentError,
      JSON.stringify(options),
    );
  }
});

test("query temp source files are cleaned up after the run", async () => {
  let inputPath;
  const typst = client("0.10.0", (args) => {
    inputPath = args.at(-2);
    writeFileSync(inputPath, "kept");
    return result(args, "[]");
  });
  await typst.query({
    input: { kind: "source", data: "= hello" },
    selector: "heading",
  });
  assert.equal(existsSync(inputPath), false);
});
