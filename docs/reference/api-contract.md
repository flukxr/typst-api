# Public API contract

This document explains the public `1.0.0` contract. The authoritative,
machine-checked declaration is [`spec/public-api.d.ts`](../../spec/public-api.d.ts):
`npm run freeze:check` fails when the emitted types drift from it.

## Construction

```ts
export function createTypst(options?: CreateTypstOptions): Promise<TypstClient>;

export interface CreateTypstOptions {
  executable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envMode?: "merge" | "replace";
  timeoutMs?: number;
  terminationGraceMs?: number;
  discovery?: {
    package?: boolean;
    environment?: boolean;
    path?: boolean;
  };
  unknownVersionPolicy?: "reject" | "assume-latest-known";
  diagnostics?: boolean;
  onLog?: (event: TypstLogEvent) => void;
  verifyExecutable?: boolean;
  defaults?: TypstWorldOptions;
}

/** Project options shared by compile, query, eval and watch. */
export interface TypstWorldOptions {
  root?: string;
  inputs?: Readonly<Record<string, string>>;
  fontPaths?: readonly string[];
  ignoreSystemFonts?: boolean; // from exact 0.12.0
  ignoreEmbeddedFonts?: boolean; // from exact 0.14.0
  packagePath?: string;
  packageCachePath?: string;
  creationTimestamp?: Date | number; // seconds since the Unix epoch
  jobs?: number;
  features?: readonly TypstFeature[]; // KnownTypstFeature | (string & {})
}
```

`defaults` holds client-level project options for `compile`, `query`, `eval`,
`watch` and the shortcuts below; `fonts` inherits the font switches. A command
option always wins, and `inputs` objects are merged key by key. A default
`root` is not applied to a project input, which is its own root. The defaults
are validated when the client is created.

`diagnostics` and `onLog` are client-level defaults: a high-level command that
does not set them on its own options inherits the client value. The call-level
option always wins when both are present.

`unknownVersionPolicy` defaults to `"reject"`. When the detected compiler
version is absent from the release inventory, high-level commands throw
`UnsupportedTypstVersionError` unless the caller opts into
`"assume-latest-known"`; `run(args)` remains available either way.

Discovery validates that the resolved path is a regular, executable file but
does not run it by default. `verifyExecutable: true` probes the resolved
executable with `--version` and rejects anything that does not report a single
exact stable Typst compiler version (`TypstExecutableProbeError`). Package
sources are always verified against their declared version regardless of this
flag.

Discovery order:

1. explicit executable;
2. installed `@flukxr/typst-cli`;
3. `TYPST_PATH`;
4. `typst` on `PATH`.

## Client

```ts
export interface TypstClient {
  readonly executable: string;
  readonly executableSource: "explicit" | "package" | "environment" | "path";

  version(): Promise<TypstVersionInfo>;
  support(): Promise<TypstSupport>;
  capabilities(options?: CapabilitiesOptions): Promise<TypstCapabilities>;

  run(
    args: readonly string[],
    options?: RunOptions,
  ): Promise<TypstProcessResult>;

  compile(
    options: CompileOptions & {
      output: string | CompileFileDestination;
      format: "pdf" | "html";
    },
  ): Promise<CompileResult & { outputs: readonly [CompileFileOutput] }>;
  compile(
    options: CompileOptions & { output: string | CompileFileDestination },
  ): Promise<CompileResult & { outputs: readonly CompileFileOutput[] }>;
  compile(
    options: CompileOptions & {
      output?: CompileMemoryDestination | undefined;
      format?: "pdf" | "html" | undefined;
    },
  ): Promise<CompileResult & { outputs: readonly [CompileMemoryOutput] }>;
  compile(
    options: CompileOptions & {
      output?: CompileMemoryDestination | undefined;
      format: "png" | "svg" | "bundle";
    },
  ): Promise<CompileResult & { outputs: readonly CompileMemoryOutput[] }>;
  compile(
    options: CompileOptions & { output?: CompileMemoryDestination | undefined },
  ): Promise<CompileResult & { outputs: readonly CompileMemoryOutput[] }>;
  compile(options: CompileOptions): Promise<CompileResult>;
  compile(
    input: CompileInput,
    output: SingleFilePath, // `${string}.pdf` | `${string}.html`
    options?: Omit<CompileToFileOptions, "format">,
  ): Promise<CompileResult & { outputs: readonly [CompileFileOutput] }>;
  compile(
    input: CompileInput,
    output: string | CompileFileDestination,
    options?: CompileToFileOptions, // CompileOptions without input/output
  ): Promise<CompileResult & { outputs: readonly CompileFileOutput[] }>;
  pdf(input: CompileInput, options?: CompileShortcutOptions): Promise<Buffer>;
  png(
    input: CompileInput,
    options?: CompileShortcutOptions,
  ): Promise<readonly Buffer[]>;
  svg(
    input: CompileInput,
    options?: CompileShortcutOptions,
  ): Promise<readonly string[]>;
  html(input: CompileInput, options?: CompileShortcutOptions): Promise<string>;
  compileMany(
    jobs: readonly CompileOptions[],
    options?: CompileManyOptions,
  ): Promise<readonly CompileManySettled[]>;
  fonts(options?: FontsOptions): Promise<FontsResult>;
  init(options: InitOptions): Promise<InitResult>;
  eval<T = unknown>(
    expression: string,
    options?: EvalOptions,
  ): Promise<EvalResult<T>>;
  eval<T = unknown>(options: EvalCallOptions): Promise<EvalResult<T>>;
  query<T = unknown>(options: QueryOptions): Promise<QueryResult<T>>;
  query<T = unknown>(
    input: CompileInput,
    selector: QuerySelector,
    options?: QueryShortcutOptions,
  ): Promise<QueryResult<T>>;
  queryOne<T = unknown>(options: QueryOptions): Promise<QueryOneResult<T>>;
  queryOne<T = unknown>(
    input: CompileInput,
    selector: QuerySelector,
    options?: QueryShortcutOptions,
  ): Promise<QueryOneResult<T>>;
  info<T = unknown>(options?: InfoOptions): Promise<InfoResult<T>>;
  completions(
    shell: TypstShell,
    options?: CompletionsOptions,
  ): Promise<CompletionsResult>;
  watch(options: WatchOptions): Promise<TypstWatchHandle>;
  diagnose(): Promise<DiagnoseReport>;
}
```

`pdf`, `png`, `svg` and `html` are shortcuts over an in-memory `compile()`
that return the value most callers want: a PDF `Buffer`, one PNG `Buffer` per
page, one SVG string per page, or the HTML document string (the `html` feature
is implied). They accept every compile option except `input`, `output`,
`format`, `depsPath` and `depsFormat`; use `compile()` when you need the
process record, file output or the dependency list.

```ts
export interface CompileManyOptions {
  concurrency?: number;
  signal?: AbortSignal;
}
export type CompileManySettled =
  { ok: true; result: CompileResult } | { ok: false; error: TypstError };
export interface EvalCallOptions extends EvalOptions {
  expression: string;
}
export type QueryShortcutOptions = Omit<QueryOptions, "input" | "selector">;
export type CompileShortcutOptions = Omit<
  CompileOptions,
  "input" | "output" | "format" | "depsPath" | "depsFormat"
>;
```

`compileMany(jobs, options)` compiles several documents with at most
`concurrency` Typst processes at once (default: the number of CPUs, capped at
4). It never rejects because a document failed: every job settles to
`{ ok: true, result }` or `{ ok: false, error }` in the order of `jobs`, where
`error` is a `TypstError`. The batch `signal` aborts running compiles and fails
the ones that have not started with `TypstAbortError`; a job's own `signal`
keeps working alongside it.

`compile(input, output, options?)` is the file-to-file form of
`typst compile <input> <output>`. A `.pdf` or `.html` destination is typed as
exactly one file; page templates and an explicit `format` keep an array. For
in-memory output use the `pdf()`/`png()`/`svg()`/`html()` shortcuts.

`query` and `queryOne` also accept `(input, selector, options?)`, and `eval`
also accepts a single `{ expression, ...options }` object. Both forms are
equivalent to the canonical ones.

### Module-level functions

```ts
export function configure(options?: CreateTypstOptions): void;
export function defaultClient(): Promise<TypstClient>;
export const compile: TypstClient["compile"];
export const compileMany: TypstClient["compileMany"];
export const pdf: TypstClient["pdf"];
export const png: TypstClient["png"];
export const svg: TypstClient["svg"];
export const html: TypstClient["html"];
export const query: TypstClient["query"];
export const queryOne: TypstClient["queryOne"];
export const watch: TypstClient["watch"];
export const fonts: TypstClient["fonts"];
```

The module-level functions forward to one shared client, created on first use
with the options last passed to `configure()` (or the defaults). `configure()`
validates its options at once and may be called at any time; the next call
then creates a fresh client. A failed creation is not cached. The functions
have exactly the overloads of the client methods. `defaultClient()` exposes the
shared client for everything else (`eval`, `version`, `diagnose`, …).

### Extra arguments and open vocabularies

```ts
export interface TypstExtraArgsOptions {
  extraArgs?: readonly string[];
}
export type PdfStandard = "1.7" | "a-2b" | "a-2u" | /* … */ (string & {});
export type TypstFeature = "html" | "bundle" | "a11y-extras" | (string & {});
```

Every high-level option set extends `TypstExtraArgsOptions`. `extraArgs` are
appended before the positional arguments without validation or version gating;
they are the escape hatch for flags a newer Typst added before this package
supports them. `PdfStandard` and `TypstFeature` list the known values for
autocompletion but accept any string, so new standards and features work at
once. Known features stay version-gated; unknown feature names are passed to
the compiler unchecked.

### Input helpers

```ts
export function source(
  data: string | Uint8Array,
  virtualPath?: string,
): CompileSourceInput;
export function jsonInput(value: unknown): string;
```

A plain string input is always a file path. `source()` wraps Typst markup
instead. When a string input is evidently markup, the call fails before spawn
with `TypstInvalidArgumentError` and a hint to use `source()`: a string with a
line break is never accepted as a path, and a single line that starts like
markup (`= `, `#set`, `#show`, `#let`, `#import`, `#include`, `[`) is reported
only when no such file exists.

`sys.inputs` only carries strings. `jsonInput()` encodes a JSON value
(`undefined`, functions and cycles are rejected); decode it in the document
with `json(bytes(sys.inputs.key))`.

### Warnings

Successful `compile`, `query`, `queryOne` and `eval` results carry
`warnings: readonly TypstDiagnostic[]`, parsed from stderr on a best-effort
basis. Parsing never fails a call: unrecognised output yields an empty list,
and the raw stderr on `process` stays authoritative.

The `compile` overloads are purely a typing convenience and change no runtime
behavior. A statically known destination selects the output kind:

- a string or `{ kind: "file" }` destination yields `CompileFileOutput`
  entries;
- an omitted destination or `{ kind: "memory" }` yields `CompileMemoryOutput`
  entries;
- an explicit `format: "pdf" | "html"` additionally proves a single artifact,
  so the result is a one-element tuple;
- PNG, SVG, bundle, a format inherited from a dynamic value, or a dynamic
  destination keep an array or the full `CompileOutput` union.

The wrapper never promises a single result for a page-per-file format. Use
`expectSingleOutput` only when the format is known to emit one file.

`query<T>`, `queryOne<T>`, `eval<T>`, and `info<T>` are consumer
assertions: the wrapper decodes JSON and the generic describes the decoded
shape. No runtime schema validation is performed; `raw` and the raw stderr
retained in `process` remain authoritative, and callers may validate with an
external library.

`eval` is implemented from exact `0.15.0`; `update()` stays absent (the
package manager owns the executable version). `compile()` returns
`dependencies` when `depsPath` is requested.

## Diagnosis

```ts
export interface DiagnoseIssue {
  code: string;
  message: string;
}

export interface DiagnoseReport {
  executable: string;
  executableSource: ExecutableSource;
  compilerVersion: string;
  version: TypstVersionInfo;
  support: TypstSupport;
  capabilities: TypstCapabilities;
  host: { platform: NodeJS.Platform; arch: string };
  launcherAvailable: boolean;
  cwd: string;
  issues: readonly DiagnoseIssue[];
}
```

`diagnose()` reports the executable path and discovery source, the exact
compiler version, the support level and capabilities resolved for it, the host
platform/arch, whether the optional `@flukxr/typst-cli` launcher is installed,
and a list of best-effort issues. Known issue codes include
`LAUNCHER_NOT_INSTALLED` (implicit sources only), `EXECUTABLE_FROM_PATH`
(version may change with the system installation), `UNKNOWN_COMPILER_VERSION`
(version outside the release inventory), `ASSUMED_VERSION_RULES` (rules of an
older release applied under `unknownVersionPolicy: "assume-latest-known"`),
and `UNTESTED_PLATFORM` (no committed high-level sweep evidence for the
current host). The report never fabricates
evidence; it only summarizes what discovery, version parsing, and the registry
already know.

## Version info

```ts
export type ExactTypstVersion = `${bigint}.${bigint}.${bigint}`;

export interface TypstVersionInfo {
  raw: string;
  version: string;
  stableVersion: ExactTypstVersion;
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
  commit?: string;
}
```

`version` is the full reported string including any prerelease/build suffix;
`stableVersion` is the exact `major.minor.patch` core.

Never model versions as a number.

## Run result

```ts
export interface TypstProcessResult {
  executable: string;
  args: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  diagnostics?: readonly TypstDiagnostic[];
}
```

`run()` resolves for every successfully spawned process that reaches a natural
exit, including a non-zero exit code or signal exit. Callers inspect the raw
record; the method does not reinterpret Typst's CLI surface.

Spawn failure, timeout, and abort throw typed process errors carrying the
normalised record and all output captured before termination. High-level
methods interpret unsuccessful exits and throw their command error type.

`stdoutBytes`/`stderrBytes` are the total bytes observed on each captured
stream, even when a capture limit retained only a tail. For buffered commands
they equal `stdout.length`/`stderr.length` (and are `0` when the stream is not
piped) and the truncation flags are `false`. The long-lived `watch()` runner
bounds its final record to 1 MiB per stream by default; when that limit is
exceeded, `stdoutTruncated`/`stderrTruncated` are `true`,
`stdout`/`stderr` contain the retained tail, and the streaming `output` events
still carry every chunk. Truncation is never silent: one `output_truncated`
log event per stream reports the total and dropped bytes.

## Capabilities

```ts
export type CapabilityState =
  "supported" | "unsupported" | "experimental" | "unknown";

export interface CapabilityBehaviorChange {
  version: ExactTypstVersion;
  change: string;
}

export interface TypstCapability {
  state: CapabilityState;
  since?: ExactTypstVersion;
  deprecatedIn?: ExactTypstVersion;
  removedIn?: ExactTypstVersion;
  behaviorChanges?: readonly CapabilityBehaviorChange[];
}

export interface CapabilityRegistryEvidence {
  status: "seed" | "verified";
  verifiedOnPlatform: NodeJS.Platform;
  verifiedOnArch: string;
  checkedAt: string;
  warning?: string;
}

export interface TypstCapabilities {
  compilerVersion: string;
  level: SupportLevel;
  commands: Readonly<Record<string, TypstCapability>>;
  formats: Readonly<Record<string, TypstCapability>>;
  options: Readonly<Record<string, TypstCapability>>;
  evidence: {
    registry?: CapabilityRegistryEvidence;
    probe?: TypstProcessResult;
  };
}
```

`unsupported` is a known absence. `unknown` means the available evidence does
not establish support. An unknown compiler version does not inherit capability
states from the nearest older release. An opt-in help probe retains its raw
process result in `evidence.probe`.

## Compilation

```ts
export type TypstOutputFormat = "pdf" | "png" | "svg" | "html" | "bundle";

export type CompileInput =
  | string
  | { kind: "file"; path: string }
  | {
      kind: "source";
      data: string | Uint8Array;
      virtualPath?: string;
    }
  | {
      kind: "project";
      files: Readonly<Record<string, string | Uint8Array>>;
      main?: string; // defaults to "main.typ"
    };

export type CompileDestination =
  string | { kind: "memory" } | { kind: "file"; path: string };
```

A `project` input is a multi-file project held in memory. Its files are
written below a private temporary directory that is passed as `--root` and
removed on every exit path, so `#import` and `#image` resolve between the
files. File names must be safe relative paths, `main` must be one of them, and
combining a project with `root` is rejected. `compile`, `query` and `eval`
accept project inputs; `watch` does not, because it needs real files.

A plain string input is a shorthand for `{ kind: "file", path }`; a plain
string destination is a shorthand for `{ kind: "file", path }`. The full
discriminated forms remain the canonical representation inside the wrapper, so
string shorthands receive identical validation, version gating, and result
handling.

```ts
export interface CompileOptions
  extends
    Omit<RunOptions, "stdin" | "stdio">,
    TypstWorldOptions,
    TypstExtraArgsOptions {
  input: CompileInput;
  output?: CompileDestination;
  format?: TypstOutputFormat;
  pages?: readonly string[];
  ppi?: number;
  pdfStandards?: readonly PdfStandard[]; // "a-2b" | "ua-1" | … | (string & {})
  pretty?: boolean;
  noPdfTags?: boolean;
  depsPath?: string;
  depsFormat?: "json" | "zero" | "make";
}

export type TypstDepsFormat = "json" | "zero" | "make";

export interface CompileDependencies {
  format: TypstDepsFormat;
  path?: string;
  data: Buffer;
}

export interface CompileResult {
  format: TypstOutputFormat;
  outputs: readonly CompileOutput[];
  dependencies?: CompileDependencies;
  warnings: readonly TypstDiagnostic[];
  process: TypstProcessResult;
  compilerVersion: string;
}

export type CompileOutput =
  | {
      kind: "file";
      path: string;
      page?: number;
      mediaType?: string;
      relativePath?: string;
    }
  | {
      kind: "memory";
      data: Buffer;
      page?: number;
      mediaType?: string;
      relativePath?: string;
    };
```

### Result typing and output helpers

The statically known destination overloads narrow `outputs` to file or memory
entries, and a static PDF/HTML format narrows a single result, so the canonical
"source to Buffer" call needs no cast:

```ts
const { outputs } = await typst.compile({
  input: source("= Hello"),
});
const pdf: Buffer = outputs[0].data; // statically inferred
```

File destinations are equally explicit:

```ts
const { outputs: files } = await typst.compile({
  input: "main.typ",
  output: "out.pdf",
  format: "pdf",
});
const path: string = files[0].path; // one-element tuple
```

For calls where the destination kind is not statically known, four small
helpers are exported:

```ts
export function isMemoryOutput(
  output: CompileOutput,
): output is CompileMemoryOutput;
export function isFileOutput(
  output: CompileOutput,
): output is CompileFileOutput;
export function expectSingleOutput(result: CompileResult): CompileOutput;
export function expectSingleMemoryOutput(
  result: CompileResult,
): CompileMemoryOutput;
```

`expectSingleOutput` and `expectSingleMemoryOutput` throw
`TypstUnexpectedResultError` when the result carries zero or several outputs
(the latter also when the single output is a file). Only use them for formats
that emit a single artifact (PDF and HTML); PNG/SVG/bundle legitimately
produce several outputs. These helpers never hide or alter the raw
`process` record.

### Per-format option validity

`CompileOptions` is one broad type on purpose; option/format combinations are
enforced at runtime before spawn (and version-gated per exact compiler
version). The meaningful rules:

| Option           | Allowed formats  | Notes                             |
| ---------------- | ---------------- | --------------------------------- |
| `pdfStandards`   | `pdf` only       | rejected before spawn otherwise   |
| `ppi`            | `png`            | raster density; ignored by others |
| `pages`          | all formats      | page selection, from 0.12.0       |
| `depsPath: "-"`  | file output only | conflicts with in-memory output   |
| `bundle` feature | `bundle`         | implied by bundle output          |
| `html` feature   | `html`           | implied by HTML output            |

The world options are gated identically for every command. The font switches
were verified on the real binaries at their adjacent boundaries:
`--ignore-system-fonts` is absent in `0.11.1` and present in `0.12.0`, and
`--ignore-embedded-fonts` is absent in `0.13.1` and present in `0.14.0`, for
`compile`, `query` and `watch` alike.

`creationTimestamp` is a `Date` or a number of **seconds** since the Unix
epoch, like `SOURCE_DATE_EPOCH`. Numbers beyond year 9999 are rejected as
probable milliseconds (`Date.now()`), so a unit mistake cannot silently produce
a wrong date.

PNG and SVG pages, and bundles, written to a file destination are rendered into a private
staging directory and moved into the destination only after a successful
compile. A failed compile never touches the destination, and files the run did
not produce are never deleted. Page numbers come from the `{p}`/`{0p}`/`{n}`
placeholder of the template, never from guessing at the file name.

An omitted `output` means `{ kind: "memory" }`. For memory output, an omitted
`format` means PDF. For file output, an omitted format is inferred from a
recognized destination extension; if that is impossible, validation fails
before spawning Typst. An explicit format always wins.

Compilation owns stdin according to the exact-version source strategy, so
`CompileOptions` deliberately omits the raw `stdin` and `stdio` escape hatches.

`outputs` is ordered and represents both single-output and multi-page results.
When a format emits separate page artifacts, the wrapper assigns deterministic
paths and page numbers. A discriminated result contains either `path` or `data`,
never both. Separate `compileFile`, `compileSource`, `compileToBuffer`, and
`compilePages` aliases are intentionally absent from the current API.

In-memory PDF output uses the compiler's positional stdout form from exact
`0.12.0`. In-memory PNG and SVG use the same stdout path for a document that
turns out to have one page; a multi-page document makes the compiler exit
unsuccessfully without writing to stdout and emit the documented
`cannot export multiple images to stdout` diagnostic, and the wrapper then
retries with deterministic temporary page files. Only that exact diagnostic is
retried: syntax errors and other failures with empty stdout keep their original
process record and are never compiled twice. An explicit `pages` selection
always uses the page-file strategy so every output keeps an unambiguous page
number. Before `0.12.0` in-memory PNG/SVG also use temporary page files.

Bundle output (experimental from exact `0.15.0`) is a multi-file directory. A
file destination path is the bundle root; memory output compiles into a
temporary root and reads the files back as Buffers. Every bundle entry carries a
forward-slash `relativePath` relative to the bundle root and a best-effort
`mediaType` derived from the file extension. The `bundle` feature flag is always
required by the compiler and is implied by `format: "bundle"`. Bundle cannot be written to
stdout.

Dependency lists are generated from `0.12.0`. Before `0.14.0` the compiler only
supports the Makefile form (`--make-deps`), so `depsFormat` must be omitted or
`"make"`. From `0.14.0` the modern `--deps`/`--deps-format` flags are used with
`json` (default), `zero`, and `make` formats. A `depsPath` of `-` streams the
list to stdout and requires a file output destination (the compiler rejects
both output and dependencies on stdout). The raw dependency content is returned
as `dependencies.data`, with `path` set when a real file was written.

```ts
const pdf = await typst.compile({
  input: source("= Hello"),
});

const pngs = await typst.compile({
  input: { kind: "file", path: "document.typ" },
  output: { kind: "file", path: "document.png" },
  format: "png",
});

const withDeps = await typst.compile({
  input: { kind: "file", path: "main.typ" },
  output: { kind: "file", path: "out.pdf" },
  depsPath: "deps.json",
  depsFormat: "json",
});
```

From exact `0.15.0`, `--pretty` pretty-prints HTML, SVG, and PDF output (PNG
is unaffected). From exact `0.14.0`, `noPdfTags` disables the tagged-PDF
accessibility baseline that is otherwise written by default.

## Fonts

```ts
export interface FontsOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {
  fontPaths?: readonly string[];
  variants?: boolean;
  ignoreSystemFonts?: boolean;
  ignoreEmbeddedFonts?: boolean;
}

export interface FontsResult {
  raw: string;
  families?: readonly string[];
  process: TypstProcessResult;
  compilerVersion: string;
}
```

The raw `typst fonts` output text is the stable result. `families` is a
best-effort list of discovered font family names in output order: without
`--variants` every non-empty line is a family; with `--variants` the unindented
block header is the family. Parsing never fails the call and an unrecognized
format omits `families`; `raw` always remains authoritative. Version gating
follows verified snapshots: `--font-path` is root-level before `0.7.0` and
command-level from `0.7.0`; `--ignore-system-fonts` exists from `0.12.0`;
`--ignore-embedded-fonts` from `0.14.0`; `--variants` from `0.1.0`. An
unsuccessful exit throws `TypstFontsError` with the raw process record.
Structured parsing is not part of the contract until exact per-version formats
are verified.

## Init

```ts
export interface InitOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {
  template: string;
  directory?: string;
  packagePath?: string;
  packageCachePath?: string;
}

export interface InitResult {
  directory?: string;
  process: TypstProcessResult;
  compilerVersion: string;
}
```

`init()` runs `typst init <TEMPLATE> [DIR]` to scaffold a project from a
template. The command exists from `0.11.0`; `--package-path` and
`--package-cache-path` are gated at `0.12.0`.

Destination handling is safe by construction. When `directory` is provided it is
resolved against the effective working directory and, if the resolved path
already exists, the call throws `TypstInitConflictError` before spawning because
the compiler refuses to overwrite an existing project directory. When `directory`
is omitted the compiler derives the destination from the template's package
name, so no pre-spawn conflict check is possible; a conflicting destination
surfaces as `TypstInitError` carrying the raw process record. Unsuccessful exits
always throw `TypstInitError` with the raw process evidence.

```ts
await typst.init({ template: "@preview/charged-ieee:0.1.0" });
await typst.init({
  template: "@preview/charged-ieee",
  directory: "my-project",
});
```

## Info

```ts
export interface InfoOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {
  format?: "json" | "yaml";
  pretty?: boolean;
}

export interface InfoResult<T = unknown> {
  raw: string;
  data?: T;
  process: TypstProcessResult;
  compilerVersion: string;
}
```

`info<T>()` asserts the decoded JSON report shape when `format: "json"` is
used; as with `query`/`eval`, it is an assertion without runtime validation
and `raw` remains authoritative.

`info()` runs `typst info` to display debugging information about the compiler.
The command exists from `0.14.0`. The raw output text is the stable result.
With `format: "json"` the output is also decoded into `data`, but `raw` always
remains authoritative. The human-readable report truncates the build commit
hash; that truncation is an upstream display behavior and is never used as
structured data. Unsuccessful exits throw `TypstInfoError` with the raw process
record.

```ts
const report = await typst.info();
const json = await typst.info({ format: "json" });
```

## Completions

```ts
export type TypstShell = "bash" | "elvish" | "fish" | "powershell" | "zsh";

export interface CompletionsOptions extends Omit<
  RunOptions,
  "stdin" | "stdio"
> {}

export interface CompletionsResult {
  raw: string;
  process: TypstProcessResult;
  compilerVersion: string;
}
```

`completions(shell)` runs `typst completions <SHELL>` to generate a
shell-completion script. The command exists from `0.14.0`; the shell name is
serialized as a single positional argument, never interpolated. The generated
script text is the stable result. Unknown shells and malformed options fail
before spawn; unsuccessful exits throw `TypstCompletionsError` with the raw
process record.

```ts
const bashCompletions = await typst.completions("bash");
const zshCompletions = await typst.completions("zsh");
```

## Query

```ts
export type QuerySelector = string;

export interface QueryOptions
  extends
    Omit<RunOptions, "stdin" | "stdio">,
    TypstWorldOptions,
    TypstExtraArgsOptions {
  input: CompileInput;
  selector: QuerySelector;
  target?: "paged" | "html" | "bundle"; // the matching feature is implied
  field?: string;
  pretty?: boolean;
}

export interface QueryResult<T = unknown> {
  elements: readonly T[];
  raw: string;
  warnings: readonly TypstDiagnostic[];
  process: TypstProcessResult;
  compilerVersion: string;
}

export interface QueryOneResult<T = unknown> {
  element: T;
  raw: string;
  warnings: readonly TypstDiagnostic[];
  process: TypstProcessResult;
  compilerVersion: string;
}
```

`query<T>()` and `queryOne<T>()` let consumers assert the decoded element
shape: `query<Heading>` returns `QueryResult<Heading>` with
`elements: readonly Heading[]`. `T` is a consumer assertion — the wrapper
decodes JSON but performs no runtime validation, and `raw` always remains
authoritative. With the `field` option, `T` describes the extracted field
values rather than the elements. When no generic is supplied, `T` defaults to
`unknown`, so existing code keeps compiling unchanged.

`query()` exposes one public contract with an internal, version-selected
backend. For exact versions `0.7.0`–`0.14.2` it uses the native `typst query`
command; from `0.15.0` it runs `typst eval query(<SELECTOR>) --in <INPUT>` and
normalises the result in JavaScript. `queryOne()` enforces the exactly-one rule
for both backends and returns the single decoded element. The selector string
is passed as one argument (native) or embedded in the documented eval
expression (eval backend); it is never interpolated through a shell. Output is
always requested as JSON; undecodable output throws `TypstQueryParseError` with
the raw stdout retained.

The eval backend applies the public semantics that native query enforced in the
compiler: `field` extraction keeps only the elements that carry the field, and
`queryOne` requires exactly one match. An exactly-one violation throws
`TypstQueryError`; on `0.15.x` its raw process record is the eval process,
which legitimately exited `0` (the wrapper does not invent an exit code).
Failed evaluations on `0.15.0` exit `0` with no output and are also detected as
`TypstQueryError`.

Version gates follow verified snapshots: `--input` from `0.11.0`;
`--creation-timestamp`, `--package-path`, `--package-cache-path`, and `--jobs`
from `0.12.0`; `--features` from `0.13.0`; `--target` from `0.14.0`; the
`bundle` target from `0.15.0`.

## Eval

```ts
export type TypstSerializationFormat = "json" | "yaml";

export interface EvalOptions
  extends
    Omit<RunOptions, "stdin" | "stdio">,
    TypstWorldOptions,
    TypstExtraArgsOptions {
  input?: CompileInput;
  format?: TypstSerializationFormat;
  target?: "paged" | "html" | "bundle"; // the matching feature is implied
  pretty?: boolean;
}

export interface EvalResult<T = unknown> {
  value?: T;
  raw: string;
  format: TypstSerializationFormat;
  warnings: readonly TypstDiagnostic[];
  process: TypstProcessResult;
  compilerVersion: string;
}
```

`eval<T>()` asserts the decoded JSON shape: `eval<{ pages: number }>` returns
`EvalResult<{ pages: number }>` with `value?: { pages: number }`. As with
`query`, `T` is a consumer assertion without runtime validation; `raw` stays
authoritative, and `value` is absent for `format: "yaml"`.

`eval(expression, options?)` runs `typst eval <EXPRESSION>` from exact
`0.15.0`. The expression is a single positional argument evaluated in code mode
with no scope. When `input` is provided the expression runs in the context of
the compiled document (so `query(...)` observes real content) through `--in`;
source input uses stdin from `0.11.0` and a temporary file otherwise. The
`html` and `bundle` targets need the corresponding feature flag, which is
implied by the target.

The `0.15.1` failure-exit transition is invisible to callers: a successful
eval always serializes a value, so on `0.15.0` a failed evaluation (exit `0`,
empty stdout) is still reported as `TypstEvalError`, and from `0.15.1` the
compiler's exit `1` follows the normal unsuccessful-exit path. `format: "json"`
(default) decodes `value`; `format: "yaml"` retains `raw` only. Undecodable
JSON throws `TypstEvalParseError` with the raw output.

```ts
const total = await typst.eval("1 + 2"); // value: 3
const headings = await typst.eval("query(heading)", {
  input: source("= Hello"),
});
```

## Watch

```ts
export type WatchInput = string | CompileFileInput | CompileSourceInput; // no project inputs

export interface WatchOptions
  extends
    Omit<RunOptions, "stdin" | "stdio">,
    TypstWorldOptions,
    TypstExtraArgsOptions {
  input: WatchInput;
  output?: string | CompileFileDestination;
  format?: "pdf" | "png" | "svg" | "html";
  pages?: readonly string[];
  pdfStandards?: readonly PdfStandard[]; // "a-2b" | "ua-1" | … | (string & {})
  ppi?: number;
  pretty?: boolean;
  noPdfTags?: boolean;
  noServe?: boolean;
  noReload?: boolean;
  port?: number;
  open?: boolean;
}

export interface WatchCycleInfo {
  index: number;
  status: "success" | "error" | "unknown";
  raw: string;
}

export interface TypstWatchEvents {
  start: () => void;
  ready: (cycle: WatchCycleInfo) => void;
  cycle: (cycle: WatchCycleInfo) => void;
  output: (chunk: WatchOutputChunk) => void;
  error: (error: TypstError) => void;
  close: (result: TypstProcessResult) => void;
}

export interface TypstWatchHandle
  extends AsyncDisposable, AsyncIterable<WatchCycleInfo> {
  readonly executable: string;
  readonly executableSource: ExecutableSource;
  readonly compilerVersion: string;
  readonly pid: number | undefined;
  readonly closed: Promise<TypstProcessResult>;
  readonly ready: Promise<WatchCycleInfo>;
  on<K extends keyof TypstWatchEvents>(
    event: K,
    listener: TypstWatchEvents[K],
  ): () => void;
  close(): Promise<TypstProcessResult>;
}
```

The handle is async-iterable over compile cycles:
`for await (const cycle of watcher)` yields every detected cycle and ends when
the watcher settles. Cycles detected before the first loop starts are kept for
it (up to 64), so a loop started right after `watch()` sees the initial cycle.
Leaving the loop early detaches that loop only; it does not stop the watcher.

`ready` resolves with the first detected compile cycle, the same value the
`ready` event carries, so the common case is simply `await watcher.ready`. It
rejects with the typed error that ended the watcher when it settles before a
cycle was detected; an ignored `ready` never becomes an unhandled rejection.
Cycle detection is best effort, so combine `ready` with a timeout for
compilers whose output it does not recognise.

Listeners are isolated from each other: a throwing listener does not skip the
remaining listeners or break the lifecycle, and its exception is rethrown
asynchronously like an uncaught `EventEmitter` listener error. A watcher never
outlives the Node.js process that started it: remaining watch processes are
terminated when the process exits.

`watch()` spawns `typst watch` as a managed long-lived process. Raw stdout and
stderr chunks stream through `output`. The `ready` event reports the first
compile-cycle completion; the `cycle` event reports every detected compile
cycle (including the first) with a 1-based `index`. Classification is best
effort because the CLI has no machine-readable protocol, and the raw cycle
text is always delivered. Spawn failures, timeout, and abort deliver a typed
error through `error` with raw process evidence, before `close`. A watcher
that terminates on its own with a non-zero exit code or a signal also delivers
a typed `TypstWatchError` (`ERR_TYPST_WATCH`) through `error` before `close`;
an exit requested via `close()` is never treated as a failure. The lifecycle
order is therefore `error` (when applicable) followed by `close`, and `close`
is always the final lifecycle event. `close()` terminates the process tree
(graceful then forced after `terminationGraceMs`) and resolves with the final
raw process record; the handle also supports `await using`.
`closed` resolves with the same final record when the watcher settles for any
reason (close, natural exit, timeout, abort, or spawn failure), and `pid`
exposes the child process id once spawned.

The final record is bounded because a watcher can run for hours and emit many
rebuild cycles. At most 1 MiB of the tail is retained per stream; the record
sets `stdoutTruncated`/`stderrTruncated` and `stdoutBytes`/`stderrBytes` so
truncation is explicit and checkable. `output` events are never truncated and
remain the authoritative byte stream; consumers that need the full log should
persist those events themselves. The `output_truncated` log event, when an
`onLog` hook is configured, is emitted once per truncated stream. Structured
diagnostics are parsed from the retained stderr tail and remain best effort.

Source input is always staged through a temporary file so the watcher has a
real file to observe; the artifact is removed on close, abort, timeout, and
spawn failure. Memory output destinations are rejected before spawn because a
long-lived watcher has no per-cycle memory output contract.

Version gates follow verified snapshots: `--ppi` from `0.5.0`; command-level
`--root`/`--font-path` from `0.7.0`; explicit `--format` from `0.8.0`;
`--input` from `0.11.0`; `--pages`, `--pdf-standard`,
`--creation-timestamp`, `--package-path`, `--package-cache-path`, and
`--jobs` from `0.12.0`; `--features`, HTML format, and the HTML watch server
options (`--no-serve`, `--no-reload`, `--port`) from `0.13.0`; `--no-pdf-tags`
from `0.14.0`; `--pretty` from `0.15.0`.

The HTML watch server options are exposed as `noServe`, `noReload`, and `port`
and require HTML output (they are rejected before spawn otherwise). The server
startup message and URL are human log output, not a stable machine protocol;
`output`/`ready` events carry the raw text without pretending to parse it into
a server contract.

## Run options

```ts
export type RunStdioTarget =
  "pipe" | "ignore" | "inherit" | number | import("node:stream").Stream;

export interface RunStdioOptions {
  stdin?: RunStdioTarget;
  stdout?: RunStdioTarget;
  stderr?: RunStdioTarget;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envMode?: "merge" | "replace";
  timeoutMs?: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
  stdin?: string | Uint8Array;
  stdio?: RunStdioOptions;
  diagnostics?: boolean;
  onLog?: (event: TypstLogEvent) => void;
}
```

`stdio` defaults to `{ stdin: "pipe", stdout: "pipe", stderr: "pipe" }`.
Only a piped stream is captured in `TypstProcessResult.stdout`/`stderr` and
emitted through `onLog`; a file descriptor, stream, `"ignore"`, or `"inherit"`
sends that stream elsewhere and leaves the corresponding result buffer empty.
When stdout or stderr is not piped, `diagnostics` cannot parse that stream.
Supplying `stdin` data together with a non-pipe `stdio.stdin` is rejected before
spawn. The high-level command option types omit `stdin` and `stdio` because the
commands own those streams.

`envMode` defaults to `"merge"`. Client creation merges against
`process.env`; a call merges against the client's effective environment.
`"replace"` makes the `env` object the complete environment at that layer.
An `undefined` property removes the inherited key.

### Opt-in structured diagnostics

`diagnostics: true` parses best-effort structured diagnostics from stderr and
attaches them to the process result (and therefore to every high-level result
or error that carries one). Raw stderr is always retained and remains
authoritative; parsing failures never change the result shape. The parser
understands Typst's severity line (`error:`/`warning:`/`info:`), span header
(`┌─ path:line:column`), source/caret block, and hint blocks (`= hint:`,
`= help:`, `= note:`) as they are emitted today. Upstream may change the
format in any release; unparseable text stays in the raw stderr untouched.

```ts
export type TypstDiagnosticSeverity = "error" | "warning" | "info";

export interface TypstDiagnosticSpan {
  path?: string;
  line?: number;
  column?: number;
}

export interface TypstDiagnosticHint {
  kind: "hint" | "help" | "note";
  message: string;
}

export interface TypstDiagnostic {
  severity: TypstDiagnosticSeverity;
  message: string;
  spans: readonly TypstDiagnosticSpan[];
  hints: readonly TypstDiagnosticHint[];
}
```

### Progress/log hooks

`onLog` receives redaction-safe lifecycle events: `spawn`, `exit`,
`stdout_chunk`/`stderr_chunk`, and `output_truncated`. The event carries no
argument values, source content, or executable paths — `command` is always
`"typst"` and chunks report only their byte length. The raw process result and
the watch `output` events remain the authoritative stream. Hook exceptions are
swallowed so a logging bug can never take down a compile.

```ts
export type TypstLogKind =
  "spawn" | "exit" | "stdout_chunk" | "stderr_chunk" | "output_truncated";

/** Every event carries `timestamp` and `command: "typst"`. */
export type TypstLogEvent =
  | { kind: "spawn"; pid?: number }
  | {
      kind: "exit";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      durationMs: number;
    }
  | {
      kind: "stdout_chunk" | "stderr_chunk";
      stream: "stdout" | "stderr";
      chunkLength: number;
    }
  | {
      kind: "output_truncated";
      stream: "stdout" | "stderr";
      totalBytes: number;
      droppedBytes: number;
    };
```

The union is discriminated by `kind`, so `if (event.kind === "exit")` narrows
to the exit fields. The named variants are exported as `TypstSpawnLogEvent`,
`TypstExitLogEvent`, `TypstChunkLogEvent` and `TypstOutputTruncatedLogEvent`.

Typst is always spawned directly with `shell: false`. Timeout and abort request
graceful tree termination, wait `terminationGraceMs` (1,000 milliseconds by
default), and then request forced termination. POSIX implementations target an
isolated process group. Windows implementations request tree termination
without a shell and fall back to the direct child. Descendant cleanup is best
effort because operating-system access or escaped descendants can make a
complete guarantee impossible.

Natural exit, timeout, and abort share a single-settlement state machine. The
first terminal event wins; once abort or timeout wins, a later process exit does
not convert the operation into success.

## Support

```ts
export interface TypstCoverage {
  readonly minimumKnown: ExactTypstVersion;
  readonly fullySupportedThrough: ExactTypstVersion | null;
  readonly knownVersions: readonly ExactTypstVersion[];
  readonly testedVersions: readonly ExactTypstVersion[];
  readonly supportByVersion: Readonly<Record<string, SupportLevel>>;
}

export interface TypstSupport {
  readonly compilerVersion: string;
  readonly apiVersion: string;
  readonly level: SupportLevel;
  readonly coverage: TypstCoverage;
  readonly tested: boolean;
}
```

`support()` reports how well the detected compiler is covered. `level` is
`"partial"` for every version in the release inventory and `"unknown"` for
anything else; `fullySupportedThrough` advances only on hosts with committed
sweep evidence.

## Executable discovery

```ts
export type ExecutableSource = "explicit" | "package" | "environment" | "path";

export interface ExecutableDiscoverySwitches {
  readonly package?: boolean;
  readonly environment?: boolean;
  readonly path?: boolean;
}

export interface DiscoverTypstExecutableOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly envMode?: EnvironmentMode;
  readonly discovery?: ExecutableDiscoverySwitches;
  readonly verifyExecutable?: boolean;
}

export interface TypstLauncherMetadata {
  readonly packageName: "@flukxr/typst-cli";
  readonly declaredVersion: string;
}

export interface DiscoveredTypstExecutable {
  readonly executable: string;
  readonly source: ExecutableSource;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly launcher?: TypstLauncherMetadata;
}

export interface ExecutableProbeResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly durationMs: number;
  readonly error?: {
    readonly name?: string;
    readonly message: string;
    readonly code?: string;
    readonly errno?: number;
    readonly syscall?: string;
  };
}

export function discoverTypstExecutable(
  options?: DiscoverTypstExecutableOptions,
): Promise<DiscoveredTypstExecutable>;
```

`discoverTypstExecutable()` is the discovery step of `createTypst()` on its
own. A failure lists every candidate it tried in `attempts`.

## Low-level process runner

```ts
export function runProcess(
  executable: string,
  args?: readonly string[],
  options?: RunOptions,
): Promise<TypstProcessResult>;
```

`runProcess()` spawns any executable with `shell: false` and the same timeout,
abort, environment and raw-output rules as the client, without version
awareness.

## Version helpers

```ts
export type VersionComparison = -1 | 0 | 1;

export interface ParsedExactStableVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseExactStableVersion(
  value: string,
): ParsedExactStableVersion;

export function compareParsedExactStableVersions(
  left: ParsedExactStableVersion,
  right: ParsedExactStableVersion,
): VersionComparison;

export function compareExactStableVersions(
  left: string,
  right: string,
): VersionComparison;

export function parseTypstVersionOutput(raw: string): TypstVersionInfo;
```

The helpers compare exact `major.minor.patch` versions only; anything else
throws `InvalidExactStableVersionError`.

## Errors

```ts
/** One unsuccessful discovery attempt. */
export interface ExecutableAttempt {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly path: string;
  readonly outcome:
    "not-found" | "not-regular-file" | "not-executable" | "permission";
  readonly message?: string;
}

export type TypstErrorCode =
  | "ERR_TYPST_ABORT"
  | "ERR_TYPST_COMPILATION"
  | "ERR_TYPST_COMPLETIONS"
  | "ERR_TYPST_EVAL"
  | "ERR_TYPST_EVAL_PARSE"
  | "ERR_TYPST_EXECUTABLE_INTEGRITY"
  | "ERR_TYPST_EXECUTABLE_LAUNCHER"
  | "ERR_TYPST_EXECUTABLE_NOT_EXECUTABLE"
  | "ERR_TYPST_EXECUTABLE_NOT_FOUND"
  | "ERR_TYPST_EXECUTABLE_NOT_REGULAR_FILE"
  | "ERR_TYPST_EXECUTABLE_PACKAGE"
  | "ERR_TYPST_EXECUTABLE_PERMISSION"
  | "ERR_TYPST_EXECUTABLE_PROBE"
  | "ERR_TYPST_FONTS"
  | "ERR_TYPST_INFO"
  | "ERR_TYPST_INIT"
  | "ERR_TYPST_INIT_CONFLICT"
  | "ERR_TYPST_INVALID_ARGUMENT"
  | "ERR_TYPST_INVALID_VERSION"
  | "ERR_TYPST_QUERY"
  | "ERR_TYPST_QUERY_PARSE"
  | "ERR_TYPST_SPAWN"
  | "ERR_TYPST_TIMEOUT"
  | "ERR_TYPST_UNEXPECTED_RESULT"
  | "ERR_TYPST_UNSUPPORTED_FEATURE"
  | "ERR_TYPST_UNSUPPORTED_VERSION"
  | "ERR_TYPST_VERSION_COMMAND"
  | "ERR_TYPST_VERSION_OUTPUT"
  | "ERR_TYPST_VERSION_PARSE"
  | "ERR_TYPST_WATCH";

export class TypstError extends Error {
  readonly code: TypstErrorCode;
  readonly compilerVersion?: string;
  readonly process?: TypstProcessResult;
}

export class TypstInvalidArgumentError extends TypstError {}
export class UnsupportedTypstVersionError extends TypstError {
  readonly actualVersion?: string;
}
export class UnsupportedTypstFeatureError extends TypstError {
  readonly feature: string;
  readonly requiredVersion?: string;
  readonly actualVersion: string;
}

export class TypstProcessError extends TypstError {
  override readonly process: TypstProcessResult;
}
export class TypstSpawnError extends TypstProcessError {
  readonly spawnError?: unknown;
}
export class TypstTimeoutError extends TypstProcessError {}
export class TypstUnexpectedResultError extends TypstError {}
export class TypstAbortError extends TypstProcessError {}
export class TypstCompilationError extends TypstProcessError {
  readonly compilerVersion: string;
}
export class TypstFontsError extends TypstProcessError {
  readonly compilerVersion: string;
}
export class TypstInitError extends TypstProcessError {
  readonly compilerVersion: string;
}
export class TypstInitConflictError extends TypstError {
  readonly directory: string;
  readonly resolved: string;
}
export class TypstInfoError extends TypstProcessError {
  readonly compilerVersion: string;
}
export class TypstCompletionsError extends TypstProcessError {
  readonly compilerVersion: string;
}
export class TypstEvalError extends TypstProcessError {
  readonly compilerVersion: string;
}
export class TypstEvalParseError extends TypstEvalError {
  readonly code: "ERR_TYPST_EVAL_PARSE";
  readonly rawOutput: string;
}
export class TypstQueryError extends TypstProcessError {
  readonly compilerVersion: string;
}
export class TypstQueryParseError extends TypstQueryError {
  readonly code: "ERR_TYPST_QUERY_PARSE";
  readonly rawOutput: string;
}
export class TypstWatchError extends TypstProcessError {
  readonly compilerVersion: string;
}
export class TypstVersionError extends TypstProcessError {
  readonly raw?: string;
}
export class TypstVersionCommandError extends TypstVersionError {}
export class TypstVersionOutputError extends TypstError {
  readonly raw?: string;
}
export class TypstVersionParseError extends TypstVersionError {}

export class TypstExecutableNotFoundError extends TypstError {
  readonly source?: ExecutableSource;
  readonly candidate?: string;
  readonly executablePath?: string;
  readonly attempts: readonly ExecutableAttempt[];
}
export class TypstExecutableNotRegularFileError extends TypstError {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;
}
export class TypstExecutablePermissionError extends TypstError {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;
}
export class TypstExecutableNotExecutableError extends TypstError {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;
}
export class TypstExecutableIntegrityError extends TypstError {
  readonly source: "package";
  readonly executablePath?: string;
  readonly declaredVersion?: string;
  readonly actualVersion?: string;
  readonly probe?: ExecutableProbeResult;
}
export class TypstExecutableProbeError extends TypstExecutableIntegrityError {
  readonly code: "ERR_TYPST_EXECUTABLE_PROBE";
}
export class TypstExecutablePackageError extends TypstError {
  readonly source: "package";
}
export class TypstExecutableLauncherError extends TypstExecutableIntegrityError {
  readonly code: "ERR_TYPST_EXECUTABLE_LAUNCHER";
}

export class InvalidExactStableVersionError extends TypstError {
  readonly value: unknown;
}
```

Every failure the package reports is a `TypstError`, including
`InvalidExactStableVersionError` from the pure version helpers
(`ERR_TYPST_INVALID_VERSION`). `TypstVersionOutputError` is thrown by the pure
`parseTypstVersionOutput()` helper and therefore carries no process record;
`TypstVersionError` and its subclasses are raised by `version()` and always
carry one.

### Error codes

Every `TypstError` carries a stable machine-readable `code`. The codes are
part of the frozen contract and form the closed `TypstErrorCode` union.
Adding a code is a deliberate spec change released in a minor version, so an
exhaustive `switch` should keep a `default` branch; existing codes never
change meaning. The full set:

| Code                                    | Thrown by                            |
| --------------------------------------- | ------------------------------------ |
| `ERR_TYPST_INVALID_ARGUMENT`            | `TypstInvalidArgumentError`          |
| `ERR_TYPST_UNSUPPORTED_VERSION`         | `UnsupportedTypstVersionError`       |
| `ERR_TYPST_UNSUPPORTED_FEATURE`         | `UnsupportedTypstFeatureError`       |
| `ERR_TYPST_SPAWN`                       | `TypstSpawnError`                    |
| `ERR_TYPST_TIMEOUT`                     | `TypstTimeoutError`                  |
| `ERR_TYPST_ABORT`                       | `TypstAbortError`                    |
| `ERR_TYPST_UNEXPECTED_RESULT`           | `TypstUnexpectedResultError`         |
| `ERR_TYPST_COMPILATION`                 | `TypstCompilationError`              |
| `ERR_TYPST_FONTS`                       | `TypstFontsError`                    |
| `ERR_TYPST_INIT`                        | `TypstInitError`                     |
| `ERR_TYPST_INIT_CONFLICT`               | `TypstInitConflictError`             |
| `ERR_TYPST_INFO`                        | `TypstInfoError`                     |
| `ERR_TYPST_COMPLETIONS`                 | `TypstCompletionsError`              |
| `ERR_TYPST_EVAL`                        | `TypstEvalError`                     |
| `ERR_TYPST_EVAL_PARSE`                  | `TypstEvalParseError`                |
| `ERR_TYPST_QUERY`                       | `TypstQueryError`                    |
| `ERR_TYPST_QUERY_PARSE`                 | `TypstQueryParseError`               |
| `ERR_TYPST_WATCH`                       | `TypstWatchError`                    |
| `ERR_TYPST_VERSION_COMMAND`             | `TypstVersionCommandError`           |
| `ERR_TYPST_VERSION_PARSE`               | `TypstVersionParseError`             |
| `ERR_TYPST_VERSION_OUTPUT`              | `TypstVersionOutputError`            |
| `ERR_TYPST_INVALID_VERSION`             | `InvalidExactStableVersionError`     |
| `ERR_TYPST_EXECUTABLE_NOT_FOUND`        | `TypstExecutableNotFoundError`       |
| `ERR_TYPST_EXECUTABLE_NOT_REGULAR_FILE` | `TypstExecutableNotRegularFileError` |
| `ERR_TYPST_EXECUTABLE_PERMISSION`       | `TypstExecutablePermissionError`     |
| `ERR_TYPST_EXECUTABLE_NOT_EXECUTABLE`   | `TypstExecutableNotExecutableError`  |
| `ERR_TYPST_EXECUTABLE_INTEGRITY`        | `TypstExecutableIntegrityError`      |
| `ERR_TYPST_EXECUTABLE_PROBE`            | `TypstExecutableProbeError`          |
| `ERR_TYPST_EXECUTABLE_PACKAGE`          | `TypstExecutablePackageError`        |
| `ERR_TYPST_EXECUTABLE_LAUNCHER`         | `TypstExecutableLauncherError`       |

Prefer `instanceof` checks for control flow; use `code` for stable
serialization, logging, and cross-library routing. Unknown codes from future
versions must not be assumed to mean anything specific.

## Compatibility notes

### Query

```text
Typst 0.7.0 – 0.14.2  -> native query (no query before 0.7.0)
Typst 0.15.0 and later -> eval-based query + JS normalisation
```

The consumer sees one `query()` contract. The backend choice is internal and
selected per exact compiler version; the public results are equivalent and
tested across the boundary. `eval()` is the same command surface users get from
`typst eval` from `0.15.0`.

### Diagnostics

Raw stderr is always retained. Structured diagnostics are implemented as an
opt-in best-effort parse of the human-readable stderr (see "Opt-in structured
diagnostics"); they remain best effort until upstream exposes a stable
machine-readable diagnostics format.

## Contract verification

`npm run freeze:check` compares `spec/public-api.d.ts` with the emitted
`dist/index.d.ts` declaration tree structurally. It resolves re-exports,
normalises import aliases, and compares exported declarations, member types,
optional/readonly modifiers, overloads, generic constraints, heritage clauses,
and return types. An export missing from the spec fails the gate until the
spec declares it, and removed or changed declarations fail; a new member or
overload is reported as an advisory. Additions are compatible and ship in a
minor release; removals and changes need a major release. A deliberate
public change is made by editing `spec/public-api.d.ts` first, then updating
the implementation and running the gate. The spec remains authoritative.
