import {
  TypstCompletionsError,
  TypstInvalidArgumentError,
} from "../core/errors.js";
import { requireVersionForRules } from "../client/support-data.js";
import type {
  CompletionsOptions,
  CompletionsResult,
  RunOptions,
  TypstShell,
  UnknownVersionPolicy,
} from "../types/public.js";
import type { TypstProcessResult } from "../core/process.js";
import {
  extraArgsOf,
  buildRunOptions,
  requireCapability,
  validateRecord,
  validateRunOptionsObject,
} from "./shared.js";

export interface CompletionsContext {
  readonly unknownVersionPolicy: UnknownVersionPolicy;
  version(): Promise<{ readonly version: string }>;
  run(
    args: readonly string[],
    options?: RunOptions,
  ): Promise<TypstProcessResult>;
}

const SHELLS: ReadonlySet<TypstShell> = new Set([
  "bash",
  "elvish",
  "fish",
  "powershell",
  "zsh",
]);

/**
 * Generate a shell-completion script (`typst completions <SHELL>`).
 *
 * The command exists from `0.14.0`. The generated script text is the stable
 * result; the script is passed to the shell by the caller.
 */
export async function completionsCommand(
  context: CompletionsContext,
  shell: TypstShell,
  options: CompletionsOptions = {},
): Promise<CompletionsResult> {
  validateCompletionsOptions(options);
  validateShell(shell);
  const version = await context.version();
  const compilerVersion = version.version;
  const rulesVersion = requireVersionForRules(
    compilerVersion,
    context.unknownVersionPolicy,
    "completions",
  );

  requireCapability(rulesVersion, "commands.completions", "completions");
  const args = ["completions", ...extraArgsOf(options), shell];
  const processResult = await context.run(args, buildRunOptions(options));

  if (
    processResult.exitCode !== 0 ||
    processResult.signal !== null ||
    processResult.timedOut ||
    processResult.aborted
  ) {
    throw new TypstCompletionsError(
      `Typst completions exited unsuccessfully (exitCode=${String(processResult.exitCode)}, signal=${String(processResult.signal)}).`,
      processResult,
      compilerVersion,
    );
  }

  const raw =
    processResult.stdout.length > 0
      ? processResult.stdout.toString("utf8")
      : processResult.stderr.toString("utf8");
  return Object.freeze({ raw, process: processResult, compilerVersion });
}

function validateShell(shell: TypstShell): void {
  if (typeof shell !== "string" || !SHELLS.has(shell as TypstShell)) {
    throw new TypstInvalidArgumentError(
      `Unknown shell: ${String(shell)}. Expected one of ${[...SHELLS].join(", ")}.`,
    );
  }
}

function validateCompletionsOptions(options: CompletionsOptions): void {
  validateRecord(options, "completions options");
  validateRunOptionsObject(options);
}
