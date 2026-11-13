import { checkPathShorthand } from "./inputs.js";
import { warningsFromStderr } from "../core/diagnostics.js";
import {
  TypstEvalError,
  TypstEvalParseError,
  TypstInvalidArgumentError,
  UnsupportedTypstFeatureError,
} from "../core/errors.js";
import { compareExactStableVersions } from "../core/version.js";
import { withTemporaryScope, type TemporaryScope } from "../core/temp.js";
import { requireVersionForRules } from "../client/support-data.js";
import {
  extraArgsOf,
  worldArgs,
  requireFeatureFlag,
  withImpliedFeature,
  type NormalisedCompileInput,
  requireWorldCapabilities,
  validateWorldOptions,
  buildRunOptions,
  normaliseCompileInput,
  prepareInputPath,
  requireCapability,
  validateInput,
  validateRecord,
  validateRunOptionsObject,
} from "./shared.js";
import type {
  EvalOptions,
  EvalResult,
  RunOptions,
  TypstSerializationFormat,
  UnknownVersionPolicy,
} from "../types/public.js";
import type { TypstProcessResult } from "../core/process.js";

/** A narrowed eval options shape in which input is never a raw string. */
type NormalisedEvalOptions = Omit<EvalOptions, "input"> & {
  readonly input?: NormalisedCompileInput;
};

export interface EvalContext {
  readonly cwd: string;
  readonly unknownVersionPolicy: UnknownVersionPolicy;
  version(): Promise<{ readonly version: string }>;
  run(
    args: readonly string[],
    options?: RunOptions,
  ): Promise<TypstProcessResult>;
}

const SERIALIZATION_FORMATS: ReadonlySet<string> = new Set(["json", "yaml"]);
const EVAL_TARGETS: ReadonlySet<string> = new Set(["paged", "html", "bundle"]);

function normaliseEvalOptions(options: EvalOptions): NormalisedEvalOptions {
  validateRecord(options, "eval options");
  const { input: _input, ...rest } = options;
  return options.input === undefined
    ? rest
    : { ...rest, input: normaliseCompileInput(options.input) };
}

/**
 * Evaluate a piece of Typst code, optionally in the context of a document.
 *
 * The command exists from exact `0.15.0`. Between `0.15.0` and `0.15.1` a
 * failed evaluation exits with code `0` while emitting no serialized value, so
 * the wrapper treats an exit-`0` run with empty stdout as a failure too; from
 * `0.15.1` the compiler exits with code `1` and the normal unsuccessful-exit
 * path handles it.
 */
export async function evalCommand(
  context: EvalContext,
  expression: string,
  options: EvalOptions = {},
): Promise<EvalResult> {
  let normalisedOptions: NormalisedEvalOptions = normaliseEvalOptions(options);
  validateEvalOptions(expression, normalisedOptions);
  await checkPathShorthand(options.input, options.cwd ?? context.cwd);
  const version = await context.version();
  const compilerVersion = version.version;
  const rulesVersion = requireVersionForRules(
    compilerVersion,
    context.unknownVersionPolicy,
    "eval",
  );
  if (compareExactStableVersions(rulesVersion, "0.15.0") < 0) {
    throw new UnsupportedTypstFeatureError("eval", compilerVersion, {
      requiredVersion: "0.15.0",
    });
  }

  normalisedOptions = withImpliedFeature(
    normalisedOptions,
    normalisedOptions.target,
    rulesVersion,
  );
  validateEvalCapabilities(rulesVersion, normalisedOptions);
  const format: TypstSerializationFormat = normalisedOptions.format ?? "json";
  return await withTemporaryScope(async (scope) => {
    const prepared = await prepareEvalInvocation(
      scope,
      rulesVersion,
      expression,
      normalisedOptions,
    );
    const processResult = await context.run(prepared.args, prepared.runOptions);
    if (
      processResult.exitCode !== 0 ||
      processResult.signal !== null ||
      processResult.timedOut ||
      processResult.aborted
    ) {
      throw new TypstEvalError(
        `Typst eval exited unsuccessfully (exitCode=${String(processResult.exitCode)}, signal=${String(processResult.signal)}).`,
        processResult,
        compilerVersion,
      );
    }

    const raw = processResult.stdout.toString("utf8");
    // A successful eval always serializes a value; empty stdout means the
    // evaluation failed even though pre-0.15.1 compilers exit with code 0.
    if (raw.trim() === "") {
      throw new TypstEvalError(
        "Typst eval produced no serialized value.",
        processResult,
        compilerVersion,
      );
    }

    const result: {
      readonly raw: string;
      readonly format: TypstSerializationFormat;
      readonly value?: unknown;
    } = { raw, format };
    if (format === "json") {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new TypstEvalParseError(
          "Typst eval output could not be decoded as JSON.",
          processResult,
          compilerVersion,
          { rawOutput: raw, cause: error },
        );
      }
      return Object.freeze({
        ...result,
        value,
        warnings: warningsFromStderr(processResult.stderr),
        process: processResult,
        compilerVersion,
      });
    }
    return Object.freeze({
      ...result,
      warnings: warningsFromStderr(processResult.stderr),
      process: processResult,
      compilerVersion,
    });
  });
}

function validateEvalOptions(
  expression: string,
  options: NormalisedEvalOptions,
): void {
  if (
    typeof expression !== "string" ||
    expression.length === 0 ||
    expression.includes("\0")
  ) {
    throw new TypstInvalidArgumentError(
      "expression must be a non-empty string.",
    );
  }
  validateRecord(options, "eval options");
  validateRunOptionsObject(options);
  validateWorldOptions(options);
  if (options.input !== undefined) validateInput(options.input);
  if (options.format !== undefined) {
    if (!SERIALIZATION_FORMATS.has(options.format)) {
      throw new TypstInvalidArgumentError(
        `Unknown serialization format: ${String(options.format)}.`,
      );
    }
  }
  if (options.target !== undefined) {
    if (!EVAL_TARGETS.has(options.target)) {
      throw new TypstInvalidArgumentError(
        `Unknown eval target: ${String(options.target)}.`,
      );
    }
  }
  if (options.pretty !== undefined && typeof options.pretty !== "boolean") {
    throw new TypstInvalidArgumentError("pretty must be a boolean.");
  }
  extraArgsOf(options);
}

function validateEvalCapabilities(
  version: string,
  options: NormalisedEvalOptions,
): void {
  requireCapability(version, "commands.eval", "eval");
  requireWorldCapabilities(version, "eval", options);
  if (options.input !== undefined)
    requireCapability(version, "options.evalIn", "in");
  if (options.format !== undefined)
    requireCapability(version, "options.evalFormat", "format");
  if (options.pretty === true)
    requireCapability(version, "options.evalPretty", "pretty");
  if (options.target !== undefined)
    requireCapability(version, "options.evalTarget", "target");
  if (options.target === "html")
    requireFeatureFlag(version, options.features, "html");
  if (options.target === "bundle")
    requireFeatureFlag(version, options.features, "bundle");
}

async function prepareEvalInvocation(
  scope: TemporaryScope,
  version: string,
  expression: string,
  options: NormalisedEvalOptions,
): Promise<{
  readonly args: readonly string[];
  readonly runOptions: RunOptions;
}> {
  const args: string[] = ["eval"];
  // A leading-hyphen expression would be parsed as a clap option (for example
  // `-1`). It is passed last, after a `--` separator, because every argument
  // following `--` is positional and the options must come before it.
  const dashed = expression.startsWith("-");
  if (!dashed) args.push(expression);
  let stdin: string | Uint8Array | undefined;
  let root = options.root;
  if (options.input !== undefined) {
    const staged = await prepareInputPath(
      scope,
      version,
      options.input,
      options.root,
    );
    root = staged.root ?? root;
    args.push("--in", staged.path);
    stdin = staged.stdin;
  }
  if (options.target !== undefined) args.push("--target", options.target);
  if (options.format !== undefined) args.push("--format", options.format);
  if (options.pretty === true) args.push("--pretty");
  args.push(...worldArgs(version, "eval", options, root).afterCommand);
  args.push(...extraArgsOf(options));
  if (dashed) args.push("--", expression);

  return { args, runOptions: buildRunOptions(options, stdin) };
}
