import assert from "node:assert/strict";
import test from "node:test";

import {
  TypstUnexpectedResultError,
  expectSingleMemoryOutput,
  expectSingleOutput,
  isFileOutput,
  isMemoryOutput,
} from "../dist/index.js";

const processRecord = {
  executable: "typst",
  args: ["compile"],
  cwd: process.cwd(),
  exitCode: 0,
  signal: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  durationMs: 1,
  timedOut: false,
  aborted: false,
};

function compileResult(outputs) {
  return {
    format: "pdf",
    outputs,
    process: processRecord,
    compilerVersion: "0.15.1",
  };
}

test("isMemoryOutput narrows memory outputs", () => {
  assert.equal(isMemoryOutput({ kind: "memory", data: Buffer.alloc(0) }), true);
  assert.equal(isMemoryOutput({ kind: "file", path: "out.pdf" }), false);
});

test("isFileOutput narrows file outputs", () => {
  assert.equal(isFileOutput({ kind: "file", path: "out.pdf" }), true);
  assert.equal(isFileOutput({ kind: "memory", data: Buffer.alloc(0) }), false);
});

test("expectSingleOutput returns the only output", () => {
  const output = expectSingleOutput(
    compileResult([{ kind: "memory", data: Buffer.from("pdf") }]),
  );
  assert.deepEqual(output, { kind: "memory", data: Buffer.from("pdf") });
});

test("expectSingleOutput rejects empty output lists", () => {
  assert.throws(
    () => expectSingleOutput(compileResult([])),
    TypstUnexpectedResultError,
  );
});

test("expectSingleOutput rejects multi-output results", () => {
  assert.throws(
    () =>
      expectSingleOutput(
        compileResult([
          { kind: "memory", data: Buffer.alloc(0), page: 1 },
          { kind: "memory", data: Buffer.alloc(0), page: 2 },
        ]),
      ),
    TypstUnexpectedResultError,
  );
});

test("expectSingleMemoryOutput returns the single buffer", () => {
  const output = expectSingleMemoryOutput(
    compileResult([{ kind: "memory", data: Buffer.from("pdf") }]),
  );
  assert.equal(output.kind, "memory");
  assert.deepEqual(output.data, Buffer.from("pdf"));
});

test("expectSingleMemoryOutput rejects single file outputs", () => {
  assert.throws(
    () =>
      expectSingleMemoryOutput(
        compileResult([{ kind: "file", path: "out.pdf" }]),
      ),
    TypstUnexpectedResultError,
  );
});

test("expectSingleMemoryOutput rejects empty and multi-output results", () => {
  assert.throws(
    () => expectSingleMemoryOutput(compileResult([])),
    TypstUnexpectedResultError,
  );
  assert.throws(
    () =>
      expectSingleMemoryOutput(
        compileResult([
          { kind: "memory", data: Buffer.alloc(0), page: 1 },
          { kind: "memory", data: Buffer.alloc(0), page: 2 },
        ]),
      ),
    TypstUnexpectedResultError,
  );
});

test("expectSingleOutput uses the unexpected-result code", () => {
  assert.throws(
    () => expectSingleOutput(compileResult([])),
    (error) =>
      error instanceof TypstUnexpectedResultError &&
      error.code === "ERR_TYPST_UNEXPECTED_RESULT",
  );
});
