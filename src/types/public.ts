import type {
  ExecutableSource,
  ExecutableDiscoverySwitches,
} from "../core/executable.js";
import type {
  EnvironmentMode,
  RunOptions as ProcessRunOptions,
  TypstProcessResult,
} from "../core/process.js";
import type { TypstError } from "../core/errors.js";
import type { TypstDiagnostic, TypstLogEvent } from "../core/diagnostics.js";

export type {
  TypstDiagnostic,
  TypstDiagnosticSeverity,
  TypstDiagnosticSpan,
  TypstDiagnosticHint,
  TypstLogEvent,
  TypstLogKind,
} from "../core/diagnostics.js";

/**
 * An exact stable Typst version: three integer components. `${bigint}` only
 * admits integer literals, so `"0.15"`, `"1.5.2.3"` or `"0.15.1-rc.1"` are
 * rejected at compile time.
 */
export type ExactTypstVersion = `${bigint}.${bigint}.${bigint}`;

/** Experimental compiler features with a known `--features` value. */
export type KnownTypstFeature = "html" | "bundle" | "a11y-extras";

/**
 * A `--features` value. Known features are version-gated; any other name is
 * passed to the compiler unchecked, so a feature added by a newer Typst works
 * before this package knows about it.
 */
export type TypstFeature = KnownTypstFeature | (string & {});

/**
 * A `--pdf-standard` value. `1.7` and `a-2b` exist from exact 0.12.0, `a-3b`
 * from 0.13.0, the others from 0.14.0. Other names are passed to the compiler
 * unchecked, so standards added by a newer Typst work immediately.
 */
export type PdfStandard =
  | "1.4"
  | "1.5"
  | "1.6"
  | "1.7"
  | "2.0"
  | "a-1a"
  | "a-1b"
  | "a-2a"
  | "a-2b"
  | "a-2u"
  | "a-3a"
  | "a-3b"
  | "a-3u"
  | "a-4"
  | "a-4e"
  | "a-4f"
  | "ua-1"
  | (string & {});

export type SupportLevel =
  "full" | "partial" | "experimental" | "untested" | "unavailable" | "unknown";

export type CapabilityState =
  "supported" | "unsupported" | "experimental" | "unknown";

/** How high-level commands treat a compiler version absent from the inventory. */
export type UnknownVersionPolicy = "reject" | "assume-latest-known";

export interface CreateTypstOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly envMode?: EnvironmentMode;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly discovery?: ExecutableDiscoverySwitches;
  readonly unknownVersionPolicy?: UnknownVersionPolicy;
  /**
   * When true, the resolved executable is probed with `--version` and must
   * report a single exact stable Typst compiler version before the client is
   * created. Package-sourced executables are always verified against their
   * declared version; this extends the same check to explicit, environment,
   * and PATH sources.
   */
  readonly verifyExecutable?: boolean;
  /**
   * Client-level default for structured diagnostics. Every high-level command
   * that does not set `diagnostics` on its own options inherits this value.
   */
  readonly diagnostics?: boolean;
  /**
   * Client-level default for the redaction-safe log hook. Every high-level
   * command that does not set `onLog` on its own options inherits this value.
   */
  readonly onLog?: (event: TypstLogEvent) => void;
  /**
   * Client-level project defaults for `compile`, `query`, `eval`, `watch`
   * (and the font switches of `fonts`). A command option always wins over
   * the default; `inputs` objects are merged key by key.
   */
  readonly defaults?: TypstWorldOptions;
}

export type RunOptions = ProcessRunOptions;

/** The raw-argument escape hatch shared by the high-level commands. */
export interface TypstExtraArgsOptions {
  /**
   * Raw CLI arguments added before the positional arguments, without
   * validation or version gating. Use them for flags a newer Typst added
   * before this package supports them; the caller owns their meaning. For a
   * fully raw call use `run(args)`.
   */
  readonly extraArgs?: readonly string[];
}

/**
 * Project ("world") options shared by every compiling command: `compile`,
 * `query`, `eval` and `watch`. Each option is gated on the exact compiler
 * version and rejected with `UnsupportedTypstFeatureError` when the compiler
 * does not support it.
 */
export interface TypstWorldOptions {
  /** Project root for absolute paths inside the document (`--root`). */
  readonly root?: string;
  /** `sys.inputs` key/value pairs (`--input key=value`). */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Additional font directories (`--font-path`). */
  readonly fontPaths?: readonly string[];
  /** Ignore fonts installed on the system; from exact 0.12.0. */
  readonly ignoreSystemFonts?: boolean;
  /** Ignore fonts embedded in the compiler; from exact 0.14.0. */
  readonly ignoreEmbeddedFonts?: boolean;
  /** Custom local package directory (`--package-path`). */
  readonly packagePath?: string;
  /** Custom package cache directory (`--package-cache-path`). */
  readonly packageCachePath?: string;
  /**
   * Document creation time; from exact 0.12.0. A number is **seconds** since
   * the Unix epoch (like `SOURCE_DATE_EPOCH`); millisecond values such as
   * `Date.now()` are rejected. Prefer passing a `Date`.
   */
  readonly creationTimestamp?: Date | number;
  /** Number of parallel compiler jobs (`--jobs`). */
  readonly jobs?: number;
  /**
   * Experimental compiler features (`html`, `bundle`, `a11y-extras`). The
   * feature required by an `html` or `bundle` output/target is added
   * automatically.
   */
  readonly features?: readonly TypstFeature[];
}

export interface TypstVersionInfo {
  readonly raw: string;
  /** The full version string as reported, including any prerelease/build suffix. */
  readonly version: string;
  /** The exact stable core (`major.minor.patch`) of the reported version. */
  readonly stableVersion: ExactTypstVersion;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly commit?: string;
}

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

export interface CapabilityBehaviorChange {
  readonly version: ExactTypstVersion;
  readonly change: string;
}

export interface TypstCapability {
  readonly state: CapabilityState;
  readonly since?: ExactTypstVersion;
  readonly deprecatedIn?: ExactTypstVersion;
  readonly removedIn?: ExactTypstVersion;
  readonly behaviorChanges?: readonly CapabilityBehaviorChange[];
}

export interface CapabilityRegistryEvidence {
  readonly status: "seed" | "verified";
  /** The platform on which the registry evidence was verified. */
  readonly verifiedOnPlatform: NodeJS.Platform;
  /** The architecture on which the registry evidence was verified. */
  readonly verifiedOnArch: string;
  readonly checkedAt: string;
  readonly warning?: string;
}

export interface TypstCapabilities {
  readonly compilerVersion: string;
  readonly level: SupportLevel;
  readonly commands: Readonly<Record<string, TypstCapability>>;
  readonly formats: Readonly<Record<string, TypstCapability>>;
  readonly options: Readonly<Record<string, TypstCapability>>;
  readonly evidence: {
    readonly registry?: CapabilityRegistryEvidence;
    readonly probe?: TypstProcessResult;
  };
}

export type TypstOutputFormat = "pdf" | "png" | "svg" | "html" | "bundle";

/** The serialization formats shared by `eval`/`query`/`info` (`json`, `yaml`). */
export type TypstSerializationFormat = "json" | "yaml";

export interface CompileFileInput {
  readonly kind: "file";
  readonly path: string;
}

export interface CompileSourceInput {
  readonly kind: "source";
  readonly data: string | Uint8Array;
  readonly virtualPath?: string;
}

/**
 * A multi-file project held in memory. Every file is written below a private
 * temporary root that is used as `--root` and removed after the call, so
 * `#import "chapter.typ"` and `#image("logo.png")` resolve between the
 * files. Not supported by `watch`, which needs real files to observe.
 */
export interface CompileProjectInput {
  readonly kind: "project";
  /** Project files keyed by relative path (`"main.typ"`, `"img/logo.png"`). */
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  /** The entry file within `files`; defaults to `"main.typ"`. */
  readonly main?: string;
}

/**
 * The compilation input. A plain string is a shorthand for a file input
 * (`{ kind: "file", path }`); the full discriminated form is equivalent.
 */
export type CompileInput =
  string | CompileFileInput | CompileSourceInput | CompileProjectInput;

/** The inputs `watch` accepts: real files or a single staged source. */
export type WatchInput = string | CompileFileInput | CompileSourceInput;

export interface CompileMemoryDestination {
  readonly kind: "memory";
}

export interface CompileFileDestination {
  readonly kind: "file";
  readonly path: string;
}

/**
 * The compilation destination. A plain string is a shorthand for a file
 * destination (`{ kind: "file", path }`); the full discriminated form is
 * equivalent. An omitted destination means memory.
 */
export type CompileDestination =
  string | CompileMemoryDestination | CompileFileDestination;

/** The format used when serializing a compilation's dependency list. */
export type TypstDepsFormat = "json" | "zero" | "make";

export interface CompileOptions
  extends
    Omit<RunOptions, "stdin" | "stdio">,
    TypstWorldOptions,
    TypstExtraArgsOptions {
  readonly input: CompileInput;
  readonly output?: CompileDestination;
  readonly format?: TypstOutputFormat;
  readonly pages?: readonly string[];
  readonly ppi?: number;
  readonly pdfStandards?: readonly PdfStandard[];
  /** Pretty-print produced output (HTML, SVG, and PDF) from exact 0.15.0. */
  readonly pretty?: boolean;
  /** Disable the tagged-PDF accessibility baseline from exact 0.14.0. */
  readonly noPdfTags?: boolean;
  /**
   * File path to which the compilation's dependency list is written.
   * From 0.14.0 the special value `-` streams the dependencies to stdout;
   * before 0.14.0 a real file path is required (`--make-deps`).
   */
  readonly depsPath?: string;
  /** The serialization format for the dependency list; only meaningful from 0.14.0. */
  readonly depsFormat?: TypstDepsFormat;
}

/** Options of the positional `compile(input, output, options)` form. */
export type CompileToFileOptions = Omit<CompileOptions, "input" | "output">;

/** File destinations whose extension proves exactly one output file. */
export type SingleFilePath = `${string}.pdf` | `${string}.html`;

/** Options of the `pdf`/`png`/`svg`/`html` shortcuts. */
export type CompileShortcutOptions = Omit<
  CompileOptions,
  "input" | "output" | "format" | "depsPath" | "depsFormat"
>;

export interface CompileFileOutput {
  readonly kind: "file";
  readonly path: string;
  readonly page?: number;
  readonly mediaType?: string;
  /**
   * Path relative to the bundle root. Present only when `format` is `bundle`;
   * the compiler emits multiple files into one output directory.
   */
  readonly relativePath?: string;
}

export interface CompileMemoryOutput {
  readonly kind: "memory";
  readonly data: Buffer;
  readonly page?: number;
  readonly mediaType?: string;
  /** Path relative to the bundle root. Present only when `format` is `bundle`. */
  readonly relativePath?: string;
}

export type CompileOutput = CompileFileOutput | CompileMemoryOutput;

/** The dependency list produced by a compile that requested `depsPath`. */
export interface CompileDependencies {
  readonly format: TypstDepsFormat;
  /** The path written to, when a real file destination was used. */
  readonly path?: string;
  /** The raw dependency-list content as produced by the compiler. */
  readonly data: Buffer;
}

export interface CompileResult {
  readonly format: TypstOutputFormat;
  readonly outputs: readonly CompileOutput[];
  /** Present only when `depsPath` was requested. */
  readonly dependencies?: CompileDependencies;
  /**
   * Best-effort warnings parsed from the stderr of the successful run. Empty
   * when there were none or the output was not recognised; the raw stderr on
   * `process` stays authoritative.
   */
  readonly warnings: readonly TypstDiagnostic[];
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export interface FontsOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {
  readonly fontPaths?: readonly string[];
  readonly variants?: boolean;
  readonly ignoreSystemFonts?: boolean;
  readonly ignoreEmbeddedFonts?: boolean;
}

export interface FontsResult {
  /** The raw `typst fonts` output text; stable result for every version. */
  readonly raw: string;
  /**
   * Best-effort list of discovered font families, in output order. Parsing is
   * based on the current output shape and never fails the call: unrecognized
   * output simply omits families. `raw` always remains authoritative.
   */
  readonly families?: readonly string[];
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export interface InitOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {
  /** The template spec, e.g. `@preview/charged-ieee` or `@preview/charged-ieee:0.1.0`. */
  readonly template: string;
  /**
   * The project directory. When omitted, the compiler derives it from the
   * template's package name, so a pre-spawn conflict check cannot run.
   */
  readonly directory?: string;
  readonly packagePath?: string;
  readonly packageCachePath?: string;
}

export interface InitResult {
  /**
   * The resolved destination when `directory` was provided. When omitted, the
   * compiler derives the directory from the template, so this is absent.
   */
  readonly directory?: string;
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export interface InfoOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {
  /**
   * Serialize machine-readable output. When omitted the compiler prints a
   * human-readable report that truncates the build commit hash.
   */
  readonly format?: "json" | "yaml";
  /** Pretty-print the serialized output; only applies to JSON. */
  readonly pretty?: boolean;
}

export interface InfoResult<T = unknown> {
  /**
   * The raw `typst info` output text. For `format: "json"` this is also
   * decoded into `data`; the raw text always remains authoritative.
   */
  readonly raw: string;
  /**
   * The decoded JSON report when `format: "json"`; absent otherwise. `T` is
   * a consumer assertion describing the decoded shape; no runtime validation
   * is performed, and `raw` always remains authoritative.
   */
  readonly data?: T;
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export type TypstShell = "bash" | "elvish" | "fish" | "powershell" | "zsh";

export interface CompletionsOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {}

export interface CompletionsResult {
  /** The generated shell-completion script text. */
  readonly raw: string;
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

/**
 * A Typst query selector. The raw string is passed as the single `<SELECTOR>`
 * argument; labels, element names, and function selectors share one surface.
 */
export type QuerySelector = string;

export interface EvalOptions
  extends
    Omit<RunOptions, "stdin" | "stdio">,
    TypstWorldOptions,
    TypstExtraArgsOptions {
  /**
   * A file in whose context to evaluate. When provided, the expression runs
   * against the compiled document so `query(...)`, `locate`, and counters
   * observe real content. When omitted, the expression evaluates standalone.
   */
  readonly input?: CompileInput;
  /** The serialization format; defaults to `json`. */
  readonly format?: TypstSerializationFormat;
  /** The target to compile the context document for. */
  readonly target?: "paged" | "html" | "bundle";
  /** Pretty-print the JSON serialization. */
  readonly pretty?: boolean;
}

/** `eval()` options with the expression inside, for the single-object form. */
export interface EvalCallOptions extends EvalOptions {
  readonly expression: string;
}

export interface EvalResult<T = unknown> {
  /**
   * The decoded JSON value when `format` is `json` (the default). Absent for
   * `yaml`, whose output has no guaranteed decoder. `T` is a consumer
   * assertion describing the decoded shape; no runtime validation is
   * performed, and `raw` always remains authoritative.
   */
  readonly value?: T;
  /** The raw serialized output text as emitted by the compiler. */
  readonly raw: string;
  readonly format: TypstSerializationFormat;
  /**
   * Best-effort warnings parsed from the stderr of the successful run. Empty
   * when there were none or the output was not recognised; the raw stderr on
   * `process` stays authoritative.
   */
  readonly warnings: readonly TypstDiagnostic[];
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export interface QueryOptions
  extends
    Omit<RunOptions, "stdin" | "stdio">,
    TypstWorldOptions,
    TypstExtraArgsOptions {
  readonly input: CompileInput;
  readonly selector: QuerySelector;
  readonly target?: "paged" | "html" | "bundle";
  readonly field?: string;
  readonly pretty?: boolean;
}

/** Options of the positional `query(input, selector, options)` form. */
export type QueryShortcutOptions = Omit<QueryOptions, "input" | "selector">;

export interface QueryResult<T = unknown> {
  /**
   * Decoded JSON array of matched elements (or field values). `T` is a
   * consumer assertion describing each element (or each field value when
   * `field` is set); no runtime validation is performed, and `raw` always
   * remains authoritative.
   */
  readonly elements: readonly T[];
  /** Raw stdout text as emitted by the compiler. */
  readonly raw: string;
  /**
   * Best-effort warnings parsed from the stderr of the successful run. Empty
   * when there were none or the output was not recognised; the raw stderr on
   * `process` stays authoritative.
   */
  readonly warnings: readonly TypstDiagnostic[];
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export interface QueryOneResult<T = unknown> {
  /** The single decoded element (or field value) from `--one`. */
  readonly element: T;
  /** Raw stdout text as emitted by the compiler. */
  readonly raw: string;
  /**
   * Best-effort warnings parsed from the stderr of the successful run. Empty
   * when there were none or the output was not recognised; the raw stderr on
   * `process` stays authoritative.
   */
  readonly warnings: readonly TypstDiagnostic[];
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export interface WatchOptions
  extends
    Omit<RunOptions, "stdin" | "stdio">,
    TypstWorldOptions,
    TypstExtraArgsOptions {
  readonly input: WatchInput;
  /**
   * The file output destination. A plain string is a shorthand for
   * `{ kind: "file", path }`. Memory output is rejected before spawn because
   * a long-lived watcher has no per-cycle memory output contract.
   */
  readonly output?: string | CompileFileDestination;
  readonly format?: "pdf" | "png" | "svg" | "html";
  readonly pages?: readonly string[];
  readonly pdfStandards?: readonly PdfStandard[];
  readonly ppi?: number;
  /** Pretty-print produced output (HTML, SVG, and PDF) from exact 0.15.0. */
  readonly pretty?: boolean;
  /** Disable the tagged-PDF accessibility baseline from exact 0.14.0. */
  readonly noPdfTags?: boolean;
  /** Disable the built-in HTTP server for HTML export from exact 0.13.0. */
  readonly noServe?: boolean;
  /** Disable the injected live-reload script for HTML export from exact 0.13.0. */
  readonly noReload?: boolean;
  /** The port where HTML is served from exact 0.13.0. */
  readonly port?: number;
  readonly open?: boolean;
}

/** A raw output chunk delivered while the watcher is running. */
export interface WatchOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly chunk: Buffer;
}

/**
 * Best-effort classification of one watch compile cycle. Detection is
 * conservative: unknown marker formats never fire this event, and the raw
 * text is always retained alongside the classification. `index` counts
 * detected cycles starting at 1.
 */
export interface WatchCycleInfo {
  readonly index: number;
  readonly status: "success" | "error" | "unknown";
  readonly raw: string;
}

/** Events exposed by a managed `typst watch` process. */
export interface TypstWatchEvents {
  /** The child process has spawned. */
  start: () => void;
  /** The initial compile cycle completed (best effort); fires only once. */
  ready: (cycle: WatchCycleInfo) => void;
  /** Every detected compile cycle completed, including the initial one. */
  cycle: (cycle: WatchCycleInfo) => void;
  /** Raw stdout/stderr chunks as they arrive. */
  output: (chunk: WatchOutputChunk) => void;
  /** Spawn failure, timeout, or abort with raw process evidence. */
  error: (error: TypstError) => void;
  /** The process terminated; carries the final raw process record. */
  close: (result: TypstProcessResult) => void;
}

/**
 * A managed long-lived `typst watch` process. It is async-iterable over the
 * detected compile cycles: `for await (const cycle of watcher)` ends when the
 * watcher settles, and leaving the loop early does not stop the watcher.
 */
export interface TypstWatchHandle
  extends AsyncDisposable, AsyncIterable<WatchCycleInfo> {
  readonly executable: string;
  readonly executableSource: ExecutableSource;
  readonly compilerVersion: string;
  /** The child process id; undefined until the process has spawned. */
  readonly pid: number | undefined;
  /**
   * Resolves with the final process record once the watcher settles for any
   * reason: `close()`, natural exit, timeout, abort, or spawn failure.
   */
  readonly closed: Promise<TypstProcessResult>;
  /**
   * Resolves with the first detected compile cycle (the same value as the
   * `ready` event). Rejects when the watcher settles before a cycle was
   * detected, with the typed error that ended it. Cycle detection is best
   * effort; combine with a timeout for compilers whose output it does not
   * recognise.
   */
  readonly ready: Promise<WatchCycleInfo>;
  on<K extends keyof TypstWatchEvents>(
    event: K,
    listener: TypstWatchEvents[K],
  ): () => void;
  /** Terminate the process tree and resolve with the final process record. */
  close(): Promise<TypstProcessResult>;
}

/** Batch options for `compileMany()`. */
export interface CompileManyOptions {
  /**
   * Maximum compiles running at once. Defaults to the number of available
   * CPUs, capped at 4. Every compile is its own Typst process.
   */
  readonly concurrency?: number;
  /** Aborts running compiles and fails the ones that have not started. */
  readonly signal?: AbortSignal;
}

/** The outcome of one `compileMany()` job, in the order of the jobs. */
export type CompileManySettled =
  | { readonly ok: true; readonly result: CompileResult }
  | { readonly ok: false; readonly error: TypstError };

/** Runtime help probing is opt-in and never upgrades unknown states. */
export interface CapabilitiesOptions {
  readonly probe?: boolean;
}

/** Report produced by `TypstClient.diagnose()`. */
export interface DiagnoseReport {
  /** The absolute path to the compiled binary currently in use. */
  readonly executable: string;
  /** The discovery source that resolved this executable. */
  readonly executableSource: ExecutableSource;
  /** The exact compiler version as reported by `--version`. */
  readonly compilerVersion: string;
  /** SemVer components of the compiler version. */
  readonly version: TypstVersionInfo;
  /** The API's support level for the detected compiler. */
  readonly support: TypstSupport;
  /** Resolved capabilities for the detected compiler. */
  readonly capabilities: TypstCapabilities;
  /** Host platform and architecture. */
  readonly host: { readonly platform: NodeJS.Platform; readonly arch: string };
  /** Whether the optional @flukxr/typst-cli launcher package is installed. */
  readonly launcherAvailable: boolean;
  /** The resolved effective working directory. */
  readonly cwd: string;
  /** Problems detected during diagnosis (e.g., missing optional dependency). */
  readonly issues: readonly DiagnoseIssue[];
}

/** An issue discovered by `diagnose()`. */
export interface DiagnoseIssue {
  readonly code: string;
  readonly message: string;
}

export interface TypstClient {
  readonly executable: string;
  readonly executableSource: ExecutableSource;

  version(): Promise<TypstVersionInfo>;
  support(): Promise<TypstSupport>;
  capabilities(options?: CapabilitiesOptions): Promise<TypstCapabilities>;
  run(
    args: readonly string[],
    options?: RunOptions,
  ): Promise<TypstProcessResult>;
  /**
   * Statically known file destinations narrow `outputs` to file results. An
   * explicit single-artifact format (`pdf` or `html`) additionally guarantees
   * exactly one file; page-per-file formats and formats inferred from a path
   * keep the array because they can produce several files.
   */
  compile(
    options: CompileOptions & {
      output: string | CompileFileDestination;
      format: "pdf" | "html";
    },
  ): Promise<
    CompileResult & { readonly outputs: readonly [CompileFileOutput] }
  >;
  compile(
    options: CompileOptions & { output: string | CompileFileDestination },
  ): Promise<
    CompileResult & { readonly outputs: readonly CompileFileOutput[] }
  >;
  /**
   * Statically known in-memory destinations narrow `outputs` to memory
   * results. The default destination is memory; PDF and HTML produce exactly
   * one result, while PNG, SVG and bundle can produce several.
   */
  compile(
    options: CompileOptions & {
      output?: CompileMemoryDestination | undefined;
      format?: "pdf" | "html" | undefined;
    },
  ): Promise<
    CompileResult & { readonly outputs: readonly [CompileMemoryOutput] }
  >;
  compile(
    options: CompileOptions & {
      output?: CompileMemoryDestination | undefined;
      format: "png" | "svg" | "bundle";
    },
  ): Promise<
    CompileResult & { readonly outputs: readonly CompileMemoryOutput[] }
  >;
  compile(
    options: CompileOptions & { output?: CompileMemoryDestination | undefined },
  ): Promise<
    CompileResult & { readonly outputs: readonly CompileMemoryOutput[] }
  >;
  compile(options: CompileOptions): Promise<CompileResult>;
  /**
   * Positional file-to-file form, mirroring `typst compile <input> <output>`.
   * A `.pdf` or `.html` destination produces exactly one file; other
   * destinations (`.png`/`.svg` page templates, bundles) produce several.
   */
  compile(
    input: CompileInput,
    output: SingleFilePath,
    options?: Omit<CompileToFileOptions, "format">,
  ): Promise<
    CompileResult & { readonly outputs: readonly [CompileFileOutput] }
  >;
  compile(
    input: CompileInput,
    output: string | CompileFileDestination,
    options?: CompileToFileOptions,
  ): Promise<
    CompileResult & { readonly outputs: readonly CompileFileOutput[] }
  >;
  /** Compile to an in-memory PDF. */
  pdf(input: CompileInput, options?: CompileShortcutOptions): Promise<Buffer>;
  /** Compile to in-memory PNG pages, in page order. */
  png(
    input: CompileInput,
    options?: CompileShortcutOptions,
  ): Promise<readonly Buffer[]>;
  /** Compile to SVG pages as UTF-8 strings, in page order. */
  svg(
    input: CompileInput,
    options?: CompileShortcutOptions,
  ): Promise<readonly string[]>;
  /** Compile to an HTML document string; the `html` feature is implied. */
  html(input: CompileInput, options?: CompileShortcutOptions): Promise<string>;
  /**
   * Compile several documents with bounded parallelism. Never rejects for a
   * failed job: every job settles to `{ ok, result }` or `{ ok, error }` in
   * the order of `jobs`.
   */
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
  /** Produce a structured diagnosis of the current executable and environment. */
  diagnose(): Promise<DiagnoseReport>;
}
