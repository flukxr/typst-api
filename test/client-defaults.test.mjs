import assert from "node:assert/strict";
import test from "node:test";

import { TypstClientImpl } from "../dist/client/index.js";

const node = process.execPath;

function clientWithDefaults(options) {
  return new TypstClientImpl(
    {
      executable: node,
      source: "explicit",
      cwd: process.cwd(),
      env: process.env,
    },
    options,
  );
}

test("client-level diagnostics default applies without a call flag", async () => {
  const client = clientWithDefaults({ diagnostics: true });
  const result = await client.run([
    "-e",
    "process.stderr.write('error: x\\n')",
  ]);
  assert.ok(result.diagnostics !== undefined);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].message, "x");
});

test("call-level diagnostics overrides the client default", async () => {
  const client = clientWithDefaults({ diagnostics: true });
  const result = await client.run(
    ["-e", "process.stderr.write('error: x\\n')"],
    { diagnostics: false },
  );
  assert.equal("diagnostics" in result, false);
});

test("client-level onLog default applies without a call flag", async () => {
  const events = [];
  const client = clientWithDefaults({
    onLog: (event) => events.push(event.kind),
  });
  await client.run(["-e", "process.exit(0)"]);
  assert.ok(events.length > 0);
  assert.ok(events.includes("spawn"));
  assert.ok(events.includes("exit"));
});

test("call-level onLog overrides the client default", async () => {
  const clientDefault = [];
  const callDefault = [];
  const client = clientWithDefaults({
    onLog: (event) => clientDefault.push(event.kind),
  });
  await client.run(["-e", "process.exit(0)"], {
    onLog: (event) => callDefault.push(event.kind),
  });
  assert.equal(clientDefault.length, 0);
  assert.ok(callDefault.length > 0);
  assert.ok(callDefault.includes("spawn"));
});
