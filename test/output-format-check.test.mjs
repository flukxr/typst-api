import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseDiagnostics } from "../dist/index.js";

const checker = fileURLToPath(
  new URL("../scripts/check-output-format.mjs", import.meta.url),
);

const ESC = String.fromCharCode(27);
const COLORED_ERROR =
  `${ESC}[0m${ESC}[1m${ESC}[38;5;9merror${ESC}[0m${ESC}[1m: expected closing paren${ESC}[0m\n` +
  `  ${ESC}[0m${ESC}[36m┌─${ESC}[0m doc.typ:1:10\n`;

test("diagnostics parse colored stderr from Typst 0.1.0-0.4.0", () => {
  const { diagnostics } = parseDiagnostics(COLORED_ERROR);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "error");
  assert.equal(diagnostics[0].message, "expected closing paren");
  assert.equal(diagnostics[0].spans[0].path, "doc.typ");
});

function release(root, version, { warning, error, fonts, watch }) {
  const behavior = join(root, version, "behavior");
  mkdirSync(behavior, { recursive: true });
  writeFileSync(
    join(behavior, "output-format.json"),
    JSON.stringify({
      observed: {
        warningStderr: warning,
        errorStderr: error,
        fontsStdout: fonts,
      },
    }),
  );
  writeFileSync(
    join(behavior, "watch-lifecycle.json"),
    JSON.stringify({ stderr: watch }),
  );
}

const GOOD = {
  warning: "warning: unknown font family: zz\n  ┌─ a.typ:1:1\n",
  error: "error: unclosed delimiter\n  ┌─ a.typ:1:9\n",
  fonts: "DejaVu Sans Mono\nNew Computer Modern\n",
  watch: "[10:00:00] compiling ...\n[10:00:00] compiled successfully in 5 ms\n",
};

test("the output-format check flags a release whose format stopped parsing", () => {
  const root = mkdtempSync(join(tmpdir(), "typst-api-format-check-"));
  try {
    release(root, "1.0.0", GOOD);
    release(root, "1.0.1", {
      ...GOOD,
      warning: "WARN unknown font family: zz (a.typ:1:1)\n",
      watch: "[10:00:00] build started\n[10:00:00] build done\n",
    });
    const run = spawnSync(
      process.execPath,
      [checker, "--snapshot-root", root, "--versions", "1.0.1"],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /REGRESSION \(worked on 1\.0\.0\)/u);
    assert.match(run.stderr, /2 parser regression/u);

    const clean = spawnSync(
      process.execPath,
      [checker, "--snapshot-root", root, "--versions", "1.0.0"],
      { encoding: "utf8" },
    );
    assert.equal(clean.status, 0, clean.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
