import { requireFlag, requireFlagValue } from "./cli-flags.js";
import { checkPathShorthand } from "./inputs.js";
import { warningsFromStderr } from "../core/diagnostics.js";
import {
  TypstInvalidArgumentError,
  TypstQueryError,
  TypstQueryParseError,
} from "../core/errors.js";
import { compareExactStableVersions } from "../core/version.js";
import { withTemporaryScope, type TemporaryScope } from "../core/temp.js";
import { requireVersionForRules } from "../client/support-data.js";
import {
  extraArgsOf,
  worldArgs,
  withImpliedFeature,
  type NormalisedCompileInput,
  requireWorldCapabilities,
  validateWorldOptions,
  buildRunOptions,
  normaliseCompileInput,
  prepareInputPath,
  requireCapability,
  validateInput,
  validatePathValue,
  validateRecord,
  validateRunOptionsObject,
} from "./shared.js";
import type {
  QueryOptions,
  QueryOneResult,
  QueryResult,
  QuerySelector,
  RunOptions,
  UnknownVersionPolicy,
} from "../types/public.js";
import type { TypstProcessResult } from "../core/process.js";

/** A narrowed query options shape in which input is never a raw string. */
type NormalisedQueryOptions = Omit<QueryOptions, "input"> & {
  readonly input: NormalisedCompileInput;
};

function normaliseQueryOptions(options: QueryOptions): NormalisedQueryOptions {
  validateRecord(options, "query options");
  const { input: _input, ...rest } = options;
  return { ...rest, input: normaliseCompileInput(options.input) };
}

export interface QueryContext {
  readonly cwd: string;
  readonly unknownVersionPolicy: UnknownVersionPolicy;
  version(): Promise<{ readonly version: string }>;
  run(
    args: readonly string[],
    options?: RunOptions,
  ): Promise<TypstProcessResult>;
}

/**
 * Run a query over an input document.
 *
 * The backend is internal and version-selected: exact versions `0.7.0` through
 * `0.14.2` use the native `typst query` command; from `0.15.0` the wrapper runs
 * `typst eval` with a `query(<selector>)` expression and normalises the result
 * in JavaScript. Both routes return equivalent public results. Output is always
 * requested as JSON and decoded, with raw stdout retained on parse failure.
 */
export async function queryCommand(
  context: QueryContext,
  options: QueryOptions,
  one: boolean,
): Promise<QueryResult | QueryOneResult> {
  let normalisedOptions = normaliseQueryOptions(options);
  validateQueryOptions(normalisedOptions);
  await checkPathShorthand(options.input, options.cwd ?? context.cwd);
  const version = await context.version();
  const compilerVersion = version.version;
  const rulesVersion = requireVersionForRules(
    compilerVersion,
    context.unknownVersionPolicy,
    "query",
  );

  normalisedOptions = withImpliedFeature(
    normalisedOptions,
    normalisedOptions.target,
    rulesVersion,
  );
  validateQueryCapabilities(rulesVersion, normalisedOptions);
  if (queryBackend(rulesVersion) === "eval") {
    return await evalQueryCommand(
      context,
      normalisedOptions,
      one,
      rulesVersion,
      compilerVersion,
    );
  }
  return await nativeQueryCommand(
    context,
    normalisedOptions,
    one,
    rulesVersion,
    compilerVersion,
  );
}

interface PreparedQueryInvocation {
  readonly args: readonly string[];
  readonly runOptions: RunOptions;
}

/**
 * The native `typst query` backend, used for exact versions `0.7.0` through
 * `0.14.2`. The selector string is passed as a single `<SELECTOR>` argument;
 * labels, element names, and function selectors share one surface.
 */
async function nativeQueryCommand(
  context: QueryContext,
  options: NormalisedQueryOptions,
  one: boolean,
  rulesVersion: string,
  compilerVersion: string,
): Promise<QueryResult | QueryOneResult> {
  return await withTemporaryScope(async (scope) => {
    const prepared = await prepareNativeQueryInvocation(
      scope,
      rulesVersion,
      options,
      one,
    );
    const processResult = await context.run(prepared.args, prepared.runOptions);
    if (
      processResult.exitCode !== 0 ||
      processResult.signal !== null ||
      processResult.timedOut ||
      processResult.aborted
    ) {
      throw new TypstQueryError(
        `Typst query exited unsuccessfully (exitCode=${String(processResult.exitCode)}, signal=${String(processResult.signal)}).`,
        processResult,
        compilerVersion,
      );
    }

    const raw = processResult.stdout.toString("utf8");
    const decoded = decodeQueryJson(processResult, raw, compilerVersion);
    if (one) {
      return Object.freeze({
        element: decoded,
        raw,
        warnings: warningsFromStderr(processResult.stderr),
        process: processResult,
        compilerVersion,
      });
    }
    if (!Array.isArray(decoded)) {
      throw new TypstQueryParseError(
        "Typst query output was not a JSON array.",
        processResult,
        compilerVersion,
        { rawOutput: raw },
      );
    }
    return Object.freeze({
      elements: Object.freeze(decoded),
      raw,
      warnings: warningsFromStderr(processResult.stderr),
      process: processResult,
      compilerVersion,
    });
  });
}

/**
 * The eval-backed query backend, used from exact `0.15.0`. The wrapper runs
 * `typst eval query(<SELECTOR>) --in <INPUT>` and then normalises the decoded
 * JSON in JavaScript: field extraction and the exactly-one rule for `queryOne`
 * are applied here so the public results match the native backend.
 */
async function evalQueryCommand(
  context: QueryContext,
  options: NormalisedQueryOptions,
  one: boolean,
  rulesVersion: string,
  compilerVersion: string,
): Promise<QueryResult | QueryOneResult> {
  return await withTemporaryScope(async (scope) => {
    const prepared = await prepareEvalQueryInvocation(
      scope,
      rulesVersion,
      options,
    );
    const processResult = await context.run(prepared.args, prepared.runOptions);
    if (
      processResult.exitCode !== 0 ||
      processResult.signal !== null ||
      processResult.timedOut ||
      processResult.aborted
    ) {
      throw new TypstQueryError(
        `Typst query exited unsuccessfully (exitCode=${String(processResult.exitCode)}, signal=${String(processResult.signal)}).`,
        processResult,
        compilerVersion,
      );
    }

    const raw = processResult.stdout.toString("utf8");
    // A successful query serializes at least an empty array, so empty stdout
    // means the evaluation failed (pre-0.15.1 compilers exit 0 on failure).
    if (raw.trim() === "") {
      throw new TypstQueryError(
        "Typst query produced no result.",
        processResult,
        compilerVersion,
      );
    }
    const decoded = decodeQueryJson(processResult, raw, compilerVersion);
    if (!Array.isArray(decoded)) {
      throw new TypstQueryParseError(
        "Typst query output was not a JSON array.",
        processResult,
        compilerVersion,
        { rawOutput: raw },
      );
    }
    const elements = normaliseQueryElements(decoded, options.field);
    if (one) {
      if (elements.length !== 1) {
        throw new TypstQueryError(
          `expected exactly one element, found ${elements.length}`,
          processResult,
          compilerVersion,
        );
      }
      return Object.freeze({
        element: elements[0],
        raw,
        warnings: warningsFromStderr(processResult.stderr),
        process: processResult,
        compilerVersion,
      });
    }
    return Object.freeze({
      elements: Object.freeze(elements),
      raw,
      warnings: warningsFromStderr(processResult.stderr),
      process: processResult,
      compilerVersion,
    });
  });
}

function decodeQueryJson(
  processResult: TypstProcessResult,
  raw: string,
  compilerVersion: string,
): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new TypstQueryParseError(
      "Typst query output could not be decoded as JSON.",
      processResult,
      compilerVersion,
      { rawOutput: raw, cause: error },
    );
  }
}

/**
 * Normalise a decoded query result to the public shape: with `field`, keep only
 * the field values of elements that carry that field, mirroring the native
 * backend's `get_by_name(field).ok()` filter; without a field the elements are
 * returned unchanged.
 */
function normaliseQueryElements(
  decoded: readonly unknown[],
  field: string | undefined,
): unknown[] {
  if (field === undefined) return [...decoded];
  return decoded
    .filter(
      (element): element is Record<string, unknown> =>
        element !== null &&
        typeof element === "object" &&
        !Array.isArray(element) &&
        field in element,
    )
    .map((element) => element[field]);
}

function validateQueryOptions(options: QueryOptions): void {
  validateRecord(options, "query options");
  validateRunOptionsObject(options);
  validateWorldOptions(options);
  validateInput(options.input);
  validateSelector(options.selector);
  if (
    options.target !== undefined &&
    options.target !== "paged" &&
    options.target !== "html" &&
    options.target !== "bundle"
  ) {
    throw new TypstInvalidArgumentError(
      `Unknown query target: ${String(options.target)}.`,
    );
  }
  if (options.field !== undefined) validatePathValue(options.field, "field");
  if (options.pretty !== undefined && typeof options.pretty !== "boolean") {
    throw new TypstInvalidArgumentError("pretty must be a boolean.");
  }
  extraArgsOf(options);
}

function validateSelector(value: QuerySelector): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypstInvalidArgumentError("selector must be a non-empty string.");
  }
}

/**
 * The subcommand that serves `query()` on `version`: the native `typst query`
 * before 0.15.0, the documented `typst eval query(...)` replacement from it.
 * Gates check the same subcommand that is actually invoked.
 */
function queryBackend(version: string): "query" | "eval" {
  return compareExactStableVersions(version, "0.15.0") >= 0 ? "eval" : "query";
}

function validateQueryCapabilities(
  version: string,
  options: QueryOptions,
): void {
  const backend = queryBackend(version);
  requireCapability(version, `commands.${backend}`, "query");
  // The target is checked first: an implied `bundle`/`html` feature must not
  // mask the more precise target error.
  if (options.target !== undefined) {
    requireFlag(version, backend, "--target", "target");
    requireFlagValue(
      version,
      backend,
      "--target",
      options.target,
      `target-${options.target}`,
    );
  }
  requireWorldCapabilities(version, backend, options);
}

async function prepareNativeQueryInvocation(
  scope: TemporaryScope,
  version: string,
  options: NormalisedQueryOptions,
  one: boolean,
): Promise<PreparedQueryInvocation> {
  const staged = await prepareInputPath(
    scope,
    version,
    options.input,
    options.root,
  );
  const root = staged.root ?? options.root;
  // Before 0.7.0 `--root` and `--font-path` are global options.
  const world = worldArgs(version, "query", options, root);
  const args: string[] = [
    ...world.beforeCommand,
    "query",
    ...world.afterCommand,
  ];
  if (options.target !== undefined) args.push("--target", options.target);
  if (options.field !== undefined) args.push("--field", options.field);
  if (options.pretty === true) args.push("--pretty");
  args.push(...extraArgsOf(options), staged.path, options.selector);
  if (one) args.push("--one");

  return {
    args,
    runOptions: buildRunOptions(options, staged.stdin),
  };
}

async function prepareEvalQueryInvocation(
  scope: TemporaryScope,
  version: string,
  options: NormalisedQueryOptions,
): Promise<PreparedQueryInvocation> {
  // The selector is already a Typst expression (the native command evaluates
  // it in code mode), so wrapping it in `query(...)` reproduces the upstream
  // documented `typst eval query(<SELECTOR>) --in <INPUT>` replacement.
  const expression = `query(${options.selector})`;
  const staged = await prepareInputPath(
    scope,
    version,
    options.input,
    options.root,
  );
  const root = staged.root ?? options.root;
  const args: string[] = ["eval", expression, "--in", staged.path];
  args.push(...worldArgs(version, "eval", options, root).afterCommand);
  if (options.target !== undefined) args.push("--target", options.target);
  if (options.pretty === true) args.push("--pretty");
  args.push(...extraArgsOf(options));

  return {
    args,
    runOptions: buildRunOptions(options, staged.stdin),
  };
}
