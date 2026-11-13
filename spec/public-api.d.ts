/// Frozen public contract for @flukxr/typst-api (1.0.0).
/// This file is the reviewable contract. Every public export of the package
/// must appear here with its declared shape. scripts/freeze-check.mjs resolves
/// the emitted dist/index.d.ts declaration tree and fails when exported
/// declarations, member types, optional/readonly modifiers, overloads, generic
/// constraints or return types diverge. Adding, removing, or renaming a public
/// export therefore requires a deliberate spec change.

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
export type EnvironmentMode = "merge" | "replace";

export type RunStdioTarget =
  "pipe" | "ignore" | "inherit" | number | import("node:stream").Stream;

export interface RunStdioOptions {
  readonly stdin?: RunStdioTarget;
  readonly stdout?: RunStdioTarget;
  readonly stderr?: RunStdioTarget;
}

export type CapabilityState =
  "supported" | "unsupported" | "experimental" | "unknown";
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
  readonly diagnostics?: boolean;
  readonly onLog?: (event: TypstLogEvent) => void;
  readonly verifyExecutable?: boolean;
  readonly defaults?: TypstWorldOptions;
}

export interface TypstWorldOptions {
  readonly root?: string;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly fontPaths?: readonly string[];
  readonly ignoreSystemFonts?: boolean;
  readonly ignoreEmbeddedFonts?: boolean;
  readonly packagePath?: string;
  readonly packageCachePath?: string;
  /** Seconds since the Unix epoch, or a `Date`. */
  readonly creationTimestamp?: Date | number;
  readonly jobs?: number;
  readonly features?: readonly TypstFeature[];
}

export interface TypstExtraArgsOptions {
  readonly extraArgs?: readonly string[];
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly envMode?: EnvironmentMode;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string | Uint8Array;
  readonly stdio?: RunStdioOptions;
  readonly diagnostics?: boolean;
  readonly onLog?: (event: TypstLogEvent) => void;
}

export type TypstDiagnosticSeverity = "error" | "warning" | "info";

export interface TypstDiagnosticSpan {
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface TypstDiagnosticHint {
  readonly kind: "hint" | "help" | "note";
  readonly message: string;
}

export interface TypstDiagnostic {
  readonly severity: TypstDiagnosticSeverity;
  readonly message: string;
  readonly spans: readonly TypstDiagnosticSpan[];
  readonly hints: readonly TypstDiagnosticHint[];
}

export type TypstLogKind =
  "spawn" | "exit" | "stdout_chunk" | "stderr_chunk" | "output_truncated";

export interface TypstLogEventBase {
  readonly timestamp: number;
  readonly command: "typst";
}

export interface TypstSpawnLogEvent extends TypstLogEventBase {
  readonly kind: "spawn";
  readonly pid?: number;
}

export interface TypstExitLogEvent extends TypstLogEventBase {
  readonly kind: "exit";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
}

export interface TypstChunkLogEvent extends TypstLogEventBase {
  readonly kind: "stdout_chunk" | "stderr_chunk";
  readonly stream: "stdout" | "stderr";
  readonly chunkLength: number;
}

export interface TypstOutputTruncatedLogEvent extends TypstLogEventBase {
  readonly kind: "output_truncated";
  readonly stream: "stdout" | "stderr";
  readonly totalBytes: number;
  readonly droppedBytes: number;
}

export type TypstLogEvent =
  | TypstSpawnLogEvent
  | TypstExitLogEvent
  | TypstChunkLogEvent
  | TypstOutputTruncatedLogEvent;

export declare function parseDiagnostics(stderr: string): {
  diagnostics: readonly TypstDiagnostic[];
  remainder: string;
};

export interface DiagnoseIssue {
  readonly code: string;
  readonly message: string;
}

export interface DiagnoseReport {
  readonly executable: string;
  readonly executableSource: ExecutableSource;
  readonly compilerVersion: string;
  readonly version: TypstVersionInfo;
  readonly support: TypstSupport;
  readonly capabilities: TypstCapabilities;
  readonly host: { readonly platform: NodeJS.Platform; readonly arch: string };
  readonly launcherAvailable: boolean;
  readonly cwd: string;
  readonly issues: readonly DiagnoseIssue[];
}

export interface TypstVersionInfo {
  readonly raw: string;
  readonly version: string;
  readonly stableVersion: ExactTypstVersion;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly commit?: string;
}

export interface TypstProcessResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly diagnostics?: readonly TypstDiagnostic[];
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
  readonly verifiedOnPlatform: NodeJS.Platform;
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

export interface CompileManyOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

export type CompileManySettled =
  | { readonly ok: true; readonly result: CompileResult }
  | { readonly ok: false; readonly error: TypstError };

export interface CapabilitiesOptions {
  readonly probe?: boolean;
}

export type TypstOutputFormat = "pdf" | "png" | "svg" | "html" | "bundle";

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

export interface CompileProjectInput {
  readonly kind: "project";
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  readonly main?: string;
}

/** A plain string is a shorthand for a file input. */
export type CompileInput =
  string | CompileFileInput | CompileSourceInput | CompileProjectInput;

export type WatchInput = string | CompileFileInput | CompileSourceInput;

export interface CompileMemoryDestination {
  readonly kind: "memory";
}

export interface CompileFileDestination {
  readonly kind: "file";
  readonly path: string;
}

/** A plain string is a shorthand for a file destination. */
export type CompileDestination =
  string | CompileMemoryDestination | CompileFileDestination;

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
  readonly pretty?: boolean;
  readonly noPdfTags?: boolean;
  readonly depsPath?: string;
  readonly depsFormat?: TypstDepsFormat;
}

export type CompileToFileOptions = Omit<CompileOptions, "input" | "output">;

export type SingleFilePath = `${string}.pdf` | `${string}.html`;

export type CompileShortcutOptions = Omit<
  CompileOptions,
  "input" | "output" | "format" | "depsPath" | "depsFormat"
>;

export interface CompileFileOutput {
  readonly kind: "file";
  readonly path: string;
  readonly page?: number;
  readonly mediaType?: string;
  readonly relativePath?: string;
}

export interface CompileMemoryOutput {
  readonly kind: "memory";
  readonly data: Buffer;
  readonly page?: number;
  readonly mediaType?: string;
  readonly relativePath?: string;
}

export type CompileOutput = CompileFileOutput | CompileMemoryOutput;

export interface CompileDependencies {
  readonly format: TypstDepsFormat;
  readonly path?: string;
  readonly data: Buffer;
}

export interface CompileResult {
  readonly format: TypstOutputFormat;
  readonly outputs: readonly CompileOutput[];
  readonly dependencies?: CompileDependencies;
  readonly warnings: readonly TypstDiagnostic[];
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

/** Narrow a `CompileOutput` to the in-memory form, or `false`. */
export declare function isMemoryOutput(
  output: CompileOutput,
): output is CompileMemoryOutput;
/** Narrow a `CompileOutput` to the file form, or `false`. */
export declare function isFileOutput(
  output: CompileOutput,
): output is CompileFileOutput;
/**
 * Assert that a compile produced exactly one output and return it; throws
 * `TypstUnexpectedResultError` otherwise.
 */
export declare function expectSingleOutput(
  result: CompileResult,
): CompileOutput;
/**
 * Assert that a compile produced exactly one in-memory output and return it;
 * throws `TypstUnexpectedResultError` otherwise.
 */
export declare function expectSingleMemoryOutput(
  result: CompileResult,
): CompileMemoryOutput;

export interface FontsOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {
  readonly fontPaths?: readonly string[];
  readonly variants?: boolean;
  readonly ignoreSystemFonts?: boolean;
  readonly ignoreEmbeddedFonts?: boolean;
}

export interface FontsResult {
  readonly raw: string;
  readonly families?: readonly string[];
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export interface InitOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {
  readonly template: string;
  readonly directory?: string;
  readonly packagePath?: string;
  readonly packageCachePath?: string;
}

export interface InitResult {
  readonly directory?: string;
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export interface InfoOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {
  readonly format?: "json" | "yaml";
  readonly pretty?: boolean;
}

export interface InfoResult<T = unknown> {
  readonly raw: string;
  readonly data?: T;
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export type TypstShell = "bash" | "elvish" | "fish" | "powershell" | "zsh";

export interface CompletionsOptions
  extends Omit<RunOptions, "stdin" | "stdio">, TypstExtraArgsOptions {}

export interface CompletionsResult {
  readonly raw: string;
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export type QuerySelector = string;

export interface EvalOptions
  extends
    Omit<RunOptions, "stdin" | "stdio">,
    TypstWorldOptions,
    TypstExtraArgsOptions {
  readonly input?: CompileInput;
  readonly format?: TypstSerializationFormat;
  readonly target?: "paged" | "html" | "bundle";
  readonly pretty?: boolean;
}

export interface EvalCallOptions extends EvalOptions {
  readonly expression: string;
}

export interface EvalResult<T = unknown> {
  readonly value?: T;
  readonly raw: string;
  readonly format: TypstSerializationFormat;
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

export type QueryShortcutOptions = Omit<QueryOptions, "input" | "selector">;

export interface QueryResult<T = unknown> {
  readonly elements: readonly T[];
  readonly raw: string;
  readonly warnings: readonly TypstDiagnostic[];
  readonly process: TypstProcessResult;
  readonly compilerVersion: string;
}

export interface QueryOneResult<T = unknown> {
  readonly element: T;
  readonly raw: string;
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
  /** A plain string is a shorthand for a file destination. */
  readonly output?: string | CompileFileDestination;
  readonly format?: "pdf" | "png" | "svg" | "html";
  readonly pages?: readonly string[];
  readonly pdfStandards?: readonly PdfStandard[];
  readonly ppi?: number;
  readonly pretty?: boolean;
  readonly noPdfTags?: boolean;
  readonly noServe?: boolean;
  readonly noReload?: boolean;
  readonly port?: number;
  readonly open?: boolean;
}

export interface WatchOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly chunk: Buffer;
}

export interface WatchCycleInfo {
  readonly index: number;
  readonly status: "success" | "error" | "unknown";
  readonly raw: string;
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

/** Wrap Typst markup as an in-memory source input. */
export declare function source(
  data: string | Uint8Array,
  virtualPath?: string,
): CompileSourceInput;

/** Encode a value for `inputs`; decode with `json(bytes(sys.inputs.key))`. */
export declare function jsonInput(value: unknown): string;

export declare function createTypst(
  options?: CreateTypstOptions,
): Promise<TypstClient>;

// Module-level functions backed by one shared client.

/** Configure the shared client; may be called at any time. */
export declare function configure(options?: CreateTypstOptions): void;
/** The shared client, created on first use with the configured options. */
export declare function defaultClient(): Promise<TypstClient>;
export declare const compile: TypstClient["compile"];
export declare const compileMany: TypstClient["compileMany"];
export declare const pdf: TypstClient["pdf"];
export declare const png: TypstClient["png"];
export declare const svg: TypstClient["svg"];
export declare const html: TypstClient["html"];
export declare const query: TypstClient["query"];
export declare const queryOne: TypstClient["queryOne"];
export declare const watch: TypstClient["watch"];
export declare const fonts: TypstClient["fonts"];

// Executable discovery.

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

export declare function discoverTypstExecutable(
  options?: DiscoverTypstExecutableOptions,
): Promise<DiscoveredTypstExecutable>;

// Low-level process runner.

export declare function runProcess(
  executable: string,
  args?: readonly string[],
  options?: RunOptions,
): Promise<TypstProcessResult>;

// Exact version helpers.

export type VersionComparison = -1 | 0 | 1;

export interface ParsedExactStableVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export declare function parseExactStableVersion(
  value: string,
): ParsedExactStableVersion;

export declare function compareParsedExactStableVersions(
  left: ParsedExactStableVersion,
  right: ParsedExactStableVersion,
): VersionComparison;

export declare function compareExactStableVersions(
  left: string,
  right: string,
): VersionComparison;

export declare function parseTypstVersionOutput(raw: string): TypstVersionInfo;

// Errors.

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

export declare class TypstError extends Error {
  readonly code: TypstErrorCode;
  readonly compilerVersion?: string;
  readonly process?: TypstProcessResult;
}

export declare class TypstInvalidArgumentError extends TypstError {}
export declare class UnsupportedTypstVersionError extends TypstError {
  readonly actualVersion?: string;
}
export declare class UnsupportedTypstFeatureError extends TypstError {
  readonly feature: string;
  readonly requiredVersion?: string;
  readonly actualVersion: string;
}

export declare class TypstProcessError extends TypstError {
  override readonly process: TypstProcessResult;
}
export declare class TypstSpawnError extends TypstProcessError {
  readonly spawnError?: unknown;
}
export declare class TypstTimeoutError extends TypstProcessError {}
export declare class TypstUnexpectedResultError extends TypstError {}
export declare class TypstAbortError extends TypstProcessError {}
export declare class TypstCompilationError extends TypstProcessError {
  readonly compilerVersion: string;
}
export declare class TypstFontsError extends TypstProcessError {
  readonly compilerVersion: string;
}
export declare class TypstInitError extends TypstProcessError {
  readonly compilerVersion: string;
}
export declare class TypstInitConflictError extends TypstError {
  readonly directory: string;
  readonly resolved: string;
}
export declare class TypstInfoError extends TypstProcessError {
  readonly compilerVersion: string;
}
export declare class TypstCompletionsError extends TypstProcessError {
  readonly compilerVersion: string;
}
export declare class TypstEvalError extends TypstProcessError {
  readonly compilerVersion: string;
}
export declare class TypstEvalParseError extends TypstEvalError {
  readonly code: "ERR_TYPST_EVAL_PARSE";
  readonly rawOutput: string;
}
export declare class TypstQueryError extends TypstProcessError {
  readonly compilerVersion: string;
}
export declare class TypstQueryParseError extends TypstQueryError {
  readonly code: "ERR_TYPST_QUERY_PARSE";
  readonly rawOutput: string;
}
export declare class TypstWatchError extends TypstProcessError {
  readonly compilerVersion: string;
}
export declare class TypstVersionError extends TypstProcessError {
  readonly raw?: string;
}
export declare class TypstVersionCommandError extends TypstVersionError {}
export declare class TypstVersionOutputError extends TypstError {
  readonly raw?: string;
}
export declare class TypstVersionParseError extends TypstVersionError {}

export declare class TypstExecutableNotFoundError extends TypstError {
  readonly source?: ExecutableSource;
  readonly candidate?: string;
  readonly executablePath?: string;
  readonly attempts: readonly ExecutableAttempt[];
}
export declare class TypstExecutableNotRegularFileError extends TypstError {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;
}
export declare class TypstExecutablePermissionError extends TypstError {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;
}
export declare class TypstExecutableNotExecutableError extends TypstError {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;
}
export declare class TypstExecutableIntegrityError extends TypstError {
  readonly source: "package";
  readonly executablePath?: string;
  readonly declaredVersion?: string;
  readonly actualVersion?: string;
  readonly probe?: ExecutableProbeResult;
}
export declare class TypstExecutableProbeError extends TypstExecutableIntegrityError {
  readonly code: "ERR_TYPST_EXECUTABLE_PROBE";
}
export declare class TypstExecutablePackageError extends TypstError {
  readonly source: "package";
}
export declare class TypstExecutableLauncherError extends TypstExecutableIntegrityError {
  readonly code: "ERR_TYPST_EXECUTABLE_LAUNCHER";
}

export declare class InvalidExactStableVersionError extends TypstError {
  readonly value: unknown;
}
