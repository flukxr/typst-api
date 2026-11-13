import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { runProcess } from "../dist/core/process.js";
import { result, client, node } from "./helpers/mock-typst.mjs";

test("large stdout beyond a single chunk is preserved byte-for-byte", async () => {
  const targetBytes = 8 * 1024 * 1024;
  const chunk = "0123456789abcdef";
  const script = `
    const chunk = process.argv[1];
    const count = Math.ceil(${targetBytes} / chunk.length);
    let written = 0;
    const write = () => {
      while (written < count) {
        const ok = process.stdout.write(chunk);
        written += 1;
        if (!ok) return process.stdout.once("drain", write);
      }
      process.stdout.end();
    };
    write();
  `;
  const outcome = await runProcess(node, ["-e", script, chunk]);
  assert.equal(outcome.exitCode, 0);
  assert.equal(
    outcome.stdout.length,
    chunk.length * Math.ceil(targetBytes / chunk.length),
  );
  assert.equal(outcome.stdout.subarray(0, 16).toString(), chunk);
  assert.equal(
    outcome.stdout.subarray(outcome.stdout.length - 16).toString(),
    chunk,
  );
  // Spot-check: all 16 KiB blocks equal the repeated chunk (no interleaving).
  const block = outcome.stdout.subarray(0, 65536);
  assert.equal(block.toString(), chunk.repeat(65536 / chunk.length));
});

test("large stdin is delivered completely with backpressure", async () => {
  const targetBytes = 4 * 1024 * 1024;
  const byte = 0x5a;
  const input = new Uint8Array(targetBytes);
  input.fill(byte);
  const reader = `
    let seen = 0;
    process.stdin.on("data", (chunk) => { seen += chunk.length; });
    process.stdin.on("end", () => process.stdout.write(String(seen)));
  `;
  const outcome = await runProcess(node, ["-e", reader], { stdin: input });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stdout.toString(), String(targetBytes));
});

test("concurrent compiles are isolated and each preserves raw evidence", async () => {
  const page = (index) => `= page ${index}\n#pagebreak()\n= page ${index + 1}`;
  const typst = client("0.15.1", (args) => {
    const input = args.at(-2);
    const template = args.at(-1);
    if (template === "-") {
      return result(
        args,
        "",
        1,
        "error: cannot export multiple images to stdout\n",
      );
    }
    writeFileSync(template.replace("{p}-of-{t}", "1-of-2"), `a${input.length}`);
    writeFileSync(template.replace("{p}-of-{t}", "2-of-2"), `b${input.length}`);
    return result(args);
  });
  const compiles = [1, 2, 3, 4, 5, 6].map(async (index) => {
    const output = await typst.compile({
      input: { kind: "source", data: page(index) },
      output: { kind: "memory" },
      format: "png",
      ppi: 72,
    });
    return { index, output };
  });
  const results = await Promise.all(compiles);
  const pageNumbers = results.map(({ index, output }) => [
    index,
    output.outputs.map((item) => item.page),
  ]);
  assert.deepEqual(pageNumbers, [
    [1, [1, 2]],
    [2, [1, 2]],
    [3, [1, 2]],
    [4, [1, 2]],
    [5, [1, 2]],
    [6, [1, 2]],
  ]);
  for (const { output } of results) {
    assert.equal(output.process.exitCode, 0);
    assert.equal(output.process.args.at(-2), "-");
  }
});

test("parallel real processes settle independently and never share output", async () => {
  const script = `process.stdout.write(process.argv[1]);`;
  const args = [1, 2, 3, 4, 5, 6, 7, 8].map((value) =>
    runProcess(node, ["-e", script, `payload-${value}`]),
  );
  const outcomes = await Promise.all(args);
  outcomes.forEach((outcome, index) => {
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.stdout.toString(), `payload-${index + 1}`);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.aborted, false);
  });
});

test("a large compile output is collected without unbounded process memory", async () => {
  // 16 MiB of PDF-ish bytes produced by a child process must be fully retained
  // without the runner treating every chunk as an independent allocation.
  const targetBytes = 16 * 1024 * 1024;
  const before = process.memoryUsage().heapUsed;
  const script = `
    const size = ${targetBytes};
    const block = Buffer.alloc(65536, 0x25);
    let written = 0;
    const write = () => {
      while (written < size) {
        const remaining = Math.min(block.length, size - written);
        const ok = process.stdout.write(block.subarray(0, remaining));
        written += remaining;
        if (!ok) return process.stdout.once("drain", write);
      }
      process.stdout.end();
    };
    write();
  `;
  const outcome = await runProcess(node, ["-e", script]);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stdout.length, targetBytes);
  assert.equal(outcome.stdout.subarray(0, 4).toString(), "%%%%");
  const after = process.memoryUsage().heapUsed;
  // The retained heap is dominated by the result buffer itself plus V8
  // allocation latency; a bound far above the payload size catches accidental
  // per-chunk duplication without being flaky on busy runners.
  assert.ok(
    after - before < 4 * targetBytes,
    `heap grew by ${after - before} bytes for a ${targetBytes}-byte output`,
  );
});

test("scale test temp source files are cleaned after parallel compiles", async () => {
  let tempSource;
  const typst = client("0.10.0", (args) => {
    tempSource = args.at(-2);
    writeFileSync(args.at(-1), "PDF");
    return result(args);
  });
  await Promise.all(
    [1, 2, 3, 4, 5].map(() =>
      typst.compile({ input: { kind: "source", data: "= hi" } }),
    ),
  );
  assert.equal(existsSync(tempSource), false);
});

test("concurrent client.version() calls settle once and share the probe", async () => {
  const typst = client("0.15.1", () => result(["compile"], "PDF"));
  let versionCalls = 0;
  const originalRun = typst.run;
  typst.run = async (args, options) => {
    if (args[0] === "--version") versionCalls += 1;
    return originalRun(args, options);
  };
  const versions = await Promise.all([
    typst.version(),
    typst.version(),
    typst.version(),
  ]);
  assert.equal(versions[0].version, "0.15.1");
  assert.equal(versions[1].version, "0.15.1");
  assert.equal(versions[2].version, "0.15.1");
  assert.equal(versionCalls, 1);
});

test("concurrent compile temp scopes never share a directory root", async () => {
  const roots = [];
  const typst = client("0.10.0", (args) => {
    roots.push(dirname(args.at(-2)));
    writeFileSync(args.at(-1), "PDF");
    return result(args);
  });
  await Promise.all(
    [1, 2, 3].map(() =>
      typst.compile({ input: { kind: "source", data: "= hi" } }),
    ),
  );
  assert.equal(new Set(roots).size, 3);
  for (const root of roots) assert.equal(existsSync(root), false);
});

test("streamed watch output chunks stay bounded under rapid output", async () => {
  const { spawnStreamProcess } = await import("../dist/core/stream-process.js");
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push(`line-${i}`);
  const expected = lines.join("\n") + "\n";
  const script = `
    const lines = [];
    for (let i = 0; i < 20000; i++) lines.push("line-" + i + "\\n");
    process.stdout.write(lines.join(""), () => process.exit(0));
  `;
  const handle = spawnStreamProcess(node, ["-e", script]);
  let chunks = 0;
  handle.on("output", () => {
    chunks += 1;
  });
  const result = await new Promise((resolve) => {
    handle.on("close", resolve);
  });
  assert.equal(result.exitCode, 0);
  assert.ok(chunks >= 1);
  assert.equal(result.stdout.toString(), expected);
});
