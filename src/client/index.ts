import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import {
  discoverTypstExecutable,
  type DiscoveredTypstExecutable,
  type ExecutableSource,
} from "../core/executable.js";
import {
  TypstError,
  TypstInvalidArgumentError,
  TypstProcessError,
  TypstVersionCommandError,
  TypstVersionParseError,
} from "../core/errors.js";
import { applyEnvironment } from "../core/environment.js";
import { compareExactStableVersions } from "../core/version.js";
import { runProcess } from "../core/process.js";
import {
  validateRecord,
  validateRunOptionsObject,
  validateWorldOptions,
} from "../commands/shared.js";
import {
  compileCommand,
  expectSingleMemoryOutput,
} from "../commands/compile.js";
import { completionsCommand } from "../commands/completions.js";
import { evalCommand } from "../commands/eval.js";
import { fontsCommand } from "../commands/fonts.js";
import { infoCommand } from "../commands/info.js";
import { initCommand } from "../commands/init.js";
import { queryCommand } from "../commands/query.js";
import { watchCommand } from "../commands/watch.js";
import { CAPABILITY_REGISTRY } from "../capabilities/registry.js";
import type { CapabilityDefinition } from "../capabilities/types.js";
import {
  highLevelSweepFor,
  KNOWN_TYPST_VERSION_SET,
  KNOWN_TYPST_VERSIONS,
  resolveVersionForRules,
} from "./support-data.js";
import { parseTypstVersionOutput } from "./version.js";
import type {
  CompileToFileOptions,
  SingleFilePath,
  CompileManyOptions,
  CompileManySettled,
  EvalCallOptions,
  QuerySelector,
  QueryShortcutOptions,
  CompileInput,
  CompileShortcutOptions,
  TypstWorldOptions,
  CapabilitiesOptions,
  CapabilityRegistryEvidence,
  CapabilityState,
  CreateTypstOptions,
  CompileMemoryDestination,
  CompileMemoryOutput,
  CompileOptions,
  CompileFileDestination,
  CompileFileOutput,
  CompileResult,
  CompletionsOptions,
  CompletionsResult,
  DiagnoseReport,
  DiagnoseIssue,
  ExactTypstVersion,
  EvalOptions,
  EvalResult,
  FontsOptions,
  FontsResult,
  InfoOptions,
  InfoResult,
  InitOptions,
  InitResult,
  QueryOneResult,
  QueryOptions,
  QueryResult,
  RunOptions,
  SupportLevel,
  TypstCapabilities,
  TypstCapability,
  TypstClient,
  TypstCoverage,
  TypstShell,
  TypstSupport,
  TypstVersionInfo,
  TypstWatchHandle,
  TypstLogEvent,
  UnknownVersionPolicy,
  WatchOptions,
} from "../types/public.js";

const DEFAULT_TERMINATION_GRACE_MS = 1_000;

type MutableEnvironment = Record<string, string>;

let apiVersionCache: string | undefined;

/**
 * The package version reported by `support().apiVersion`. Read from the
 * installed `package.json` so the value can never drift from the shipped
 * package; a missing or malformed manifest falls back conservatively.
 */
function apiVersion(): string {
  if (apiVersionCache === undefined) {
    let resolved = "0.0.0";
    try {
      const manifest = REQUIRE("../../package.json");
      if (
        typeof manifest?.version === "string" &&
        manifest.version.length > 0
      ) {
        resolved = manifest.version;
      }
    } catch {
      // Fall back to the conservative default.
    }
    apiVersionCache = resolved;
  }
  return apiVersionCache;
}

/** Create a version-aware, raw-command Typst client. */
export async function createTypst(
  options: CreateTypstOptions = {},
): Promise<TypstClient> {
  validateCreateOptions(options);
  const discovered = await discoverTypstExecutable({
    ...(options.executable === undefined
      ? {}
      : { executable: options.executable }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.envMode === undefined ? {} : { envMode: options.envMode }),
    ...(options.discovery === undefined
      ? {}
      : { discovery: options.discovery }),
    ...(options.verifyExecutable === undefined
      ? {}
      : { verifyExecutable: options.verifyExecutable }),
  });
  return new TypstClientImpl(discovered, options);
}

class TypstClientImpl implements TypstClient {
  readonly executable: string;
  readonly executableSource: ExecutableSource;
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs: number | undefined;
  readonly terminationGraceMs: number;
  readonly unknownVersionPolicy: UnknownVersionPolicy;
  readonly diagnostics: boolean | undefined;
  readonly onLog: ((event: TypstLogEvent) => void) | undefined;
  readonly defaults: TypstWorldOptions | undefined;

  private readonly baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  private versionPromise: Promise<TypstVersionInfo> | undefined;
  private supportPromise: Promise<TypstSupport> | undefined;
  private capabilitiesPromise: Promise<TypstCapabilities> | undefined;
  private probedCapabilitiesPromise: Promise<TypstCapabilities> | undefined;
  private probePromise: Promise<TypstProcessResultLike> | undefined;

  constructor(
    discovered: DiscoveredTypstExecutable,
    options: CreateTypstOptions,
  ) {
    this.executable = discovered.executable;
    this.executableSource = discovered.source;
    this.cwd = discovered.cwd;
    this.baseEnvironment = cloneEnvironment(discovered.env);
    this.env = this.baseEnvironment;
    this.timeoutMs = options.timeoutMs;
    this.terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.unknownVersionPolicy = options.unknownVersionPolicy ?? "reject";
    this.diagnostics = options.diagnostics;
    this.onLog = options.onLog;
    this.defaults =
      options.defaults === undefined
        ? undefined
        : Object.freeze({ ...options.defaults });
  }

  /**
   * Layer the client-level project defaults under a command's options. A
   * command option always wins; `inputs` are merged key by key. A default
   * `root` is not applied to a project input, which is its own root.
   */
  private withDefaults<
    T extends TypstWorldOptions & { readonly input?: CompileInput },
  >(options: T): T {
    const defaults = this.defaults;
    if (
      defaults === undefined ||
      options === null ||
      typeof options !== "object"
    )
      return options;
    const projectInput =
      typeof options.input === "object" &&
      options.input !== null &&
      options.input.kind === "project";
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(defaults)) {
      if (value === undefined) continue;
      if (key === "root" && projectInput) continue;
      merged[key] = value;
    }
    const result = { ...merged, ...options } as T;
    if (defaults.inputs !== undefined && options.inputs !== undefined) {
      return { ...result, inputs: { ...defaults.inputs, ...options.inputs } };
    }
    return result;
  }

  version(): Promise<TypstVersionInfo> {
    if (this.versionPromise !== undefined) return this.versionPromise;

    const pending = this.readVersion();
    const handled = pending.catch((error: unknown) => {
      if (this.versionPromise === handled) this.versionPromise = undefined;
      throw error;
    });
    this.versionPromise = handled;
    return handled;
  }

  support(): Promise<TypstSupport> {
    if (this.supportPromise !== undefined) return this.supportPromise;

    const pending = this.version().then((version) => buildSupport(version));
    const handled = pending.catch((error: unknown) => {
      if (this.supportPromise === handled) this.supportPromise = undefined;
      throw error;
    });
    this.supportPromise = handled;
    return handled;
  }

  capabilities(options: CapabilitiesOptions = {}): Promise<TypstCapabilities> {
    validateCapabilitiesOptions(options);
    if (this.capabilitiesPromise === undefined) {
      const pending = this.version().then((version) =>
        buildCapabilities(version),
      );
      const handled = pending.catch((error: unknown) => {
        if (this.capabilitiesPromise === handled)
          this.capabilitiesPromise = undefined;
        throw error;
      });
      this.capabilitiesPromise = handled;
    }

    const base = this.capabilitiesPromise;
    if (options.probe !== true) {
      // Once an opt-in probe has run, retain its evidence for all subsequent
      // calls on this client rather than silently returning a less-informative
      // cached view.
      return detachCapabilities(this.probedCapabilitiesPromise ?? base);
    }
    if (this.probedCapabilitiesPromise !== undefined) {
      return detachCapabilities(this.probedCapabilitiesPromise);
    }

    const pending = base.then(async (capabilities) => {
      if (capabilities.level !== "unknown") return capabilities;
      let probe: TypstProcessResultLike;
      try {
        probe = await this.helpProbe();
      } catch (error) {
        // A failed process still has normalised process evidence. Keep the
        // conservative unknown states and expose that raw record to callers.
        if (error instanceof TypstProcessError) {
          probe = cloneProcessResult(error.process);
        } else {
          throw error;
        }
      }
      return withProbeEvidence(capabilities, probe);
    });
    const handled = pending.catch((error: unknown) => {
      if (this.probedCapabilitiesPromise === handled) {
        this.probedCapabilitiesPromise = undefined;
      }
      throw error;
    });
    this.probedCapabilitiesPromise = handled;
    return detachCapabilities(handled);
  }

  async run(
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<TypstProcessResultLike> {
    validateRunOptionsObject(options);
    const envMode = options.envMode ?? "merge";

    const env = applyEnvironment(this.baseEnvironment, options.env, envMode);
    const runOptions: RunOptions = {
      cwd: options.cwd ?? this.cwd,
      env,
      // The client has already resolved its environment layer. Passing
      // replace prevents the low-level runner from reintroducing process.env.
      envMode: "replace",
      ...(options.timeoutMs === undefined
        ? this.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.timeoutMs }
        : { timeoutMs: options.timeoutMs }),
      terminationGraceMs: options.terminationGraceMs ?? this.terminationGraceMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.stdio === undefined ? {} : { stdio: options.stdio }),
      ...(options.diagnostics === undefined
        ? this.diagnostics === undefined
          ? {}
          : { diagnostics: this.diagnostics }
        : { diagnostics: options.diagnostics }),
      ...(options.onLog === undefined
        ? this.onLog === undefined
          ? {}
          : { onLog: this.onLog }
        : { onLog: options.onLog }),
    };

    const argsSnapshot = Array.isArray(args) ? [...args] : args;
    return await runProcess(this.executable, argsSnapshot, runOptions);
  }

  /**
   * Statically known file destinations narrow `outputs` to file results. An
   * explicit single-artifact format (`pdf` or `html`) additionally guarantees
   * exactly one file; page-per-file formats and formats inferred from a path
   * keep the array because they can produce several files.
   */
  async compile(
    options: CompileOptions & {
      output: string | CompileFileDestination;
      format: "pdf" | "html";
    },
  ): Promise<
    CompileResult & { readonly outputs: readonly [CompileFileOutput] }
  >;
  async compile(
    options: CompileOptions & { output: string | CompileFileDestination },
  ): Promise<
    CompileResult & { readonly outputs: readonly CompileFileOutput[] }
  >;
  /**
   * Statically known in-memory destinations narrow `outputs` to memory
   * results. The default destination is memory; PDF and HTML produce exactly
   * one result, while PNG, SVG and bundle can produce several.
   */
  async compile(
    options: CompileOptions & {
      output?: CompileMemoryDestination | undefined;
      format?: "pdf" | "html" | undefined;
    },
  ): Promise<
    CompileResult & { readonly outputs: readonly [CompileMemoryOutput] }
  >;
  async compile(
    options: CompileOptions & {
      output?: CompileMemoryDestination | undefined;
      format: "png" | "svg" | "bundle";
    },
  ): Promise<
    CompileResult & { readonly outputs: readonly CompileMemoryOutput[] }
  >;
  async compile(
    options: CompileOptions & { output?: CompileMemoryDestination | undefined },
  ): Promise<
    CompileResult & { readonly outputs: readonly CompileMemoryOutput[] }
  >;
  async compile(options: CompileOptions): Promise<CompileResult>;
  async compile(
    input: CompileInput,
    output: SingleFilePath,
    options?: Omit<CompileToFileOptions, "format">,
  ): Promise<
    CompileResult & { readonly outputs: readonly [CompileFileOutput] }
  >;
  async compile(
    input: CompileInput,
    output: string | CompileFileDestination,
    options?: CompileToFileOptions,
  ): Promise<
    CompileResult & { readonly outputs: readonly CompileFileOutput[] }
  >;
  async compile(
    first: CompileOptions | CompileInput,
    output?: string | CompileFileDestination,
    options?: CompileToFileOptions,
  ): Promise<CompileResult> {
    return await compileCommand(
      this,
      this.withDefaults(compileArguments(first, output, options)),
    );
  }

  async pdf(
    input: CompileInput,
    options: CompileShortcutOptions = {},
  ): Promise<Buffer> {
    const result = await this.compileShortcut(input, options, "pdf");
    return expectSingleMemoryOutput(result).data;
  }

  async png(
    input: CompileInput,
    options: CompileShortcutOptions = {},
  ): Promise<readonly Buffer[]> {
    const result = await this.compileShortcut(input, options, "png");
    return Object.freeze(memoryOutputs(result).map((output) => output.data));
  }

  async svg(
    input: CompileInput,
    options: CompileShortcutOptions = {},
  ): Promise<readonly string[]> {
    const result = await this.compileShortcut(input, options, "svg");
    return Object.freeze(
      memoryOutputs(result).map((output) => output.data.toString("utf8")),
    );
  }

  async html(
    input: CompileInput,
    options: CompileShortcutOptions = {},
  ): Promise<string> {
    const result = await this.compileShortcut(input, options, "html");
    return expectSingleMemoryOutput(result).data.toString("utf8");
  }

  private async compileShortcut(
    input: CompileInput,
    options: CompileShortcutOptions,
    format: "pdf" | "png" | "svg" | "html",
  ): Promise<CompileResult> {
    validateRecord(options, "compile options");
    const forbidden = ["input", "output", "format", "depsPath", "depsFormat"];
    for (const key of forbidden) {
      if (key in options) {
        throw new TypstInvalidArgumentError(
          `The ${format}() shortcut does not accept ${key}; use compile() instead.`,
        );
      }
    }
    return await this.compile({ ...options, input, format });
  }

  async fonts(options: FontsOptions = {}): Promise<FontsResult> {
    const defaults = this.defaults;
    if (defaults === undefined) return await fontsCommand(this, options);
    return await fontsCommand(this, {
      ...(defaults.fontPaths === undefined
        ? {}
        : { fontPaths: defaults.fontPaths }),
      ...(defaults.ignoreSystemFonts === undefined
        ? {}
        : { ignoreSystemFonts: defaults.ignoreSystemFonts }),
      ...(defaults.ignoreEmbeddedFonts === undefined
        ? {}
        : { ignoreEmbeddedFonts: defaults.ignoreEmbeddedFonts }),
      ...options,
    });
  }

  async init(options: InitOptions): Promise<InitResult> {
    return await initCommand(this, options);
  }

  async eval<T = unknown>(
    expression: string,
    options?: EvalOptions,
  ): Promise<EvalResult<T>>;
  async eval<T = unknown>(options: EvalCallOptions): Promise<EvalResult<T>>;
  async eval<T = unknown>(
    expressionOrOptions: string | EvalCallOptions,
    maybeOptions: EvalOptions = {},
  ): Promise<EvalResult<T>> {
    let expression: string;
    let options: EvalOptions;
    if (
      expressionOrOptions !== null &&
      typeof expressionOrOptions === "object" &&
      !Array.isArray(expressionOrOptions)
    ) {
      const { expression: inner, ...rest } = expressionOrOptions;
      expression = inner;
      options = rest;
    } else {
      expression = expressionOrOptions as string;
      options = maybeOptions;
    }
    return (await evalCommand(
      this,
      expression,
      this.withDefaults(options),
    )) as EvalResult<T>;
  }

  async info<T = unknown>(options: InfoOptions = {}): Promise<InfoResult<T>> {
    return (await infoCommand(this, options)) as InfoResult<T>;
  }

  async completions(
    shell: TypstShell,
    options: CompletionsOptions = {},
  ): Promise<CompletionsResult> {
    return await completionsCommand(this, shell, options);
  }

  async query<T = unknown>(options: QueryOptions): Promise<QueryResult<T>>;
  async query<T = unknown>(
    input: CompileInput,
    selector: QuerySelector,
    options?: QueryShortcutOptions,
  ): Promise<QueryResult<T>>;
  async query<T = unknown>(
    first: QueryOptions | CompileInput,
    selector?: QuerySelector,
    options?: QueryShortcutOptions,
  ): Promise<QueryResult<T>> {
    return (await queryCommand(
      this,
      this.withDefaults(queryArguments(first, selector, options)),
      false,
    )) as QueryResult<T>;
  }

  async queryOne<T = unknown>(
    options: QueryOptions,
  ): Promise<QueryOneResult<T>>;
  async queryOne<T = unknown>(
    input: CompileInput,
    selector: QuerySelector,
    options?: QueryShortcutOptions,
  ): Promise<QueryOneResult<T>>;
  async queryOne<T = unknown>(
    first: QueryOptions | CompileInput,
    selector?: QuerySelector,
    options?: QueryShortcutOptions,
  ): Promise<QueryOneResult<T>> {
    return (await queryCommand(
      this,
      this.withDefaults(queryArguments(first, selector, options)),
      true,
    )) as QueryOneResult<T>;
  }

  async compileMany(
    jobs: readonly CompileOptions[],
    options: CompileManyOptions = {},
  ): Promise<readonly CompileManySettled[]> {
    if (!Array.isArray(jobs)) {
      throw new TypstInvalidArgumentError("compileMany jobs must be an array.");
    }
    validateRecord(options, "compileMany options");
    const concurrency =
      options.concurrency ?? Math.min(4, Math.max(1, availableParallelism()));
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new TypstInvalidArgumentError(
        "concurrency must be a positive integer.",
      );
    }
    const batchSignal = options.signal;
    if (batchSignal !== undefined && !(batchSignal instanceof AbortSignal)) {
      throw new TypstInvalidArgumentError(
        "signal must be an AbortSignal when provided.",
      );
    }

    const settled: CompileManySettled[] = new Array(jobs.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex++;
        if (index >= jobs.length) return;
        const job = jobs[index] as CompileOptions;
        let linked: ReturnType<typeof linkSignals> | undefined;
        try {
          const own: unknown = job?.signal;
          if (own !== undefined && !(own instanceof AbortSignal)) {
            throw new TypstInvalidArgumentError(
              `jobs[${index}].signal must be an AbortSignal when provided.`,
            );
          }
          linked = linkSignals(own, batchSignal);
          const jobOptions: CompileOptions =
            linked.signal === undefined
              ? job
              : { ...job, signal: linked.signal };
          const result = await compileCommand(
            this,
            this.withDefaults(jobOptions),
          );
          settled[index] = Object.freeze({ ok: true as const, result });
        } catch (error) {
          if (!(error instanceof TypstError)) {
            // An unexpected failure stops handing out further jobs.
            nextIndex = jobs.length;
            throw error;
          }
          settled[index] = Object.freeze({ ok: false as const, error });
        } finally {
          linked?.dispose();
        }
      }
    };
    const workers = Math.min(concurrency, jobs.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return Object.freeze(settled);
  }

  async watch(options: WatchOptions): Promise<TypstWatchHandle> {
    return await watchCommand(this, this.withDefaults(options));
  }

  async diagnose(): Promise<DiagnoseReport> {
    const [version, support, capabilities] = await Promise.all([
      this.version(),
      this.support(),
      this.capabilities(),
    ]);

    const issues: DiagnoseIssue[] = [];
    const launcherAvailable = checkLauncherAvailable();

    if (!launcherAvailable && this.executableSource !== "package") {
      issues.push({
        code: "LAUNCHER_NOT_INSTALLED",
        message:
          "The optional @flukxr/typst-cli launcher package is not installed. " +
          "Install it for automatic executable discovery and version matching.",
      });
    }

    if (this.executableSource === "path") {
      issues.push({
        code: "EXECUTABLE_FROM_PATH",
        message:
          "The Typst executable was found via PATH. Its version may change " +
          "when the system Typst installation is updated.",
      });
    }

    if (support.level === "unknown") {
      issues.push({
        code: "UNKNOWN_COMPILER_VERSION",
        message:
          `Compiler version ${version.version} is not in the known release inventory. ` +
          "Structured capabilities and version-gated features are unavailable.",
      });
    }

    if (
      support.level === "unknown" &&
      this.unknownVersionPolicy === "assume-latest-known"
    ) {
      const rulesVersion = resolveVersionForRules(
        version.version,
        this.unknownVersionPolicy,
      );
      issues.push({
        code: "ASSUMED_VERSION_RULES",
        message:
          `Compiler version ${version.version} is not in the known release inventory; ` +
          `high-level commands assumed the rules of the nearest known version` +
          (rulesVersion === undefined ? "" : ` (${rulesVersion})`) +
          ". This assumption is untested and capabilities remain unknown.",
      });
    }

    if (support.level === "partial" && !support.tested) {
      issues.push({
        code: "UNTESTED_PLATFORM",
        message:
          `The current platform (${process.platform}/${process.arch}) has no ` +
          "committed high-level sweep evidence. Behavior on this host is untested.",
      });
    }

    return Object.freeze({
      executable: this.executable,
      executableSource: this.executableSource,
      compilerVersion: version.version,
      version,
      support,
      capabilities,
      host: Object.freeze({
        platform: process.platform,
        arch: process.arch,
      }),
      launcherAvailable,
      cwd: this.cwd,
      issues: Object.freeze(issues),
    });
  }

  private async readVersion(): Promise<TypstVersionInfo> {
    const processResult = await this.run(["--version"]);
    const raw = rawVersionText(processResult);
    if (
      processResult.exitCode !== 0 ||
      processResult.signal !== null ||
      processResult.timedOut ||
      processResult.aborted
    ) {
      throw new TypstVersionCommandError(
        `Typst --version exited unsuccessfully (exitCode=${String(processResult.exitCode)}, signal=${String(processResult.signal)}).`,
        processResult,
        { raw },
      );
    }

    try {
      return parseTypstVersionOutput(raw);
    } catch (error) {
      throw new TypstVersionParseError(
        "Typst --version output did not match the supported exact format.",
        processResult,
        { raw, cause: error },
      );
    }
  }

  private helpProbe(): Promise<TypstProcessResultLike> {
    if (this.probePromise !== undefined) return this.probePromise;
    const pending = this.run(["--help"]).then((result) =>
      cloneProcessResult(result),
    );
    const handled = pending.catch((error: unknown) => {
      if (this.probePromise === handled) this.probePromise = undefined;
      throw error;
    });
    this.probePromise = handled;
    return handled;
  }
}

type TypstProcessResultLike = Awaited<ReturnType<typeof runProcess>>;

async function detachCapabilities(
  promise: Promise<TypstCapabilities>,
): Promise<TypstCapabilities> {
  const capabilities = await promise;
  if (capabilities.evidence.probe === undefined) return capabilities;
  return Object.freeze({
    ...capabilities,
    evidence: Object.freeze({
      ...capabilities.evidence,
      probe: cloneProcessResult(capabilities.evidence.probe),
    }),
  });
}

export function validateCreateOptions(options: CreateTypstOptions): void {
  validateRecord(options, "create options");
  validateEnvironment(options.env);
  validateTiming("timeoutMs", options.timeoutMs);
  validateTiming("terminationGraceMs", options.terminationGraceMs);
  if (
    options.envMode !== undefined &&
    options.envMode !== "merge" &&
    options.envMode !== "replace"
  ) {
    throw new TypstInvalidArgumentError(
      `Unknown environment mode: ${String(options.envMode)}.`,
    );
  }
  if (
    options.unknownVersionPolicy !== undefined &&
    options.unknownVersionPolicy !== "reject" &&
    options.unknownVersionPolicy !== "assume-latest-known"
  ) {
    throw new TypstInvalidArgumentError(
      `Unknown version policy: ${String(options.unknownVersionPolicy)}.`,
    );
  }
  if (
    options.diagnostics !== undefined &&
    typeof options.diagnostics !== "boolean"
  ) {
    throw new TypstInvalidArgumentError(
      "diagnostics must be a boolean when provided.",
    );
  }
  if (options.onLog !== undefined && typeof options.onLog !== "function") {
    throw new TypstInvalidArgumentError(
      "onLog must be a function when provided.",
    );
  }
  if (options.defaults !== undefined) {
    validateRecord(options.defaults, "defaults");
    validateWorldOptions(options.defaults);
  }
}

/** Normalise the object and positional `compile()` forms. */
function compileArguments(
  first: CompileOptions | CompileInput,
  output: string | CompileFileDestination | undefined,
  options: CompileToFileOptions | undefined,
): CompileOptions {
  if (output === undefined) {
    if (options !== undefined) {
      throw new TypstInvalidArgumentError(
        "compile(input, output, options) needs an output; for in-memory output use pdf(), png(), svg() or html().",
      );
    }
    return first as CompileOptions;
  }
  if (options !== undefined) {
    validateRecord(options, "compile options");
    for (const key of ["input", "output"]) {
      if (key in options) {
        throw new TypstInvalidArgumentError(
          `compile(input, output, options) does not accept options.${key}.`,
        );
      }
    }
  }
  return { ...options, input: first as CompileInput, output };
}

/** Normalise the two `query()` call forms to a single options object. */
function queryArguments(
  first: QueryOptions | CompileInput,
  selector: QuerySelector | undefined,
  options: QueryShortcutOptions | undefined,
): QueryOptions {
  if (selector === undefined) return first as QueryOptions;
  if (options !== undefined) validateRecord(options, "query options");
  return { ...options, input: first as CompileInput, selector };
}

/**
 * Combine a job's own signal with the batch signal. The returned signal
 * aborts when either does; `dispose` removes the listeners.
 */
function linkSignals(
  own: AbortSignal | undefined,
  batch: AbortSignal | undefined,
): { readonly signal: AbortSignal | undefined; dispose(): void } {
  if (batch === undefined || own === undefined)
    return { signal: own ?? batch, dispose: () => undefined };
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => (): void =>
    controller.abort(source.reason);
  const onOwn = abortFrom(own);
  const onBatch = abortFrom(batch);
  if (own.aborted) onOwn();
  else if (batch.aborted) onBatch();
  own.addEventListener("abort", onOwn, { once: true });
  batch.addEventListener("abort", onBatch, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      own.removeEventListener("abort", onOwn);
      batch.removeEventListener("abort", onBatch);
    },
  };
}

function memoryOutputs(result: CompileResult): CompileMemoryOutput[] {
  return result.outputs.filter(
    (output): output is CompileMemoryOutput => output.kind === "memory",
  );
}

function validateCapabilitiesOptions(options: CapabilitiesOptions): void {
  validateRecord(options, "capabilities options");
  if (options.probe !== undefined && typeof options.probe !== "boolean") {
    throw new TypstInvalidArgumentError("capabilities probe must be boolean.");
  }
}

function validateEnvironment(env: NodeJS.ProcessEnv | undefined): void {
  if (
    env !== undefined &&
    (env === null || typeof env !== "object" || Array.isArray(env))
  ) {
    throw new TypstInvalidArgumentError("env must be an object when provided.");
  }
}

function validateTiming(
  name: "timeoutMs" | "terminationGraceMs",
  value: number | undefined,
): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0)
  ) {
    throw new TypstInvalidArgumentError(
      `${name} must be a finite non-negative number.`,
    );
  }
}

function cloneEnvironment(
  input: NodeJS.ProcessEnv,
): Readonly<NodeJS.ProcessEnv> {
  const clone: MutableEnvironment = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) clone[key] = value;
  }
  return Object.freeze(clone);
}

function rawVersionText(processResult: TypstProcessResultLike): string {
  return processResult.stdout.length > 0
    ? processResult.stdout.toString("utf8")
    : processResult.stderr.toString("utf8");
}

function cloneProcessResult(
  value: TypstProcessResultLike,
): TypstProcessResultLike {
  return Object.freeze({
    executable: value.executable,
    args: Object.freeze([...value.args]),
    cwd: value.cwd,
    exitCode: value.exitCode,
    signal: value.signal,
    stdout: Buffer.from(value.stdout),
    stderr: Buffer.from(value.stderr),
    durationMs: value.durationMs,
    timedOut: value.timedOut,
    aborted: value.aborted,
    stdoutBytes: value.stdoutBytes ?? value.stdout.length,
    stderrBytes: value.stderrBytes ?? value.stderr.length,
    stdoutTruncated: value.stdoutTruncated ?? false,
    stderrTruncated: value.stderrTruncated ?? false,
    ...(value.diagnostics === undefined || value.diagnostics.length === 0
      ? {}
      : { diagnostics: Object.freeze([...value.diagnostics]) }),
  });
}

function buildSupport(version: TypstVersionInfo): TypstSupport {
  const known = KNOWN_TYPST_VERSION_SET.has(version.version);
  const level: SupportLevel = known ? "partial" : "unknown";
  const coverage = buildCoverage();
  return Object.freeze({
    compilerVersion: version.version,
    apiVersion: apiVersion(),
    level,
    coverage,
    tested: known && highLevelTestedOnThisPlatform(),
  });
}

function buildCoverage(): TypstCoverage {
  const supportByVersion: Record<string, SupportLevel> = {};
  for (const version of KNOWN_TYPST_VERSIONS) {
    supportByVersion[version] = "partial";
  }
  const sweepRecord = highLevelSweepForThisPlatform();
  const testedVersions =
    sweepRecord === undefined ? [] : sweepRecord.testedVersions;
  return Object.freeze({
    minimumKnown: KNOWN_TYPST_VERSIONS[0] as ExactTypstVersion,
    fullySupportedThrough:
      sweepRecord === undefined ? null : sweepRecord.testedThrough,
    knownVersions: Object.freeze([...KNOWN_TYPST_VERSIONS]),
    testedVersions: Object.freeze([...testedVersions]),
    supportByVersion: Object.freeze(supportByVersion),
  });
}

/**
 * The committed high-level sweep evidence is keyed by platform/arch. `tested`
 * is only claimed when the current host has a committed sweep record; other
 * hosts stay conservative and report none.
 */
function highLevelSweepForThisPlatform():
  import("./support-data.js").HighLevelSweepRecord | undefined {
  return highLevelSweepFor(process.platform, process.arch);
}

function highLevelTestedOnThisPlatform(): boolean {
  return highLevelSweepForThisPlatform() !== undefined;
}

function buildCapabilities(version: TypstVersionInfo): TypstCapabilities {
  const known = KNOWN_TYPST_VERSION_SET.has(version.version);
  const level: SupportLevel = known ? "partial" : "unknown";
  const commands: Record<string, TypstCapability> = {};
  const formats: Record<string, TypstCapability> = {};
  const options: Record<string, TypstCapability> = {};

  for (const [name, definition] of Object.entries(
    CAPABILITY_REGISTRY.features,
  )) {
    const separator = name.indexOf(".");
    if (separator <= 0 || separator === name.length - 1) continue;
    const group = name.slice(0, separator);
    const key = name.slice(separator + 1);
    const capability = describeCapability(version.version, known, definition);
    if (group === "commands") commands[key] = capability;
    else if (group === "formats") formats[key] = capability;
    else if (group === "options") options[key] = capability;
  }

  const registryEvidence: CapabilityRegistryEvidence = Object.freeze({
    status: CAPABILITY_REGISTRY.status,
    verifiedOnPlatform: CAPABILITY_REGISTRY.verification.platform,
    verifiedOnArch: CAPABILITY_REGISTRY.verification.arch,
    checkedAt: CAPABILITY_REGISTRY.checkedAt,
    warning: CAPABILITY_REGISTRY.warning,
  });

  return Object.freeze({
    compilerVersion: version.version,
    level,
    commands: Object.freeze(commands),
    formats: Object.freeze(formats),
    options: Object.freeze(options),
    evidence: Object.freeze({ registry: registryEvidence }),
  });
}

function describeCapability(
  compilerVersion: string,
  known: boolean,
  definition: CapabilityDefinition,
): TypstCapability {
  const metadata = {
    ...(definition.since === undefined || definition.since === null
      ? {}
      : { since: definition.since as ExactTypstVersion }),
    ...(definition.deprecatedIn === undefined
      ? {}
      : { deprecatedIn: definition.deprecatedIn as ExactTypstVersion }),
    ...(definition.removedIn === undefined
      ? {}
      : { removedIn: definition.removedIn as ExactTypstVersion }),
    ...(definition.behaviorChanges === undefined
      ? {}
      : {
          behaviorChanges: Object.freeze(
            definition.behaviorChanges.map((change) =>
              Object.freeze({
                version: change.version as ExactTypstVersion,
                change: change.change,
              }),
            ),
          ),
        }),
  } satisfies Partial<TypstCapability>;

  let state: CapabilityState = "unknown";
  if (known) {
    const beforeSince =
      definition.since !== undefined &&
      definition.since !== null &&
      compareExactStableVersions(compilerVersion, definition.since) < 0;
    const removed =
      definition.removedIn !== undefined &&
      compareExactStableVersions(compilerVersion, definition.removedIn) >= 0;
    if (beforeSince || removed || definition.apiPolicy === "blocked") {
      state = "unsupported";
    } else if (definition.experimental === true) {
      state = "experimental";
    } else {
      state = "supported";
    }
  }
  return Object.freeze({ state, ...metadata });
}

function withProbeEvidence(
  capabilities: TypstCapabilities,
  probe: TypstProcessResultLike,
): TypstCapabilities {
  return Object.freeze({
    ...capabilities,
    evidence: Object.freeze({
      ...capabilities.evidence,
      probe: cloneProcessResult(probe),
    }),
  });
}

let launcherAvailableCache: boolean | undefined;
const REQUIRE = createRequire(import.meta.url);

function checkLauncherAvailable(): boolean {
  if (launcherAvailableCache !== undefined) return launcherAvailableCache;
  try {
    REQUIRE.resolve("@flukxr/typst-cli");
    launcherAvailableCache = true;
  } catch {
    launcherAvailableCache = false;
  }
  return launcherAvailableCache;
}

export { TypstClientImpl };
