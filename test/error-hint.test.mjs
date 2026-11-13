import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TypstCompilationError, createTypst } from "../dist/index.js";
import { result } from "./helpers/mock-typst.mjs";

test("TypstCompilationError message includes the compiler diagnostic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-error-hint-"));
  try {
    const source = join(directory, "broken.typ");
    writeFileSync(source, "#unknown-function()");
    const client = await createTypst({ executable: process.execPath });
    client.run = async (args) => {
      if (args[0] === "--version") return result(args, "Typst 0.15.1");
      return result(
        args,
        "",
        1,
        "error: unknown variable: undefined_fn\n  --> broken.typ:1:2\n",
      );
    };
    await assert.rejects(
      client.compile({
        input: { kind: "file", path: source },
        output: { kind: "memory" },
      }),
      (error) => {
        assert.ok(error instanceof TypstCompilationError);
        assert.match(error.message, /unknown variable: undefined_fn/u);
        assert.match(error.message, /exitCode=1/u);
        // Raw stderr remains authoritative and unmodified.
        assert.equal(
          error.process.stderr.toString(),
          "error: unknown variable: undefined_fn\n  --> broken.typ:1:2\n",
        );
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("error message hint is truncated for long stderr lines", async () => {
  const client = await createTypst({ executable: process.execPath });
  client.run = async (args) => {
    if (args[0] === "--version") return result(args, "Typst 0.15.1");
    const longLine = `x${"y".repeat(500)}`;
    return result(args, "", 1, `error: ${longLine}\n`);
  };
  await assert.rejects(
    client.compile({
      input: { kind: "file", path: "broken.typ" },
      output: { kind: "memory" },
    }),
    (error) => {
      assert.ok(error instanceof TypstCompilationError);
      assert.ok(error.message.length <= 350, error.message);
      assert.match(error.message, /…$/u);
      return true;
    },
  );
});

test("error message omits the hint when stderr is empty", async () => {
  const client = await createTypst({ executable: process.execPath });
  client.run = async (args) => {
    if (args[0] === "--version") return result(args, "Typst 0.15.1");
    return result(args, "", 1);
  };
  await assert.rejects(
    client.compile({
      input: { kind: "file", path: "broken.typ" },
      output: { kind: "memory" },
    }),
    (error) => {
      assert.ok(error instanceof TypstCompilationError);
      assert.equal(
        error.message,
        "Typst compile exited unsuccessfully (exitCode=1, signal=null).",
      );
      return true;
    },
  );
});
