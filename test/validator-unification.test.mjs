import assert from "node:assert/strict";
import test from "node:test";
import { client, node } from "./helpers/mock-typst.mjs";

function captureRejection(promise) {
  return promise.then(
    () => null,
    (error) => error,
  );
}

test("shared path validation messages are identical across commands", async () => {
  const typst = client("0.15.1");
  const compileError = await captureRejection(
    typst.compile({ input: { kind: "file", path: "" } }),
  );
  const watchError = await captureRejection(
    typst.watch({ input: { kind: "file", path: "" } }),
  );
  const initError = await captureRejection(
    typst.init({ template: "@preview/x", directory: "" }),
  );
  for (const error of [compileError, watchError, initError]) {
    assert.ok(error !== null);
    // The shared validator always reports the same `must be a non-empty
    // path.` suffix regardless of the command that surfaced the violation.
    assert.match(error.message, /must be a non-empty path\.$/u);
  }
});

test("shared run-options validation is identical across commands", async () => {
  const typst = client("0.15.1");
  const options = { timeoutMs: -1 };
  const compileError = await captureRejection(
    typst.compile({ input: { kind: "file", path: "a.typ" }, ...options }),
  );
  const fontsError = await captureRejection(typst.fonts(options));
  const infoError = await captureRejection(typst.info(options));
  const initError = await captureRejection(
    typst.init({ template: "@preview/x", ...options }),
  );
  for (const error of [compileError, fontsError, infoError, initError]) {
    assert.ok(error !== null);
    assert.equal(
      error.message,
      "timeoutMs must be a finite non-negative number.",
    );
  }
});
