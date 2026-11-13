import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { applyEnvironment } from "./environment.js";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import type { Stream } from "node:stream";

import {
  TypstAbortError,
  TypstInvalidArgumentError,
  TypstSpawnError,
  TypstTimeoutError,
} from "./errors.js";
import {
  parseDiagnostics,
  type TypstDiagnostic,
  type TypstLogEvent,
  type TypstLogEventInput,
} from "./diagnostics.js";

export {
  TypstAbortError,
  TypstInvalidArgumentError,
  TypstProcessError,
  TypstSpawnError,
  TypstTimeoutError,
  TypstError,
} from "./errors.js";

export type {
  TypstDiagnostic,
  TypstDiagnosticHint,
  TypstDiagnosticSeverity,
  TypstDiagnosticSpan,
} from "./diagnostics.js";
export type { TypstLogEvent, TypstLogKind } from "./diagnostics.js";

/** Environment construction mode for a process invocation. */
export type EnvironmentMode = "merge" | "replace";

/**
 * A destination for one standard stream of a child process.
 *
 * `"pipe"` is the only destination whose bytes are captured in
 * `TypstProcessResult.stdout`/`stderr`. A file descriptor, stream, `"ignore"`,
 * or `"inherit"` sends the stream elsewhere and is the caller's responsibility.
 */
export type RunStdioTarget = "pipe" | "ignore" | "inherit" | number | Stream;

/**
 * Standard-stream destinations for a spawned process. Omitted fields default
 * to `"pipe"`.
 */
export interface RunStdioOptions {
  /** Default: `"pipe"`. Any other target cannot be combined with `stdin` data. */
  readonly stdin?: RunStdioTarget;
  /** Default: `"pipe"`. Only `"pipe"` is captured in `stdout`. */
  readonly stdout?: RunStdioTarget;
  /** Default: `"pipe"`. Only `"pipe"` is captured in `stderr` and diagnostics. */
  readonly stderr?: RunStdioTarget;
}

/** Options accepted by the low-level process runner. */
export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly envMode?: EnvironmentMode;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string | Uint8Array;
  /**
   * Override the child's standard-stream wiring. The default is a pipe for
   * every stream. When stdout or stderr is not `"pipe"`, the corresponding
   * `TypstProcessResult` buffer is empty, `onLog` emits no chunk events for it,
   * and diagnostics cannot be parsed from stderr.
   */
  readonly stdio?: RunStdioOptions;
  /**
   * When true, best-effort structured diagnostics are parsed from stderr
   * and attached to the process result. Raw stderr remains authoritative.
   */
  readonly diagnostics?: boolean;
  /**
   * Opt-in callback that receives redaction-safe lifecycle events during
   * process execution. The raw process result remains the authoritative record.
   */
  readonly onLog?: (event: TypstLogEvent) => void;
}

/** Raw output and termination metadata for a spawned process. */
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
  /**
   * Total bytes observed on stdout. For a buffered command this equals
   * `stdout.length`; when `stdio.stdout` is not a pipe the stream is not
   * captured and this is `0`.
   */
  readonly stdoutBytes: number;
  /** Total bytes observed on stderr; `0` when stderr is not piped. */
  readonly stderrBytes: number;
  /**
   * True when `stdout` holds only the retained tail of a bounded capture.
   * Long-lived processes such as `watch()` bound their retained output; the
   * streaming `output` events remain complete. Never set silently: the
   * corresponding `output_truncated` log event and these totals expose it.
   */
  readonly stdoutTruncated: boolean;
  /** True when `stderr` holds only the retained tail of a bounded capture. */
  readonly stderrTruncated: boolean;
  /**
   * Best-effort structured diagnostics parsed from stderr. Present only when
   * `diagnostics` was enabled in RunOptions. Raw stderr remains authoritative.
   */
  readonly diagnostics?: readonly TypstDiagnostic[];
}

const DEFAULT_TERMINATION_GRACE_MS = 1_000;
// Node clamps larger values to one millisecond. Clamp explicitly so a valid
// finite option never unexpectedly turns into an immediate timeout.
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

interface NormalisedOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly terminationGraceMs: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string | Uint8Array;
  readonly stdio: ResolvedStdio;
  readonly diagnostics: boolean;
  readonly onLog?: (event: TypstLogEvent) => void;
}

interface ResolvedStdio {
  readonly stdin: RunStdioTarget;
  readonly stdout: RunStdioTarget;
  readonly stderr: RunStdioTarget;
}

interface TerminationState {
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

interface SpawnFailureDetails {
  readonly error: unknown;
}

/**
 * Spawn an executable directly and collect its unmodified output.
 *
 * A naturally exited process always resolves, including non-zero and signal
 * exits. Spawn failures, timeout and abort are represented by typed errors
 * carrying the same normalised record that a successful invocation returns.
 */
export async function runProcess(
  executable: string,
  args: readonly string[] = [],
  options: RunOptions = {},
): Promise<TypstProcessResult> {
  const normalised = normaliseOptions(options);
  const executableSnapshot = validateExecutable(executable);
  const argsSnapshot = snapshotArgs(args);
  const cwd = normalised.cwd;

  const preAborted = normalised.signal?.aborted === true;
  if (preAborted) {
    const result = createResult(
      executableSnapshot,
      argsSnapshot,
      cwd,
      null,
      null,
      Buffer.alloc(0),
      Buffer.alloc(0),
      0,
      { timedOut: false, aborted: true },
    );
    throw new TypstAbortError(
      "The Typst process was aborted before spawn.",
      result,
      normalised.signal?.reason === undefined
        ? undefined
        : { cause: normalised.signal.reason },
    );
  }

  const startedAt = performance.now();
  const spawnOptions: SpawnOptions = {
    cwd,
    env: normalised.env,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: [
      normalised.stdio.stdin,
      normalised.stdio.stdout,
      normalised.stdio.stderr,
    ],
  };

  let child: ChildProcess;
  try {
    child = spawn(executableSnapshot, argsSnapshot, spawnOptions);
  } catch (error) {
    const result = createResult(
      executableSnapshot,
      argsSnapshot,
      cwd,
      null,
      null,
      Buffer.alloc(0),
      Buffer.alloc(0),
      elapsedMs(startedAt),
      { timedOut: false, aborted: false },
    );
    throwSpawnError(result, error);
  }

  return await collectProcess(
    child,
    executableSnapshot,
    argsSnapshot,
    cwd,
    normalised,
    startedAt,
  );
}

function normaliseOptions(options: RunOptions): NormalisedOptions {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new TypstInvalidArgumentError("Run options must be an object.");
  }

  const cwd =
    options.cwd === undefined ? process.cwd() : validateCwd(options.cwd);
  const envMode = options.envMode ?? "merge";
  if (envMode !== "merge" && envMode !== "replace") {
    throw new TypstInvalidArgumentError(
      `Unknown environment mode: ${String(envMode)}.`,
    );
  }
  const timeoutMs = validateTimingOption("timeoutMs", options.timeoutMs);
  const configuredGrace = validateTimingOption(
    "terminationGraceMs",
    options.terminationGraceMs,
  );
  const terminationGraceMs = configuredGrace ?? DEFAULT_TERMINATION_GRACE_MS;
  validateEnvironment(options.env);
  validateSignal(options.signal);
  validateStdin(options.stdin);
  const stdio = normaliseStdio(options.stdio, options.stdin);
  const diagnostics = options.diagnostics === true;
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
  const env = applyEnvironment(process.env, options.env, envMode);

  return {
    cwd,
    env,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    terminationGraceMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    stdio,
    diagnostics,
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  };
}

function validateEnvironment(env: NodeJS.ProcessEnv | undefined): void {
  if (
    env !== undefined &&
    (env === null || typeof env !== "object" || Array.isArray(env))
  ) {
    throw new TypstInvalidArgumentError("env must be an object when provided.");
  }
}

function validateSignal(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypstInvalidArgumentError(
      "signal must be an AbortSignal when provided.",
    );
  }
}

function validateStdin(stdin: string | Uint8Array | undefined): void {
  if (stdin === undefined || typeof stdin === "string") return;
  if (!(stdin instanceof Uint8Array)) {
    throw new TypstInvalidArgumentError(
      "stdin must be a string or Uint8Array when provided.",
    );
  }
}

const DEFAULT_STDIO: ResolvedStdio = Object.freeze({
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

function normaliseStdio(
  stdio: RunStdioOptions | undefined,
  stdinData: string | Uint8Array | undefined,
): ResolvedStdio {
  if (stdio === undefined) return DEFAULT_STDIO;
  if (stdio === null || typeof stdio !== "object" || Array.isArray(stdio)) {
    throw new TypstInvalidArgumentError(
      "stdio must be an object when provided.",
    );
  }
  const resolved: ResolvedStdio = {
    stdin: validateStdioTarget("stdio.stdin", stdio.stdin),
    stdout: validateStdioTarget("stdio.stdout", stdio.stdout),
    stderr: validateStdioTarget("stdio.stderr", stdio.stderr),
  };
  if (stdinData !== undefined && resolved.stdin !== "pipe") {
    throw new TypstInvalidArgumentError(
      'stdin data requires stdio.stdin to be "pipe".',
    );
  }
  return resolved;
}

function validateStdioTarget(
  name: string,
  target: RunStdioTarget | undefined,
): RunStdioTarget {
  if (target === undefined || target === "pipe") return "pipe";
  if (target === "ignore" || target === "inherit") return target;
  if (typeof target === "number") {
    if (!Number.isSafeInteger(target) || target < 0) {
      throw new TypstInvalidArgumentError(
        `${name} must be a non-negative integer file descriptor.`,
      );
    }
    return target;
  }
  if (
    target !== null &&
    typeof target === "object" &&
    typeof (target as Stream).on === "function"
  ) {
    return target;
  }
  throw new TypstInvalidArgumentError(
    `${name} must be "pipe", "ignore", "inherit", a non-negative file descriptor, or a stream.`,
  );
}

function validateExecutable(executable: string): string {
  if (typeof executable !== "string" || executable.length === 0) {
    throw new TypstInvalidArgumentError(
      "The executable must be a non-empty string.",
    );
  }
  return executable;
}

function validateCwd(cwd: string): string {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypstInvalidArgumentError("cwd must be a non-empty string.");
  }
  return resolve(cwd);
}

function snapshotArgs(args: readonly string[]): readonly string[] {
  if (!Array.isArray(args)) {
    throw new TypstInvalidArgumentError("args must be an array of strings.");
  }
  for (const [index, arg] of args.entries()) {
    if (typeof arg !== "string") {
      throw new TypstInvalidArgumentError(
        `args[${index}] must be a string, received ${typeof arg}.`,
      );
    }
  }
  return Object.freeze([...args]);
}

function validateTimingOption(
  name: "timeoutMs" | "terminationGraceMs",
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypstInvalidArgumentError(
      `${name} must be a finite non-negative number.`,
    );
  }
  return value;
}

async function collectProcess(
  child: ChildProcess,
  executable: string,
  args: readonly string[],
  cwd: string,
  options: NormalisedOptions,
  startedAt: number,
): Promise<TypstProcessResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;
  let termination: TerminationState = { timedOut: false, aborted: false };
  let terminationTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  let stdinDrainListener: (() => void) | undefined;
  const stdinErrorListener = (): void => undefined;
  const stdoutErrorListener = (): void => undefined;
  const stderrErrorListener = (): void => undefined;
  const stdoutDataListener = (chunk: Buffer | string): void => {
    stdout.push(Buffer.from(chunk));
    emitLog({
      kind: "stdout_chunk",
      timestamp: elapsedMs(startedAt),
      stream: "stdout",
      chunkLength: Buffer.byteLength(chunk),
    });
  };
  const stderrDataListener = (chunk: Buffer | string): void => {
    stderr.push(Buffer.from(chunk));
    emitLog({
      kind: "stderr_chunk",
      timestamp: elapsedMs(startedAt),
      stream: "stderr",
      chunkLength: Buffer.byteLength(chunk),
    });
  };
  let spawnFailure: SpawnFailureDetails | undefined;
  let abortReason: unknown;

  const emitLog = (event: TypstLogEventInput): void => {
    if (options.onLog === undefined) return;
    try {
      options.onLog({ ...event, command: "typst" } as TypstLogEvent);
    } catch {
      // A user callback must never take down the process runner.
    }
  };

  child.stdout?.on("data", stdoutDataListener);
  child.stderr?.on("data", stderrDataListener);
  child.stdout?.on("error", stdoutErrorListener);
  child.stderr?.on("error", stderrErrorListener);

  // EPIPE is expected when a child closes stdin early. It must not replace a
  // natural process result or the timeout/abort error that caused termination.
  child.stdin?.on("error", stdinErrorListener);

  return await new Promise<TypstProcessResult>(
    (resolveResult, rejectResult) => {
      const clearTimersAndListeners = (): void => {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        if (abortListener !== undefined && options.signal !== undefined) {
          options.signal.removeEventListener("abort", abortListener);
        }
        if (stdinDrainListener !== undefined && child.stdin !== null) {
          child.stdin.removeListener("drain", stdinDrainListener);
        }
        child.stdin?.removeListener("error", stdinErrorListener);
        child.stdout?.removeListener("error", stdoutErrorListener);
        child.stderr?.removeListener("error", stderrErrorListener);
        child.stdout?.removeListener("data", stdoutDataListener);
        child.stderr?.removeListener("data", stderrDataListener);
        timeoutTimer = undefined;
        terminationTimer = undefined;
        abortListener = undefined;
        stdinDrainListener = undefined;
      };

      const makeDiagnostics = (
        stderrBuf: Buffer,
      ): readonly TypstDiagnostic[] | undefined => {
        if (!options.diagnostics || stderrBuf.length === 0) return undefined;
        try {
          const parsed = parseDiagnostics(stderrBuf.toString("utf8"));
          return parsed.diagnostics.length > 0 ? parsed.diagnostics : undefined;
        } catch {
          return undefined;
        }
      };

      const makeResult = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): TypstProcessResult => {
        const stderrBuf = Buffer.concat(stderr);
        return createResult(
          executable,
          args,
          cwd,
          exitCode,
          signal,
          Buffer.concat(stdout),
          stderrBuf,
          elapsedMs(startedAt),
          termination,
          makeDiagnostics(stderrBuf),
        );
      };

      const settleNatural = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimersAndListeners();
        if (spawnFailure !== undefined) {
          const result = makeResult(null, null);
          rejectResult(
            new TypstSpawnError(
              "The Typst executable could not be spawned.",
              result,
              { cause: spawnFailure.error, spawnError: spawnFailure.error },
            ),
          );
        } else {
          const result = makeResult(exitCode, signal);
          emitLog({
            kind: "exit",
            timestamp: elapsedMs(startedAt),
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
          });
          if (termination.timedOut) {
            rejectResult(
              new TypstTimeoutError(
                "The Typst process exceeded its timeout.",
                result,
              ),
            );
          } else if (termination.aborted) {
            rejectResult(
              new TypstAbortError(
                "The Typst process was aborted.",
                result,
                abortReason === undefined ? undefined : { cause: abortReason },
              ),
            );
          } else {
            resolveResult(result);
          }
        }
      };

      // `on`, not `once`: a failed kill() can emit a further "error" event,
      // which would otherwise be an unhandled error event.
      child.on("error", (error: Error) => {
        if (
          settled ||
          termination.timedOut ||
          termination.aborted ||
          spawnFailure !== undefined
        )
          return;
        // A spawn error normally precedes close. Keep collecting output until
        // close so any bytes emitted by the platform are represented.
        spawnFailure = { error };
      });
      child.once("close", settleNatural);
      child.once("spawn", () => {
        emitLog({
          kind: "spawn",
          timestamp: elapsedMs(startedAt),
          ...(child.pid === undefined ? {} : { pid: child.pid }),
        });
        if (
          options.timeoutMs !== undefined &&
          !settled &&
          !termination.timedOut &&
          !termination.aborted &&
          spawnFailure === undefined
        ) {
          timeoutTimer = setSafeTimeout(() => {
            timeoutTimer = undefined;
            requestTermination("timeout");
          }, options.timeoutMs);
          timeoutTimer.unref?.();
        }
      });

      const requestTermination = (kind: "timeout" | "abort"): void => {
        if (
          settled ||
          termination.timedOut ||
          termination.aborted ||
          spawnFailure
        )
          return;
        termination =
          kind === "timeout"
            ? { timedOut: true, aborted: false }
            : { timedOut: false, aborted: true };
        if (kind === "abort") abortReason = options.signal?.reason;
        requestKill(child, false);
        terminationTimer = setSafeTimeout(() => {
          terminationTimer = undefined;
          if (!settled) requestKill(child, true);
        }, options.terminationGraceMs);
        terminationTimer.unref?.();
      };

      if (options.signal !== undefined) {
        abortListener = () => requestTermination("abort");
        options.signal.addEventListener("abort", abortListener, { once: true });
        if (options.signal.aborted) requestTermination("abort");
      }

      stdinDrainListener = writeStdin(child, options.stdin, () => {
        stdinDrainListener = undefined;
      });
    },
  );
}

function writeStdin(
  child: ChildProcess,
  input: string | Uint8Array | undefined,
  onDrain: () => void,
): (() => void) | undefined {
  const stream = child.stdin;
  if (stream === null) return undefined;
  if (input === undefined) {
    stream.end();
    return undefined;
  }
  const data =
    typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    stream.end();
    onDrain();
  };
  let drainListener: (() => void) | undefined;
  try {
    const canContinue = stream.write(data);
    if (canContinue) end();
    else {
      drainListener = (): void => end();
      stream.once("drain", drainListener);
    }
  } catch {
    // An early close can throw synchronously (notably on Windows). The child
    // exit/error remains authoritative, so simply finish the stream.
    end();
  }
  return drainListener;
}

function requestKill(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";

  if (process.platform === "win32") {
    requestWindowsTreeKill(child, force);
    return;
  }

  let groupSignalled = false;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      groupSignalled = true;
    } catch {
      // Detached process groups are not available in every runtime/container.
    }
  }
  if (!groupSignalled) {
    try {
      child.kill(signal);
    } catch {
      // Best effort only. The primary timeout/abort error remains unchanged.
    }
  }
}

/** @internal Shared with the long-lived watch process layer. */
export { requestKill };

/** @internal Option validators shared with the long-lived process layer. */
export {
  snapshotArgs,
  validateCwd,
  validateEnvironment,
  validateExecutable,
  validateSignal,
  validateTimingOption,
};

/** @internal Shared with the long-lived watch process layer. */
export { requestWindowsTreeKill };

/** @internal Shared result-building helpers used by process layers. */
export { createResult, elapsedMs, setSafeTimeout };

/** @internal Shared spawn options used by long-lived process layers. */
export { MAX_NODE_TIMEOUT_MS };

function requestWindowsTreeKill(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  const directFallback = (): void => {
    try {
      child.kill(signal);
    } catch {
      // Best effort only. The primary timeout/abort error remains unchanged.
    }
  };
  if (pid === undefined) {
    directFallback();
    return;
  }
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  try {
    const helper = spawn("taskkill.exe", args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    helper.once("error", directFallback);
    helper.once("close", (exitCode) => {
      if (exitCode !== 0) directFallback();
    });
    helper.unref();
  } catch {
    // Direct-child termination below is the fallback.
    directFallback();
  }
}

interface OutputCapture {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

function createResult(
  executable: string,
  args: readonly string[],
  cwd: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stdout: Buffer,
  stderr: Buffer,
  durationMs: number,
  termination: TerminationState,
  diagnostics?: readonly TypstDiagnostic[],
  capture?: OutputCapture,
): TypstProcessResult {
  return {
    executable,
    args,
    cwd,
    exitCode,
    signal,
    stdout,
    stderr,
    durationMs: Math.max(0, durationMs),
    timedOut: termination.timedOut,
    aborted: termination.aborted,
    stdoutBytes: capture?.stdoutBytes ?? stdout.length,
    stderrBytes: capture?.stderrBytes ?? stderr.length,
    stdoutTruncated: capture?.stdoutTruncated ?? false,
    stderrTruncated: capture?.stderrTruncated ?? false,
    ...(diagnostics === undefined || diagnostics.length === 0
      ? {}
      : { diagnostics: Object.freeze([...diagnostics]) }),
  };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function setSafeTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
  return setTimeout(callback, Math.min(delayMs, MAX_NODE_TIMEOUT_MS));
}

function throwSpawnError(result: TypstProcessResult, error: unknown): never {
  throw new TypstSpawnError(
    "The Typst executable could not be spawned.",
    result,
    { cause: error, spawnError: error },
  );
}

export default runProcess;
