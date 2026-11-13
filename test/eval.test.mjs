import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  TypstEvalError,
  TypstEvalParseError,
  TypstInvalidArgumentError,
  UnsupportedTypstFeatureError,
  UnsupportedTypstVersionError,
} from "../dist/index.js";
import { result, client, node } from "./helpers/mock-typst.mjs";

test("eval serializes the expression as a single positional argument", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, "2");
  });
  const outcome = await typst.eval("1 + 1");
  assert.deepEqual(seen[0], ["eval", "1 + 1"]);
  assert.equal(outcome.value, 2);
  assert.equal(outcome.raw, "2");
  assert.equal(outcome.format, "json");
  assert.equal(outcome.compilerVersion, "0.15.1");
});

test("eval shields a leading-hyphen expression with the -- separator", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, "-1");
  });
  const outcome = await typst.eval("-1");
  assert.deepEqual(seen[0], ["eval", "--", "-1"]);
  assert.equal(outcome.value, -1);
});

test("eval decodes JSON including null and structured values", async () => {
  const json = client("0.15.1", (args) =>
    result(args, '{"a":1,"b":[true,null]}'),
  );
  const structured = await json.eval("(a: 1, b: (true, none))");
  assert.deepEqual(structured.value, { a: 1, b: [true, null] });

  const none = client("0.15.1", (args) => result(args, "null"));
  const nullValue = await none.eval("none");
  assert.equal(nullValue.value, null);
});

test("eval returns raw text without decoding for yaml", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, "- 1\n- 2\n- 3\n");
  });
  const outcome = await typst.eval("(1, 2, 3)", { format: "yaml" });
  assert.deepEqual(seen[0], ["eval", "(1, 2, 3)", "--format", "yaml"]);
  assert.equal(outcome.format, "yaml");
  assert.equal(outcome.raw, "- 1\n- 2\n- 3\n");
  assert.equal("value" in outcome, false);
});

test("eval stages a context file through --in and stdin for source input", async () => {
  const seen = [];
  const typst = client("0.15.1", (args, options) => {
    seen.push({ args, options });
    return result(args, "[]");
  });
  await typst.eval("query(heading)", {
    input: { kind: "source", data: "= Hello" },
  });
  assert.deepEqual(seen[0].args.slice(0, 5), [
    "eval",
    "query(heading)",
    "--in",
    "-",
  ]);
  assert.equal(seen[0].options.stdin, "= Hello");

  const seenFile = [];
  const fileTypst = client("0.15.1", (args) => {
    seenFile.push(args);
    return result(args, "[]");
  });
  await fileTypst.eval("query(heading)", {
    input: { kind: "file", path: "document.typ" },
  });
  assert.deepEqual(seenFile[0], [
    "eval",
    "query(heading)",
    "--in",
    "document.typ",
  ]);
});

test("eval accepts a string input as a file path shorthand", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, "[]");
  });
  await typst.eval("query(heading)", { input: "document.typ" });
  assert.deepEqual(seen[0], ["eval", "query(heading)", "--in", "document.typ"]);
});

test("eval serializes version-gated options", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, "{}");
  });
  await typst.eval("(a: 1)", {
    input: { kind: "file", path: "document.typ" },
    target: "html",
    format: "json",
    pretty: true,
    root: "proj",
    inputs: { kind: "book" },
    fontPaths: ["fonts"],
    ignoreSystemFonts: true,
    ignoreEmbeddedFonts: true,
    packagePath: "pkgs",
    packageCachePath: "cache",
    creationTimestamp: 1_700_000_000,
    jobs: 2,
    features: ["html"],
  });
  assert.deepEqual(seen[0], [
    "eval",
    "(a: 1)",
    "--in",
    "document.typ",
    "--target",
    "html",
    "--format",
    "json",
    "--pretty",
    "--root",
    "proj",
    "--font-path",
    "fonts",
    "--ignore-system-fonts",
    "--ignore-embedded-fonts",
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
  ]);
});

test("eval gates the command at exact 0.15.0", async () => {
  const before = client("0.14.2", () => result(["eval"], "2"));
  await assert.rejects(
    before.eval("1 + 1"),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "eval" &&
      error.requiredVersion === "0.15.0" &&
      error.actualVersion === "0.14.2",
  );
  const at = client("0.15.0", (args) => result(args, "2"));
  const outcome = await at.eval("1 + 1");
  assert.equal(outcome.value, 2);
});

test("eval treats the 0.15.0 exit-0 failure as an eval error", async () => {
  const stderr = "error: unknown variable: nope\n";
  const old = client("0.15.0", (args) => result(args, "", 0, stderr));
  await assert.rejects(
    old.eval("does-not-exist"),
    (error) =>
      error instanceof TypstEvalError &&
      error.code === "ERR_TYPST_EVAL" &&
      error.compilerVersion === "0.15.0" &&
      error.process.exitCode === 0 &&
      error.process.stderr.toString("utf8") === stderr,
  );
});

test("eval throws a typed error for unsuccessful exits from 0.15.1", async () => {
  const stderr = "error: unknown variable: nope\n";
  const typst = client("0.15.1", (args) => result(args, "", 1, stderr));
  await assert.rejects(
    typst.eval("does-not-exist"),
    (error) =>
      error instanceof TypstEvalError &&
      error.code === "ERR_TYPST_EVAL" &&
      error.compilerVersion === "0.15.1" &&
      error.process.exitCode === 1 &&
      error.process.stderr.toString("utf8") === stderr,
  );
});

test("eval throws a parse error for undecodable JSON with raw output", async () => {
  const typst = client("0.15.1", (args) => result(args, "not json"));
  await assert.rejects(
    typst.eval("nope"),
    (error) =>
      error instanceof TypstEvalParseError &&
      error.code === "ERR_TYPST_EVAL_PARSE" &&
      error.rawOutput === "not json" &&
      error.process.stdout.toString("utf8") === "not json",
  );
});

test("eval rejects unknown future versions before spawn", async () => {
  const unknown = client("0.16.0", () => result(["eval"], "2"));
  await assert.rejects(
    unknown.eval("1 + 1"),
    (error) =>
      error instanceof UnsupportedTypstVersionError &&
      error.actualVersion === "0.16.0",
  );
});

test("eval implies the feature flag of an html or bundle target", async () => {
  for (const target of ["html", "bundle"]) {
    let seen;
    const typst = client("0.15.1", (args) => {
      seen = args;
      return result(args, "2");
    });
    await typst.eval("1 + 1", { target });
    assert.equal(seen[seen.indexOf("--features") + 1], target);
    // An explicit flag is not duplicated.
    await typst.eval("1 + 1", { target, features: [target] });
    assert.equal(seen.filter((arg) => arg === target).length, 2);
  }
});

test("eval accepts the font ignore flags on every eval-eligible version", async () => {
  for (const version of ["0.15.0", "0.15.1"]) {
    const seen = [];
    const typst = client(version, (args) => {
      seen.push(args);
      return result(args, "{}");
    });
    await typst.eval("none", {
      input: { kind: "file", path: "document.typ" },
      ignoreSystemFonts: true,
      ignoreEmbeddedFonts: true,
    });
    assert.equal(seen[0].includes("--ignore-system-fonts"), true);
    assert.equal(seen[0].includes("--ignore-embedded-fonts"), true);
  }
});

test("eval rejects malformed options before spawn", async () => {
  for (const options of [
    null,
    [],
    "eval",
    { format: "xml" },
    { target: "web" },
    { pretty: "yes" },
    { root: "" },
    { input: { kind: "file", path: "" } },
    { input: { kind: "source", data: 42 } },
    { fontPaths: "fonts" },
    { features: [""] },
    { jobs: 0 },
    { inputs: [] },
    { creationTimestamp: Number.NaN },
    { ignoreSystemFonts: 1 },
  ]) {
    const typst = client("0.15.1", () => result(["eval"], "2"));
    await assert.rejects(
      typst.eval("1 + 1", options),
      TypstInvalidArgumentError,
      JSON.stringify(options),
    );
  }
  const empty = client("0.15.1", () => result(["eval"], "2"));
  await assert.rejects(empty.eval(""), TypstInvalidArgumentError);
});

test("eval temp source files are cleaned up after the run", async () => {
  let inputPath;
  const legacy = client("0.15.0", (args) => {
    inputPath = args.at(-2);
    return result(args, "2");
  });
  await legacy.eval("1 + 1", {
    input: { kind: "source", data: "= hello", virtualPath: "docs/main.typ" },
  });
  assert.equal(existsSync(inputPath), false);
});
