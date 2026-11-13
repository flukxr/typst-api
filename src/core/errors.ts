import { stripAnsi } from "./ansi.js";
import type { ExecutableSource, ExecutableProbeResult } from "./executable.js";
import type { TypstProcessResult } from "./process.js";

/** Maximum length of the first-stderr-line hint appended to error messages. */
const STDERR_HINT_LIMIT = 200;

/**
 * The first meaningful line of a process's stderr, best effort. The raw stderr
 * buffer on the process record remains authoritative; this only feeds the
 * human-readable `message` so a typical `console.error(err.message)` shows the
 * compiler's actual diagnosis instead of only the exit status.
 */
function firstMeaningfulStderrLine(
  process: TypstProcessResult,
): string | undefined {
  const line = stripAnsi(process.stderr.toString("utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (line === undefined) return undefined;
  return line.length <= STDERR_HINT_LIMIT
    ? line
    : `${line.slice(0, STDERR_HINT_LIMIT)}…`;
}

/**
 * Base error shared by the executable discovery and later process layers.
 *
 * Discovery errors intentionally carry a stable machine-readable code while
 * keeping a useful human message.  The low-level evidence is exposed on the
 * specialised subclasses below rather than being discarded in a catch block.
 */
/** Every stable machine-readable `TypstError.code`. */
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

  constructor(code: TypstErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** An argument or option cannot be represented by the process runner. */
export class TypstInvalidArgumentError extends TypstError {
  constructor(message: string, options?: ErrorOptions) {
    super("ERR_TYPST_INVALID_ARGUMENT", message, options);
  }
}

/**
 * The process exited successfully but its result shape did not match the
 * expected public contract (for example, a single-output assertion on a
 * multi-output result). This is distinct from an argument error: the arguments
 * were valid; the produced result was not what the caller required.
 */
export class TypstUnexpectedResultError extends TypstError {
  constructor(message: string, options?: ErrorOptions) {
    super("ERR_TYPST_UNEXPECTED_RESULT", message, options);
  }
}

/** A compiler version is not supported by the committed release inventory. */
export class UnsupportedTypstVersionError extends TypstError {
  readonly actualVersion?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { readonly actualVersion?: string },
  ) {
    super("ERR_TYPST_UNSUPPORTED_VERSION", message, options);
    if (options?.actualVersion !== undefined) {
      this.actualVersion = options.actualVersion;
      Object.defineProperty(this, "compilerVersion", {
        configurable: true,
        enumerable: true,
        value: options.actualVersion,
      });
    }
  }
}

/** A high-level feature cannot be represented for the selected compiler. */
export class UnsupportedTypstFeatureError extends TypstError {
  readonly feature: string;
  readonly requiredVersion?: string;
  readonly actualVersion: string;

  constructor(
    feature: string,
    actualVersion: string,
    options?: ErrorOptions & { readonly requiredVersion?: string },
  ) {
    super(
      "ERR_TYPST_UNSUPPORTED_FEATURE",
      `Typst feature ${feature} is not supported by compiler ${actualVersion}.`,
      options,
    );
    this.feature = feature;
    this.actualVersion = actualVersion;
    Object.defineProperty(this, "compilerVersion", {
      configurable: true,
      enumerable: true,
      value: actualVersion,
    });
    if (options?.requiredVersion !== undefined) {
      this.requiredVersion = options.requiredVersion;
    }
  }
}

/** A child process could not be started. */
export class TypstProcessError extends TypstError {
  override readonly process: TypstProcessResult;

  constructor(
    code: TypstErrorCode,
    message: string,
    process: TypstProcessResult,
    options?: ErrorOptions,
  ) {
    super(code, withStderrHint(message, process), options);
    this.process = process;
  }
}

/** Append the first meaningful stderr line to a process error message. */
function withStderrHint(message: string, process: TypstProcessResult): string {
  const hint = firstMeaningfulStderrLine(process);
  return hint === undefined ? message : `${message} ${hint}`;
}

/** A process spawn failed before a child could reach a natural exit. */
export class TypstSpawnError extends TypstProcessError {
  readonly spawnError?: unknown;

  constructor(
    message: string,
    process: TypstProcessResult,
    options?: ErrorOptions & { readonly spawnError?: unknown },
  ) {
    super("ERR_TYPST_SPAWN", message, process, options);
    if (options?.spawnError !== undefined) this.spawnError = options.spawnError;
  }
}

/** A successfully spawned process was terminated because its deadline elapsed. */
export class TypstTimeoutError extends TypstProcessError {
  constructor(
    message: string,
    process: TypstProcessResult,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_TIMEOUT", message, process, options);
  }
}

/** A successfully spawned process was terminated by an AbortSignal. */
export class TypstAbortError extends TypstProcessError {
  constructor(
    message: string,
    process: TypstProcessResult,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_ABORT", message, process, options);
  }
}

/** A high-level compile command exited unsuccessfully. */
export class TypstCompilationError extends TypstProcessError {
  override readonly compilerVersion: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_COMPILATION", message, process, options);
    this.compilerVersion = compilerVersion;
  }
}

/** A high-level fonts command exited unsuccessfully. */
export class TypstFontsError extends TypstProcessError {
  override readonly compilerVersion: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_FONTS", message, process, options);
    this.compilerVersion = compilerVersion;
  }
}

/** A long-lived watch process exited unsuccessfully on its own. */
export class TypstWatchError extends TypstProcessError {
  override readonly compilerVersion: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_WATCH", message, process, options);
    this.compilerVersion = compilerVersion;
  }
}

/** A high-level init command exited unsuccessfully. */
export class TypstInitError extends TypstProcessError {
  override readonly compilerVersion: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_INIT", message, process, options);
    this.compilerVersion = compilerVersion;
  }
}

/** A high-level info command exited unsuccessfully. */
export class TypstInfoError extends TypstProcessError {
  override readonly compilerVersion: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_INFO", message, process, options);
    this.compilerVersion = compilerVersion;
  }
}

/** A high-level completions command exited unsuccessfully. */
export class TypstCompletionsError extends TypstProcessError {
  override readonly compilerVersion: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_COMPLETIONS", message, process, options);
    this.compilerVersion = compilerVersion;
  }
}

/** A high-level eval command exited unsuccessfully or produced no value. */
export class TypstEvalError extends TypstProcessError {
  override readonly compilerVersion: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_EVAL", message, process, options);
    this.compilerVersion = compilerVersion;
  }
}

/** The eval command produced output that could not be decoded as JSON. */
export class TypstEvalParseError extends TypstEvalError {
  override readonly code = "ERR_TYPST_EVAL_PARSE";
  readonly rawOutput: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions & { readonly rawOutput?: string },
  ) {
    super(message, process, compilerVersion, options);
    this.rawOutput = options?.rawOutput ?? "";
  }
}

/** The requested init destination already exists; init refuses to overwrite it. */
export class TypstInitConflictError extends TypstError {
  readonly directory: string;
  readonly resolved: string;

  constructor(directory: string, resolved: string, options?: ErrorOptions) {
    super(
      "ERR_TYPST_INIT_CONFLICT",
      `A project directory already exists at ${resolved}; refusing to overwrite it.`,
      options,
    );
    this.directory = directory;
    this.resolved = resolved;
  }
}

/** A high-level query command exited unsuccessfully. */
export class TypstQueryError extends TypstProcessError {
  override readonly compilerVersion: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions,
  ) {
    super("ERR_TYPST_QUERY", message, process, options);
    this.compilerVersion = compilerVersion;
  }
} /** The query command produced output that could not be decoded as JSON. */
export class TypstQueryParseError extends TypstQueryError {
  override readonly code = "ERR_TYPST_QUERY_PARSE";
  readonly rawOutput: string;

  constructor(
    message: string,
    process: TypstProcessResult,
    compilerVersion: string,
    options?: ErrorOptions & { readonly rawOutput?: string },
  ) {
    super(message, process, compilerVersion, options);
    this.rawOutput = options?.rawOutput ?? "";
  }
}

/** Base class for errors interpreting the raw `typst --version` command. */
export class TypstVersionError extends TypstProcessError {
  readonly raw?: string;

  constructor(
    code: TypstErrorCode,
    message: string,
    process: TypstProcessResult,
    options?: ErrorOptions & { readonly raw?: string },
  ) {
    super(code, message, process, options);
    if (options?.raw !== undefined) this.raw = options.raw;
  }
}

/** `typst --version` exited naturally without a successful status. */
export class TypstVersionCommandError extends TypstVersionError {
  constructor(
    message: string,
    process: TypstProcessResult,
    options?: ErrorOptions & { readonly raw?: string },
  ) {
    super("ERR_TYPST_VERSION_COMMAND", message, process, options);
  }
}

/** `typst --version` output did not match the strict supported contract. */
export class TypstVersionParseError extends TypstVersionError {
  constructor(
    message: string,
    process: TypstProcessResult,
    options?: ErrorOptions & { readonly raw?: string },
  ) {
    super("ERR_TYPST_VERSION_PARSE", message, process, options);
  }
}

/**
 * `typst --version` output could not be interpreted as a version at all.
 *
 * This is thrown by the standalone `parseTypstVersionOutput` parser, which has
 * no process record to attach. It stays inside the `TypstError` hierarchy so
 * consumers catching `TypstError` see it, and it carries a stable code.
 */
export class TypstVersionOutputError extends TypstError {
  readonly raw?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { readonly raw?: string },
  ) {
    super("ERR_TYPST_VERSION_OUTPUT", message, options);
    if (options?.raw !== undefined) this.raw = options.raw;
  }
}

export interface ExecutableAttempt {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly path: string;
  readonly outcome:
    "not-found" | "not-regular-file" | "not-executable" | "permission";
  readonly message?: string;
}

export interface ExecutableErrorOptions {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;
  readonly cause?: unknown;
}

/** No candidate could be selected from the enabled implicit sources. */
export class TypstExecutableNotFoundError extends TypstError {
  readonly source?: ExecutableSource;
  readonly candidate?: string;
  readonly executablePath?: string;
  readonly attempts: readonly ExecutableAttempt[];

  constructor(
    message: string,
    options?: {
      readonly source?: ExecutableSource;
      readonly candidate?: string;
      readonly executablePath?: string;
      readonly attempts?: readonly ExecutableAttempt[];
      readonly cause?: unknown;
    },
  ) {
    super(
      "ERR_TYPST_EXECUTABLE_NOT_FOUND",
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    if (options?.source !== undefined) this.source = options.source;
    if (options?.candidate !== undefined) this.candidate = options.candidate;
    if (options?.executablePath !== undefined) {
      this.executablePath = options.executablePath;
    }
    this.attempts = options?.attempts ?? [];
  }
}

/** A configured candidate exists but is not a regular file. */
export class TypstExecutableNotRegularFileError extends TypstError {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;

  constructor(options: ExecutableErrorOptions) {
    super(
      "ERR_TYPST_EXECUTABLE_NOT_REGULAR_FILE",
      `Typst executable candidate for ${options.source} is not a regular file: ${options.executablePath}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.source = options.source;
    this.candidate = options.candidate;
    this.executablePath = options.executablePath;
  }
}

/** A configured candidate cannot be executed due to permissions or mode. */
export class TypstExecutablePermissionError extends TypstError {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;

  constructor(options: ExecutableErrorOptions) {
    super(
      "ERR_TYPST_EXECUTABLE_PERMISSION",
      `Typst executable candidate for ${options.source} is not executable or is inaccessible: ${options.executablePath}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.source = options.source;
    this.candidate = options.candidate;
    this.executablePath = options.executablePath;
  }
}

/** A configured candidate is a file but has no executable permission. */
export class TypstExecutableNotExecutableError extends TypstError {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;

  constructor(options: ExecutableErrorOptions) {
    const detail =
      options.cause instanceof Error ? ` ${options.cause.message}` : "";
    super(
      "ERR_TYPST_EXECUTABLE_NOT_EXECUTABLE",
      `Typst executable candidate for ${options.source} is not executable: ${options.executablePath}.${detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.source = options.source;
    this.candidate = options.candidate;
    this.executablePath = options.executablePath;
  }
}

/** The optional launcher is present but malformed or disagrees with the binary. */
export class TypstExecutableIntegrityError extends TypstError {
  readonly source: "package" = "package";
  readonly executablePath?: string;
  readonly declaredVersion?: string;
  readonly actualVersion?: string;
  readonly probe?: ExecutableProbeResult;

  constructor(
    message: string,
    options?: {
      readonly executablePath?: string;
      readonly declaredVersion?: string;
      readonly actualVersion?: string;
      readonly probe?: ExecutableProbeResult;
      readonly cause?: unknown;
    },
  ) {
    super(
      "ERR_TYPST_EXECUTABLE_INTEGRITY",
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    if (options?.executablePath !== undefined)
      this.executablePath = options.executablePath;
    if (options?.declaredVersion !== undefined)
      this.declaredVersion = options.declaredVersion;
    if (options?.actualVersion !== undefined)
      this.actualVersion = options.actualVersion;
    if (options?.probe !== undefined) this.probe = options.probe;
  }
}

/** The launcher binary could not be probed successfully. */
export class TypstExecutableProbeError extends TypstExecutableIntegrityError {
  override readonly code = "ERR_TYPST_EXECUTABLE_PROBE";

  constructor(
    message: string,
    options?: {
      readonly executablePath?: string;
      readonly declaredVersion?: string;
      readonly actualVersion?: string;
      readonly probe?: ExecutableProbeResult;
      readonly cause?: unknown;
    },
  ) {
    super(message, options);
  }
}

/** A package loader failed for a reason other than the optional package being absent. */
export class TypstExecutablePackageError extends TypstError {
  readonly source: "package" = "package";

  constructor(message: string, cause?: unknown) {
    super(
      "ERR_TYPST_EXECUTABLE_PACKAGE",
      message,
      cause === undefined ? undefined : { cause },
    );
  }
}

/** A package launcher object did not expose the required metadata. */
export class TypstExecutableLauncherError extends TypstExecutableIntegrityError {
  override readonly code = "ERR_TYPST_EXECUTABLE_LAUNCHER";
}
