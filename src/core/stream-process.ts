import { invokeListeners } from "./listeners.js";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { performance } from "node:perf_hooks";

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
import {
  createResult,
  elapsedMs,
  requestKill,
  setSafeTimeout,
  snapshotArgs,
  validateCwd,
  validateEnvironment,
  validateExecutable,
  validateSignal,
  validateTimingOption,
} from "./process.js";
import { applyEnvironment } from "./environment.js";
import type { TypstProcessResult } from "./process.js";

export {
  TypstAbortError,
  TypstInvalidArgumentError,
  TypstSpawnError,
  TypstTimeoutError,
} from "./errors.js";

/** Options accepted by the long-lived process runner. */
export interface StreamProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly envMode?: "merge" | "replace";
  readonly terminationGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Maximum bytes retained per stream in the final `close` record. Output
   * chunks still stream through the `output` event in full; only the retained
   * tail is bounded. Defaults to 1 MiB per stream and may be `0` to retain no
   * bytes. Truncation is always explicit through `stdoutTruncated`/
   * `stderrTruncated`, the total byte counts, and one `output_truncated` log
   * event per stream.
   */
  readonly maxBufferedOutputBytes?: number;
  /**
   * When true, best-effort structured diagnostics are parsed from the stderr
   * accumulated by the long-lived process and attached to its final record.
   * Raw stderr remains authoritative.
   */
  readonly diagnostics?: boolean;
  /**
   * Opt-in callback receiving redaction-safe lifecycle events during the
   * process lifetime. The raw output events remain the authoritative stream.
   */
  readonly onLog?: (event: TypstLogEvent) => void;
}

/** A chunk of raw child output, tagged with its originating stream. */
export interface StreamOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly chunk: Buffer;
}

/** Event listeners accepted by a long-lived process handle. */
export interface StreamProcessEvents {
  start: () => void;
  output: (chunk: StreamOutputChunk) => void;
  error: (error: TypstSpawnError | TypstTimeoutError | TypstAbortError) => void;
  close: (result: TypstProcessResult) => void;
}

type ListenerMap = {
  [K in keyof StreamProcessEvents]: Set<StreamProcessEvents[K]>;
};

/**
 * A long-lived process handle with streaming output and explicit disposal.
 *
 * The process is spawned immediately. Output chunks are delivered as they
 * arrive; the final `close` event carries the full normalised process record.
 * Spawn failures, timeout and abort deliver a typed error followed by `close`
 * with the same raw evidence. `close()` terminates the process tree and
 * settles once; repeated calls share the settlement.
 */
export interface StreamProcessHandle {
  readonly executable: string;
  readonly args: readonly string[];
  readonly pid: number | undefined;
  /**
   * Resolves with the final process record once the process settles for any
   * reason: `close()`, natural exit, timeout, abort, or spawn failure.
   */
  readonly closed: Promise<TypstProcessResult>;
  on<K extends keyof StreamProcessEvents>(
    event: K,
    listener: StreamProcessEvents[K],
  ): () => void;
  close(): Promise<TypstProcessResult>;
  [Symbol.asyncDispose](): Promise<void>;
}

const DEFAULT_TERMINATION_GRACE_MS = 1_000;
/** Retained tail per stream for long-lived processes (1 MiB). */
const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 1_048_576;

/**
 * Long-lived children that are still running. On POSIX they run in their own
 * process group so the whole tree can be signalled, which also means they do
 * not receive the parent's Ctrl+C. When the Node.js process exits, every
 * remaining child is terminated synchronously so a watcher never outlives the
 * program that started it.
 */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function terminateLiveChildrenOnExit(): void {
  for (const child of liveChildren) {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill();
      }
    } catch {
      // Already gone, or the group is not signalable; nothing else to do.
    }
  }
  liveChildren.clear();
}

function trackLiveChild(child: ChildProcess): void {
  if (!exitHookInstalled) {
    process.once("exit", terminateLiveChildrenOnExit);
    exitHookInstalled = true;
  }
  liveChildren.add(child);
}

interface NormalisedStreamOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly terminationGraceMs: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBufferedOutputBytes: number;
  readonly diagnostics: boolean;
  readonly onLog?: (event: TypstLogEvent) => void;
}

/**
 * Spawn a long-lived process and stream its output until `close()`.
 *
 * Unlike `runProcess`, this runner does not settle on its own: the child is
 * expected to keep running. `close()` requests graceful termination, escalates
 * to forced termination after `terminationGraceMs`, and resolves with the
 * final normalised record.
 */
export function spawnStreamProcess(
  executable: string,
  args: readonly string[] = [],
  options: StreamProcessOptions = {},
): StreamProcessHandle {
  const normalised = normaliseOptions(options);
  const executableSnapshot = validateExecutable(executable);
  const argsSnapshot = snapshotArgs(args);
  const cwd = normalised.cwd;
  const startedAt = performance.now();

  const listeners: ListenerMap = {
    start: new Set(),
    output: new Set(),
    error: new Set(),
    close: new Set(),
  };

  const emit = <K extends keyof StreamProcessEvents>(
    event: K,
    ...payload: Parameters<StreamProcessEvents[K]>
  ): void => {
    invokeListeners(
      listeners[event] as Set<
        (...parts: Parameters<StreamProcessEvents[K]>) => void
      >,
      ...payload,
    );
  };

  const spawnOptions: SpawnOptions = {
    cwd,
    env: normalised.env,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
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
    let resolveClosed!: (result: TypstProcessResult) => void;
    const closed = new Promise<TypstProcessResult>((resolvePendingClosed) => {
      resolveClosed = resolvePendingClosed;
    });
    const handle = createHandle(
      executableSnapshot,
      argsSnapshot,
      undefined,
      listeners,
      () => closed,
      closed,
    );
    // Defer past the current microtask queue so synchronous callers and async
    // wrappers such as `watch()` can attach listeners before the lifecycle
    // events fire. `closed` resolves only after both events are delivered,
    // matching the settled-child path.
    setImmediate(() => {
      try {
        emit(
          "error",
          new TypstSpawnError(
            "The Typst executable could not be spawned.",
            result,
            {
              cause: error,
              spawnError: error,
            },
          ),
        );
      } finally {
        try {
          emit("close", result);
        } finally {
          resolveClosed(result);
        }
      }
    });
    return handle;
  }

  const stdout = new BoundedOutputBuffer(normalised.maxBufferedOutputBytes);
  const stderr = new BoundedOutputBuffer(normalised.maxBufferedOutputBytes);
  let settled = false;
  let settledResult: TypstProcessResult | undefined;
  let pendingClose:
    | {
        promise: Promise<TypstProcessResult>;
        resolve: (result: TypstProcessResult) => void;
      }
    | undefined;
  let closedResolve: ((result: TypstProcessResult) => void) | undefined;
  const closedPromise = new Promise<TypstProcessResult>((resolve) => {
    closedResolve = resolve;
  });
  let spawnFailure: unknown | undefined;
  let termination: { timedOut: boolean; aborted: boolean } = {
    timedOut: false,
    aborted: false,
  };
  let abortReason: unknown;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let terminationTimer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  const emitLog = (event: TypstLogEventInput): void => {
    if (normalised.onLog === undefined) return;
    try {
      normalised.onLog({ ...event, command: "typst" } as TypstLogEvent);
    } catch {
      // A user callback must never take down the process runner.
    }
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.from(chunk);
    const capture = stdout.push(buffer);
    emitLog({
      kind: "stdout_chunk",
      timestamp: elapsedMs(startedAt),
      stream: "stdout",
      chunkLength: buffer.length,
    });
    if (capture.justTruncated) {
      emitLog({
        kind: "output_truncated",
        timestamp: elapsedMs(startedAt),
        stream: "stdout",
        totalBytes: capture.totalBytes,
        droppedBytes: capture.droppedBytes,
      });
    }
    emit("output", { stream: "stdout", chunk: buffer });
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.from(chunk);
    const capture = stderr.push(buffer);
    emitLog({
      kind: "stderr_chunk",
      timestamp: elapsedMs(startedAt),
      stream: "stderr",
      chunkLength: buffer.length,
    });
    if (capture.justTruncated) {
      emitLog({
        kind: "output_truncated",
        timestamp: elapsedMs(startedAt),
        stream: "stderr",
        totalBytes: capture.totalBytes,
        droppedBytes: capture.droppedBytes,
      });
    }
    emit("output", { stream: "stderr", chunk: buffer });
  });
  child.stdout?.on("error", () => undefined);
  child.stderr?.on("error", () => undefined);
  child.stdin?.on("error", () => undefined);

  const makeDiagnostics = (
    stderrBuf: Buffer,
  ): readonly TypstDiagnostic[] | undefined => {
    if (!normalised.diagnostics || stderrBuf.length === 0) return undefined;
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
    const stdoutBuf = stdout.toBuffer();
    const stderrBuf = stderr.toBuffer();
    return createResult(
      executableSnapshot,
      argsSnapshot,
      cwd,
      exitCode,
      signal,
      stdoutBuf,
      stderrBuf,
      elapsedMs(startedAt),
      termination,
      makeDiagnostics(stderrBuf),
      {
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      },
    );
  };

  const settle = (result: TypstProcessResult): void => {
    if (settled) return;
    settled = true;
    settledResult = result;
    liveChildren.delete(child);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (terminationTimer !== undefined) clearTimeout(terminationTimer);
    if (abortListener !== undefined && normalised.signal !== undefined) {
      normalised.signal.removeEventListener("abort", abortListener);
    }
    emitLog({
      kind: "exit",
      timestamp: elapsedMs(startedAt),
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
    });
    // Listeners are user code. A synchronously throwing `close` listener must
    // not be able to strand `closed`, `close()` or `asyncDispose()`.
    try {
      emit("close", result);
    } finally {
      if (closedResolve !== undefined) {
        closedResolve(result);
        closedResolve = undefined;
      }
      if (pendingClose !== undefined) {
        pendingClose.resolve(result);
        pendingClose = undefined;
      }
    }
  };

  const settleWithError = (
    error: TypstSpawnError | TypstTimeoutError | TypstAbortError,
    result: TypstProcessResult,
  ): void => {
    // The lifecycle contract is error first, then close. Settle in `finally`
    // so a throwing user error listener cannot leave the handle unresolved or
    // the process tree un-reaped.
    try {
      emit("error", error);
    } finally {
      settle(result);
    }
  };

  const requestTermination = (kind: "timeout" | "abort"): void => {
    if (settled || termination.timedOut || termination.aborted) return;
    termination =
      kind === "timeout"
        ? { timedOut: true, aborted: false }
        : { timedOut: false, aborted: true };
    if (kind === "abort") abortReason = normalised.signal?.reason;
    requestKill(child, false);
    terminationTimer = setSafeTimeout(() => {
      terminationTimer = undefined;
      if (!settled) requestKill(child, true);
    }, normalised.terminationGraceMs);
    terminationTimer.unref?.();
  };

  const requestClose = (): void => {
    if (settled) return;
    requestKill(child, false);
    // A timeout or abort may already have armed the escalation timer; keep
    // that deadline instead of leaking a second timer.
    if (terminationTimer !== undefined) return;
    terminationTimer = setSafeTimeout(() => {
      terminationTimer = undefined;
      if (!settled) requestKill(child, true);
    }, normalised.terminationGraceMs);
    terminationTimer.unref?.();
  };

  // `on`, not `once`: a failed kill() can emit a further "error" event, which
  // would otherwise be an unhandled error event.
  child.on("error", (error: Error) => {
    if (settled || spawnFailure !== undefined) return;
    spawnFailure = error;
  });
  child.once("spawn", () => {
    if (!settled) trackLiveChild(child);
    emitLog({
      kind: "spawn",
      timestamp: elapsedMs(startedAt),
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });
    emit("start");
    if (
      normalised.timeoutMs !== undefined &&
      !settled &&
      spawnFailure === undefined
    ) {
      timeoutTimer = setSafeTimeout(() => {
        timeoutTimer = undefined;
        requestTermination("timeout");
      }, normalised.timeoutMs);
      timeoutTimer.unref?.();
    }
  });
  child.once("close", (exitCode, signal) => {
    if (spawnFailure !== undefined) {
      // A spawn error normally precedes close; the normalised record keeps
      // the same shape as the buffered runner's spawn-failure record.
      const result = makeResult(null, null);
      settleWithError(
        new TypstSpawnError(
          "The Typst executable could not be spawned.",
          result,
          {
            cause: spawnFailure,
            spawnError: spawnFailure,
          },
        ),
        result,
      );
      return;
    }
    const result = makeResult(exitCode, signal);
    if (termination.timedOut) {
      settleWithError(
        new TypstTimeoutError(
          "The Typst watch process exceeded its timeout.",
          result,
        ),
        result,
      );
      return;
    }
    if (termination.aborted) {
      settleWithError(
        new TypstAbortError(
          "The Typst watch process was aborted.",
          result,
          abortReason === undefined ? undefined : { cause: abortReason },
        ),
        result,
      );
      return;
    }
    settle(result);
  });

  if (normalised.signal !== undefined) {
    abortListener = () => requestTermination("abort");
    normalised.signal.addEventListener("abort", abortListener, { once: true });
    if (normalised.signal.aborted) requestTermination("abort");
  }

  const closeImpl = (): Promise<TypstProcessResult> => {
    if (settled) return Promise.resolve(settledResult as TypstProcessResult);
    if (pendingClose === undefined) {
      let resolveClose!: (result: TypstProcessResult) => void;
      const promise = new Promise<TypstProcessResult>((resolvePending) => {
        resolveClose = resolvePending;
      });
      pendingClose = { promise, resolve: resolveClose };
      requestClose();
    }
    return pendingClose.promise;
  };

  return createHandle(
    executableSnapshot,
    argsSnapshot,
    child.pid,
    listeners,
    closeImpl,
    closedPromise,
  );
}

function createHandle(
  executable: string,
  args: readonly string[],
  pid: number | undefined,
  listeners: ListenerMap,
  closeImpl: () => Promise<TypstProcessResult>,
  closed: Promise<TypstProcessResult>,
): StreamProcessHandle {
  let disposed = false;
  return {
    executable,
    args,
    pid,
    closed,
    on<K extends keyof StreamProcessEvents>(
      event: K,
      listener: StreamProcessEvents[K],
    ): () => void {
      if (typeof listener !== "function") {
        throw new TypstInvalidArgumentError(
          "The process event listener must be a function.",
        );
      }
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
    close(): Promise<TypstProcessResult> {
      return closeImpl();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      if (disposed) return;
      disposed = true;
      await closeImpl();
    },
  };
}

function normaliseOptions(
  options: StreamProcessOptions,
): NormalisedStreamOptions {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new TypstInvalidArgumentError(
      "Stream process options must be an object.",
    );
  }
  const cwd =
    options.cwd === undefined ? process.cwd() : validateCwd(options.cwd);
  const envMode = options.envMode ?? "merge";
  if (envMode !== "merge" && envMode !== "replace") {
    throw new TypstInvalidArgumentError(
      `Unknown environment mode: ${String(envMode)}.`,
    );
  }
  validateEnvironment(options.env);
  validateSignal(options.signal);
  const grace = validateTimingOption(
    "terminationGraceMs",
    options.terminationGraceMs,
  );
  const timeout = validateTimingOption("timeoutMs", options.timeoutMs);
  const terminationGraceMs = grace ?? DEFAULT_TERMINATION_GRACE_MS;
  const maxBufferedOutputBytes = validateBufferLimit(
    options.maxBufferedOutputBytes,
  );
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
  return {
    cwd,
    env: applyEnvironment(process.env, options.env, envMode),
    terminationGraceMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
    maxBufferedOutputBytes,
    diagnostics: options.diagnostics === true,
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  };
}

function validateBufferLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_BUFFERED_OUTPUT_BYTES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypstInvalidArgumentError(
      "maxBufferedOutputBytes must be a non-negative safe integer.",
    );
  }
  return value;
}

interface CapturePushResult {
  readonly justTruncated: boolean;
  readonly totalBytes: number;
  readonly droppedBytes: number;
}

/**
 * Retains at most `limit` bytes of a stream's tail without letting heap use
 * grow with the total output. Chunks are kept as a deque and only the oldest
 * chunk is sliced or discarded, so each byte is trimmed at most once.
 */
class BoundedOutputBuffer {
  private readonly limit: number;
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private observedBytes = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  get totalBytes(): number {
    return this.observedBytes;
  }

  get truncated(): boolean {
    return this.observedBytes > this.limit;
  }

  push(chunk: Buffer): CapturePushResult {
    const wasTruncated = this.truncated;
    this.observedBytes += chunk.length;
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.retainedBytes += chunk.length;
      this.trim();
    }
    return {
      justTruncated: !wasTruncated && this.truncated,
      totalBytes: this.observedBytes,
      droppedBytes: this.observedBytes - this.retainedBytes,
    };
  }

  toBuffer(): Buffer {
    return this.chunks.length === 0
      ? Buffer.alloc(0)
      : Buffer.concat(this.chunks, this.retainedBytes);
  }

  private trim(): void {
    while (this.retainedBytes > this.limit) {
      const first = this.chunks[0];
      if (first === undefined) return;
      const overflow = this.retainedBytes - this.limit;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.retainedBytes -= overflow;
      }
    }
  }
}
