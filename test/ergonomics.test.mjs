import assert from "node:assert/strict";
import test from "node:test";

import {
  TypstAbortError,
  TypstCompilationError,
  TypstInvalidArgumentError,
  jsonInput,
  source,
} from "../dist/index.js";
import { result, client, node, writeOutput } from "./helpers/mock-typst.mjs";

const WARNING =
  "warning: unknown font family: nope\n" +
  "  ┌─ main.typ:1:17\n" +
  "  │\n" +
  '1 │ #set text(font: "nope")\n' +
  "  │                 ^^^^^^\n";

test("source() builds a frozen source input", () => {
  const input = source("= Hello");
  assert.deepEqual(input, { kind: "source", data: "= Hello" });
  assert.equal(Object.isFrozen(input), true);
  assert.deepEqual(source("x", "doc.typ"), {
    kind: "source",
    data: "x",
    virtualPath: "doc.typ",
  });
  assert.throws(() => source(42), TypstInvalidArgumentError);
});

test("jsonInput() encodes values and rejects what JSON cannot carry", () => {
  assert.equal(
    jsonInput({ total: 3, items: ["a"] }),
    '{"total":3,"items":["a"]}',
  );
  assert.equal(jsonInput("text"), '"text"');
  assert.throws(() => jsonInput(undefined), TypstInvalidArgumentError);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => jsonInput(cyclic), TypstInvalidArgumentError);
});

test("markup passed as a path fails early with a source() hint", async () => {
  const typst = client("0.15.1", () => {
    throw new Error("must not spawn");
  });
  for (const input of [
    "= Hello",
    "#set page(width: 5cm)",
    "line one\nline two",
  ]) {
    await assert.rejects(
      typst.pdf(input),
      (error) =>
        error instanceof TypstInvalidArgumentError &&
        error.message.includes("source("),
    );
  }
  // An ordinary path is passed through to the compiler untouched.
  let seen;
  const ok = client("0.15.1", (args) => {
    seen = args;
    return result(args, "%PDF-");
  });
  await ok.pdf("main.typ");
  assert.equal(seen.includes("main.typ"), true);
});

test("successful results carry parsed warnings", async () => {
  const typst = client("0.15.1", (args) => {
    if (args[0] !== "compile") return result(args, "[]", 0, WARNING);
    return result(args, "%PDF-", 0, WARNING);
  });
  const compiled = await typst.compile({ input: source("x") });
  assert.equal(compiled.warnings.length, 1);
  assert.equal(compiled.warnings[0].severity, "warning");
  assert.match(compiled.warnings[0].message, /unknown font family/u);
  const queried = await typst.query(source("x"), "heading");
  assert.equal(queried.warnings.length, 1);
  const clean = client("0.15.1", (args) => result(args, "%PDF-"));
  assert.deepEqual((await clean.compile({ input: source("x") })).warnings, []);
});

test("query and queryOne accept the positional form", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, '[{"level":1}]');
  });
  await typst.query("doc.typ", "heading", { field: "level" });
  // 0.15.1 routes query through eval: the selector becomes query(heading).
  assert.equal(
    seen[0].some((arg) => arg.includes("heading")),
    true,
  );
  assert.equal(seen[0].includes("doc.typ"), true);
  const one = await typst.queryOne("doc.typ", "heading");
  assert.deepEqual(one.element, { level: 1 });
});

test("eval accepts a single options object", async () => {
  let seen;
  const typst = client("0.15.1", (args) => {
    seen = args;
    return result(args, "2");
  });
  const outcome = await typst.eval({ expression: "1 + 1", pretty: true });
  assert.equal(outcome.value, 2);
  assert.equal(seen.includes("1 + 1"), true);
  assert.equal(seen.includes("--pretty"), true);
});

test("compileMany keeps job order, bounds concurrency and settles failures", async () => {
  let running = 0;
  let peak = 0;
  const typst = client("0.15.1", async (args) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
    const text = args.includes("bad.typ") ? "" : "%PDF-" + args.at(-2);
    return args.includes("bad.typ")
      ? result(args, "", 1, "error: boom")
      : result(args, text);
  });
  const jobs = ["a.typ", "b.typ", "bad.typ", "c.typ", "d.typ"].map((input) => ({
    input,
  }));
  const settled = await typst.compileMany(jobs, { concurrency: 2 });
  assert.equal(peak, 2);
  assert.deepEqual(
    settled.map((item) => item.ok),
    [true, true, false, true, true],
  );
  assert.ok(settled[2].error instanceof TypstCompilationError);
  assert.equal(settled[3].result.outputs[0].data.toString(), "%PDF-c.typ");
  await assert.rejects(
    typst.compileMany(jobs, { concurrency: 0 }),
    TypstInvalidArgumentError,
  );
});

test("compileMany aborts pending jobs through the batch signal", async () => {
  const controller = new AbortController();
  let spawned = 0;
  const typst = client("0.15.1", async (args, options) => {
    spawned += 1;
    controller.abort();
    if (options.signal?.aborted) {
      const { runProcess } = await import("../dist/index.js");
      return await runProcess(node, ["-e", ""], { signal: options.signal });
    }
    return result(args, "%PDF-");
  });
  const settled = await typst.compileMany(
    [{ input: "a.typ" }, { input: "b.typ" }, { input: "c.typ" }],
    { concurrency: 1, signal: controller.signal },
  );
  assert.equal(settled.length, 3);
  for (const item of settled) {
    assert.equal(item.ok, false);
    assert.ok(item.error instanceof TypstAbortError);
  }
  assert.ok(spawned >= 1);
});

test("compile accepts the positional file-to-file form", async () => {
  let seen;
  const typst = client("0.15.1", (args) => {
    seen = args;
    writeOutput(args);
    return result(args);
  });
  const outcome = await typst.compile("main.typ", "out.pdf", { root: "." });
  assert.equal(seen.at(-2), "main.typ");
  assert.equal(seen.at(-1), "out.pdf");
  assert.equal(seen[seen.indexOf("--root") + 1], ".");
  assert.equal(outcome.outputs.length, 1);
  assert.equal(outcome.outputs[0].kind, "file");

  for (const options of [{ input: "x.typ" }, { output: "y.pdf" }]) {
    await assert.rejects(
      typst.compile("main.typ", "out.pdf", options),
      TypstInvalidArgumentError,
    );
  }
  // Options without an output are a mistake, not an object-form call.
  await assert.rejects(
    typst.compile("main.typ", undefined, { root: "." }),
    TypstInvalidArgumentError,
  );
});
