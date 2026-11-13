// Shared fakes for unit tests that exercise the client without a real Typst
// binary: a process-result factory and a client whose `run` is replaced.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { TypstClientImpl } from "../../dist/client/index.js";

/** The stand-in executable; it is never spawned by the mocked client. */
export const node = process.execPath;

let sandbox;

/**
 * A private working directory for mocked clients, created on first use and
 * removed when the test process exits. Relative outputs written by mocked
 * compiles land here instead of the repository root.
 */
export function sandboxDirectory() {
  if (sandbox === undefined) {
    sandbox = mkdtempSync(join(tmpdir(), "typst-api-test-cwd-"));
    process.once("exit", () => {
      rmSync(sandbox, { recursive: true, force: true });
    });
  }
  return sandbox;
}

/** A normalised process result as `runProcess` would produce it. */
export function result(args, stdout = "", exitCode = 0, stderr = "") {
  return {
    executable: node,
    args: [...args],
    cwd: sandboxDirectory(),
    exitCode,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    durationMs: 1,
    timedOut: false,
    aborted: false,
  };
}

/**
 * A client that reports `Typst <version>` for `--version` and hands every
 * other invocation to `onRun(args, options)`. `clientOptions` are the
 * `createTypst` options; `cwd` defaults to the sandbox directory.
 */
export function client(
  version,
  onRun = (args) => result(args),
  { cwd = sandboxDirectory(), env = process.env, ...clientOptions } = {},
) {
  const typst = new TypstClientImpl(
    { executable: node, source: "explicit", cwd, env },
    clientOptions,
  );
  typst.run = async (args, options) => {
    if (args[0] === "--version") return result(args, `Typst ${version}`);
    return await onRun(args, options);
  };
  return typst;
}

/**
 * Write the positional output a mocked compile would have produced. Relative
 * paths resolve against the sandbox, which is the mocked client's cwd.
 */
export function writeOutput(args, data = "PDF") {
  writeFileSync(resolve(sandboxDirectory(), args.at(-1)), data);
}
