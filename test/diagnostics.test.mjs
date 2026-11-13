import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDiagnostics,
  runProcess,
  TypstInvalidArgumentError,
} from "../dist/index.js";
import { TypstClientImpl } from "../dist/client/index.js";
import { result, node } from "./helpers/mock-typst.mjs";

function script(source) {
  return ["-e", source];
}

// ---------------------------------------------------------------------------
// parseDiagnostics
// ---------------------------------------------------------------------------

test("parseDiagnostics parses an error with a span and hint", () => {
  const { diagnostics, remainder } = parseDiagnostics(
    [
      "error: expected expression",
      "  ┌─ main.typ:2:10",
      "  │",
      "2 │ #let x = = 1",
      "  │         ^",
      "  │",
      "  = help: expected expression",
      "",
    ].join("\n"),
  );
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], {
    severity: "error",
    message: "expected expression",
    spans: [{ path: "main.typ", line: 2, column: 10 }],
    hints: [{ kind: "help", message: "expected expression" }],
  });
  assert.equal(remainder, "");
});

test("parseDiagnostics parses warning severity", () => {
  const { diagnostics } = parseDiagnostics(
    "warning: unused variable `x`\n" +
      "  ┌─ main.typ:2:5\n" +
      "  │\n" +
      "2 │ #let x = 1\n" +
      "  │     ^\n" +
      "  │\n" +
      "  = note: consider using it\n",
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "warning");
  assert.equal(diagnostics[0].message, "unused variable `x`");
  assert.deepEqual(diagnostics[0].spans, [
    { path: "main.typ", line: 2, column: 5 },
  ]);
  assert.deepEqual(diagnostics[0].hints, [
    { kind: "note", message: "consider using it" },
  ]);
});

test("parseDiagnostics parses multiple diagnostics in one stderr stream", () => {
  const { diagnostics } = parseDiagnostics(
    [
      "error: first failure",
      "  ┌─ a.typ:1:1",
      "  │",
      "1 │ x",
      "  │ ^",
      "  │",
      "warning: second issue",
      "  ┌─ b.typ:3:2",
      "  │",
      "3 │ y",
      "  │  ^",
      "  │",
      "info: something noteworthy",
      "",
    ].join("\n"),
  );
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[0].severity, "error");
  assert.equal(diagnostics[0].message, "first failure");
  assert.equal(diagnostics[1].severity, "warning");
  assert.equal(diagnostics[1].message, "second issue");
  assert.equal(diagnostics[2].severity, "info");
  assert.equal(diagnostics[2].message, "something noteworthy");
});

test("parseDiagnostics keeps unrecognized text in the remainder", () => {
  const { diagnostics, remainder } = parseDiagnostics(
    "some arbitrary log line\n" + "error: real failure\n",
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, "real failure");
  assert.equal(remainder, "some arbitrary log line\n");
});

test("parseDiagnostics returns no diagnostics for empty or plain text", () => {
  assert.deepEqual(parseDiagnostics(""), { diagnostics: [], remainder: "" });
  const plain = "just a log line\nand another\n";
  assert.deepEqual(parseDiagnostics(plain), {
    diagnostics: [],
    remainder: plain,
  });
});

test("parseDiagnostics handles a diagnostic without a span", () => {
  const { diagnostics } = parseDiagnostics(
    "error: could not find file\n" + "  = help: check the path\n",
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, "could not find file");
  assert.deepEqual(diagnostics[0].spans, []);
  assert.deepEqual(diagnostics[0].hints, [
    { kind: "help", message: "check the path" },
  ]);
});

test("parseDiagnostics is best effort and never throws on odd input", () => {
  const bare = parseDiagnostics("error: no newline at end");
  assert.equal(bare.diagnostics.length, 1);
  assert.equal(bare.diagnostics[0].message, "no newline at end");
  assert.deepEqual(bare.diagnostics[0].spans, []);
  assert.equal(bare.remainder, "");
  assert.deepEqual(parseDiagnostics("┌─ bare:1:2\n"), {
    diagnostics: [],
    remainder: "┌─ bare:1:2\n",
  });
});

// ---------------------------------------------------------------------------
// Process runner integration
// ---------------------------------------------------------------------------

const TYPST_STYLE_ERROR =
  "error: expected `]`, found end of file\n" +
  "  ┌─ doc.typ:1:6\n" +
  "  │\n" +
  "1 │ #set [\n" +
  "  │      ^\n" +
  "  │\n" +
  "  = help: close the bracket\n";

test("runProcess with diagnostics: true attaches parsed diagnostics", async () => {
  const result = await runProcess(
    node,
    script(
      `process.stderr.write(${JSON.stringify(TYPST_STYLE_ERROR)}); process.exit(1)`,
    ),
    { diagnostics: true },
  );
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].severity, "error");
  assert.equal(
    result.diagnostics[0].message,
    "expected `]`, found end of file",
  );
  assert.deepEqual(result.diagnostics[0].spans, [
    { path: "doc.typ", line: 1, column: 6 },
  ]);
  // Raw stderr remains authoritative.
  assert.equal(result.stderr.toString(), TYPST_STYLE_ERROR);
});

test("runProcess without diagnostics omits the field", async () => {
  const result = await runProcess(
    node,
    script("process.stderr.write('error: x\\n'); process.exit(1)"),
  );
  assert.equal("diagnostics" in result, false);
  assert.equal(result.stderr.toString(), "error: x\n");
});

test("runProcess attaches diagnostics to errors carrying the process record", async () => {
  await assert.rejects(
    runProcess(
      node,
      script(
        `process.stderr.write(${JSON.stringify(TYPST_STYLE_ERROR)}); setTimeout(() => {}, 10000)`,
      ),
      { diagnostics: true, timeoutMs: 300, terminationGraceMs: 100 },
    ),
    (error) => {
      assert.equal(error.process.stderr.toString(), TYPST_STYLE_ERROR);
      assert.equal(error.process.diagnostics.length, 1);
      assert.equal(
        error.process.diagnostics[0].message,
        "expected `]`, found end of file",
      );
      return true;
    },
  );
});

test("runProcess rejects invalid diagnostics option before spawn", async () => {
  await assert.rejects(
    runProcess(node, script(""), { diagnostics: "yes" }),
    (error) => {
      assert.ok(error instanceof TypstInvalidArgumentError);
      return true;
    },
  );
  await assert.rejects(
    runProcess(node, script(""), { onLog: "not-a-function" }),
    (error) => {
      assert.ok(error instanceof TypstInvalidArgumentError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// onLog progress hook
// ---------------------------------------------------------------------------

test("onLog receives spawn and exit events with redaction-safe metadata", async () => {
  const events = [];
  const result = await runProcess(node, script("process.exit(3)"), {
    onLog: (event) => events.push(event),
  });
  const kinds = events.map((event) => event.kind);
  assert.equal(kinds[0], "spawn");
  assert.equal(kinds.at(-1), "exit");
  assert.equal(events[0].command, "typst");
  assert.equal(typeof events[0].pid, "number");
  const exit = events.at(-1);
  assert.equal(exit.exitCode, 3);
  assert.equal(exit.signal, null);
  assert.equal(exit.durationMs >= 0, true);
  assert.equal(result.exitCode, 3);
});

test("onLog receives chunk events with stream and length", async () => {
  const events = [];
  await runProcess(
    node,
    script('process.stdout.write("hello"); process.stderr.write("oops")'),
    { onLog: (event) => events.push(event) },
  );
  const chunks = events.filter((event) => event.kind.endsWith("_chunk"));
  assert.ok(chunks.length >= 1);
  const stdoutChunks = chunks.filter((event) => event.stream === "stdout");
  const stderrChunks = chunks.filter((event) => event.stream === "stderr");
  assert.ok(stdoutChunks.length >= 1);
  assert.ok(stderrChunks.length >= 1);
  const totalStdout = stdoutChunks.reduce(
    (sum, event) => sum + event.chunkLength,
    0,
  );
  assert.equal(totalStdout, 5);
});

test("onLog failures never break the process run", async () => {
  const result = await runProcess(node, script("process.exit(0)"), {
    onLog: () => {
      throw new Error("hook exploded");
    },
  });
  assert.equal(result.exitCode, 0);
});

// ---------------------------------------------------------------------------
// diagnose()
// ---------------------------------------------------------------------------

function discovered(source = "explicit") {
  return {
    executable: node,
    source,
    cwd: process.cwd(),
    env: process.env,
  };
}

test("diagnose reports executable, version, support, capabilities, and host", async () => {
  const client = new TypstClientImpl(discovered(), {});
  client.run = async (args) => {
    if (args[0] === "--version") return result(args, "Typst 0.15.1 (abc)\n");
    throw new Error("unexpected command");
  };
  const report = await client.diagnose();
  assert.equal(report.executable, node);
  assert.equal(report.executableSource, "explicit");
  assert.equal(report.compilerVersion, "0.15.1");
  assert.equal(report.version.version, "0.15.1");
  assert.equal(report.support.compilerVersion, "0.15.1");
  assert.equal(report.capabilities.compilerVersion, "0.15.1");
  assert.equal(report.host.platform, process.platform);
  assert.equal(report.host.arch, process.arch);
  assert.equal(report.cwd, process.cwd());
  assert.equal(report.launcherAvailable, true);
  assert.equal(Array.isArray(report.issues), true);
});

test("diagnose flags an unknown compiler version", async () => {
  const client = new TypstClientImpl(discovered(), {});
  client.run = async (args) => {
    if (args[0] === "--version") return result(args, "Typst 9.9.9\n");
    throw new Error("unexpected command");
  };
  const report = await client.diagnose();
  const issue = report.issues.find(
    (item) => item.code === "UNKNOWN_COMPILER_VERSION",
  );
  assert.ok(issue !== undefined);
  assert.match(issue.message, /9\.9\.9/);
  assert.equal(report.support.level, "unknown");
});

test("diagnose flags an executable resolved through PATH", async () => {
  const client = new TypstClientImpl(discovered("path"), {});
  client.run = async (args) => {
    if (args[0] === "--version") return result(args, "Typst 0.15.1\n");
    throw new Error("unexpected command");
  };
  const report = await client.diagnose();
  const issue = report.issues.find(
    (item) => item.code === "EXECUTABLE_FROM_PATH",
  );
  assert.ok(issue !== undefined);
});

test("diagnose issues are frozen and the report is frozen", async () => {
  const client = new TypstClientImpl(discovered(), {});
  client.run = async (args) => {
    if (args[0] === "--version") return result(args, "Typst 0.15.1\n");
    throw new Error("unexpected command");
  };
  const report = await client.diagnose();
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.issues), true);
  assert.equal(Object.isFrozen(report.host), true);
  assert.equal(report.launcherAvailable, true);
  assert.equal(report.issues.length, 0);
});
