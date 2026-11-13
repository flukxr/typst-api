import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  TypstInitConflictError,
  TypstInitError,
  TypstInvalidArgumentError,
} from "../core/errors.js";
import { requireVersionForRules } from "../client/support-data.js";
import type {
  InitOptions,
  InitResult,
  RunOptions,
  UnknownVersionPolicy,
} from "../types/public.js";
import type { TypstProcessResult } from "../core/process.js";
import {
  buildRunOptions,
  extraArgsOf,
  cliPath,
  requireCapability,
  validatePathValue,
  validateRecord,
  validateRunOptionsObject,
} from "./shared.js";

export interface InitContext {
  readonly cwd: string;
  readonly unknownVersionPolicy: UnknownVersionPolicy;
  version(): Promise<{ readonly version: string }>;
  run(
    args: readonly string[],
    options?: RunOptions,
  ): Promise<TypstProcessResult>;
}

/**
 * Initialize a new Typst project from a template (`typst init`).
 *
 * The command exists from `0.11.0`. A provided `directory` is resolved against
 * the effective working directory and, when it already exists, the call fails
 * before spawn with `TypstInitConflictError` because the compiler refuses to
 * overwrite a project directory. When `directory` is omitted the compiler
 * derives it from the template's package name, so the conflict check runs
 * inside the process and its raw evidence is preserved on `TypstInitError`.
 */
export async function initCommand(
  context: InitContext,
  options: InitOptions,
): Promise<InitResult> {
  validateInitOptions(options);
  const version = await context.version();
  const compilerVersion = version.version;
  const rulesVersion = requireVersionForRules(
    compilerVersion,
    context.unknownVersionPolicy,
    "init",
  );

  validateInitCapabilities(rulesVersion, options);

  const cwd = options.cwd ?? context.cwd;
  let resolvedDirectory: string | undefined;
  if (options.directory !== undefined) {
    const requested = options.directory;
    resolvedDirectory = isAbsolute(requested)
      ? requested
      : resolve(cwd, requested);
    await assertDestinationAvailable(resolvedDirectory, requested);
  }

  const args = buildInitArgs(options);
  const processResult = await context.run(args, buildRunOptions(options));

  if (
    processResult.exitCode !== 0 ||
    processResult.signal !== null ||
    processResult.timedOut ||
    processResult.aborted
  ) {
    throw new TypstInitError(
      `Typst init exited unsuccessfully (exitCode=${String(processResult.exitCode)}, signal=${String(processResult.signal)}).`,
      processResult,
      compilerVersion,
    );
  }

  return Object.freeze({
    ...(resolvedDirectory === undefined
      ? {}
      : { directory: resolvedDirectory }),
    process: processResult,
    compilerVersion,
  });
}

function validateInitOptions(options: InitOptions): void {
  validateRecord(options, "init options");
  validateRunOptionsObject(options);
  if (typeof options.template !== "string" || options.template.length === 0) {
    throw new TypstInvalidArgumentError("template must be a non-empty string.");
  }
  if (options.template.includes("\0")) {
    throw new TypstInvalidArgumentError("template must not contain NUL bytes.");
  }
  if (options.directory !== undefined)
    validatePathValue(options.directory, "directory");
  if (options.packagePath !== undefined)
    validatePathValue(options.packagePath, "packagePath");
  if (options.packageCachePath !== undefined)
    validatePathValue(options.packageCachePath, "packageCachePath");
  extraArgsOf(options);
}

/**
 * Reject a destination that already exists before spawn. The compiler refuses
 * to overwrite an existing project directory, so failing early with a typed
 * conflict error is both safer and cheaper than letting the process fail.
 */
async function assertDestinationAvailable(
  resolved: string,
  original: string,
): Promise<void> {
  try {
    await stat(resolved);
    throw new TypstInitConflictError(original, resolved);
  } catch (error) {
    if (error instanceof TypstInitConflictError) throw error;
    // ENOENT and other errors mean no conflicting entry exists; the compiler
    // remains authoritative for race conditions between the check and the
    // spawn.
  }
}

function validateInitCapabilities(version: string, options: InitOptions): void {
  requireCapability(version, "commands.init", "init");
  if (options.packagePath !== undefined)
    requireCapability(version, "options.packagePath", "packagePath");
  if (options.packageCachePath !== undefined)
    requireCapability(version, "options.packageCachePath", "packageCachePath");
}

function buildInitArgs(options: InitOptions): string[] {
  const args: string[] = ["init"];
  if (options.packagePath !== undefined)
    args.push("--package-path", options.packagePath);
  if (options.packageCachePath !== undefined)
    args.push("--package-cache-path", options.packageCachePath);
  args.push(...extraArgsOf(options), options.template);
  if (options.directory !== undefined) args.push(cliPath(options.directory));
  return args;
}

export { buildInitArgs };
