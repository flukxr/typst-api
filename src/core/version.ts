import { TypstError } from "./errors.js";

const EXACT_STABLE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export type VersionComparison = -1 | 0 | 1;

export interface ParsedExactStableVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * A value is not an exact stable `major.minor.patch` version. Part of the
 * `TypstError` hierarchy like every other failure the package reports.
 */
export class InvalidExactStableVersionError extends TypstError {
  readonly value: unknown;

  constructor(value: unknown) {
    const description =
      typeof value === "string"
        ? JSON.stringify(value)
        : Object.prototype.toString.call(value);
    super(
      "ERR_TYPST_INVALID_VERSION",
      `Expected exact stable SemVer, got ${description}`,
    );
    this.value = value;
  }
}

function parseSafeComponent(component: string, originalValue: string): number {
  const parsed = Number(component);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidExactStableVersionError(originalValue);
  }
  return parsed;
}

export function parseExactStableVersion(
  value: string,
): ParsedExactStableVersion {
  if (typeof value !== "string") {
    throw new InvalidExactStableVersionError(value);
  }

  const match = EXACT_STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    throw new InvalidExactStableVersionError(value);
  }

  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  if (
    majorText === undefined ||
    minorText === undefined ||
    patchText === undefined
  ) {
    throw new InvalidExactStableVersionError(value);
  }

  return {
    raw: value,
    major: parseSafeComponent(majorText, value),
    minor: parseSafeComponent(minorText, value),
    patch: parseSafeComponent(patchText, value),
  };
}

export function compareParsedExactStableVersions(
  left: ParsedExactStableVersion,
  right: ParsedExactStableVersion,
): VersionComparison {
  if (left.major !== right.major) {
    return left.major < right.major ? -1 : 1;
  }
  if (left.minor !== right.minor) {
    return left.minor < right.minor ? -1 : 1;
  }
  if (left.patch !== right.patch) {
    return left.patch < right.patch ? -1 : 1;
  }
  return 0;
}

export function compareExactStableVersions(
  left: string,
  right: string,
): VersionComparison {
  return compareParsedExactStableVersions(
    parseExactStableVersion(left),
    parseExactStableVersion(right),
  );
}
