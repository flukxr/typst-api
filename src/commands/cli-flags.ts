import { UnsupportedTypstFeatureError } from "../core/errors.js";
import { compareExactStableVersions } from "../core/version.js";
import {
  CLI_FLAGS,
  type CliFlagRecord,
} from "../capabilities/cli-flags.generated.js";
import type { ExactTypstVersion } from "../types/public.js";

/** The subcommands whose `--help` is part of the flag inventory. */
export type CliCommand =
  "compile" | "watch" | "query" | "eval" | "fonts" | "init" | "info";

function lifetime(
  command: CliCommand | "root",
  flag: string,
): CliFlagRecord | undefined {
  return CLI_FLAGS[command]?.[flag];
}

/**
 * The first exact release that documents `flag` for `command`, either on the
 * subcommand itself or as a global option before it (Typst before 0.7.0
 * parsed `--root` and `--font-path` globally). `undefined` when no release
 * documents it.
 */
export function flagSince(
  command: CliCommand,
  flag: string,
): ExactTypstVersion | undefined {
  const candidates = [lifetime(command, flag), lifetime("root", flag)]
    .filter((entry): entry is CliFlagRecord => entry !== undefined)
    .map((entry) => entry.since)
    .sort(compareExactStableVersions);
  return candidates[0] as ExactTypstVersion | undefined;
}

/**
 * Reject `version` when it predates the first release that documents the
 * flag. A flag that later disappears from the help is not rejected: Typst
 * hides deprecated flags that still work, and real removals are recorded in
 * the capability registry from binary evidence.
 */
export function requireFlag(
  version: string,
  command: CliCommand,
  flag: string,
  feature: string,
): void {
  const since = flagSince(command, flag);
  if (since === undefined) {
    throw new UnsupportedTypstFeatureError(feature, version);
  }
  if (compareExactStableVersions(version, since) < 0) {
    throw new UnsupportedTypstFeatureError(feature, version, {
      requiredVersion: since,
    });
  }
}

/**
 * True when `version` expects `flag` before the subcommand: the subcommand
 * does not document it yet, but the global options do.
 */
export function flagIsGlobal(
  version: string,
  command: CliCommand,
  flag: string,
): boolean {
  const own = lifetime(command, flag);
  if (own !== undefined && compareExactStableVersions(version, own.since) >= 0)
    return false;
  const global = lifetime("root", flag);
  return (
    global !== undefined &&
    compareExactStableVersions(version, global.since) >= 0
  );
}

/** The first exact release that documents `value` for `flag`. */
export function flagValueSince(
  command: CliCommand,
  flag: string,
  value: string,
): ExactTypstVersion | undefined {
  return lifetime(command, flag)?.values?.[value]?.since as
    ExactTypstVersion | undefined;
}

/** True when `version` is at or after the first release documenting `flag`. */
export function hasFlag(
  version: string,
  command: CliCommand,
  flag: string,
): boolean {
  const since = flagSince(command, flag);
  return since !== undefined && compareExactStableVersions(version, since) >= 0;
}

/** Reject a value of `flag` that `version` does not document yet. */
export function requireFlagValue(
  version: string,
  command: CliCommand,
  flag: string,
  value: string,
  feature: string,
): void {
  const since = flagValueSince(command, flag, value);
  if (since === undefined) return;
  if (compareExactStableVersions(version, since) < 0) {
    throw new UnsupportedTypstFeatureError(feature, version, {
      requiredVersion: since,
    });
  }
}
