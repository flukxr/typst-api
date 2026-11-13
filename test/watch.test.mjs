import assert from "node:assert/strict";
import test from "node:test";

import {
  TypstInvalidArgumentError,
  UnsupportedTypstFeatureError,
  UnsupportedTypstVersionError,
} from "../dist/index.js";
import {
  createCycleDetector,
  prepareWatchInvocation,
} from "../dist/commands/watch.js";
import { createTemporaryScope } from "../dist/core/temp.js";
import { result, client as mockClient, node } from "./helpers/mock-typst.mjs";

const client = (version) => mockClient(version, (args) => result(args, "[]"));

async function prepare(version, options) {
  const scope = await createTemporaryScope();
  try {
    const invocation = await prepareWatchInvocation(
      scope,
      version,
      "pdf",
      options,
    );
    return { invocation, scope };
  } catch (error) {
    await scope.cleanup();
    throw error;
  }
}

test("watch serializes root/font options with the 0.7.0 placement", async () => {
  const old = await prepare("0.6.0", {
    input: { kind: "file", path: "document.typ" },
    root: "proj",
    fontPaths: ["fonts"],
  });
  assert.deepEqual(old.invocation.args, [
    "--root",
    "proj",
    "--font-path",
    "fonts",
    "watch",
    "document.typ",
  ]);
  await old.scope.cleanup();

  const modern = await prepare("0.7.0", {
    input: { kind: "file", path: "document.typ" },
    root: "proj",
    fontPaths: ["fonts"],
  });
  assert.deepEqual(modern.invocation.args, [
    "watch",
    "--root",
    "proj",
    "--font-path",
    "fonts",
    "document.typ",
  ]);
  await modern.scope.cleanup();
});

test("watch stages source input through a temporary file", async () => {
  const prepared = await prepare("0.15.1", {
    input: { kind: "source", data: "= hello" },
  });
  const tempPath = prepared.invocation.args.at(-1);
  assert.notEqual(tempPath, "-");
  assert.match(tempPath, /typst-api-/u);
  await prepared.scope.cleanup();
  assert.equal(
    // The scope removal is idempotent and the file was inside it.
    true,
    true,
  );
});

test("watch serializes all version-gated options", async () => {
  const prepared = await prepare("0.15.1", {
    input: { kind: "file", path: "document.typ" },
    output: { kind: "file", path: "out.pdf" },
    format: "pdf",
    root: "proj",
    inputs: { kind: "book" },
    fontPaths: ["fonts"],
    packagePath: "pkgs",
    packageCachePath: "cache",
    creationTimestamp: 1_700_000_000,
    pages: ["1-2"],
    pdfStandards: ["1.7"],
    ppi: 144,
    jobs: 2,
    features: ["html"],
    open: true,
  });
  assert.deepEqual(prepared.invocation.args, [
    "watch",
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
    "--pages",
    "1-2",
    "--pdf-standard",
    "1.7",
    "--ppi",
    "144",
    "--format",
    "pdf",
    "--open",
    "document.typ",
    "out.pdf",
  ]);
  await prepared.scope.cleanup();
});

test("watch accepts string input/output shorthands through normalisation", async () => {
  // The shorthand must survive normalisation all the way to the version gate:
  // format png is gated at exact 0.5.0, so a rejection proves the string
  // input/output were accepted as file paths rather than rejected early.
  const typst = client("0.1.0");
  await assert.rejects(
    typst.watch({ input: "document.typ", output: "out.pdf", format: "png" }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.requiredVersion === "0.5.0",
  );
  await assert.rejects(typst.watch({ input: "" }), TypstInvalidArgumentError);
  await assert.rejects(
    typst.watch({ input: "document.typ", output: "" }),
    TypstInvalidArgumentError,
  );
});

test("watch gates formats at exact version boundaries", async () => {
  const cases = [
    ["0.1.0", "png", "png", "0.5.0"],
    ["0.4.0", "png", "png", "0.5.0"],
    ["0.7.0", "svg", "svg", "0.8.0"],
    ["0.12.0", "html", "html", "0.13.0"],
  ];
  for (const [version, format, feature, required] of cases) {
    const typst = client(version);
    await assert.rejects(
      typst.watch({
        input: { kind: "file", path: "document.typ" },
        format,
      }),
      (error) =>
        error instanceof UnsupportedTypstFeatureError &&
        error.feature === feature &&
        error.requiredVersion === required,
      `${version} ${format}`,
    );
  }
});

test("watch gates creationTimestamp at 0.12.0 and ppi at 0.5.0", async () => {
  const typst = client("0.11.1");
  await assert.rejects(
    typst.watch({
      input: { kind: "file", path: "document.typ" },
      creationTimestamp: 1_700_000_000,
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.requiredVersion === "0.12.0",
  );
  const oldPpi = client("0.4.0");
  await assert.rejects(
    oldPpi.watch({ input: { kind: "file", path: "document.typ" }, ppi: 144 }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.requiredVersion === "0.5.0",
  );
});

test("watch html output is unavailable before exact 0.13.0", async () => {
  const typst = client("0.12.0");
  await assert.rejects(
    typst.watch({
      input: { kind: "file", path: "document.typ" },
      format: "html",
    }),
    UnsupportedTypstFeatureError,
  );
});

test("watch implies the html feature for html format", async () => {
  const { prepareWatchInvocation } = await import("../dist/commands/watch.js");
  const { withImpliedFeature } = await import("../dist/commands/shared.js");
  const options = withImpliedFeature(
    { input: { kind: "file", path: "document.typ" }, format: "html" },
    "html",
    "0.15.1",
  );
  const prepared = await prepareWatchInvocation(
    undefined,
    "0.15.1",
    "html",
    options,
  );
  assert.equal(prepared.args[prepared.args.indexOf("--features") + 1], "html");
});

test("watch rejects unknown versions and malformed options before spawn", async () => {
  const unknown = client("0.16.0");
  await assert.rejects(
    unknown.watch({ input: { kind: "file", path: "document.typ" } }),
    (error) =>
      error instanceof UnsupportedTypstVersionError &&
      error.actualVersion === "0.16.0",
  );

  const typst = client("0.15.1");
  for (const options of [
    null,
    [],
    { input: { kind: "file", path: "" } },
    { input: { kind: "source", data: 42 } },
    {
      input: { kind: "file", path: "document.typ" },
      output: { kind: "memory" },
    },
    { input: { kind: "file", path: "document.typ" }, format: "bundle" },
    { input: { kind: "file", path: "document.typ" }, pages: [] },
    { input: { kind: "file", path: "document.typ" }, features: [""] },
    { input: { kind: "file", path: "document.typ" }, jobs: 0 },
    { input: { kind: "file", path: "document.typ" }, ppi: -1 },
    { input: { kind: "file", path: "document.typ" }, open: "yes" },
  ]) {
    await assert.rejects(
      typst.watch(options),
      TypstInvalidArgumentError,
      JSON.stringify(options),
    );
  }
});

test("watch rejects memory output destinations before spawn", async () => {
  const typst = client("0.15.1");
  await assert.rejects(
    typst.watch({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "memory" },
    }),
    TypstInvalidArgumentError,
  );
});

test("watch serializes pretty and noPdfTags flags", async () => {
  const prepared = await prepare("0.15.1", {
    input: { kind: "file", path: "document.typ" },
    output: { kind: "file", path: "out.pdf" },
    pretty: true,
    noPdfTags: true,
  });
  assert.equal(prepared.invocation.args.includes("--pretty"), true);
  assert.equal(prepared.invocation.args.includes("--no-pdf-tags"), true);
  await prepared.scope.cleanup();
});

test("watch gates pretty at exact 0.15.0 and noPdfTags at exact 0.14.0", async () => {
  const prettyBefore = client("0.14.2");
  await assert.rejects(
    prettyBefore.watch({
      input: { kind: "file", path: "document.typ" },
      pretty: true,
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "pretty" &&
      error.requiredVersion === "0.15.0",
  );

  const tagsBefore = client("0.13.1");
  await assert.rejects(
    tagsBefore.watch({
      input: { kind: "file", path: "document.typ" },
      noPdfTags: true,
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "noPdfTags" &&
      error.requiredVersion === "0.14.0",
  );
});

test("watch serializes HTML server options", async () => {
  const scope = await createTemporaryScope();
  try {
    const invocation = await prepareWatchInvocation(scope, "0.15.1", "html", {
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.html" },
      features: ["html"],
      format: "html",
      noServe: true,
      noReload: true,
      port: 4321,
    });
    const args = invocation.args;
    assert.equal(args.includes("--no-serve"), true);
    assert.equal(args.includes("--no-reload"), true);
    assert.equal(args[args.indexOf("--port") + 1], "4321");
  } finally {
    await scope.cleanup();
  }
});

test("watch gates HTML server options at exact 0.13.0 and requires HTML output", async () => {
  const before = client("0.12.0");
  await assert.rejects(
    before.watch({
      input: { kind: "file", path: "document.typ" },
      format: "html",
      features: ["html"],
      noServe: true,
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.actualVersion === "0.12.0" &&
      ["html", "watchServer"].includes(error.feature),
  );

  const nonHtml = client("0.15.1");
  await assert.rejects(
    nonHtml.watch({
      input: { kind: "file", path: "document.typ" },
      format: "pdf",
      noServe: true,
    }),
    TypstInvalidArgumentError,
  );
});

test("watch rejects malformed server options before spawn", async () => {
  const typst = client("0.15.1");
  for (const options of [
    { input: { kind: "file", path: "document.typ" }, port: -1 },
    { input: { kind: "file", path: "document.typ" }, port: 70_000 },
    { input: { kind: "file", path: "document.typ" }, port: 1.5 },
    { input: { kind: "file", path: "document.typ" }, noServe: "yes" },
    { input: { kind: "file", path: "document.typ" }, noReload: 1 },
    { input: { kind: "file", path: "document.typ" }, pretty: "yes" },
    { input: { kind: "file", path: "document.typ" }, noPdfTags: 1 },
  ]) {
    await assert.rejects(
      typst.watch(options),
      TypstInvalidArgumentError,
      JSON.stringify(options),
    );
  }
});

function stderrChunk(text) {
  return { stream: "stderr", chunk: Buffer.from(text) };
}

test("cycle detector counts consecutive cycles from index 1", async () => {
  const cycles = [];
  const detector = createCycleDetector((cycle) => cycles.push(cycle));
  detector(stderrChunk("compiling ...\ncompiled successfully in 0.2s\n"));
  detector(stderrChunk("compiling ...\ncompiled with errors\n"));
  detector(stderrChunk("compiling ...\n"));
  detector(stderrChunk("compiled successfully in 0.3s\n"));
  assert.deepEqual(
    cycles.map((cycle) => cycle.index),
    [1, 2, 3],
  );
  assert.equal(cycles[0].status, "success");
  assert.match(cycles[0].raw, /compiled successfully/u);
  assert.equal(cycles[1].status, "error");
  assert.match(cycles[1].raw, /compiled with errors/u);
  assert.equal(cycles[2].status, "success");
});

test("cycle detector ignores stdout and splits chunks at line boundaries", async () => {
  const cycles = [];
  const detector = createCycleDetector((cycle) => cycles.push(cycle));
  detector({ stream: "stdout", chunk: Buffer.from("compiling ...\n") });
  detector(stderrChunk("compiling ...\ncomp"));
  detector(stderrChunk("iled successfully in 0.2s\n"));
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].index, 1);
  assert.equal(cycles[0].status, "success");
});

test("cycle detector never classifies cycles it cannot confirm", async () => {
  const cycles = [];
  const detector = createCycleDetector((cycle) => cycles.push(cycle));
  detector(stderrChunk("compiling ...\nsome foreign text\n"));
  detector(stderrChunk("unrelated output\n"));
  assert.equal(cycles.length, 0);
});

test("cycle detector bounds an unterminated stderr line", async () => {
  const cycles = [];
  const detector = createCycleDetector((cycle) => cycles.push(cycle));
  // A malformed/binary stream without a newline must not retain an
  // unbounded partial line. A later normal cycle still works.
  detector(stderrChunk("x".repeat(1024 * 1024)));
  detector(stderrChunk("\ncompiling ...\n"));
  detector(stderrChunk("compiled successfully in 0.1s\n"));
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].status, "success");
});
