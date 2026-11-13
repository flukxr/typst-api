import { compareExactStableVersions } from "../core/version.js";
import { UnsupportedTypstVersionError } from "../core/errors.js";
import type {
  ExactTypstVersion,
  UnknownVersionPolicy,
} from "../types/public.js";

/**
 * Exact stable releases collected by the committed sweep and inventory
 * evidence. Keeping this list in the package makes coverage deterministic
 * after installation; it is deliberately not inferred from the host filesystem
 * or from a nearest match.
 */
export const KNOWN_TYPST_VERSIONS = Object.freeze([
  "0.1.0",
  "0.2.0",
  "0.3.0",
  "0.4.0",
  "0.5.0",
  "0.6.0",
  "0.7.0",
  "0.8.0",
  "0.9.0",
  "0.10.0",
  "0.11.0",
  "0.11.1",
  "0.12.0",
  "0.13.0",
  "0.13.1",
  "0.14.0",
  "0.14.1",
  "0.14.2",
  "0.15.0",
  "0.15.1",
] as ExactTypstVersion[]);

export const KNOWN_TYPST_VERSION_SET: ReadonlySet<string> = new Set(
  KNOWN_TYPST_VERSIONS,
);

/**
 * Resolve the compiler version whose rules govern a high-level command.
 *
 * Known versions pass through unchanged. Under `"reject"` (the default) an
 * unknown version resolves to `undefined` so the command throws; under
 * `"assume-latest-known"` an unknown version maps to the newest known version
 * that is not newer than the actual one, so version-gated rules still apply.
 * The caller must keep the actual version for reporting — this only selects
 * the rule set, it never changes the reported compiler version.
 */
export function resolveVersionForRules(
  actualVersion: string,
  policy: UnknownVersionPolicy | undefined,
): string | undefined {
  if (KNOWN_TYPST_VERSION_SET.has(actualVersion)) return actualVersion;
  if (policy !== "assume-latest-known") return undefined;
  return newestKnownAtOrBefore(actualVersion);
}

/**
 * Resolve the rule version for a high-level command and throw when the policy
 * rejects the actual version. `command` names the high-level command in the
 * error message, e.g. `"compilation"` for compile.
 */
export function requireVersionForRules(
  actualVersion: string,
  policy: UnknownVersionPolicy | undefined,
  command: string,
): string {
  const rulesVersion = resolveVersionForRules(actualVersion, policy);
  if (rulesVersion === undefined) {
    throw new UnsupportedTypstVersionError(
      `High-level ${command} is not verified for compiler ${actualVersion}.`,
      { actualVersion },
    );
  }
  return rulesVersion;
}

/**
 * The newest known version that is not newer than `actualVersion`. The known
 * list is sorted ascending; the comparison is exact and never prefix-based.
 *
 * A prerelease such as `0.13.0-rc.1` precedes its stable core, so only known
 * versions strictly older than `0.13.0` qualify. Build metadata (`+...`) does
 * not affect precedence. A version whose core is not an exact stable version
 * has no safe rule set and yields `undefined`.
 */
function newestKnownAtOrBefore(actualVersion: string): string | undefined {
  const match = /^([^-+]+)(-[^+]*)?(\+.*)?$/.exec(actualVersion);
  if (match === null) return undefined;
  const core = match[1]!;
  const isPrerelease = match[2] !== undefined;
  let result: string | undefined;
  for (const known of KNOWN_TYPST_VERSIONS) {
    const comparison = tryCompareExactStable(known, core);
    if (comparison === undefined) return undefined;
    if (comparison < 0 || (comparison === 0 && !isPrerelease)) {
      result = known;
    } else {
      break;
    }
  }
  return result;
}

function tryCompareExactStable(
  left: string,
  right: string,
): number | undefined {
  try {
    return compareExactStableVersions(left, right);
  } catch {
    return undefined;
  }
}

/**
 * A committed high-level sweep record for one platform/arch pair. Backed by
 * `data/sweep/<platform>-<arch>.json` and validated as build input.
 */
export interface HighLevelSweepRecord {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly testedVersions: readonly ExactTypstVersion[];
  readonly testedThrough: ExactTypstVersion | null;
}

/**
 * Exact versions whose high-level API (version, compile, fonts, the watch
 * lifecycle, query, info, eval, bundle, multiple PDF standards) passed the
 * committed high-level sweep on the matching host. Evidence lives in
 * `data/sweep/<platform>-<arch>.json` (plus the legacy
 * `data/high-level-sweep.json` for `win32`/`x64`); the sweep runner is
 * `scripts/high-level-sweep.mjs` (`npm run sweep:historical`).
 */
const HIGH_LEVEL_SWEEP_EVIDENCE: Readonly<
  Record<string, HighLevelSweepRecord>
> = Object.freeze({
  "win32:x64": Object.freeze({
    platform: "win32",
    arch: "x64",
    testedVersions: Object.freeze([...KNOWN_TYPST_VERSIONS]),
    testedThrough: "0.15.1",
  }),
  "linux:x64": Object.freeze({
    platform: "linux",
    arch: "x64",
    testedVersions: Object.freeze([...KNOWN_TYPST_VERSIONS]),
    testedThrough: "0.15.1",
  }),
  "linux:arm64": Object.freeze({
    platform: "linux",
    arch: "arm64",
    testedVersions: Object.freeze([...KNOWN_TYPST_VERSIONS]),
    testedThrough: "0.15.1",
  }),
  "darwin:arm64": Object.freeze({
    platform: "darwin",
    arch: "arm64",
    testedVersions: Object.freeze([...KNOWN_TYPST_VERSIONS]),
    testedThrough: "0.15.1",
  }),
});

/** Look up the committed sweep record for a platform/arch pair, if any. */
export function highLevelSweepFor(
  platform: NodeJS.Platform,
  arch: string,
): HighLevelSweepRecord | undefined {
  return HIGH_LEVEL_SWEEP_EVIDENCE[`${platform}:${arch}`];
}
