// Type-level consumer check: install the packed tarball into a blank ESM
// fixture and type-check a strict consumer source with `moduleResolution:
// NodeNext`, using the same TypeScript and @types/node as the repository.
// Catches declaration-resolution and public-type regressions that the runtime
// smoke test cannot see.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("consumer-typecheck.mjs must be run through an npm script");
}

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      // A nested npm pack must write a real tarball even when the enclosing
      // npm invocation inherited a --dry-run flag (e.g. prepack during
      // `npm pack --dry-run`).
      env: { ...process.env, npm_config_dry_run: "false" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function assertSucceeded(result, description) {
  assert.equal(
    result.exitCode,
    0,
    `${description} failed\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`,
  );
  assert.equal(result.signal, null, `${description} exited by signal`);
}

const FIXTURE_TSCONFIG = {
  compilerOptions: {
    strict: true,
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2022",
    lib: ["ES2022"],
    types: ["node"],
    noEmit: true,
    skipLibCheck: false,
  },
  include: ["consumer.ts"],
};

const CONSUMER_SOURCE = `import {
  createTypst,
  expectSingleMemoryOutput,
  expectSingleOutput,
  isFileOutput,
  isMemoryOutput,
  parseExactStableVersion,
  TypstCompilationError,
  UnsupportedTypstFeatureError,
  type CompileFileOutput,
  type CompileMemoryOutput,
  type CompileDestination,
  type CompileOptions,
  type CompileOutput,
  type CompileResult,
  type EvalResult,
  type InfoResult,
  type QueryOneResult,
  type QueryResult,
  type TypstClient,
  type TypstOutputFormat,
  type TypstVersionInfo,
  type TypstWatchHandle,
  type ExactTypstVersion,
  type TypstError,
  type TypstErrorCode,
  type TypstLogEvent,
  type WatchCycleInfo,
  type CompileManySettled,
  type PdfStandard,
  type TypstFeature,
  jsonInput,
  source,
  configure,
  compile as compileFile,
  pdf as pdfOf,
  query as queryOf,
} from "@flukxr/typst-api";

// Open vocabularies: known values autocomplete, newer values still type-check.
const standard: PdfStandard = "a-2u";
const futureStandard: PdfStandard = "a-9z";
const feature: TypstFeature = "html";
const futureFeature: TypstFeature = "future-feature";
// @ts-expect-error a PDF standard is a string, not a number
const wrongStandard: PdfStandard = 2;

// Exact versions admit only three integer components.
const exactVersion: ExactTypstVersion = "0.15.1";
// @ts-expect-error a major.minor pair is not an exact version
const twoPart: ExactTypstVersion = "0.15";
// @ts-expect-error a fractional component is not an exact version
const fourPart: ExactTypstVersion = "1.5.2.3";

// Error codes are a closed union that supports exhaustive handling.
function describe(error: TypstError): string {
  const code: TypstErrorCode = error.code;
  // @ts-expect-error unknown codes are not part of the union
  const bogus: TypstErrorCode = "ERR_SOMETHING_ELSE";
  void bogus;
  return code;
}

// Log events narrow by kind.
function onLog(event: TypstLogEvent): number | null {
  if (event.kind === "exit") return event.exitCode;
  if (event.kind === "stdout_chunk" || event.kind === "stderr_chunk")
    return event.chunkLength;
  // @ts-expect-error spawn events carry no exit code
  if (event.kind === "spawn") return event.exitCode;
  return null;
}

const version: { raw: string; major: number; minor: number; patch: number } =
  parseExactStableVersion("0.15.1");

async function main(): Promise<void> {
  const client: TypstClient = await createTypst({ executable: "typst" });
  const info: TypstVersionInfo = await client.version();
  const format: TypstOutputFormat = "pdf";
  const dynamicFormat: TypstOutputFormat =
    Math.random() > 0.5 ? "pdf" : "png";
  const options: CompileOptions = {
    input: "main.typ",
    output: "out.pdf",
    format,
  };
  const result: CompileResult = await client.compile(options);
  const firstOutput = result.outputs[0];
  const firstPage: Buffer | undefined =
    firstOutput?.kind === "memory" ? firstOutput.data : undefined;
  const processExit: number | null = result.process.exitCode;

  // Statically in-memory PDF calls infer exactly one memory output.
  const memory = await client.compile({ input: { kind: "source", data: "x" } });
  const singleMemory: readonly [CompileMemoryOutput] = memory.outputs;
  const pdfBuffer: Buffer = memory.outputs[0].data;
  const pdfKind: "memory" = memory.outputs[0].kind;
  // @ts-expect-error a memory output is not a file output
  const notFileMemory: CompileFileOutput = memory.outputs[0];

  // An explicit memory destination with an explicit pdf format also narrows.
  const explicitMemory = await client.compile({
    input: "main.typ",
    output: { kind: "memory" },
    format: "pdf",
  });
  const explicitBuffer: Buffer = explicitMemory.outputs[0].data;

  // File destinations keep the full output union.
  const file = await client.compile({ input: "main.typ", output: "out.pdf" });
  const firstFile: CompileOutput = file.outputs[0];
  // @ts-expect-error a file output is not a memory output
  const notMemory: CompileMemoryOutput = file.outputs[0];

  // A string destination is always a file destination.
  const stringFile = await client.compile({
    input: "main.typ",
    output: "out.png",
  });
  const stringFileOutputs: readonly CompileFileOutput[] =
    stringFile.outputs;
  const stringFilePath: string = stringFile.outputs[0].path;
  // @ts-expect-error a file output has no in-memory data
  const stringFileData: Buffer = stringFile.outputs[0].data;

  // An explicit single-artifact format narrows a file result to one element.
  const singleFile = await client.compile({
    input: "main.typ",
    output: "out.pdf",
    format: "pdf",
  });
  const singleFileOutputs: readonly [CompileFileOutput] =
    singleFile.outputs;
  const singleFilePath: string = singleFile.outputs[0].path;

  const singleHtmlFile = await client.compile({
    input: "main.typ",
    output: { kind: "file", path: "out.html" },
    format: "html",
    features: ["html"],
  });
  const singleHtmlOutputs: readonly [CompileFileOutput] =
    singleHtmlFile.outputs;

  const unionSingleFormat = await client.compile({
    input: "main.typ",
    output: "out.pdf",
    format: "pdf" as "pdf" | "html",
  });
  const unionSingleOutputs: readonly [CompileFileOutput] =
    unionSingleFormat.outputs;

  // PNG/SVG file output is page-per-file and is never a single-result tuple.
  const pngFile = await client.compile({
    input: "main.typ",
    output: "out.png",
    format: "png",
  });
  const pngFileOutputs: readonly CompileFileOutput[] = pngFile.outputs;
  // @ts-expect-error png file output may contain several pages
  const notSinglePngFile: readonly [CompileFileOutput] = pngFile.outputs;

  // A string destination without an explicit format keeps the array because
  // the extension cannot be proven to be single-artifact.
  const inferredFile = await client.compile({
    input: "main.typ",
    output: "out.pdf",
  });
  // @ts-expect-error the extension alone does not prove a single output
  const notInferredSingle: readonly [CompileFileOutput] = inferredFile.outputs;

  // Multi-page formats keep the multi-output union even in memory.
  const pngs = await client.compile({ input: "main.typ", format: "png" });
  // @ts-expect-error png output may be multiple, not a single memory output
  const notSinglePng: readonly [CompileMemoryOutput] = pngs.outputs;

  const bundle = await client.compile({
    input: "main.typ",
    format: "bundle",
    features: ["bundle"],
  });
  const bundleOutputs: readonly CompileMemoryOutput[] = bundle.outputs;
  // @ts-expect-error bundle is a multi-file format
  const notSingleBundle: readonly [CompileMemoryOutput] = bundle.outputs;

  // An explicit HTML memory destination is a single in-memory artifact.
  const htmlMemory = await client.compile({
    input: "main.typ",
    output: { kind: "memory" },
    format: "html",
    features: ["html"],
  });
  const htmlBytes: Buffer = htmlMemory.outputs[0].data;

  // Dynamic option objects fall back to the full union.
  const dynamic = await client.compile({
    input: "main.typ",
    format: dynamicFormat,
  });
  const dynamicFirst: CompileOutput = dynamic.outputs[0];

  // A dynamic format with the default memory destination stays in memory but
  // cannot promise a single output.
  const dynamicMemory = await client.compile({
    input: "main.typ",
    format: dynamicFormat,
  });
  const dynamicMemoryOutputs: readonly CompileMemoryOutput[] =
    dynamicMemory.outputs;
  // @ts-expect-error a dynamic format may produce several memory outputs
  const notSingleDynamic: readonly [CompileMemoryOutput] =
    dynamicMemory.outputs;

  // A dynamic destination union keeps the full output union.
  const dynamicDestination: CompileDestination =
    Math.random() > 0.5 ? "out.pdf" : { kind: "memory" };
  const unionDestination = await client.compile({
    input: "main.typ",
    output: dynamicDestination,
  });
  const unionOutput: CompileOutput = unionDestination.outputs[0];

  // A fully dynamic options object keeps the base result.
  const dynamicOptions: CompileOptions = { input: "main.typ" };
  const dynamicResult: CompileResult = await client.compile(dynamicOptions);

  // Output helpers.
  const guarded: boolean = isMemoryOutput(result.outputs[0]);
  const fileGuard: boolean = isFileOutput(file.outputs[0]);
  const single: CompileOutput = expectSingleOutput(result);
  const singleMemoryBytes: Buffer = expectSingleMemoryOutput(memory).data;

  // Typed query / queryOne / eval / info.
  const headings = await client.query<{ level: number; body: string }>({
    input: "main.typ",
    selector: "heading",
  });
  const firstLevel: number = headings.elements[0].level;
  // @ts-expect-error query<number> elements are numbers, not strings
  const wrongElements: string[] = headings.elements;

  const heading = await client.queryOne<{ body: string }>({
    input: "main.typ",
    selector: "heading",
  });
  const body: string = heading.element.body;

  const evaluated = await client.eval<{ ok: boolean }>("(ok: true)");
  const ok: boolean | undefined = evaluated.value?.ok;

  const report = await client.info<{ version: string }>({ format: "json" });
  const reportVersion: string | undefined = report.data?.version;

  // Generic defaults keep the untyped shapes for existing code.
  const untypedQuery: QueryResult = await client.query({
    input: "main.typ",
    selector: "heading",
  });
  const untypedElements: readonly unknown[] = untypedQuery.elements;
  const untypedOne: QueryOneResult = await client.queryOne({
    input: "main.typ",
    selector: "heading",
  });
  const untypedElement: unknown = untypedOne.element;
  const untypedEval: EvalResult = await client.eval("1 + 2");
  const untypedValue: unknown = untypedEval.value;
  const untypedInfo: InfoResult = await client.info();
  const untypedData: unknown = untypedInfo.data;

  try {
    await client.compile({ input: { kind: "source", data: "x" } });
  } catch (error) {
    if (error instanceof TypstCompilationError) {
      const exitCode: number | null = error.process.exitCode;
      const diagnostics = error.process.diagnostics;
    }
  }

  const watch: TypstWatchHandle = await client.watch({
    input: "main.typ",
    output: "out.pdf",
  });
  const closed: Promise<import("@flukxr/typst-api").TypstProcessResult> =
    watch.closed;
  const ready: Promise<WatchCycleInfo> = watch.ready;

  // Format shortcuts return ready-to-use values.
  const shortcutPdf: Buffer = await client.pdf("main.typ");
  const shortcutPngs: readonly Buffer[] = await client.png("main.typ");
  const shortcutSvgs: readonly string[] = await client.svg({
    kind: "source",
    data: "x",
  });
  const shortcutHtml: string = await client.html("main.typ");
  // @ts-expect-error the shortcut already fixes the format
  await client.pdf("main.typ", { format: "png" });

  // A multi-file project held in memory.
  const projectPdf: Buffer = await client.pdf({
    kind: "project",
    files: { "main.typ": '#import "lib.typ": x', "lib.typ": "#let x = 1" },
  });
  await client.watch({
    // @ts-expect-error watch needs real files, not a project
    input: { kind: "project", files: { "main.typ": "x" } },
  });

  // source() wraps markup; results always carry parsed warnings.
  const fromSource = await client.compile({ input: source("= Hi") });
  const warningCount: number = fromSource.warnings.length;

  // Positional compile narrows by the destination extension.
  const oneFile: readonly [CompileFileOutput] = (
    await client.compile("main.typ", "out.pdf")
  ).outputs;
  const pages: readonly CompileFileOutput[] = (
    await client.compile("main.typ", "page-{p}.png", { ppi: 144 })
  ).outputs;
  // @ts-expect-error png templates may produce several pages
  const notOne: readonly [CompileFileOutput] = (
    await client.compile("main.typ", "page-{p}.png")
  ).outputs;
  // An explicit format may produce several files, so the result is an array.
  const explicitFormat: readonly CompileFileOutput[] = (
    await client.compile("main.typ", "out.pdf", { format: "png" })
  ).outputs;
  // @ts-expect-error an explicit format drops the single-file guarantee
  const explicitOne: readonly [CompileFileOutput] = explicitFormat;
  void explicitOne;
  void oneFile;
  void pages;
  void notOne;

  // Positional query and single-object eval.
  const positional = await client.query<{ level: number }>(
    "main.typ",
    "heading",
    { field: "level" },
  );
  const positionalLevel: number = positional.elements[0].level;
  const evaluatedObject = await client.eval<number>({ expression: "1 + 1" });
  const evaluatedNumber: number | undefined = evaluatedObject.value;
  // @ts-expect-error the object form needs an expression
  await client.eval({ pretty: true });

  // Batch compiles settle per job.
  const batch: readonly CompileManySettled[] = await client.compileMany(
    [{ input: "a.typ" }, { input: "b.typ", format: "svg" }],
    { concurrency: 2 },
  );
  for (const item of batch) {
    if (item.ok) void item.result.outputs;
    else void item.error.code;
  }

  // Structured inputs and cycle iteration.
  const data: string = jsonInput({ total: 3 });
  for await (const cycle of watch) {
    const index: number = cycle.index;
    void index;
    break;
  }

  // Module-level functions mirror the client, overloads included.
  configure({ timeoutMs: 30_000 });
  const moduleOne: readonly [CompileFileOutput] = (
    await compileFile("main.typ", "out.pdf", { extraArgs: ["--future"] })
  ).outputs;
  const moduleBuffer: Buffer = await pdfOf(source("= Hi"), {
    pdfStandards: ["a-2u"],
  });
  const moduleHeadings = await queryOf<{ level: number }>("a.typ", "heading");
  const moduleLevel: number = moduleHeadings.elements[0].level;
  // @ts-expect-error extraArgs is a string array
  await pdfOf(source("x"), { extraArgs: "--flag" });

  // Client defaults share the world options of every compiling command.
  const withDefaults = await createTypst({
    defaults: { fontPaths: ["fonts"], ignoreSystemFonts: true },
  });
  await withDefaults.query({
    input: "main.typ",
    selector: "heading",
    ignoreEmbeddedFonts: true,
  });

  void standard;
  void futureStandard;
  void feature;
  void futureFeature;
  void wrongStandard;
  void moduleOne;
  void moduleBuffer;
  void moduleLevel;
  void warningCount;
  void positionalLevel;
  void evaluatedNumber;
  void data;
  void exactVersion;
  void twoPart;
  void fourPart;
  void describe;
  void onLog;
  void ready;
  void shortcutPdf;
  void shortcutPngs;
  void shortcutSvgs;
  void shortcutHtml;
  void projectPdf;
  void firstPage;
  void processExit;
  void closed;
  void info;
  void version;
  void pdfBuffer;
  void pdfKind;
  void explicitBuffer;
  void firstFile;
  void dynamicFirst;
  void stringFileOutputs;
  void stringFilePath;
  void singleFileOutputs;
  void singleFilePath;
  void singleHtmlOutputs;
  void unionSingleOutputs;
  void pngFileOutputs;
  void bundleOutputs;
  void htmlBytes;
  void dynamicMemoryOutputs;
  void unionOutput;
  void dynamicResult;
  void guarded;
  void fileGuard;
  void single;
  void singleMemoryBytes;
  void firstLevel;
  void body;
  void ok;
  void reportVersion;
  void untypedElements;
  void untypedElement;
  void untypedValue;
  void untypedData;
}
`;

const temporaryRoot = await mkdtemp(
  join(tmpdir(), "typst-api-consumer-types-"),
);
try {
  const packResult = await run(
    process.execPath,
    [
      npmCli,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporaryRoot,
    ],
    repositoryRoot,
  );
  assertSucceeded(packResult, "npm pack");
  const packDescription = JSON.parse(packResult.stdout.toString("utf8"));
  const packed = Array.isArray(packDescription)
    ? packDescription[0]
    : Object.values(packDescription)[0];

  const fixture = join(temporaryRoot, "fixture");
  await mkdir(fixture);
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    join(fixture, "tsconfig.json"),
    `${JSON.stringify(FIXTURE_TSCONFIG, null, 2)}\n`,
  );
  await writeFile(join(fixture, "consumer.ts"), CONSUMER_SOURCE);

  const tarball = join(temporaryRoot, packed.filename);
  const installResult = await run(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    fixture,
  );
  assertSucceeded(installResult, "fixture install");

  // Reuse the repository's TypeScript and @types/node so the check runs
  // offline with the exact versions the package is verified against.
  await cp(
    join(repositoryRoot, "node_modules", "typescript"),
    join(fixture, "node_modules", "typescript"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "node_modules", "@types"),
    join(fixture, "node_modules", "@types"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "node_modules", "@typescript"),
    join(fixture, "node_modules", "@typescript"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "node_modules", "undici-types"),
    join(fixture, "node_modules", "undici-types"),
    { recursive: true },
  );

  const typeResult = await run(
    process.execPath,
    [join(fixture, "node_modules", "typescript", "bin", "tsc"), "-p", "."],
    fixture,
  );
  assertSucceeded(typeResult, "consumer typecheck");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
