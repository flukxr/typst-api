// Performance baselines and CI-safe regression guards.
//
// Modes:
//   node scripts/benchmark.mjs            measure and write benchmarks/baselines.json
//   node scripts/benchmark.mjs --check    run the same measurements and assert the
//                                         relative guards; never writes a baseline
//   node scripts/benchmark.mjs --json=PATH  write the report to PATH (default
//                                         benchmarks/baselines.json)
//
// Guards are relative (ratios and cache effectiveness), never absolute wall
// times, because shared CI runners make absolute thresholds flaky.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTypst } from "../dist/index.js";
import { runProcess } from "../dist/core/process.js";

const CHECK = process.argv.includes("--check");
const jsonFlag = process.argv.find((argument) =>
  argument.startsWith("--json="),
);
const jsonPath = jsonFlag
  ? jsonFlag.slice("--json=".length)
  : join(
      fileURLToPath(new URL("../", import.meta.url)),
      "benchmarks",
      "baselines.json",
    );

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function measure(runs, warmups, fn) {
  const samples = [];
  for (let index = 0; index < warmups; index += 1) {
    await fn();
  }
  for (let index = 0; index < runs; index += 1) {
    samples.push(await fn());
  }
  return samples;
}

const executableInfo = await createTypst();
const compilerVersion = (await executableInfo.version()).version;
const executable = executableInfo.executable;

const report = {
  script: "scripts/benchmark.mjs",
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  compilerVersion,
  check: CHECK,
  scenarios: {},
};

// 1. Cold discovery: a fresh client must probe the executable exactly once;
// the cached version lookup must be strictly faster than the spawning probe.
const discoverySamples = await measure(5, 1, async () => {
  const client = await createTypst();
  const start = performance.now();
  const first = await client.version();
  const firstMs = performance.now() - start;
  const cachedStart = performance.now();
  await client.version();
  const cachedMs = performance.now() - cachedStart;
  return {
    firstMs,
    cachedMs,
    resolved: `${client.executableSource}:${first.version}`,
  };
});
report.scenarios.coldDiscovery = {
  totalMedianMs: median(discoverySamples.map((sample) => sample.firstMs)),
  cachedMedianMs: median(discoverySamples.map((sample) => sample.cachedMs)),
  resolved: discoverySamples[0].resolved,
};

// 2. Warm compile overhead: the wrapper's cost is the API wall time minus the
// child process duration, compared against a bare spawn of the same compile.
// The bare invocation must use the identical positional `-` stdout form the
// API uses (probe-verified as the only stdout form across 0.12.0-0.15.1); the
// `-o -` flag form does not write to stdout on any version.
const WARM_SOURCE = "= hello";
async function apiCompile() {
  const client = await createTypst();
  await client.version();
  const start = performance.now();
  const result = await client.compile({
    input: { kind: "source", data: WARM_SOURCE },
    output: { kind: "memory" },
  });
  const wallMs = performance.now() - start;
  return { wallMs, childMs: result.process.durationMs };
}
async function bareCompile() {
  const outcome = await runProcess(executable, ["compile", "-", "-"], {
    stdin: WARM_SOURCE,
  });
  assert.equal(outcome.exitCode, 0, "bare compile must exit 0");
  assert.equal(
    outcome.stdout.subarray(0, 5).toString("latin1"),
    "%PDF-",
    "bare compile must emit a PDF on stdout",
  );
  return outcome.durationMs;
}
const apiSamples = await measure(5, 1, apiCompile);
const bareSamples = await measure(5, 1, bareCompile);
const apiMedian = median(apiSamples.map((sample) => sample.wallMs));
const bareMedian = median(bareSamples);
const childMedian = median(apiSamples.map((sample) => sample.childMs));
report.scenarios.warmCompile = {
  apiMedianMs: apiMedian,
  childMedianMs: childMedian,
  bareMedianMs: bareMedian,
  wrapperOverheadMedianMs: Math.max(0, apiMedian - childMedian),
};

// 3. Large output: a 300-page document must compile with bounded retained heap
// relative to the payload size (same guard as the scale suite). A PDF is a
// single artifact, so the byte size is the payload metric.
const LARGE_SOURCE = Array.from(
  { length: 300 },
  (_, index) =>
    `= Page ${index + 1}\n\nBody of page ${index + 1}.\n\n#pagebreak()`,
).join("\n");
const largeSamples = await measure(3, 1, async () => {
  const client = await createTypst();
  await client.version();
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = await client.compile({
    input: { kind: "source", data: LARGE_SOURCE },
    output: { kind: "memory" },
  });
  const wallMs = performance.now() - start;
  const bytes = result.outputs.reduce(
    (total, output) => total + output.data.length,
    0,
  );
  return {
    wallMs,
    bytes,
    heapDelta: process.memoryUsage().heapUsed - before,
  };
});
report.scenarios.largeOutput = {
  medianMs: median(largeSamples.map((sample) => sample.wallMs)),
  bytes: largeSamples[0].bytes,
  heapDeltaBytes: median(largeSamples.map((sample) => sample.heapDelta)),
};

for (const [name, scenario] of Object.entries(report.scenarios)) {
  console.log(`${name}: ${JSON.stringify(scenario)}`);
}

if (CHECK) {
  const discovery = report.scenarios.coldDiscovery;
  const warm = report.scenarios.warmCompile;
  const large = report.scenarios.largeOutput;

  assert.ok(
    discovery.cachedMedianMs < discovery.totalMedianMs,
    `cached version lookup (${discovery.cachedMedianMs}ms) must be faster than the probing lookup (${discovery.totalMedianMs}ms)`,
  );
  assert.ok(
    warm.wrapperOverheadMedianMs < 1.5 * warm.bareMedianMs,
    `wrapper overhead (${warm.wrapperOverheadMedianMs}ms) must stay below 1.5x the bare child duration (${warm.bareMedianMs}ms)`,
  );
  assert.ok(
    warm.apiMedianMs < 3 * warm.bareMedianMs,
    `API compile (${warm.apiMedianMs}ms) must stay below 3x the bare child duration (${warm.bareMedianMs}ms)`,
  );
  assert.ok(
    large.heapDeltaBytes < 4 * large.bytes,
    `retained heap (${large.heapDeltaBytes} bytes) must stay below 4x the payload (${large.bytes} bytes)`,
  );
  console.log("bench:check passed");
} else {
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`baseline written to ${jsonPath}`);
}
