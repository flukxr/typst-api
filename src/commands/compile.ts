import { flagSince, hasFlag } from "./cli-flags.js";
import { checkPathShorthand } from "./inputs.js";
import { warningsFromStderr } from "../core/diagnostics.js";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import {
  extname,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "node:path";
import {
  TypstCompilationError,
  TypstInvalidArgumentError,
  TypstUnexpectedResultError,
  UnsupportedTypstFeatureError,
} from "../core/errors.js";
import { compareExactStableVersions } from "../core/version.js";
import { withTemporaryScope, type TemporaryScope } from "../core/temp.js";
import { requireVersionForRules } from "../client/support-data.js";
import type {
  CompileDependencies,
  CompileFileDestination,
  CompileFileOutput,
  CompileMemoryDestination,
  CompileMemoryOutput,
  CompileOptions,
  CompileOutput,
  CompileResult,
  RunOptions,
  TypstDepsFormat,
  TypstOutputFormat,
  UnknownVersionPolicy,
} from "../types/public.js";
import type { TypstProcessResult } from "../core/process.js";
import {
  buildRunOptions,
  flagWithPath,
  outputArgs,
  requireOutputCapabilities,
  validateOutputOptions,
  extraArgsOf,
  worldArgs,
  requireFeatureFlag,
  validateInput,
  withImpliedFeature,
  prepareInputPath,
  type NormalisedCompileInput,
  requireWorldCapabilities,
  validateWorldOptions,
  cliPath,
  normaliseCompileDestination,
  normaliseCompileInput,
  requireCapability,
  validatePathValue,
  validateRecord,
  validateRunOptionsObject,
} from "./shared.js";

/** A narrowed options shape in which input/output are never raw strings. */
type NormalisedCompileOptions = Omit<CompileOptions, "input" | "output"> & {
  readonly input: NormalisedCompileInput;
  readonly output?: CompileMemoryDestination | CompileFileDestination;
};

function normaliseCompileOptions(
  options: CompileOptions,
): NormalisedCompileOptions {
  validateRecord(options, "compile options");
  const { input: _input, output: _output, ...rest } = options;
  return {
    ...rest,
    input: normaliseCompileInput(options.input),
    ...(options.output === undefined
      ? {}
      : { output: normaliseCompileDestination(options.output) }),
  };
}

export interface CompileContext {
  readonly cwd: string;
  readonly unknownVersionPolicy: UnknownVersionPolicy;
  version(): Promise<{ readonly version: string }>;
  run(
    args: readonly string[],
    options?: RunOptions,
  ): Promise<TypstProcessResult>;
}

export async function compileCommand(
  context: CompileContext,
  options: CompileOptions,
): Promise<CompileResult> {
  let normalisedOptions = normaliseCompileOptions(options);
  validateCompileOptions(normalisedOptions);
  await checkPathShorthand(options.input, options.cwd ?? context.cwd);
  const version = await context.version();
  const compilerVersion = version.version;
  const rulesVersion = requireVersionForRules(
    compilerVersion,
    context.unknownVersionPolicy,
    "compilation",
  );

  const destination = normalisedOptions.output ?? { kind: "memory" as const };
  const format = resolveCompileFormat(destination, normalisedOptions.format);
  normalisedOptions = withImpliedFeature(
    normalisedOptions,
    format,
    rulesVersion,
  );
  validateCompileCapabilities(
    rulesVersion,
    format,
    normalisedOptions,
    destination,
  );

  return await withTemporaryScope(async (scope) => {
    const effectiveCwd = normalisedOptions.cwd ?? context.cwd;
    let prepared = await prepareCompileInvocation(
      scope,
      rulesVersion,
      format,
      normalisedOptions,
      destination,
      effectiveCwd,
    );
    let processResult = await context.run(prepared.args, prepared.runOptions);
    if (prepared.stdoutFallback && shouldRetryCompileWithFiles(processResult)) {
      // Typst can only stream a single PNG/SVG image to stdout. A document
      // with several pages exits unsuccessfully without writing any output and
      // emits the documented multi-image diagnostic. Only that exact case is
      // retried through the page-file strategy; other failures (including
      // syntax errors with empty stdout) keep their original process record
      // and are surfaced immediately.
      prepared = await prepareCompileInvocation(
        scope,
        rulesVersion,
        format,
        normalisedOptions,
        destination,
        effectiveCwd,
        true,
      );
      processResult = await context.run(prepared.args, prepared.runOptions);
    }
    if (
      processResult.exitCode !== 0 ||
      processResult.signal !== null ||
      processResult.timedOut ||
      processResult.aborted
    ) {
      throw new TypstCompilationError(
        `Typst compile exited unsuccessfully (exitCode=${String(processResult.exitCode)}, signal=${String(processResult.signal)}).`,
        processResult,
        compilerVersion,
      );
    }

    const outputs = await collectCompileOutputs(
      prepared,
      processResult,
      format,
      destination,
      compilerVersion,
    );
    const dependencies = await collectCompileDependencies(
      prepared,
      processResult,
      compilerVersion,
    );
    return Object.freeze({
      format,
      outputs: Object.freeze(outputs),
      ...(dependencies === undefined ? {} : { dependencies }),
      warnings: warningsFromStderr(processResult.stderr),
      process: processResult,
      compilerVersion,
    });
  });
}

interface PreparedCompileInvocation {
  readonly args: readonly string[];
  readonly runOptions: RunOptions;
  readonly memoryOutput: boolean;
  /** True when in-memory output is streamed through `stdout`. */
  readonly stdoutOutput: boolean;
  /** True when a failed stdout attempt may be retried with page files. */
  readonly stdoutFallback: boolean;
  readonly outputPath?: string;
  readonly outputDirectory?: string;
  /**
   * File PNG/SVG output is rendered into a private staging directory and
   * moved to `destinationDirectory` only after a successful run, so a failed
   * compile never touches the destination and unrelated files are never
   * deleted.
   */
  readonly pageStaging?: {
    readonly template: string;
    readonly destinationDirectory: string;
  };
  /**
   * File bundle output is written into a private staging directory and moved
   * into `destinationDirectory` after a successful run, so the result lists
   * exactly this run's files and a failed compile leaves the destination
   * untouched.
   */
  readonly bundleStaging?: {
    readonly directory: string;
    readonly destinationDirectory: string;
  };
  readonly depsPath?: string;
  readonly depsFormat: TypstDepsFormat;
}

const OUTPUT_FORMATS = new Set<TypstOutputFormat>([
  "pdf",
  "png",
  "svg",
  "html",
  "bundle",
]);

const OUTPUT_MEDIA_TYPES: Readonly<Partial<Record<TypstOutputFormat, string>>> =
  {
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    html: "text/html",
  };

/** Best-effort media types for the individual files of a bundle output. */
const BUNDLE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  css: "text/css",
  htm: "text/html",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  mjs: "text/javascript",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
};

function mediaTypeFor(format: TypstOutputFormat): string {
  const mediaType = OUTPUT_MEDIA_TYPES[format];
  if (mediaType === undefined) {
    throw new TypstInvalidArgumentError(
      `Output format ${format} has no known media type.`,
    );
  }
  return mediaType;
}

function mediaTypeForBundleFile(relativePath: string): string | undefined {
  const extension = extname(relativePath).toLowerCase().slice(1);
  return BUNDLE_MEDIA_TYPES[extension];
}

function validateCompileOptions(options: NormalisedCompileOptions): void {
  validateRecord(options, "compile options");
  validateRunOptionsObject(options);
  validateWorldOptions(options);
  validateInput(options.input);
  if (options.output !== undefined) {
    if (
      options.output === null ||
      typeof options.output !== "object" ||
      Array.isArray(options.output)
    ) {
      throw new TypstInvalidArgumentError("output must be an object.");
    }
    if (options.output.kind === "file") {
      validatePathValue(options.output.path, "output.path");
    } else if (options.output.kind !== "memory") {
      throw new TypstInvalidArgumentError(
        "output.kind must be file or memory.",
      );
    }
  }
  if (options.format !== undefined && !OUTPUT_FORMATS.has(options.format)) {
    throw new TypstInvalidArgumentError(
      `Unknown output format: ${String(options.format)}.`,
    );
  }
  validateOutputOptions(options);
  if (options.depsPath !== undefined)
    validatePathValue(options.depsPath, "depsPath");
  if (options.depsFormat !== undefined) validateDepsFormat(options.depsFormat);
  extraArgsOf(options);
}

const DEPS_FORMATS: ReadonlySet<TypstDepsFormat> = new Set([
  "json",
  "zero",
  "make",
]);

function validateDepsFormat(value: TypstDepsFormat): void {
  if (!DEPS_FORMATS.has(value)) {
    throw new TypstInvalidArgumentError(
      `Unknown dependency format: ${String(value)}.`,
    );
  }
}

function resolveCompileFormat(
  destination: NonNullable<NormalisedCompileOptions["output"]>,
  explicit: TypstOutputFormat | undefined,
): TypstOutputFormat {
  if (explicit !== undefined) return explicit;
  if (destination.kind !== "file") return "pdf";
  const inferred = knownFormatExtension(destination.path);
  if (inferred !== undefined) return inferred;
  throw new TypstInvalidArgumentError(
    "Cannot infer output format from destination path; specify format.",
  );
}

export function knownFormatExtension(
  path: string,
): TypstOutputFormat | undefined {
  const value = extname(path).toLowerCase().slice(1);
  if (value === "pdf" || value === "png" || value === "svg" || value === "html")
    return value;
  if (value === "bundle") return "bundle";
  return undefined;
}

function hasPagePlaceholder(path: string, modern: boolean): boolean {
  if (modern) {
    return (
      path.includes("{p}") ||
      path.includes("{0p}") ||
      path.includes("{t}") ||
      path.includes("{n}")
    );
  }
  return path.includes("{n}");
}

function validateCompileCapabilities(
  version: string,
  format: TypstOutputFormat,
  options: NormalisedCompileOptions,
  destination: NonNullable<NormalisedCompileOptions["output"]>,
): void {
  requireCapability(version, `formats.${format}`, format);
  requireWorldCapabilities(version, "compile", options);
  if (format === "bundle") {
    // Bundle output is experimental from 0.15.0 and always requires the
    // `bundle` feature flag; without it the compiler refuses before layout.
    requireFeatureFlag(version, options.features, "bundle");
  }
  if (options.format !== undefined && hasFlag(version, "compile", "--format"))
    requireCapability(
      version,
      "options.explicitOutputFormat",
      "explicit output format",
    );
  if (
    options.format !== undefined &&
    !hasFlag(version, "compile", "--format") &&
    destination.kind === "file" &&
    knownFormatExtension(destination.path) !== options.format
  ) {
    throw new TypstInvalidArgumentError(
      "Explicit format does not match the destination extension.",
    );
  }
  requireOutputCapabilities(version, "compile", format, options);
  if (options.depsPath !== undefined) {
    if (hasFlag(version, "compile", "--deps")) {
      requireCapability(version, "options.deps", "depsPath");
    } else {
      requireCapability(version, "options.makeDeps", "depsPath");
    }
    if (options.depsPath === "-" && destination.kind === "memory") {
      throw new TypstInvalidArgumentError(
        "depsPath '-' (stdout) conflicts with in-memory output; use a file destination.",
      );
    }
    if (options.depsPath === "-" && !hasFlag(version, "compile", "--deps")) {
      throw new UnsupportedTypstFeatureError("depsPath '-'", version, {
        requiredVersion: flagSince("compile", "--deps") as string,
      });
    }
  }
  if (options.depsFormat !== undefined) {
    requireCapability(version, "options.depsFormat", "depsFormat");
  }
  if (format === "png" || format === "svg") {
    if (
      destination.kind === "file" &&
      compareExactStableVersions(version, "0.12.0") < 0
    ) {
      for (const placeholder of ["{p}", "{0p}", "{t}"]) {
        if (destination.path.includes(placeholder)) {
          throw new TypstInvalidArgumentError(
            `Page placeholder ${placeholder} requires compiler 0.12.0 or later; pre-0.12.0 compilers only support {n}.`,
          );
        }
      }
    }
  }
  if (format === "html") requireFeatureFlag(version, options.features, "html");
}

async function prepareCompileInvocation(
  scope: TemporaryScope,
  version: string,
  format: TypstOutputFormat,
  options: NormalisedCompileOptions,
  destination: NonNullable<NormalisedCompileOptions["output"]>,
  cwd: string,
  forcePageFiles = false,
): Promise<PreparedCompileInvocation> {
  const modernPageTemplates =
    compareExactStableVersions(version, "0.12.0") >= 0;
  const staged = await prepareInputPath(
    scope,
    version,
    options.input,
    options.root,
  );
  const inputPath = staged.path;
  const stdin = staged.stdin;
  const root = staged.root ?? options.root;

  const memoryOutput = destination.kind === "memory";
  const stdoutCapable = compareExactStableVersions(version, "0.12.0") >= 0;
  // PNG and SVG are page-per-file formats. A single page can be streamed to
  // stdout from exact 0.12.0, but an explicit page selection keeps the
  // deterministic file strategy so page numbers remain unambiguous. If a
  // document turns out to be multi-page, compileCommand retries through the
  // page-file strategy only for the documented multi-image diagnostic; see
  // `stdoutFallback`.
  const stdoutPageStream =
    memoryOutput &&
    stdoutCapable &&
    options.pages === undefined &&
    (format === "png" || format === "svg");
  const stdoutOutput =
    memoryOutput &&
    stdoutCapable &&
    (format === "pdf" || (stdoutPageStream && !forcePageFiles));
  const stdoutFallback = stdoutPageStream;
  let outputPath: string | undefined;
  let outputDirectory: string | undefined;
  let pageStaging: PreparedCompileInvocation["pageStaging"];
  let bundleStaging: PreparedCompileInvocation["bundleStaging"];
  let outputToken: string;
  if (!memoryOutput) {
    outputToken = cliPath(destination.path);
    if (
      (format === "png" || format === "svg") &&
      !hasPagePlaceholder(destination.path, modernPageTemplates)
    ) {
      const extension = extname(destination.path);
      const base =
        extension === ""
          ? destination.path
          : destination.path.slice(0, -extension.length);
      const templateExtension = extension === "" ? `.${format}` : extension;
      outputToken = modernPageTemplates
        ? `${base}-{0p}-of-{t}${templateExtension}`
        : `${base}-{n}${templateExtension}`;
    }
    if (format === "png" || format === "svg") {
      const resolvedTemplate = isAbsolute(outputToken)
        ? outputToken
        : resolve(cwd, outputToken);
      const staging = await scope.createDirectory("pages");
      outputToken = join(staging, win32.basename(resolvedTemplate));
      pageStaging = {
        template: outputToken,
        destinationDirectory: dirname(resolvedTemplate),
      };
    }
    if (format === "bundle") {
      const destinationDirectory = isAbsolute(outputToken)
        ? outputToken
        : resolve(cwd, outputToken);
      outputToken = await scope.createDirectory("bundle-file");
      bundleStaging = { directory: outputToken, destinationDirectory };
    }
  } else if (stdoutOutput) outputToken = "-";
  else if (format === "bundle") {
    // A bundle is a multi-file directory that cannot be written to stdout;
    // for in-memory output compile into a temporary bundle root and read the
    // produced files back before the temporary scope is torn down.
    outputDirectory = await scope.createDirectory("bundle");
    outputPath = outputDirectory;
    outputToken = outputPath;
  } else {
    outputDirectory = await scope.createDirectory("output");
    const suffix =
      format === "png" || format === "svg"
        ? modernPageTemplates
          ? `-{p}-of-{t}.${format}`
          : `-{n}.${format}`
        : `.${format}`;
    outputPath = join(outputDirectory, `output${suffix}`);
    outputToken = outputPath;
  }

  const world = worldArgs(version, "compile", options, root);
  const args: string[] = [
    ...world.beforeCommand,
    "compile",
    ...world.afterCommand,
  ];
  if (options.format !== undefined && hasFlag(version, "compile", "--format"))
    args.push("--format", format);
  args.push(...outputArgs(options));
  if (options.depsPath !== undefined) {
    if (hasFlag(version, "compile", "--deps")) {
      args.push(...flagWithPath("--deps", options.depsPath));
      if (options.depsFormat !== undefined)
        args.push("--deps-format", options.depsFormat);
    } else {
      args.push(...flagWithPath("--make-deps", options.depsPath));
    }
  }
  args.push(...extraArgsOf(options), inputPath, outputToken);

  const runOptions: RunOptions = { ...buildRunOptions(options, stdin), cwd };
  const effectiveDepsFormat: TypstDepsFormat =
    options.depsFormat ??
    (hasFlag(version, "compile", "--deps") ? "json" : "make");
  return {
    args,
    runOptions,
    memoryOutput,
    stdoutOutput,
    stdoutFallback,
    ...(options.depsPath === undefined ? {} : { depsPath: options.depsPath }),
    depsFormat: effectiveDepsFormat,
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(pageStaging === undefined ? {} : { pageStaging }),
    ...(bundleStaging === undefined ? {} : { bundleStaging }),
  };
}

const MULTI_IMAGE_STDOUT_DIAGNOSTIC =
  "error: cannot export multiple images to stdout";

function shouldRetryCompileWithFiles(result: TypstProcessResult): boolean {
  if (
    result.timedOut ||
    result.aborted ||
    result.signal !== null ||
    result.stdout.length !== 0
  ) {
    return false;
  }
  if (result.exitCode === null || result.exitCode === 0) return false;
  // Typst has no machine-readable error code for this case. Retry only when
  // the documented multi-image diagnostic is present verbatim; every other
  // failure (syntax errors, missing files, unknown variables, …) is surfaced
  // immediately with its original process record. If upstream changes the
  // wording, the safe behavior is to stop retrying rather than to double-run
  // arbitrary failing documents.
  return result.stderr
    .toString("utf8")
    .split(/\r?\n/u)
    .some((line) => line.trim() === MULTI_IMAGE_STDOUT_DIAGNOSTIC);
}

async function collectCompileOutputs(
  prepared: PreparedCompileInvocation,
  processResult: TypstProcessResult,
  format: TypstOutputFormat,
  destination: NonNullable<NormalisedCompileOptions["output"]>,
  compilerVersion: string,
): Promise<CompileOutput[]> {
  if (!prepared.memoryOutput && destination.kind === "file") {
    if (prepared.bundleStaging !== undefined) {
      return await moveBundleOutputs(
        prepared.bundleStaging,
        compilerVersion,
        processResult,
      );
    }
    if (prepared.pageStaging !== undefined) {
      return await movePageOutputs(
        prepared.pageStaging,
        format,
        processResult,
        compilerVersion,
      );
    }
    const filePath = isAbsolute(destination.path)
      ? destination.path
      : resolve(prepared.runOptions.cwd ?? process.cwd(), destination.path);
    try {
      const details = await stat(filePath);
      if (!details.isFile()) throw new Error("Expected a regular output file.");
    } catch {
      throw new TypstCompilationError(
        "Typst compile completed without producing expected output.",
        processResult,
        compilerVersion,
      );
    }
    return [
      {
        kind: "file",
        path: filePath,
        mediaType: mediaTypeFor(format),
      },
    ];
  }
  if (prepared.outputPath === undefined) {
    return [
      {
        kind: "memory",
        data: Buffer.from(processResult.stdout),
        ...(prepared.stdoutOutput && (format === "png" || format === "svg")
          ? { page: 1 }
          : {}),
        mediaType: mediaTypeFor(format),
      },
    ];
  }
  if (format === "bundle") {
    const root = prepared.outputPath;
    const files = await collectBundleFiles(root);
    if (files.length === 0) {
      throw new TypstCompilationError(
        "Typst compile completed without producing bundle output.",
        processResult,
        compilerVersion,
      );
    }
    const outputs: CompileOutput[] = [];
    try {
      for (const file of files) {
        const data = await readFile(file);
        const relativePath = bundleRelativePath(root, file);
        const mediaType = mediaTypeForBundleFile(relativePath);
        outputs.push({
          kind: "memory",
          data,
          relativePath,
          ...(mediaType === undefined ? {} : { mediaType }),
        });
      }
    } catch {
      throw new TypstCompilationError(
        "Typst compile bundle output could not be read.",
        processResult,
        compilerVersion,
      );
    }
    return outputs;
  }
  let candidates: PageFile[];
  try {
    candidates =
      format === "png" || format === "svg"
        ? await collectPageFiles(
            prepared.outputPath,
            prepared.runOptions.cwd ?? process.cwd(),
          )
        : [{ path: prepared.outputPath }];
  } catch {
    throw new TypstCompilationError(
      "Typst compile completed without producing expected output.",
      processResult,
      compilerVersion,
    );
  }
  if (candidates.length === 0) {
    throw new TypstCompilationError(
      "Typst compile completed without producing expected output.",
      processResult,
      compilerVersion,
    );
  }
  const outputs: CompileOutput[] = [];
  try {
    for (const { path: file, page } of candidates) {
      const data = await readFile(file);
      outputs.push({
        kind: "memory",
        data,
        ...(page === undefined ? {} : { page }),
        mediaType: mediaTypeFor(format),
      });
    }
  } catch {
    throw new TypstCompilationError(
      "Typst compile output could not be read.",
      processResult,
      compilerVersion,
    );
  }
  return outputs;
}

/**
 * Collect the requested dependency-list content.
 *
 * A `depsPath` of `-` streams the list to stdout (only with a file output
 * destination, enforced before spawn), so the process record's stdout is the
 * raw content. A real path is read back from disk, resolved against the run's
 * working directory. The `zero` format is binary (NUL-separated), so the
 * content is always retained as a Buffer.
 */
async function collectCompileDependencies(
  prepared: PreparedCompileInvocation,
  processResult: TypstProcessResult,
  compilerVersion: string,
): Promise<CompileDependencies | undefined> {
  const depsPath = prepared.depsPath;
  if (depsPath === undefined) return undefined;
  const result: {
    readonly format: TypstDepsFormat;
    readonly path?: string;
    readonly data: Buffer;
  } = {
    format: prepared.depsFormat,
    data: Buffer.alloc(0),
  };
  if (depsPath === "-") {
    return Object.freeze({
      format: result.format,
      data: Buffer.from(processResult.stdout),
    });
  }
  const resolved = isAbsolute(depsPath)
    ? depsPath
    : resolve(prepared.runOptions.cwd ?? process.cwd(), depsPath);
  let data: Buffer;
  try {
    data = await readFile(resolved);
  } catch {
    throw new TypstCompilationError(
      "Typst compile completed without producing the requested dependency list.",
      processResult,
      compilerVersion,
    );
  }
  return Object.freeze({
    format: result.format,
    path: resolved,
    data,
  });
}

/**
 * Build the directory and file-name matcher for a page-per-file template.
 * The first page placeholder (`{p}`, `{0p}`, `{n}`) is captured so the page
 * number comes from the template itself, never from guessing at the file
 * name; `{t}` (the total) only has to be numeric.
 */
export function pageFilePattern(
  templatePath: string,
  cwd: string,
): { readonly directory: string; readonly matcher: RegExp } {
  const resolvedTemplate = isAbsolute(templatePath)
    ? templatePath
    : resolve(cwd, templatePath);
  const directory = dirname(resolvedTemplate);
  const templateName = win32.basename(resolvedTemplate);
  let captured = false;
  const pattern = templateName
    .split(/(\{(?:0p|n|p|t)\})/u)
    .map((part) => {
      const placeholder = /^\{(0p|n|p|t)\}$/u.exec(part);
      if (placeholder === null) return escapeRegExp(part);
      if (placeholder[1] !== "t" && !captured) {
        captured = true;
        return "(?<page>\\d+)";
      }
      return "\\d+";
    })
    .join("");
  return { directory, matcher: new RegExp(`^${pattern}$`, "u") };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface PageFile {
  readonly path: string;
  readonly page?: number;
}

async function collectPageFiles(
  templatePath: string,
  cwd: string,
): Promise<PageFile[]> {
  const { directory, matcher } = pageFilePattern(templatePath, cwd);
  const pages: PageFile[] = [];
  for (const name of await readdir(directory)) {
    const match = matcher.exec(name);
    if (match === null) continue;
    const page = match.groups?.["page"];
    pages.push({
      path: join(directory, name),
      ...(page === undefined ? {} : { page: Number(page) }),
    });
  }
  return pages.sort((left, right) => {
    const leftPage = left.page ?? Number.MAX_SAFE_INTEGER;
    const rightPage = right.page ?? Number.MAX_SAFE_INTEGER;
    return leftPage === rightPage
      ? left.path.localeCompare(right.path)
      : leftPage - rightPage;
  });
}

/**
 * Move this run's staged page files into the destination directory. Existing
 * files with the same names are replaced; nothing else in the destination is
 * touched.
 */
async function movePageOutputs(
  staging: NonNullable<PreparedCompileInvocation["pageStaging"]>,
  format: TypstOutputFormat,
  processResult: TypstProcessResult,
  compilerVersion: string,
): Promise<CompileOutput[]> {
  let pages: PageFile[];
  try {
    pages = await collectPageFiles(staging.template, process.cwd());
  } catch {
    pages = [];
  }
  if (pages.length === 0) {
    throw new TypstCompilationError(
      "Typst compile completed without producing expected page outputs.",
      processResult,
      compilerVersion,
    );
  }
  const outputs: CompileOutput[] = [];
  try {
    await mkdir(staging.destinationDirectory, { recursive: true });
    for (const page of pages) {
      const target = join(
        staging.destinationDirectory,
        win32.basename(page.path),
      );
      await moveFile(page.path, target);
      outputs.push({
        kind: "file",
        path: target,
        ...(page.page === undefined ? {} : { page: page.page }),
        mediaType: mediaTypeFor(format),
      });
    }
  } catch (error) {
    throw new TypstCompilationError(
      `Typst compile page outputs could not be moved to ${staging.destinationDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      processResult,
      compilerVersion,
    );
  }
  return outputs;
}

/** Move a file, falling back to copy + remove across filesystems. */
async function moveFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(source, target);
    await rm(source, { force: true });
  }
}

/**
 * Recursively list every file under a bundle root, sorted for deterministic
 * ordering. Throws if the root is missing or cannot be listed.
 */
async function collectBundleFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/** Normalise a bundle file path to a forward-slash path relative to its root. */
function bundleRelativePath(root: string, file: string): string {
  return relative(root, file)
    .split(/[\\/]+/u)
    .join("/");
}

/**
 * Move this run's staged bundle into the destination directory, keeping the
 * relative layout. Existing files with the same paths are replaced; nothing
 * else in the destination is touched.
 */
async function moveBundleOutputs(
  staging: NonNullable<PreparedCompileInvocation["bundleStaging"]>,
  compilerVersion: string,
  processResult: TypstProcessResult,
): Promise<CompileOutput[]> {
  let files: string[];
  try {
    files = await collectBundleFiles(staging.directory);
  } catch {
    files = [];
  }
  if (files.length === 0) {
    throw new TypstCompilationError(
      "Typst compile completed without producing bundle output.",
      processResult,
      compilerVersion,
    );
  }
  const outputs: CompileOutput[] = [];
  try {
    for (const file of files) {
      const relativePath = bundleRelativePath(staging.directory, file);
      const target = join(
        staging.destinationDirectory,
        ...relativePath.split("/"),
      );
      await mkdir(dirname(target), { recursive: true });
      await moveFile(file, target);
      const mediaType = mediaTypeForBundleFile(relativePath);
      outputs.push({
        kind: "file",
        path: target,
        relativePath,
        ...(mediaType === undefined ? {} : { mediaType }),
      });
    }
  } catch (error) {
    throw new TypstCompilationError(
      `Typst compile bundle output could not be moved to ${staging.destinationDirectory}: ${error instanceof Error ? error.message : String(error)}`,
      processResult,
      compilerVersion,
    );
  }
  return outputs;
}

/**
 * Narrow a `CompileOutput` to the in-memory form, or `false`.
 *
 * The statically in-memory `compile()` overload already infers this for
 * canonical calls; use this guard when the destination kind is not statically
 * known, for example with dynamic option objects.
 */
export function isMemoryOutput(
  output: CompileOutput,
): output is CompileMemoryOutput {
  return output.kind === "memory";
}

/** Narrow a `CompileOutput` to the file form, or `false`. */
export function isFileOutput(
  output: CompileOutput,
): output is CompileFileOutput {
  return output.kind === "file";
}

/**
 * Assert that a compile produced exactly one output and return it.
 *
 * Throws `TypstUnexpectedResultError` when the result carries zero or several
 * outputs. Only rely on this for formats that emit a single artifact (PDF and
 * HTML); page-per-file formats such as PNG and SVG legitimately produce many.
 */
export function expectSingleOutput(result: CompileResult): CompileOutput {
  const first = result.outputs[0];
  if (result.outputs.length !== 1 || first === undefined) {
    throw new TypstUnexpectedResultError(
      `Expected exactly one output, found ${result.outputs.length}.`,
    );
  }
  return first;
}

/**
 * Assert that a compile produced exactly one in-memory output and return it.
 *
 * This is the typed escape hatch for the common "compile source to a PDF
 * Buffer" call when the options object is not statically known to be
 * in-memory PDF. Throws `TypstUnexpectedResultError` when the result carries
 * zero or several outputs, or when the single output is a file.
 */
export function expectSingleMemoryOutput(
  result: CompileResult,
): CompileMemoryOutput {
  const output = expectSingleOutput(result);
  if (output.kind !== "memory") {
    throw new TypstUnexpectedResultError(
      "Expected the single output to be an in-memory output.",
    );
  }
  return output;
}
