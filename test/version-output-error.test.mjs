import assert from "node:assert/strict";
import test from "node:test";

import {
  TypstError,
  TypstVersionOutputError,
  TypstVersionParseError,
  parseTypstVersionOutput,
} from "../dist/index.js";

test("parseTypstVersionOutput throws a typed TypstError with a stable code", () => {
  assert.throws(
    () => parseTypstVersionOutput("мусор"),
    (error) => {
      assert.ok(error instanceof TypstError);
      assert.ok(error instanceof TypstVersionOutputError);
      assert.equal(error.code, "ERR_TYPST_VERSION_OUTPUT");
      assert.equal(error.raw, "мусор");
      return true;
    },
  );
});

test("the client wraps parse failures without losing the inner cause", async () => {
  const { TypstClientImpl } = await import("../dist/client/index.js");
  const client = new TypstClientImpl(
    {
      executable: process.execPath,
      source: "explicit",
      cwd: process.cwd(),
      env: process.env,
    },
    {},
  );
  client.run = async (args) => ({
    executable: process.execPath,
    args: [...args],
    cwd: process.cwd(),
    exitCode: 0,
    signal: null,
    stdout: Buffer.from("garbage"),
    stderr: Buffer.alloc(0),
    durationMs: 1,
    timedOut: false,
    aborted: false,
  });
  await assert.rejects(client.version(), (error) => {
    assert.ok(error instanceof TypstVersionParseError);
    assert.equal(error.code, "ERR_TYPST_VERSION_PARSE");
    assert.ok(error.cause instanceof TypstVersionOutputError);
    assert.equal(error.cause.code, "ERR_TYPST_VERSION_OUTPUT");
    return true;
  });
});
