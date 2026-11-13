import { parseExactStableVersion } from "../core/version.js";
import { TypstVersionOutputError } from "../core/errors.js";
import type { ExactTypstVersion, TypstVersionInfo } from "../types/public.js";

interface ParsedVersionParts {
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly commit?: string;
}

// Typst's current CLI emits `Typst X.Y.Z (commit)`; the optional SemVer
// prerelease/build portions are accepted only in that anchored form. A bare
// arbitrary line containing a version is intentionally rejected.
const VERSION_OUTPUT_PATTERN =
  /^[Tt]ypst\s+(((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)(?:\s+\((?:(?:commit)\s+)?([0-9A-Za-z][0-9A-Za-z._-]*)\))?$/u;

/** Parse the strict, non-localized output contract of `typst --version`. */
export function parseTypstVersionOutput(raw: string): TypstVersionInfo {
  const trimmed = raw.trim();
  const match = VERSION_OUTPUT_PATTERN.exec(trimmed);
  if (match === null || match[1] === undefined) {
    throw new TypstVersionOutputError(
      "Typst version output must match `Typst X.Y.Z` with an optional commit.",
      { raw },
    );
  }

  const version = match[1];
  const stableVersion = match[2];
  if (stableVersion === undefined) {
    throw new TypstVersionOutputError(
      "Typst version output has no numeric version.",
      { raw },
    );
  }
  const parsed = parseExactStableVersion(stableVersion);
  const prereleaseText = match[3];
  if (
    prereleaseText !== undefined &&
    prereleaseText.split(".").some((identifier) => {
      if (!/^\d+$/u.test(identifier)) return false;
      return (
        !/^(0|[1-9]\d*)$/u.test(identifier) ||
        !Number.isSafeInteger(Number(identifier))
      );
    })
  ) {
    throw new TypstVersionOutputError(
      "Typst prerelease identifiers must be valid SemVer.",
      { raw },
    );
  }
  const prerelease =
    prereleaseText === undefined
      ? []
      : prereleaseText.split(".").map((identifier) => {
          if (/^(0|[1-9]\d*)$/u.test(identifier)) {
            const value = Number(identifier);
            if (Number.isSafeInteger(value)) return value;
          }
          return identifier;
        });

  return Object.freeze({
    raw,
    version,
    stableVersion: stableVersion as ExactTypstVersion,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: Object.freeze(prerelease),
    ...(match[5] === undefined ? {} : { commit: match[5] }),
  });
}

export type { ParsedVersionParts };
