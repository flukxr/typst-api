import { knownFormatExtension } from "./compile.js";
import { hasFlag } from "./cli-flags.js";
import { checkPathShorthand } from "./inputs.js";
import { extname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  type TypstError,
  TypstInvalidArgumentError,
  TypstWatchError,
} from "../core/errors.js";
import type { TypstProcessResult } from "../core/process.js";
import { applyEnvironment } from "../core/environment.js";
import {
  spawnStreamProcess,
  type StreamOutputChunk,
} from "../core/stream-process.js";
import { createTemporaryScope, type TemporaryScope } from "../core/temp.js";
import { invokeListeners } from "../core/listeners.js";
import { requireVersionForRules } from "../client/support-data.js";
import type {
  CompileFileDestination,
  CompileFileInput,
  CompileSourceInput,
  TypstLogEvent,
  TypstWatchEvents,
  TypstWatchHandle,
  UnknownVersionPolicy,
  WatchCycleInfo,
  WatchOptions,
} from "../types/public.js";
import {
  outputArgs,
  requireOutputCapabilities,
  validateOutputOptions,
  extraArgsOf,
  worldArgs,
  requireFeatureFlag,
  validateInput,
  withImpliedFeature,
  requireWorldCapabilities,
  validateWorldOptions,
  cliPath,
  normaliseCompileInput,
  requireCapability,
  validatePathValue,
  validateRunOptionsObject,
} from "./shared.js";

/** A narrowed watch options shape in which input/output are never raw strings. */
type NormalisedWatchOptions = Omit<WatchOptions, "input" | "output"> & {
  readonly input: CompileFileInput | CompileSourceInput;
  readonly output?: CompileFileDestination;
};

function normaliseWatchOutput(
  output: string | CompileFileDestination,
): CompileFileDestination {
  if (typeof output === "string") {
    validatePathValue(output, "output");
    return { kind: "file", path: output };
  }
  return output;
}

function normaliseWatchOptions(options: WatchOptions): NormalisedWatchOptions {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new TypstInvalidArgumentError("watch options must be an object.");
  }
  const { input: _input, output: _output, ...rest } = options;
  const input = normaliseCompileInput(options.input);
  if (input.kind === "project") {
    throw new TypstInvalidArgumentError(
      "watch needs real files to observe; project inputs are not supported. Write the project to disk and watch its entry file.",
    );
  }
  return {
    ...rest,
    input,
    ...(options.output === undefined
      ? {}
      : { output: normaliseWatchOutput(options.output) }),
  };
}

const WATCH_FORMATS = new Set<"pdf" | "png" | "svg" | "html">([
  "pdf",
  "png",
  "svg",
  "html",
]);

/**
 * Start a managed `typst watch` process.
 *
 * The process is long-lived: output chunks stream through the `output` event,
 * the initial compile cycle completion is reported best-effort through
 * `ready`, and `close()` terminates the process tree and resolves with the
 * final raw process record. Source input is always staged through a temporary
 * file so the watcher has a real file to observe; that artifact is removed on
 * close, abort, timeout, and spawn failure.
 */
export async function watchCommand(
  context: WatchContext,
  options: WatchOptions,
): Promise<TypstWatchHandle> {
  let normalisedOptions = normaliseWatchOptions(options);
  validateWatchOptions(normalisedOptions);
  await checkPathShorthand(options.input, options.cwd ?? context.cwd);
  const version = await context.version();
  const compilerVersion = version.version;
  const rulesVersion = requireVersionForRules(
    compilerVersion,
    context.unknownVersionPolicy,
    "watch",
  );

  const format = resolveWatchFormat(normalisedOptions);
  normalisedOptions = withImpliedFeature(
    normalisedOptions,
    format,
    rulesVersion,
  );
  validateWatchCapabilities(rulesVersion, format, normalisedOptions);

  const env = applyEnvironment(
    context.env,
    normalisedOptions.env,
    normalisedOptions.envMode ?? "merge",
  );
  // Same inheritance as client.run(). The client's timeoutMs is deliberately
  // not inherited: a watch process is meant to outlive any default timeout.
  const diagnostics = normalisedOptions.diagnostics ?? context.diagnostics;
  const onLog = normalisedOptions.onLog ?? context.onLog;
  const runOptions = {
    cwd: normalisedOptions.cwd ?? context.cwd,
    env,
    // The watch layer has already resolved its environment. Passing replace
    // prevents the low-level runner from reintroducing process.env.
    envMode: "replace" as const,
    terminationGraceMs:
      normalisedOptions.terminationGraceMs ?? context.terminationGraceMs,
    ...(normalisedOptions.signal === undefined
      ? {}
      : { signal: normalisedOptions.signal }),
    ...(normalisedOptions.timeoutMs === undefined
      ? {}
      : { timeoutMs: normalisedOptions.timeoutMs }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(onLog === undefined ? {} : { onLog }),
  };

  // From here on a temporary scope exists. Any failure before the process
  // handle owns it must remove it again (engineering rule 12).
  const scope = await createTemporaryScope();
  let spawnHandle: ReturnType<typeof spawnStreamProcess>;
  try {
    const prepared = await prepareWatchInvocation(
      scope,
      rulesVersion,
      format,
      normalisedOptions,
    );
    spawnHandle = spawnStreamProcess(context.executable, prepared.args, {
      ...runOptions,
    });
  } catch (error) {
    await scope.cleanup().catch(() => undefined);
    throw error;
  }

  // Background cleanup triggered by the process lifecycle. Its failure is
  // surfaced by an explicit `close()` (which awaits the same promise), never
  // as an unhandled rejection.
  const cleanupInBackground = (): Promise<void> =>
    scope.cleanup().catch(() => undefined);

  const listeners: {
    [K in keyof TypstWatchEvents]: Set<TypstWatchEvents[K]>;
  } = {
    start: new Set(),
    ready: new Set(),
    cycle: new Set(),
    output: new Set(),
    error: new Set(),
    close: new Set(),
  };

  const emit = <K extends keyof TypstWatchEvents>(
    event: K,
    ...payload: Parameters<TypstWatchEvents[K]>
  ): void => {
    invokeListeners(
      listeners[event] as Set<
        (...parts: Parameters<TypstWatchEvents[K]>) => void
      >,
      ...payload,
    );
  };

  // `ready` settles exactly once: with the first detected cycle, or with the
  // error that ended the watcher before any cycle was detected. A handler is
  // attached internally so an ignored `ready` never becomes an unhandled
  // rejection.
  let readySettled = false;
  let lastError: TypstError | undefined;
  let resolveReady!: (cycle: WatchCycleInfo) => void;
  let rejectReady!: (error: TypstError) => void;
  const readyPromise = new Promise<WatchCycleInfo>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  readyPromise.catch(() => undefined);

  // `for await (const cycle of watcher)`: every iterator receives the cycles
  // detected after it was created. Cycles detected before the first iterator
  // exists are kept (bounded) and handed to it, so starting the loop right
  // after `watch()` never misses the initial cycle.
  const cycleQueues = new Set<CycleQueue>();
  let earlyCycles: WatchCycleInfo[] | undefined = [];
  let iterationFinished = false;
  const deliverCycle = (cycle: WatchCycleInfo): void => {
    if (earlyCycles !== undefined) {
      earlyCycles.push(cycle);
      if (earlyCycles.length > MAX_EARLY_CYCLES) earlyCycles.shift();
    }
    for (const queue of cycleQueues) queue.push(cycle);
  };
  const finishIteration = (): void => {
    iterationFinished = true;
    for (const queue of cycleQueues) queue.finish();
    cycleQueues.clear();
  };

  const cycleDetector = createCycleDetector((cycle) => {
    deliverCycle(cycle);
    emit("cycle", cycle);
    if (cycle.index === 1) {
      if (!readySettled) {
        readySettled = true;
        resolveReady(cycle);
      }
      emit("ready", cycle);
    }
  });

  spawnHandle.on("start", () => emit("start"));
  spawnHandle.on("output", (chunk) => {
    cycleDetector(chunk);
    emit("output", chunk);
  });
  spawnHandle.on("error", (error) => {
    lastError = error;
    emit("error", error);
  });
  spawnHandle.on("close", (result) => {
    void cleanupInBackground();
    // A watcher is long-lived; a natural exit that was not requested through
    // `close()` and did not succeed is a failure the consumer must see. Spawn
    // failures, timeout, and abort already deliver their own typed `error`
    // events upstream, so only a settled, naturally-terminated process with a
    // non-zero code or signal is classified here. The `close` event still
    // carries the authoritative raw record. Emit the typed error first so the
    // public lifecycle order is always error → close.
    const settledNaturally =
      !result.timedOut &&
      !result.aborted &&
      (result.exitCode !== null || result.signal !== null);
    try {
      if (
        settledNaturally &&
        !userRequestedClose &&
        (result.exitCode !== 0 || result.signal !== null)
      ) {
        lastError = new TypstWatchError(
          `Typst watch exited unsuccessfully (exitCode=${String(result.exitCode)}, signal=${String(result.signal)}).`,
          result,
          compilerVersion,
        );
        emit("error", lastError);
      }
    } finally {
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          lastError ??
            new TypstWatchError(
              "Typst watch closed before the first compile cycle was detected.",
              result,
              compilerVersion,
            ),
        );
      }
      finishIteration();
      emit("close", result);
    }
  });

  let userRequestedClose = false;
  const closeImpl = async (): Promise<TypstProcessResult> => {
    userRequestedClose = true;
    const result = await spawnHandle.close();
    await scope.cleanup();
    return result;
  };

  const closedPromise = spawnHandle.closed.then(async (result) => {
    await cleanupInBackground();
    return result;
  });

  const executableSource = WATCH_SOURCES.has(context.executableSource)
    ? (context.executableSource as
        "explicit" | "package" | "environment" | "path")
    : "path";

  const publicHandle: TypstWatchHandle = {
    executable: context.executable,
    executableSource,
    compilerVersion,
    pid: spawnHandle.pid,
    closed: closedPromise,
    ready: readyPromise,
    on<K extends keyof TypstWatchEvents>(
      event: K,
      listener: TypstWatchEvents[K],
    ): () => void {
      if (typeof listener !== "function") {
        throw new TypstInvalidArgumentError(
          "The watch event listener must be a function.",
        );
      }
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
    close(): Promise<TypstProcessResult> {
      return closeImpl();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await closeImpl();
    },
    [Symbol.asyncIterator](): AsyncIterator<WatchCycleInfo> {
      const queue = new CycleQueue(earlyCycles ?? [], () =>
        cycleQueues.delete(queue),
      );
      earlyCycles = undefined;
      if (iterationFinished) queue.finish();
      else cycleQueues.add(queue);
      return queue;
    },
  };

  return publicHandle;
}

export interface WatchContext {
  readonly executable: string;
  readonly executableSource: string;
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly terminationGraceMs: number;
  readonly unknownVersionPolicy: UnknownVersionPolicy;
  /** Client-level defaults; a watch option of the same name wins. */
  readonly diagnostics?: boolean | undefined;
  readonly onLog?: ((event: TypstLogEvent) => void) | undefined;
  version(): Promise<{ readonly version: string }>;
}

const WATCH_SOURCES: ReadonlySet<string> = new Set([
  "explicit",
  "package",
  "environment",
  "path",
]);

interface PreparedWatchInvocation {
  readonly args: readonly string[];
}

/**
 * Internal: build the version-gated watch argument list. Exported only for
 * focused serialization tests.
 */
export async function prepareWatchInvocation(
  scope: TemporaryScope,
  version: string,
  format: "pdf" | "png" | "svg" | "html",
  options: NormalisedWatchOptions,
): Promise<PreparedWatchInvocation> {
  let inputPath: string;
  if (options.input.kind === "file") inputPath = cliPath(options.input.path);
  else {
    const name = options.input.virtualPath ?? "source.typ";
    inputPath = await scope.createFile(
      name.endsWith(".typ") ? name : `${name}.typ`,
      options.input.data,
    );
  }

  const world = worldArgs(version, "watch", options);
  const args: string[] = [
    ...world.beforeCommand,
    "watch",
    ...world.afterCommand,
  ];
  args.push(...outputArgs(options));
  if (options.noServe === true) args.push("--no-serve");
  if (options.noReload === true) args.push("--no-reload");
  if (options.port !== undefined) args.push("--port", String(options.port));
  if (options.format !== undefined && hasFlag(version, "watch", "--format"))
    args.push("--format", format);
  if (options.open === true) args.push("--open");
  args.push(...extraArgsOf(options), inputPath);
  if (options.output !== undefined) args.push(cliPath(options.output.path));

  return { args };
}

function resolveWatchFormat(
  options: NormalisedWatchOptions,
): "pdf" | "png" | "svg" | "html" {
  if (options.format !== undefined) return options.format;
  if (options.output === undefined) return "pdf";
  const value = extname(options.output.path).toLowerCase().slice(1);
  if (value === "pdf" || value === "png" || value === "svg" || value === "html")
    return value;
  throw new TypstInvalidArgumentError(
    "Cannot infer watch output format from destination path; specify format.",
  );
}

function validateWatchOptions(options: NormalisedWatchOptions): void {
  validateRunOptionsObject(options);
  validateWorldOptions(options);
  validateInput(options.input);
  if (options.output !== undefined) {
    if (
      options.output === null ||
      typeof options.output !== "object" ||
      Array.isArray(options.output)
    ) {
      throw new TypstInvalidArgumentError("output must be an object.");
    }
    if (options.output.kind !== "file") {
      throw new TypstInvalidArgumentError(
        "watch output must be a file destination.",
      );
    }
    validatePathValue(options.output.path, "output.path");
  }
  if (options.format !== undefined && !WATCH_FORMATS.has(options.format)) {
    throw new TypstInvalidArgumentError(
      `Unknown watch output format: ${String(options.format)}.`,
    );
  }
  validateOutputOptions(options);
  if (options.open !== undefined && typeof options.open !== "boolean") {
    throw new TypstInvalidArgumentError("open must be a boolean.");
  }
  for (const [name, value] of [
    ["noServe", options.noServe],
    ["noReload", options.noReload],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypstInvalidArgumentError(`${name} must be a boolean.`);
    }
  }
  if (
    options.port !== undefined &&
    (typeof options.port !== "number" ||
      !Number.isSafeInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535)
  ) {
    throw new TypstInvalidArgumentError(
      "port must be an integer between 0 and 65535.",
    );
  }
  extraArgsOf(options);
}

function validateWatchCapabilities(
  version: string,
  format: "pdf" | "png" | "svg" | "html",
  options: NormalisedWatchOptions,
): void {
  requireCapability(version, "commands.watch", "watch");
  requireCapability(version, `formats.${format}`, format);
  requireWorldCapabilities(version, "watch", options);
  if (format === "html") requireFeatureFlag(version, options.features, "html");
  if (options.format !== undefined && hasFlag(version, "watch", "--format"))
    requireCapability(
      version,
      "options.explicitOutputFormat",
      "explicit output format",
    );
  if (
    options.format !== undefined &&
    !hasFlag(version, "watch", "--format") &&
    options.output !== undefined &&
    knownFormatExtension(options.output.path) !== options.format
  ) {
    throw new TypstInvalidArgumentError(
      "Explicit format does not match the destination extension.",
    );
  }
  requireOutputCapabilities(version, "watch", format, options);
  if (
    options.noServe === true ||
    options.noReload === true ||
    options.port !== undefined
  ) {
    requireCapability(version, "options.watchServer", "watchServer");
    if (format !== "html") {
      throw new TypstInvalidArgumentError(
        "Watch server options (noServe, noReload, port) require HTML output.",
      );
    }
  }
}

/**
 * Best-effort watch compile-cycle detection.
 *
 * The CLI reports cycles through human text such as `compiling ...` and
 * `compiled successfully in ...` / `compiled with errors`. Detection is
 * conservative: it fires once per observed cycle boundary and never claims a
 * status it cannot classify. The raw text of the cycle is always delivered.
 * Every detected cycle carries a 1-based `index`.
 *
 * Internal: exported only for focused unit tests.
 */
export function createCycleDetector(
  onCycle: (cycle: WatchCycleInfo) => void,
): (chunk: StreamOutputChunk) => void {
  let buffer = "";
  // Chunk boundaries may split a multi-byte UTF-8 sequence.
  const decoder = new StringDecoder("utf8");
  let inCycle = false;
  let cycleCount = 0;
  // A marker line is short. Bound the partial-line buffer so a malformed or
  // binary stderr stream without newlines cannot grow the watcher heap for the
  // lifetime of the process. A truncated partial line is never classified.
  const MAX_PENDING_LINE_CHARS = 64 * 1024;
  const CYCLE_START = /compiling\s*\.\.\./u;
  const SUCCESS = /compiled successfully/u;
  const FAILURE = /compiled with errors/u;

  return (chunk: StreamOutputChunk): void => {
    if (chunk.stream !== "stderr") return;
    buffer += decoder.write(chunk.chunk);
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    if (buffer.length > MAX_PENDING_LINE_CHARS) {
      buffer = buffer.slice(-MAX_PENDING_LINE_CHARS);
    }
    for (const line of lines) {
      if (CYCLE_START.test(line)) {
        inCycle = true;
        continue;
      }
      if (!inCycle) continue;
      const status = SUCCESS.test(line)
        ? ("success" as const)
        : FAILURE.test(line)
          ? ("error" as const)
          : undefined;
      if (status !== undefined) {
        inCycle = false;
        cycleCount += 1;
        onCycle({ index: cycleCount, status, raw: `${line}\n` });
      }
    }
  };
}

/** Cycles kept for the first iterator when none exists yet. */
const MAX_EARLY_CYCLES = 64;

/**
 * One `for await` consumer of watch cycles. Iteration ends when the watcher
 * settles; leaving the loop early (`break`) only detaches this consumer and
 * does not stop the watcher.
 */
class CycleQueue implements AsyncIterator<WatchCycleInfo> {
  private readonly items: WatchCycleInfo[];
  private readonly waiters: Array<
    (result: IteratorResult<WatchCycleInfo>) => void
  > = [];
  private done = false;

  constructor(
    initial: readonly WatchCycleInfo[],
    private readonly detach: () => void,
  ) {
    this.items = [...initial];
  }

  push(cycle: WatchCycleInfo): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ value: cycle, done: false });
    else this.items.push(cycle);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<WatchCycleInfo>> {
    const item = this.items.shift();
    if (item !== undefined)
      return Promise.resolve({ value: item, done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<WatchCycleInfo>> {
    this.items.length = 0;
    this.finish();
    this.detach();
    return Promise.resolve({ value: undefined, done: true });
  }
}
