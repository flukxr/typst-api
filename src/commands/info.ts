import { TypstInfoError, TypstInvalidArgumentError } from "../core/errors.js";
import { requireVersionForRules } from "../client/support-data.js";
import type {
  InfoOptions,
  InfoResult,
  RunOptions,
  UnknownVersionPolicy,
} from "../types/public.js";
import type { TypstProcessResult } from "../core/process.js";
import {
  buildRunOptions,
  extraArgsOf,
  requireCapability,
  validateRecord,
  validateRunOptionsObject,
} from "./shared.js";

export interface InfoContext {
  readonly unknownVersionPolicy: UnknownVersionPolicy;
  version(): Promise<{ readonly version: string }>;
  run(
    args: readonly string[],
    options?: RunOptions,
  ): Promise<TypstProcessResult>;
}

/**
 * Display debugging information about Typst (`typst info`).
 *
 * The command exists from `0.14.0`. The raw output text is the stable result.
 * With `format: "json"` the output is also decoded into `data`, but the raw
 * text always remains authoritative. The human-readable report truncates the
 * build commit hash; that truncation is an upstream display behavior and is
 * never used as structured data.
 */
export async function infoCommand(
  context: InfoContext,
  options: InfoOptions = {},
): Promise<InfoResult> {
  validateInfoOptions(options);
  const version = await context.version();
  const compilerVersion = version.version;
  const rulesVersion = requireVersionForRules(
    compilerVersion,
    context.unknownVersionPolicy,
    "info",
  );

  validateInfoCapabilities(rulesVersion, options);
  const args = buildInfoArgs(options);
  const processResult = await context.run(args, buildRunOptions(options));

  if (
    processResult.exitCode !== 0 ||
    processResult.signal !== null ||
    processResult.timedOut ||
    processResult.aborted
  ) {
    throw new TypstInfoError(
      `Typst info exited unsuccessfully (exitCode=${String(processResult.exitCode)}, signal=${String(processResult.signal)}).`,
      processResult,
      compilerVersion,
    );
  }

  const raw =
    processResult.stdout.length > 0
      ? processResult.stdout.toString("utf8")
      : processResult.stderr.toString("utf8");
  const decoded = options.format === "json" ? decodeJson(raw) : undefined;
  return Object.freeze({
    raw,
    ...(decoded === undefined ? {} : { data: decoded }),
    process: processResult,
    compilerVersion,
  });
}

function validateInfoOptions(options: InfoOptions): void {
  validateRecord(options, "info options");
  validateRunOptionsObject(options);
  if (
    options.format !== undefined &&
    options.format !== "json" &&
    options.format !== "yaml"
  ) {
    throw new TypstInvalidArgumentError(
      `Unknown info format: ${String(options.format)}.`,
    );
  }
  if (options.pretty !== undefined && typeof options.pretty !== "boolean") {
    throw new TypstInvalidArgumentError("pretty must be a boolean.");
  }
  extraArgsOf(options);
}

function validateInfoCapabilities(
  version: string,
  _options: InfoOptions,
): void {
  requireCapability(version, "commands.info", "info");
}

function buildInfoArgs(options: InfoOptions): string[] {
  const args: string[] = ["info"];
  if (options.format !== undefined) args.push("--format", options.format);
  if (options.pretty === true) args.push("--pretty");
  args.push(...extraArgsOf(options));
  return args;
}

function decodeJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export { buildInfoArgs };
