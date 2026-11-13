import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  compareExactStableVersions,
  parseExactStableVersion,
} from "./version.js";
import {
  TypstError,
  TypstExecutableIntegrityError,
  TypstExecutableLauncherError,
  TypstExecutableNotExecutableError,
  TypstExecutableNotFoundError,
  TypstExecutableNotRegularFileError,
  TypstExecutablePackageError,
  TypstExecutablePermissionError,
  TypstExecutableProbeError,
  type ExecutableAttempt,
} from "./errors.js";

export type ExecutableSource = "explicit" | "package" | "environment" | "path";

export interface ExecutableDiscoverySwitches {
  readonly package?: boolean;
  readonly environment?: boolean;
  readonly path?: boolean;
}

export type EnvironmentMode = "merge" | "replace";

/** The subset of createTypst options consumed by executable discovery. */
export interface DiscoverTypstExecutableOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly envMode?: EnvironmentMode;
  readonly discovery?: ExecutableDiscoverySwitches;
  /**
   * When true, the resolved executable is probed with `--version` and must
   * report a single exact stable Typst compiler version before discovery
   * succeeds. Package-sourced executables are always verified against their
   * declared version; this extends the same verification to explicit,
   * environment, and PATH sources.
   */
  readonly verifyExecutable?: boolean;
}

export interface TypstLauncherMetadata {
  readonly packageName: "@flukxr/typst-cli";
  readonly declaredVersion: string;
}

export interface DiscoveredTypstExecutable {
  /** Absolute, normalised path that can be passed to spawn without a shell. */
  readonly executable: string;
  readonly source: ExecutableSource;
  /** Effective cwd used to resolve relative candidates and package probes. */
  readonly cwd: string;
  /** Effective environment after merge/replace and undefined-key removal. */
  readonly env: NodeJS.ProcessEnv;
  /** Present only when the optional launcher package supplied the executable. */
  readonly launcher?: TypstLauncherMetadata;
}

export interface ExecutableProbeResult {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly durationMs: number;
  readonly error?: {
    readonly name?: string;
    readonly message: string;
    readonly code?: string;
    readonly errno?: number;
    readonly syscall?: string;
  };
}

/**
 * Narrow seams used by tests and by embedders that need to control module
 * loading. They are deliberately a second argument rather than part of the
 * stable CreateTypstOptions object.
 */
export interface ExecutableDiscoveryDependencies {
  readonly platform?: NodeJS.Platform;
  readonly loadLauncher?: () => unknown | Promise<unknown>;
  readonly probe?: ProbeExecutable;
}

export type ProbeExecutable = (
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Promise<ExecutableProbeResult>;

interface CandidateContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

interface CandidatePath {
  readonly source: ExecutableSource;
  readonly candidate: string;
  readonly executablePath: string;
}

type CandidateFailure =
  "not-found" | "not-regular-file" | "not-executable" | "permission";

interface CandidateInspection {
  readonly ok: boolean;
  readonly failure?: CandidateFailure;
  readonly cause?: unknown;
}

const PACKAGE_NAME = "@flukxr/typst-cli";
const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE"];
// Without a shell, Windows can only start PE images. Batch files (`.cmd`,
// `.bat`) fail with EINVAL on supported Node.js releases, and extensionless
// files (such as the POSIX shim npm writes next to `typst.cmd`) are never
// started by CreateProcess.
const WINDOWS_SPAWNABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".com",
  ".exe",
]);
const WINDOWS_NOT_SPAWNABLE_MESSAGE =
  "Windows can only start .exe or .com files without a shell; batch scripts and extensionless shims (such as typst.cmd from a global npm install) are not supported. Point to typst.exe instead.";
const REQUIRE = createRequire(import.meta.url);

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/**
 * Read an environment variable with Windows' case-insensitive semantics.
 * The first matching key is used; effective-env construction below guarantees
 * there is normally only one such key.
 */
function getEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (!isWindows(platform)) return environment[name];
  const expected = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === expected && value !== undefined) return value;
  }
  return undefined;
}

function setEnvironmentValue(
  target: Record<string, string>,
  key: string,
  value: string | undefined,
  platform: NodeJS.Platform,
): void {
  if (isWindows(platform)) {
    const expected = key.toUpperCase();
    for (const existing of Object.keys(target)) {
      if (existing.toUpperCase() === expected) delete target[existing];
    }
  }
  if (value !== undefined) target[key] = value;
}

function effectiveEnvironment(
  input: NodeJS.ProcessEnv | undefined,
  mode: EnvironmentMode,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const result: Record<string, string> = {};
  if (mode === "merge") {
    for (const [key, value] of Object.entries(process.env)) {
      setEnvironmentValue(result, key, value, platform);
    }
  }
  for (const [key, value] of Object.entries(input ?? {})) {
    setEnvironmentValue(result, key, value, platform);
  }
  return result;
}

function effectiveCwd(cwd: string | undefined): string {
  return path.resolve(cwd ?? process.cwd());
}

function resolveCandidatePath(candidate: string, cwd: string): string {
  return path.normalize(
    path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate),
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return undefined;
}

function isNotFoundError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPermissionError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EACCES" || code === "EPERM";
}

async function inspectCandidate(
  candidate: CandidatePath,
  platform: NodeJS.Platform,
): Promise<CandidateInspection> {
  let file;
  try {
    file = await stat(candidate.executablePath);
  } catch (error) {
    if (isNotFoundError(error))
      return { ok: false, failure: "not-found", cause: error };
    if (isPermissionError(error))
      return { ok: false, failure: "permission", cause: error };
    return { ok: false, failure: "permission", cause: error };
  }

  if (!file.isFile()) return { ok: false, failure: "not-regular-file" };

  if (
    isWindows(platform) &&
    !WINDOWS_SPAWNABLE_EXTENSIONS.has(
      path.extname(candidate.executablePath).toLowerCase(),
    )
  ) {
    return {
      ok: false,
      failure: "not-executable",
      cause: new Error(WINDOWS_NOT_SPAWNABLE_MESSAGE),
    };
  }

  // On POSIX, stat mode bits are deterministic even when tests run as root;
  // access(X_OK) catches ACL/parent-directory failures that mode bits miss.
  if (!isWindows(platform) && (file.mode & 0o111) === 0) {
    return { ok: false, failure: "not-executable" };
  }

  try {
    await access(candidate.executablePath, fsConstants.X_OK);
  } catch (error) {
    if (isNotFoundError(error))
      return { ok: false, failure: "not-found", cause: error };
    if (isPermissionError(error)) {
      return {
        ok: false,
        failure: "permission",
        cause: error,
      };
    }
    return { ok: false, failure: "permission", cause: error };
  }

  return { ok: true };
}

function attemptFromInspection(
  candidate: CandidatePath,
  inspection: CandidateInspection,
): ExecutableAttempt | undefined {
  if (inspection.ok || inspection.failure === undefined) return undefined;
  const message = errorMessage(inspection.cause);
  return message === undefined
    ? {
        source: candidate.source,
        candidate: candidate.candidate,
        path: candidate.executablePath,
        outcome: inspection.failure,
      }
    : {
        source: candidate.source,
        candidate: candidate.candidate,
        path: candidate.executablePath,
        outcome: inspection.failure,
        message,
      };
}

function throwConfiguredCandidateError(
  candidate: CandidatePath,
  inspection: CandidateInspection,
): never {
  const options = {
    source: candidate.source,
    candidate: candidate.candidate,
    executablePath: candidate.executablePath,
    ...(inspection.cause === undefined ? {} : { cause: inspection.cause }),
  };
  switch (inspection.failure) {
    case "not-found":
      throw new TypstExecutableNotFoundError(
        `Configured Typst executable for ${candidate.source} was not found: ${candidate.executablePath}`,
        options,
      );
    case "not-regular-file":
      throw new TypstExecutableNotRegularFileError(options);
    case "not-executable":
      throw new TypstExecutableNotExecutableError(options);
    case "permission":
      throw new TypstExecutablePermissionError(options);
    default:
      throw new TypstExecutablePermissionError(options);
  }
}

async function selectConfiguredCandidate(
  source: Exclude<ExecutableSource, "path">,
  candidate: string,
  context: CandidateContext,
): Promise<string> {
  const candidatePath: CandidatePath = {
    source,
    candidate,
    executablePath: resolveCandidatePath(candidate, context.cwd),
  };
  const inspection = await inspectCandidate(candidatePath, context.platform);
  if (!inspection.ok) throwConfiguredCandidateError(candidatePath, inspection);
  return candidatePath.executablePath;
}

function pathEntries(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const value = getEnvironmentValue(environment, "PATH", platform);
  if (value === undefined) return [];
  // Delimiters follow the target platform, not the host running a simulated
  // discovery test. This also keeps injected linux/darwin probes correct on
  // Windows CI.
  return value.split(isWindows(platform) ? ";" : ":");
}

function windowsPathExtensions(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (!isWindows(platform)) return [""];
  const value = getEnvironmentValue(environment, "PATHEXT", platform);
  const source =
    value === undefined ? DEFAULT_WINDOWS_PATHEXT : value.split(";");
  const extensions = source
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    )
    .filter((extension) =>
      WINDOWS_SPAWNABLE_EXTENSIONS.has(extension.toLowerCase()),
    );
  return extensions.length === 0 ? DEFAULT_WINDOWS_PATHEXT : extensions;
}

async function searchPath(context: CandidateContext): Promise<{
  readonly executable?: string;
  readonly attempts: readonly ExecutableAttempt[];
}> {
  const attempts: ExecutableAttempt[] = [];
  const extensions = windowsPathExtensions(context.env, context.platform);
  for (const entry of pathEntries(context.env, context.platform)) {
    const directory =
      entry.length === 0
        ? context.cwd
        : resolveCandidatePath(entry, context.cwd);
    for (const extension of extensions) {
      const candidate = extension.length === 0 ? "typst" : `typst${extension}`;
      const candidatePath: CandidatePath = {
        source: "path",
        candidate,
        executablePath: path.normalize(path.join(directory, candidate)),
      };
      const inspection = await inspectCandidate(
        candidatePath,
        context.platform,
      );
      if (inspection.ok)
        return { executable: candidatePath.executablePath, attempts };
      const attempt = attemptFromInspection(candidatePath, inspection);
      if (attempt !== undefined) attempts.push(attempt);
    }
  }
  return { attempts };
}

function isDirectOptionalPackageMissing(error: unknown): boolean {
  if (errorCode(error) !== "MODULE_NOT_FOUND") return false;
  const message = errorMessage(error);
  if (message === undefined) return false;
  // A nested missing dependency names that dependency instead. Matching the
  // exact launcher specifier is what permits only true optional absence to
  // fall through.
  return new RegExp(
    `Cannot find module ['"]${PACKAGE_NAME.replace("/", "\\/")}['"]`,
    "u",
  ).test(message);
}

function launcherValue(value: unknown): {
  readonly typstPath: string;
  readonly version: string;
} {
  if (typeof value !== "object" || value === null) {
    throw new TypstExecutableLauncherError(
      "The @flukxr/typst-cli launcher did not export an object.",
    );
  }
  const record = value as { typstPath?: unknown; version?: unknown };
  if (typeof record.typstPath !== "string" || record.typstPath.length === 0) {
    throw new TypstExecutableLauncherError(
      "The @flukxr/typst-cli launcher did not export a non-empty typstPath.",
    );
  }
  if (typeof record.version !== "string" || record.version.length === 0) {
    throw new TypstExecutableLauncherError(
      "The @flukxr/typst-cli launcher did not export an exact compiler version.",
    );
  }
  try {
    parseExactStableVersion(record.version);
  } catch (error) {
    throw new TypstExecutableLauncherError(
      `The @flukxr/typst-cli launcher declared an invalid exact compiler version: ${record.version}`,
      { cause: error },
    );
  }
  return { typstPath: record.typstPath, version: record.version };
}

function normaliseProbeResult(
  value: ExecutableProbeResult,
): ExecutableProbeResult {
  return {
    executable: value.executable,
    args: [...value.args],
    cwd: value.cwd,
    exitCode: value.exitCode,
    signal: value.signal,
    stdout: Buffer.isBuffer(value.stdout)
      ? value.stdout
      : Buffer.from(value.stdout),
    stderr: Buffer.isBuffer(value.stderr)
      ? value.stderr
      : Buffer.from(value.stderr),
    durationMs: value.durationMs,
    ...(value.error === undefined ? {} : { error: { ...value.error } }),
  };
}

function probeError(
  executablePath: string,
  declaredVersion: string,
  probe: ExecutableProbeResult,
): TypstExecutableProbeError {
  const reason =
    probe.error === undefined
      ? `exitCode=${String(probe.exitCode)}, signal=${String(probe.signal)}`
      : `${probe.error.name ?? "Error"}: ${probe.error.message}`;
  return new TypstExecutableProbeError(
    `Unable to probe the @flukxr/typst-cli executable with --version (${reason}).`,
    { executablePath, declaredVersion, probe },
  );
}

function parseProbeVersion(probe: ExecutableProbeResult): string {
  const text = `${probe.stdout.toString("utf8")}\n${probe.stderr.toString("utf8")}`;
  const versions: string[] = [];
  const expression = /\d+\.\d+\.\d+/gu;
  for (const match of text.matchAll(expression)) {
    const token = match[0];
    const index = match.index;
    const previous = index > 0 ? text[index - 1] : undefined;
    const next = text[index + token.length];
    if (previous !== undefined && /[A-Za-z0-9._-]/u.test(previous)) continue;
    if (next !== undefined && /[A-Za-z0-9._-]/u.test(next)) continue;
    try {
      parseExactStableVersion(token);
    } catch {
      continue;
    }
    if (!versions.includes(token)) versions.push(token);
  }
  if (versions.length !== 1 || versions[0] === undefined) {
    throw new TypstExecutableProbeError(
      "The @flukxr/typst-cli executable returned no single exact stable compiler version.",
      { probe },
    );
  }
  return versions[0];
}

/**
 * Upper bound for the `--version` probe. A real Typst answers in
 * milliseconds; the bound only exists so a hung or interactive executable
 * cannot stall discovery forever. It is generous because the first start of
 * a binary on Windows can be slowed down by antivirus scanning.
 */
const PROBE_TIMEOUT_MS = 30_000;

async function defaultProbeExecutable(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ExecutableProbeResult> {
  const started = Date.now();
  const args = ["--version"] as const;
  return await new Promise<ExecutableProbeResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (result: ExecutableProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({
        executable,
        args,
        cwd,
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        durationMs: Date.now() - started,
        error: serialiseSpawnError(error),
      });
      return;
    }

    const probe = child;
    timer = setTimeout(() => {
      probe.kill("SIGKILL");
      settle({
        executable,
        args,
        cwd,
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        durationMs: Date.now() - started,
        error: {
          name: "TimeoutError",
          message: `${executable} --version did not exit within ${PROBE_TIMEOUT_MS} ms`,
          code: "ETIMEDOUT",
        },
      });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer | string) =>
      stdout.push(Buffer.from(chunk)),
    );
    child.stderr?.on("data", (chunk: Buffer | string) =>
      stderr.push(Buffer.from(chunk)),
    );
    // `on`, not `once`: a failed kill() can emit a second "error" event.
    child.on("error", (error) => {
      settle({
        executable,
        args,
        cwd,
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        durationMs: Date.now() - started,
        error: serialiseSpawnError(error),
      });
    });
    child.once("close", (exitCode, signal) => {
      settle({
        executable,
        args,
        cwd,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        durationMs: Date.now() - started,
      });
    });
  });
}

function serialiseSpawnError(
  error: unknown,
): NonNullable<ExecutableProbeResult["error"]> {
  if (error instanceof Error) {
    const value = error as Error & {
      code?: unknown;
      errno?: unknown;
      syscall?: unknown;
    };
    const result: {
      name?: string;
      message: string;
      code?: string;
      errno?: number;
      syscall?: string;
    } = { name: value.name, message: value.message };
    if (typeof value.code === "string") result.code = value.code;
    if (typeof value.errno === "number") result.errno = value.errno;
    if (typeof value.syscall === "string") result.syscall = value.syscall;
    return result;
  }
  return { message: String(error) };
}

async function discoverPackageExecutable(
  context: CandidateContext,
  dependencies: ExecutableDiscoveryDependencies,
): Promise<DiscoveredTypstExecutable | undefined> {
  let loaded: unknown;
  try {
    loaded =
      dependencies.loadLauncher === undefined
        ? REQUIRE(PACKAGE_NAME)
        : await dependencies.loadLauncher();
  } catch (error) {
    if (isDirectOptionalPackageMissing(error)) return undefined;
    throw new TypstExecutablePackageError(
      `Unable to load the installed @flukxr/typst-cli launcher: ${errorMessage(error) ?? String(error)}`,
      error,
    );
  }

  const launcher = launcherValue(loaded);
  let executablePath: string;
  try {
    executablePath = await selectConfiguredCandidate(
      "package",
      launcher.typstPath,
      context,
    );
  } catch (error) {
    throw new TypstExecutableIntegrityError(
      `The @flukxr/typst-cli launcher points to an invalid executable: ${errorMessage(error) ?? String(error)}`,
      {
        declaredVersion: launcher.version,
        executablePath: resolveCandidatePath(launcher.typstPath, context.cwd),
        cause: error,
      },
    );
  }

  let probe: ExecutableProbeResult;
  try {
    probe = normaliseProbeResult(
      await (dependencies.probe ?? defaultProbeExecutable)(
        executablePath,
        context.cwd,
        context.env,
      ),
    );
  } catch (error) {
    // The production probe resolves a raw record for spawn errors, but a test
    // seam or an embedder may reject. Preserve that failure as the same typed
    // package-probe error instead of leaking an arbitrary rejection.
    const failedProbe: ExecutableProbeResult = {
      executable: executablePath,
      args: ["--version"],
      cwd: context.cwd,
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      durationMs: 0,
      error: serialiseSpawnError(error),
    };
    throw probeError(executablePath, launcher.version, failedProbe);
  }
  if (
    probe.error !== undefined ||
    probe.exitCode !== 0 ||
    probe.signal !== null
  ) {
    throw probeError(executablePath, launcher.version, probe);
  }

  let actualVersion: string;
  try {
    actualVersion = parseProbeVersion(probe);
  } catch (error) {
    if (error instanceof TypstExecutableProbeError) {
      throw new TypstExecutableProbeError(error.message, {
        executablePath,
        declaredVersion: launcher.version,
        probe,
        cause: error,
      });
    }
    throw error;
  }
  if (compareExactStableVersions(actualVersion, launcher.version) !== 0) {
    throw new TypstExecutableIntegrityError(
      `The @flukxr/typst-cli launcher declared ${launcher.version}, but --version reported ${actualVersion}.`,
      {
        executablePath,
        declaredVersion: launcher.version,
        actualVersion,
        probe,
      },
    );
  }

  return {
    executable: executablePath,
    source: "package",
    cwd: context.cwd,
    env: context.env,
    launcher: { packageName: PACKAGE_NAME, declaredVersion: launcher.version },
  };
}

function contextFor(
  options: DiscoverTypstExecutableOptions,
  dependencies: ExecutableDiscoveryDependencies,
): CandidateContext {
  const platform = dependencies.platform ?? process.platform;
  const mode = options.envMode ?? "merge";
  return {
    cwd: effectiveCwd(options.cwd),
    env: effectiveEnvironment(options.env, mode, platform),
    platform,
  };
}

/**
 * Optionally probe a resolved executable with `--version` and require a single
 * exact stable Typst compiler version. Package-sourced executables are always
 * verified against their declared version; this extends the same check to
 * explicit, environment, and PATH sources when `verifyExecutable` is set.
 */
async function verifyResolvedExecutable(
  source: "explicit" | "environment" | "path",
  executablePath: string,
  context: CandidateContext,
  dependencies: ExecutableDiscoveryDependencies,
): Promise<void> {
  let probe: ExecutableProbeResult;
  try {
    probe = normaliseProbeResult(
      await (dependencies.probe ?? defaultProbeExecutable)(
        executablePath,
        context.cwd,
        context.env,
      ),
    );
  } catch (error) {
    const failedProbe: ExecutableProbeResult = {
      executable: executablePath,
      args: ["--version"],
      cwd: context.cwd,
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      durationMs: 0,
      error: serialiseSpawnError(error),
    };
    throw new TypstExecutableProbeError(
      `Unable to probe the ${source}-configured executable with --version.`,
      { executablePath, probe: failedProbe },
    );
  }
  if (
    probe.error !== undefined ||
    probe.exitCode !== 0 ||
    probe.signal !== null
  ) {
    throw new TypstExecutableProbeError(
      `Unable to probe the ${source}-configured executable with --version.`,
      { executablePath, probe },
    );
  }
  try {
    parseProbeVersion(probe);
  } catch (error) {
    if (error instanceof TypstExecutableProbeError) {
      throw new TypstExecutableProbeError(error.message, {
        executablePath,
        probe,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Internal implementation with injectable seams for repository tests. Keep
 * this deep-core entry point out of the package root so the stable public
 * discovery API remains a single-options function.
 */
export async function discoverTypstExecutableWithDependencies(
  options: DiscoverTypstExecutableOptions = {},
  dependencies: ExecutableDiscoveryDependencies = {},
): Promise<DiscoveredTypstExecutable> {
  const context = contextFor(options, dependencies);

  if (options.executable !== undefined) {
    const executable = await selectConfiguredCandidate(
      "explicit",
      options.executable,
      context,
    );
    if (options.verifyExecutable === true) {
      await verifyResolvedExecutable(
        "explicit",
        executable,
        context,
        dependencies,
      );
    }
    return {
      executable,
      source: "explicit",
      cwd: context.cwd,
      env: context.env,
    };
  }

  const switches = options.discovery;
  if (switches?.package !== false) {
    const packageResult = await discoverPackageExecutable(
      context,
      dependencies,
    );
    if (packageResult !== undefined) return packageResult;
  }

  if (switches?.environment !== false) {
    const configured = getEnvironmentValue(
      context.env,
      "TYPST_PATH",
      context.platform,
    );
    if (configured !== undefined && configured.length > 0) {
      const executable = await selectConfiguredCandidate(
        "environment",
        configured,
        context,
      );
      if (options.verifyExecutable === true) {
        await verifyResolvedExecutable(
          "environment",
          executable,
          context,
          dependencies,
        );
      }
      return {
        executable,
        source: "environment",
        cwd: context.cwd,
        env: context.env,
      };
    }
  }

  const attempts: ExecutableAttempt[] = [];
  if (switches?.path !== false) {
    const result = await searchPath(context);
    if (result.executable !== undefined) {
      if (options.verifyExecutable === true) {
        await verifyResolvedExecutable(
          "path",
          result.executable,
          context,
          dependencies,
        );
      }
      return {
        executable: result.executable,
        source: "path",
        cwd: context.cwd,
        env: context.env,
      };
    }
    attempts.push(...result.attempts);
  }

  const disabled =
    switches?.package === false &&
    switches.environment === false &&
    switches.path === false;
  const suffix = disabled
    ? " (all implicit discovery sources are disabled)"
    : "";
  throw new TypstExecutableNotFoundError(
    `Unable to discover a Typst executable${suffix}. Checked the enabled package, environment, and PATH sources.`,
    { attempts },
  );
}

/** Public discovery entry point. Implicit runtime seams are intentionally not
 * part of the root API; use the deep-core helper only in repository tests. */
export async function discoverTypstExecutable(
  options: DiscoverTypstExecutableOptions = {},
): Promise<DiscoveredTypstExecutable> {
  return await discoverTypstExecutableWithDependencies(options);
}

// Re-export discovery errors from the implementation module for consumers
// that import the focused core entry point directly.
export {
  TypstError,
  TypstExecutableIntegrityError,
  TypstExecutableLauncherError,
  TypstExecutableNotExecutableError,
  TypstExecutableNotFoundError,
  TypstExecutableNotRegularFileError,
  TypstExecutablePackageError,
  TypstExecutablePermissionError,
  TypstExecutableProbeError,
};
export type { ExecutableAttempt } from "./errors.js";
