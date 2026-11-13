import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const node = process.execPath;
const clientEntry = fileURLToPath(
  new URL("../dist/client/index.js", import.meta.url),
);

const script = `
import { TypstClientImpl } from ${JSON.stringify(`file:///${clientEntry.replace(/\\\\/gu, "/")}`)};
const node = process.execPath;
const client = new TypstClientImpl(
  { executable: node, source: "explicit", cwd: process.cwd(), env: process.env },
  {},
);
client.run = async (args) => {
  if (args[0] === "--version") {
    return {
      executable: node, args: [...args], cwd: process.cwd(), exitCode: 0,
      signal: null, stdout: Buffer.from("Typst 0.15.1"), stderr: Buffer.alloc(0),
      durationMs: 1, timedOut: false, aborted: false,
    };
  }
  return {
    executable: node, args: [...args], cwd: process.cwd(), exitCode: 0,
    signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    durationMs: 1, timedOut: false, aborted: false,
  };
};
const capabilities = await client.capabilities();
process.stdout.write(JSON.stringify(capabilities));
`;

test("a replaced registry data file changes capabilities()", () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-registry-e2e-"));
  try {
    const seed = join(directory, "capabilities.seed.json");
    writeFileSync(
      seed,
      JSON.stringify({
        $schema: "../schemas/capabilities.schema.json",
        status: "verified",
        verification: {
          milestone: "M0",
          platform: "win32",
          arch: "x64",
        },
        warning: "Replacement registry used by a test.",
        checkedAt: "2026-01-01",
        features: {
          "commands.compile": {
            since: "0.1.0",
          },
          "commands.replacementOnly": {
            since: "0.1.0",
          },
        },
      }),
    );
    const result = spawnSync(node, ["--input-type=module", "--eval", script], {
      cwd: join(process.cwd(), "test"),
      env: {
        ...process.env,
        TYPST_API_CAPABILITY_REGISTRY: seed,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `subprocess failed: ${result.stderr}`);
    const capabilities = JSON.parse(result.stdout);
    assert.equal(capabilities.level, "partial");
    // The replacement-only feature is visible through capabilities().
    assert.equal(capabilities.commands["replacementOnly"].state, "supported");
    assert.equal(capabilities.commands["replacementOnly"].since, "0.1.0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
