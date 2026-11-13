import { TypstFontsError, TypstInvalidArgumentError } from "../core/errors.js";
import { requireVersionForRules } from "../client/support-data.js";
import type {
  FontsOptions,
  FontsResult,
  RunOptions,
  UnknownVersionPolicy,
} from "../types/public.js";
import type { TypstProcessResult } from "../core/process.js";
import {
  type WorldOptionsLike,
  validateWorldOptions,
  validateRunOptionsObject,
  validateRecord,
  requireWorldCapabilities,
  buildRunOptions,
  worldArgs,
  extraArgsOf,
  requireCapability,
} from "./shared.js";

export interface FontsContext {
  readonly unknownVersionPolicy: UnknownVersionPolicy;
  version(): Promise<{ readonly version: string }>;
  run(
    args: readonly string[],
    options?: RunOptions,
  ): Promise<TypstProcessResult>;
}

/**
 * List fonts discovered by the compiler.
 *
 * The raw output text is the stable result across every version boundary;
 * structured parsing is intentionally absent until exact per-version formats
 * are verified. Version-gated flags follow the verified snapshot evidence:
 * `--font-path` moved from root to command level at exact `0.7.0`,
 * `--ignore-system-fonts` exists from `0.12.0`, and
 * `--ignore-embedded-fonts` from `0.14.0`.
 */
export async function fontsCommand(
  context: FontsContext,
  options: FontsOptions = {},
): Promise<FontsResult> {
  validateFontsOptions(options);
  const version = await context.version();
  const compilerVersion = version.version;
  const rulesVersion = requireVersionForRules(
    compilerVersion,
    context.unknownVersionPolicy,
    "font listing",
  );

  validateFontsCapabilities(rulesVersion, options);
  const args = buildFontsArgs(rulesVersion, options);
  const processResult = await context.run(args, buildRunOptions(options));

  if (
    processResult.exitCode !== 0 ||
    processResult.signal !== null ||
    processResult.timedOut ||
    processResult.aborted
  ) {
    throw new TypstFontsError(
      `Typst fonts exited unsuccessfully (exitCode=${String(processResult.exitCode)}, signal=${String(processResult.signal)}).`,
      processResult,
      compilerVersion,
    );
  }

  const raw =
    processResult.stdout.length > 0
      ? processResult.stdout.toString("utf8")
      : processResult.stderr.toString("utf8");
  const families = parseFontFamilies(raw);
  return Object.freeze({
    raw,
    ...(families === undefined ? {} : { families }),
    process: processResult,
    compilerVersion,
  });
}

/**
 * Best-effort extraction of font family names from the current `typst fonts`
 * output shape.
 *
 * Without `--variants` every non-empty line is a family name. With
 * `--variants` the family name is the unindented line at the top of each block
 * and the variant details that follow are indented (or use tree-drawing box
 * characters). Unrecognized output yields `undefined` rather than a partial or
 * wrong list, and the raw text always remains authoritative.
 */
export function parseFontFamilies(raw: string): readonly string[] | undefined {
  const lines = raw.split(/\r?\n/u);
  const families: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const indentation = line.length - line.trimStart().length;
    if (indentation > 0) continue;
    const firstColumn = line.split(/\t/u)[0]?.trim() ?? "";
    if (firstColumn.length === 0) continue;
    if (FAMILY_LINE_LEADER.test(firstColumn)) continue;
    families.push(firstColumn);
  }
  if (families.length === 0) return undefined;
  return Object.freeze(families);
}

/** Box-drawing / tree leaders used by `typst fonts --variants`. */
const FAMILY_LINE_LEADER = /^[├└│─+*•]/u;

/** The world options that `typst fonts` understands. */
function fontWorldOptions(options: FontsOptions): WorldOptionsLike {
  return {
    ...(options.fontPaths === undefined
      ? {}
      : { fontPaths: options.fontPaths }),
    ...(options.ignoreSystemFonts === undefined
      ? {}
      : { ignoreSystemFonts: options.ignoreSystemFonts }),
    ...(options.ignoreEmbeddedFonts === undefined
      ? {}
      : { ignoreEmbeddedFonts: options.ignoreEmbeddedFonts }),
  };
}

function validateFontsOptions(options: FontsOptions): void {
  validateRecord(options, "fonts options");
  validateRunOptionsObject(options);
  validateWorldOptions(fontWorldOptions(options));
  if (options.variants !== undefined && typeof options.variants !== "boolean")
    throw new TypstInvalidArgumentError("variants must be a boolean.");
  extraArgsOf(options);
}

function validateFontsCapabilities(
  version: string,
  options: FontsOptions,
): void {
  requireCapability(version, "commands.fonts", "fonts");
  requireWorldCapabilities(version, "fonts", fontWorldOptions(options));
}

function buildFontsArgs(version: string, options: FontsOptions): string[] {
  // The font options are world options; the shared table places
  // `--font-path` before the subcommand on releases older than 0.7.0.
  const world = worldArgs(version, "fonts", fontWorldOptions(options));
  const args = [...world.beforeCommand, "fonts", ...world.afterCommand];
  if (options.variants === true) args.push("--variants");
  args.push(...extraArgsOf(options));
  return args;
}
