import { isAbsolute, posix, relative, win32 } from "node:path";
import {
  TypstInvalidArgumentError,
  UnsupportedTypstFeatureError,
} from "../core/errors.js";
import { compareExactStableVersions } from "../core/version.js";
import {
  type CliCommand,
  flagIsGlobal,
  flagValueSince,
  requireFlag,
} from "./cli-flags.js";
import { CAPABILITY_REGISTRY } from "../capabilities/registry.js";
import type { CapabilityDefinition } from "../capabilities/types.js";
import type { TemporaryScope } from "../core/temp.js";
import type { RunOptions } from "../core/process.js";
import type {
  CompileDestination,
  CompileFileDestination,
  CompileFileInput,
  CompileInput,
  CompileMemoryDestination,
  CompileProjectInput,
  CompileSourceInput,
  ExactTypstVersion,
  KnownTypstFeature,
} from "../types/public.js";

export function validateRecord(
  value: unknown,
  label: string,
): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypstInvalidArgumentError(`${label} must be an object.`);
  }
}

export function validateRunOptionsObject(options: RunOptions): void {
  validateRecord(options, "run options");
  if (
    options.env !== undefined &&
    (options.env === null ||
      typeof options.env !== "object" ||
      Array.isArray(options.env))
  ) {
    throw new TypstInvalidArgumentError("env must be an object when provided.");
  }
  if (
    options.envMode !== undefined &&
    options.envMode !== "merge" &&
    options.envMode !== "replace"
  ) {
    throw new TypstInvalidArgumentError(
      `Unknown environment mode: ${String(options.envMode)}.`,
    );
  }
  for (const [name, value] of [
    ["timeoutMs", options.timeoutMs],
    ["terminationGraceMs", options.terminationGraceMs],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    ) {
      throw new TypstInvalidArgumentError(
        `${name} must be a finite non-negative number.`,
      );
    }
  }
  if (
    options.diagnostics !== undefined &&
    typeof options.diagnostics !== "boolean"
  ) {
    throw new TypstInvalidArgumentError(
      "diagnostics must be a boolean when provided.",
    );
  }
  if (options.onLog !== undefined && typeof options.onLog !== "function") {
    throw new TypstInvalidArgumentError(
      "onLog must be a function when provided.",
    );
  }
  if (options.cwd !== undefined) validatePathValue(options.cwd, "cwd");
  if (
    options.signal !== undefined &&
    !(options.signal instanceof AbortSignal)
  ) {
    throw new TypstInvalidArgumentError(
      "signal must be an AbortSignal when provided.",
    );
  }
}

export function validatePathValue(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypstInvalidArgumentError(`${name} must be a non-empty path.`);
  }
}

export function validateVirtualPath(
  value: string,
  name = "input.virtualPath",
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    relative(".", value)
      .split(/[\\/]+/u)
      .includes("..")
  ) {
    throw new TypstInvalidArgumentError(
      `${name} must be a safe relative path.`,
    );
  }
}

/** The entry file of a project input when `main` is omitted. */
const DEFAULT_PROJECT_MAIN = "main.typ";

function validateProjectInput(input: CompileProjectInput): void {
  const files: unknown = input.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    throw new TypstInvalidArgumentError("input.files must be an object.");
  }
  const names = Object.keys(input.files);
  if (names.length === 0) {
    throw new TypstInvalidArgumentError("input.files must not be empty.");
  }
  for (const name of names) {
    validateVirtualPath(name, `input.files[${JSON.stringify(name)}]`);
    const data: unknown = input.files[name];
    if (typeof data !== "string" && !(data instanceof Uint8Array)) {
      throw new TypstInvalidArgumentError(
        `input.files[${JSON.stringify(name)}] must be a string or Uint8Array.`,
      );
    }
  }
  const main = input.main ?? DEFAULT_PROJECT_MAIN;
  validateVirtualPath(main, "input.main");
  if (!Object.prototype.hasOwnProperty.call(input.files, main)) {
    throw new TypstInvalidArgumentError(
      `input.main ${JSON.stringify(main)} is not one of input.files.`,
    );
  }
}

export function validateStringArray(
  value: readonly string[] | undefined,
  name: string,
  allowEmpty: boolean,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value))
    throw new TypstInvalidArgumentError(`${name} must be an array.`);
  for (const item of value) {
    if (typeof item !== "string" || (!allowEmpty && item.length === 0)) {
      throw new TypstInvalidArgumentError(`${name} must contain strings.`);
    }
  }
}

export function validateInput(input: CompileInput): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypstInvalidArgumentError("input must be an object.");
  }
  if (input.kind === "file") {
    validatePathValue(input.path, "input.path");
  } else if (input.kind === "source") {
    if (typeof input.data !== "string" && !(input.data instanceof Uint8Array)) {
      throw new TypstInvalidArgumentError(
        "input.data must be a string or Uint8Array.",
      );
    }
    if (input.virtualPath !== undefined) validateVirtualPath(input.virtualPath);
  } else if (input.kind === "project") {
    validateProjectInput(input);
  } else {
    throw new TypstInvalidArgumentError(
      "input.kind must be file, source or project.",
    );
  }
}

/** A compile input after the string shorthand has been expanded. */
export type NormalisedCompileInput =
  CompileFileInput | CompileSourceInput | CompileProjectInput;

/**
 * Normalise the string shorthand for compilation inputs into the full file
 * form so downstream layers only ever see the discriminated union.
 */
export function normaliseCompileInput(
  input: CompileInput,
): NormalisedCompileInput {
  if (typeof input === "string") {
    validatePathValue(input, "input");
    return { kind: "file", path: input };
  }
  return input;
}

/**
 * Normalise the string shorthand for compilation destinations into the full
 * file form so downstream layers only ever see the discriminated union.
 */
export function normaliseCompileDestination(
  destination: CompileDestination,
): CompileMemoryDestination | CompileFileDestination {
  if (typeof destination === "string") {
    validatePathValue(destination, "output");
    return { kind: "file", path: destination };
  }
  return destination;
}

export function validateInputs(
  inputs: Readonly<Record<string, string>> | undefined,
): void {
  if (inputs === undefined) return;
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new TypstInvalidArgumentError("inputs must be an object.");
  }
  for (const [key, value] of Object.entries(inputs)) {
    if (key.length === 0 || typeof value !== "string") {
      throw new TypstInvalidArgumentError(
        "inputs keys must be non-empty and values must be strings.",
      );
    }
  }
}

export function validateJobs(value: number | undefined): void {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypstInvalidArgumentError("jobs must be a positive integer.");
  }
}

/**
 * When a feature flag exists and when it is still required. `since` is the
 * first exact release that documents the flag, taken from the CLI flag
 * inventory. `stableIn` is the first exact
 * release in which the feature no longer needs it; from there on the flag is
 * neither implied nor passed, so a stabilised feature keeps working when the
 * compiler drops or rejects the flag. Record `stableIn` only from evidence.
 */
export interface FeatureFlagRule {
  readonly since: ExactTypstVersion;
  readonly stableIn?: ExactTypstVersion;
}

/** The single source of truth for experimental feature flags. */
export const FEATURE_FLAGS: Readonly<
  Record<KnownTypstFeature, FeatureFlagRule>
> = Object.freeze({
  html: { since: documentedFeature("html") },
  "a11y-extras": { since: documentedFeature("a11y-extras") },
  bundle: { since: documentedFeature("bundle") },
});

/** The first release whose `--help` lists `feature` as a `--features` value. */
function documentedFeature(feature: KnownTypstFeature): ExactTypstVersion {
  const since = flagValueSince("compile", "--features", feature);
  if (since === undefined) {
    throw new Error(
      `The CLI flag inventory has no evidence for the ${feature} feature; regenerate it.`,
    );
  }
  return since;
}

export type FeatureFlagRules = Readonly<
  Record<KnownTypstFeature, FeatureFlagRule>
>;

function isFeatureFlag(
  value: string,
  rules: FeatureFlagRules,
): value is KnownTypstFeature {
  return Object.prototype.hasOwnProperty.call(rules, value);
}

/** True when `version` accepts the flag and the feature still requires it. */
export function featureFlagRequired(
  version: string,
  feature: KnownTypstFeature,
  rules: FeatureFlagRules = FEATURE_FLAGS,
): boolean {
  const rule = rules[feature];
  return (
    compareExactStableVersions(version, rule.since) >= 0 &&
    (rule.stableIn === undefined ||
      compareExactStableVersions(version, rule.stableIn) < 0)
  );
}

/**
 * Serialize `--features` for `version`. Flags of features that are stable on
 * that version are dropped, and an empty list emits nothing.
 */
export function featureArgs(
  version: string,
  features: readonly string[] | undefined,
  rules: FeatureFlagRules = FEATURE_FLAGS,
): string[] {
  const needed = (features ?? []).filter(
    (feature) =>
      !isFeatureFlag(feature, rules) ||
      featureFlagRequired(version, feature, rules),
  );
  return needed.length === 0 ? [] : ["--features", needed.join(",")];
}

/**
 * Feature names must be non-empty strings. Unknown names are allowed and
 * passed to the compiler unchecked, so features of newer releases work before
 * this package knows them; known names are version-gated.
 */
export function validateFeatures(
  features: readonly string[] | undefined,
): void {
  validateStringArray(features, "features", false);
}

export function requireCapability(
  version: string,
  name: string,
  feature: string,
): void {
  const definition = CAPABILITY_REGISTRY.features[
    name as keyof typeof CAPABILITY_REGISTRY.features
  ] as CapabilityDefinition | undefined;
  if (definition === undefined) {
    throw new UnsupportedTypstFeatureError(feature, version);
  }
  if (definition.apiPolicy === "blocked") {
    throw new UnsupportedTypstFeatureError(feature, version);
  }
  if (
    definition.since !== undefined &&
    definition.since !== null &&
    compareExactStableVersions(version, definition.since) < 0
  ) {
    throw new UnsupportedTypstFeatureError(feature, version, {
      requiredVersion: definition.since,
    });
  }
  if (
    definition.removedIn !== undefined &&
    compareExactStableVersions(version, definition.removedIn) >= 0
  ) {
    throw new UnsupportedTypstFeatureError(feature, version);
  }
}

function requireSince(
  version: string,
  feature: string,
  since: ExactTypstVersion,
): void {
  if (compareExactStableVersions(version, since) < 0) {
    throw new UnsupportedTypstFeatureError(feature, version, {
      requiredVersion: since,
    });
  }
}

/**
 * Make a user path safe to pass where the CLI parses arguments: a relative
 * path that starts with `-` (for example `-draft.typ`) would otherwise be read
 * as a flag. `-` itself is the deliberate stdin/stdout token and stays as is.
 */
export function cliPath(value: string): string {
  return value.startsWith("-") && value !== "-" ? `./${value}` : value;
}

/**
 * Pass a path option value. A value that starts with `-` would be read as a
 * flag, so it is attached with `=` (`--root=-proj`); `-` alone is the stdio
 * token and other values keep the separate-argument form.
 */
export function flagWithPath(flag: string, value: string): string[] {
  return value.startsWith("-") && value !== "-"
    ? [`${flag}=${value}`]
    : [flag, value];
}

/**
 * Stage an input for a command invocation: file inputs pass through, source
 * inputs use stdin from exact `0.11.0` when no virtual path is set, and a
 * temporary `.typ` file otherwise. The temporary file lives in the caller's
 * temporary scope and is removed with it. The input must already be
 * normalised (callers use `normaliseCompileInput`).
 */
export interface StagedInput {
  /** The positional input path (or `-` for stdin). */
  readonly path: string;
  readonly stdin?: string | Uint8Array;
  /** The staged project root that must be passed as `--root`. */
  readonly root?: string;
}

/**
 * Write a project input below the temporary scope and return its entry path
 * and root. A caller-provided `root` conflicts with the staged one.
 */
async function stageProject(
  scope: TemporaryScope,
  input: CompileProjectInput,
  root: string | undefined,
): Promise<StagedInput> {
  if (root !== undefined) {
    throw new TypstInvalidArgumentError(
      "root cannot be combined with a project input; the project is its own root.",
    );
  }
  const projectRoot = await scope.createDirectory("project");
  for (const [name, data] of Object.entries(input.files)) {
    await scope.createFile(`project/${name}`, data);
  }
  return {
    path: scope.path(`project/${input.main ?? DEFAULT_PROJECT_MAIN}`),
    root: projectRoot,
  };
}

export async function prepareInputPath(
  scope: TemporaryScope,
  version: string,
  input: NormalisedCompileInput,
  root?: string,
): Promise<StagedInput> {
  if (input.kind === "project") return await stageProject(scope, input, root);
  const stdinSource =
    input.kind === "source" &&
    input.virtualPath === undefined &&
    compareExactStableVersions(version, "0.11.0") >= 0;
  if (input.kind === "file") return { path: cliPath(input.path) };
  if (stdinSource) return { path: "-", stdin: input.data };
  const name = input.virtualPath ?? "source.typ";
  const path = await scope.createFile(
    name.endsWith(".typ") ? name : `${name}.typ`,
    input.data,
  );
  return { path };
}

/**
 * Build the run options shared by version-gated commands from their option
 * object, preserving cwd/env/timing/signal/diagnostics/logging and stdin
 * where staged.
 */
export function buildRunOptions(
  options: RunOptions,
  stdin?: string | Uint8Array,
): RunOptions {
  return {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.envMode === undefined ? {} : { envMode: options.envMode }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: options.terminationGraceMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.diagnostics === undefined
      ? {}
      : { diagnostics: options.diagnostics }),
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    ...(stdin === undefined ? {} : { stdin }),
  };
}

/**
 * The largest `creationTimestamp` in seconds that still is a valid calendar
 * date (9999-12-31T23:59:59Z). Anything beyond it is almost certainly a
 * millisecond value such as `Date.now()`.
 */
const MAX_CREATION_TIMESTAMP_SECONDS = 253_402_300_799;

export function validateCreationTimestamp(
  value: Date | number | undefined,
): void {
  if (value === undefined) return;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypstInvalidArgumentError(
        "creationTimestamp must be a valid Date.",
      );
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypstInvalidArgumentError(
      "creationTimestamp must be a Date or a finite number of seconds since the Unix epoch.",
    );
  }
  if (Math.abs(value) > MAX_CREATION_TIMESTAMP_SECONDS) {
    throw new TypstInvalidArgumentError(
      `creationTimestamp is in seconds since the Unix epoch, but ${String(value)} is out of range; it looks like milliseconds (pass a Date, or divide by 1000).`,
    );
  }
}

/**
 * The project ("world") options every compiling command accepts: compile,
 * query, eval and watch. They are validated, capability-gated and documented
 * in one place so the commands cannot drift apart.
 */
export interface WorldOptionsLike {
  readonly root?: string;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly fontPaths?: readonly string[];
  readonly ignoreSystemFonts?: boolean;
  readonly ignoreEmbeddedFonts?: boolean;
  readonly packagePath?: string;
  readonly packageCachePath?: string;
  readonly creationTimestamp?: Date | number;
  readonly jobs?: number;
  readonly features?: readonly string[];
}

/**
 * How one world option is checked and passed to the CLI.
 *
 * - `path`: a non-empty path value (`--root <path>`);
 * - `paths`: repeated for every entry (`--font-path a --font-path b`);
 * - `switch`: a flag passed when the option is `true`;
 * - `inputs`: repeated `key=value` pairs;
 * - `timestamp`: a `Date` or seconds, passed as whole seconds;
 * - `count`: a positive integer;
 * - `features`: the version-aware `--features` list.
 *
 * `capability` names a registry entry. Version boundaries and the placement
 * before or after the subcommand are not written here: they come from the CLI
 * flag inventory generated from the per-release `--help` snapshots.
 */
interface WorldFlag {
  readonly key: keyof WorldOptionsLike;
  readonly flag: string;
  readonly kind:
    "path" | "paths" | "switch" | "inputs" | "timestamp" | "count" | "features";
  readonly capability?: string;
}

/**
 * The single table of world options shared by compile, query, eval, watch
 * and fonts: validation, version gates and CLI serialization all follow it, in
 * this order.
 */
const WORLD_FLAGS: readonly WorldFlag[] = [
  {
    key: "root",
    flag: "--root",
    kind: "path",
    capability: "options.root",
  },
  {
    key: "fontPaths",
    flag: "--font-path",
    kind: "paths",
    capability: "options.fontPaths",
  },
  {
    key: "ignoreSystemFonts",
    flag: "--ignore-system-fonts",
    kind: "switch",
  },
  {
    key: "ignoreEmbeddedFonts",
    flag: "--ignore-embedded-fonts",
    kind: "switch",
  },
  {
    key: "inputs",
    flag: "--input",
    kind: "inputs",
    capability: "options.sysInputs",
  },
  {
    key: "packagePath",
    flag: "--package-path",
    kind: "path",
    capability: "options.packagePath",
  },
  {
    key: "packageCachePath",
    flag: "--package-cache-path",
    kind: "path",
    capability: "options.packageCachePath",
  },
  {
    key: "creationTimestamp",
    flag: "--creation-timestamp",
    kind: "timestamp",
  },
  { key: "jobs", flag: "--jobs", kind: "count", capability: "options.jobs" },
  {
    key: "features",
    flag: "--features",
    kind: "features",
    capability: "options.features",
  },
];

function isPresent(flag: WorldFlag, value: unknown): boolean {
  return flag.kind === "switch" ? value === true : value !== undefined;
}

export function validateWorldOptions(options: WorldOptionsLike): void {
  for (const flag of WORLD_FLAGS) {
    const value = options[flag.key];
    if (value === undefined) continue;
    switch (flag.kind) {
      case "path":
        validatePathValue(value, flag.key);
        break;
      case "paths":
        validateStringArray(value as readonly string[], flag.key, false);
        break;
      case "switch":
        if (typeof value !== "boolean")
          throw new TypstInvalidArgumentError(`${flag.key} must be a boolean.`);
        break;
      case "inputs":
        validateInputs(value as Readonly<Record<string, string>>);
        break;
      case "timestamp":
        validateCreationTimestamp(value as Date | number);
        break;
      case "count":
        validateJobs(value as number);
        break;
      case "features":
        validateFeatures(value as readonly string[]);
        break;
    }
  }
}

/**
 * Gate the world options against the exact compiler version: the registry
 * capability where one exists, and the first release whose `--help` documents
 * the flag for `command`.
 */
export function requireWorldCapabilities(
  version: string,
  command: CliCommand,
  options: WorldOptionsLike,
): void {
  for (const flag of WORLD_FLAGS) {
    if (!isPresent(flag, options[flag.key])) continue;
    if (flag.capability !== undefined)
      requireCapability(version, flag.capability, flag.key);
    requireFlag(version, command, flag.flag, flag.key);
  }
  for (const feature of options.features ?? []) {
    if (isFeatureFlag(feature, FEATURE_FLAGS))
      requireSince(
        version,
        `features.${feature}`,
        FEATURE_FLAGS[feature].since,
      );
  }
}

/**
 * Serialize the world options for `version`; call only after
 * `requireWorldCapabilities`. `root` overrides `options.root` (a staged
 * project root). `beforeCommand` holds the flags an old release expects
 * before the subcommand; the rest go after it.
 */
export function worldArgs(
  version: string,
  command: CliCommand,
  options: WorldOptionsLike,
  root: string | undefined = options.root,
): { readonly beforeCommand: string[]; readonly afterCommand: string[] } {
  const beforeCommand: string[] = [];
  const afterCommand: string[] = [];
  for (const flag of WORLD_FLAGS) {
    const value = flag.key === "root" ? root : options[flag.key];
    if (!isPresent(flag, value)) continue;
    const target = flagIsGlobal(version, command, flag.flag)
      ? beforeCommand
      : afterCommand;
    switch (flag.kind) {
      case "path":
        target.push(...flagWithPath(flag.flag, value as string));
        break;
      case "paths":
        for (const path of value as readonly string[])
          target.push(...flagWithPath(flag.flag, path));
        break;
      case "switch":
        target.push(flag.flag);
        break;
      case "inputs":
        for (const [key, entry] of Object.entries(
          value as Readonly<Record<string, string>>,
        ))
          target.push(flag.flag, `${key}=${entry}`);
        break;
      case "timestamp": {
        // Whole seconds since the Unix epoch, like SOURCE_DATE_EPOCH.
        const time = value as Date | number;
        const seconds =
          time instanceof Date
            ? Math.floor(time.getTime() / 1000)
            : Math.floor(time);
        target.push(flag.flag, String(seconds));
        break;
      }
      case "count":
        target.push(flag.flag, String(value));
        break;
      case "features":
        target.push(...featureArgs(version, value as readonly string[]));
        break;
    }
  }
  return { beforeCommand, afterCommand };
}

/**
 * HTML and bundle output are experimental and need their feature flag. The
 * caller already asked for that output, so the flag is implied while the
 * feature still requires it on `version`; once it is stable nothing is added.
 * The capability gates still reject compilers without the feature.
 */
export function withImpliedFeature<
  T extends { readonly features?: readonly string[] },
>(
  options: T,
  output: string | undefined,
  version: string,
  rules: FeatureFlagRules = FEATURE_FLAGS,
): T {
  const feature: KnownTypstFeature | undefined =
    output === "html" ? "html" : output === "bundle" ? "bundle" : undefined;
  if (
    feature === undefined ||
    options.features?.includes(feature) ||
    !featureFlagRequired(version, feature, rules)
  )
    return options;
  return { ...options, features: [...(options.features ?? []), feature] };
}

/**
 * Reject an output that needs a feature flag the options do not carry. After
 * `withImpliedFeature` this only fires on compilers without the feature.
 */
export function requireFeatureFlag(
  version: string,
  features: readonly string[] | undefined,
  feature: KnownTypstFeature,
  rules: FeatureFlagRules = FEATURE_FLAGS,
): void {
  if (
    featureFlagRequired(version, feature, rules) &&
    features?.includes(feature) !== true
  ) {
    throw new UnsupportedTypstFeatureError(`features.${feature}`, version);
  }
}

/**
 * Validate and copy `extraArgs`: raw CLI arguments appended to a high-level
 * command without validation or version gating. They are the escape hatch for
 * flags a newer Typst added before this package knows them; the caller owns
 * their meaning. Commands place them after their own options and before the
 * input path; `eval` keeps its expression first, as the CLI expects.
 */
export function extraArgsOf(options: {
  readonly extraArgs?: readonly string[];
}): string[] {
  const value: unknown = options.extraArgs;
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (arg) =>
        typeof arg !== "string" || arg.length === 0 || arg.includes("\0"),
    )
  ) {
    throw new TypstInvalidArgumentError(
      "extraArgs must be an array of non-empty strings.",
    );
  }
  return [...(value as string[])];
}

/** Export options shared by `compile` and `watch`. */
export interface OutputOptionsLike {
  readonly pages?: readonly string[];
  readonly pdfStandards?: readonly string[];
  readonly ppi?: number;
  readonly pretty?: boolean;
  readonly noPdfTags?: boolean;
}

interface OutputFlag {
  readonly key: keyof OutputOptionsLike;
  readonly flag: string;
  /** `list`: non-empty, comma-joined; `positive`: finite number > 0. */
  readonly kind: "list" | "positive" | "switch";
  readonly capability?: string;
}

/**
 * The single table of export options shared by `compile` and `watch`. Like
 * the world options, version boundaries come from the CLI flag inventory.
 */
const OUTPUT_FLAGS: readonly OutputFlag[] = [
  { key: "pages", flag: "--pages", kind: "list", capability: "options.pages" },
  {
    key: "pdfStandards",
    flag: "--pdf-standard",
    kind: "list",
    capability: "options.pdfStandard",
  },
  { key: "ppi", flag: "--ppi", kind: "positive" },
  {
    key: "pretty",
    flag: "--pretty",
    kind: "switch",
    capability: "options.compilePretty",
  },
  {
    key: "noPdfTags",
    flag: "--no-pdf-tags",
    kind: "switch",
    capability: "options.noPdfTags",
  },
];

export function validateOutputOptions(options: OutputOptionsLike): void {
  for (const flag of OUTPUT_FLAGS) {
    const value: unknown = options[flag.key];
    if (value === undefined) continue;
    if (flag.kind === "list") {
      validateStringArray(value as readonly string[], flag.key, false);
      if ((value as readonly string[]).length === 0)
        throw new TypstInvalidArgumentError(`${flag.key} must not be empty.`);
    } else if (flag.kind === "positive") {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        throw new TypstInvalidArgumentError(
          `${flag.key} must be a finite positive number.`,
        );
    } else if (typeof value !== "boolean") {
      throw new TypstInvalidArgumentError(`${flag.key} must be a boolean.`);
    }
  }
}

/** Gate the export options; `pdfStandards` only applies to PDF output. */
export function requireOutputCapabilities(
  version: string,
  command: "compile" | "watch",
  format: string,
  options: OutputOptionsLike,
): void {
  for (const flag of OUTPUT_FLAGS) {
    const value = options[flag.key];
    if (flag.kind === "switch" ? value !== true : value === undefined) continue;
    if (flag.capability !== undefined)
      requireCapability(version, flag.capability, flag.key);
    requireFlag(version, command, flag.flag, flag.key);
  }
  if (options.pdfStandards !== undefined) {
    if (format !== "pdf") {
      throw new TypstInvalidArgumentError(
        "pdfStandards can only be used with PDF output.",
      );
    }
    if (options.pdfStandards.length > 1)
      requireCapability(
        version,
        "options.multiplePdfStandards",
        "multiplePdfStandards",
      );
  }
}

/** Serialize the export options; call after `requireOutputCapabilities`. */
export function outputArgs(options: OutputOptionsLike): string[] {
  const args: string[] = [];
  for (const flag of OUTPUT_FLAGS) {
    const value = options[flag.key];
    if (flag.kind === "switch") {
      if (value === true) args.push(flag.flag);
    } else if (value !== undefined) {
      args.push(
        flag.flag,
        flag.kind === "list"
          ? (value as readonly string[]).join(",")
          : String(value),
      );
    }
  }
  return args;
}
