import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from "node:path";

const TEMPORARY_ROOT_PREFIX = "typst-api-";

/** The options used by the internal temporary-artifact scope. */
export interface TemporaryScopeOptions {
  /** Internal test hook; production callers use the real asynchronous `rm`. */
  readonly remove?: RemoveTemporaryRoot;
}

/** The asynchronous remove operation used when disposing a temporary root. */
export type RemoveTemporaryRoot = (
  path: string,
  options: { readonly recursive: true; readonly force: true },
) => Promise<void>;

/**
 * A package-owned directory for artifacts used during one operation.
 *
 * The root is created with `mkdtemp` below the operating-system temporary
 * directory. Every path accepted by this class is resolved and checked against
 * that root before it is used. Once `cleanup()` starts, the scope is disposed
 * permanently, even when removal itself fails; this prevents callers from
 * accidentally reusing a partially removed scope.
 */
export class TemporaryScope {
  readonly root: string;

  private readonly remove: RemoveTemporaryRoot;
  private activeOperations = 0;
  private idlePromise: Promise<void> | undefined;
  private idleResolve: (() => void) | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private isDisposed = false;

  /** @internal Constructed by `createTemporaryScope`; not part of the root API. */
  constructor(root: string, options: TemporaryScopeOptions = {}) {
    if (typeof root !== "string" || root.length === 0) {
      throw new TypeError("The temporary scope root must be a non-empty path.");
    }
    this.root = resolve(root);
    this.remove = options.remove ?? removeTemporaryRoot;
  }

  /** True after cleanup starts; disposed scopes cannot create or resolve paths. */
  get disposed(): boolean {
    return this.isDisposed;
  }

  /**
   * Resolve a relative artifact path inside this scope.
   *
   * The empty path and `.` refer to the root, which is useful when a caller
   * needs to pass the package-owned working directory to a child process.
   */
  path(name = ""): string {
    this.assertUsable();
    return resolveWithinRoot(this.root, name);
  }

  /** Alias for `path`, kept explicit for call sites that construct arguments. */
  resolvePath(name = ""): string {
    return this.path(name);
  }

  /** Create a nested directory and return its absolute path. */
  async createDirectory(name = ""): Promise<string> {
    const done = this.beginOperation();
    try {
      const directory = resolveWithinRoot(this.root, name);
      await mkdir(directory, { recursive: true });
      return directory;
    } finally {
      done();
    }
  }

  /** Short alias for `createDirectory`. */
  async directory(name = ""): Promise<string> {
    return await this.createDirectory(name);
  }

  /**
   * Create or replace a file below the scope and return its absolute path.
   * Parent directories are created recursively, so nested Unicode/space-safe
   * paths can be used directly.
   */
  async createFile(
    name: string,
    data: string | Uint8Array = "",
  ): Promise<string> {
    const done = this.beginOperation();
    try {
      const file = resolveWithinRoot(this.root, name);
      if (file === this.root) {
        throw new TypeError("A temporary file must have a file name.");
      }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data);
      return file;
    } finally {
      done();
    }
  }

  /** Short alias for `createFile`. */
  async file(name: string, data: string | Uint8Array = ""): Promise<string> {
    return await this.createFile(name, data);
  }

  /**
   * Recursively remove the package-owned root.
   *
   * Disposal is idempotent: concurrent or repeated calls share one promise,
   * and `force: true` makes an already-absent root a successful cleanup. A
   * failed removal still leaves the scope disposed, so no later artifact can be
   * created in a potentially unsafe partially-cleaned tree.
   */
  cleanup(): Promise<void> {
    if (this.cleanupPromise !== undefined) return this.cleanupPromise;
    this.isDisposed = true;
    this.cleanupPromise = this.waitForOperations().then(() =>
      this.remove(this.root, { recursive: true, force: true }),
    );
    return this.cleanupPromise;
  }

  /** Alias for `cleanup`, useful with explicit lifecycle naming. */
  dispose(): Promise<void> {
    return this.cleanup();
  }

  /** Allow `await using` callers on Node versions that support async disposal. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }

  private assertUsable(): void {
    if (this.isDisposed) {
      throw new Error("The temporary artifact scope has been disposed.");
    }
  }

  private beginOperation(): () => void {
    this.assertUsable();
    this.activeOperations += 1;
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      this.activeOperations -= 1;
      if (this.activeOperations === 0 && this.idleResolve !== undefined) {
        const resolveIdle = this.idleResolve;
        this.idleResolve = undefined;
        this.idlePromise = undefined;
        resolveIdle();
      }
    };
  }

  private waitForOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve();
    if (this.idlePromise === undefined) {
      this.idlePromise = new Promise<void>((resolveIdle) => {
        this.idleResolve = resolveIdle;
      });
    }
    return this.idlePromise;
  }
}

/** Create a unique package-owned temporary-artifact scope. */
export async function createTemporaryScope(
  options: TemporaryScopeOptions = {},
): Promise<TemporaryScope> {
  const root = await mkdtemp(join(tmpdir(), TEMPORARY_ROOT_PREFIX));
  return new TemporaryScope(root, options);
}

/**
 * Run one operation with a temporary scope and always dispose it afterwards.
 *
 * If the callback succeeds, a cleanup failure rejects the helper. If the
 * callback fails, its original value/error is preserved exactly and a routine
 * cleanup failure is suppressed rather than masking that operation failure.
 */
export async function withTemporaryScope<T>(
  callback: (scope: TemporaryScope) => T | PromiseLike<T>,
  options: TemporaryScopeOptions = {},
): Promise<T> {
  if (typeof callback !== "function") {
    throw new TypeError("The temporary scope callback must be a function.");
  }
  const scope = await createTemporaryScope(options);
  let operationFailed = false;
  try {
    return await callback(scope);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await scope.cleanup();
    } catch (cleanupError) {
      if (!operationFailed) throw cleanupError;
    }
  }
}

function removeTemporaryRoot(
  path: string,
  options: { readonly recursive: true; readonly force: true },
): Promise<void> {
  // Windows antivirus and indexers briefly lock fresh files (EBUSY/EPERM);
  // retrying a few times turns those transient failures into a clean removal.
  return rm(path, { ...options, maxRetries: 5, retryDelay: 100 });
}

function resolveWithinRoot(root: string, name: string): string {
  if (typeof name !== "string") {
    throw new TypeError("A temporary artifact path must be a string.");
  }
  if (name.includes("\0")) {
    throw new TypeError("A temporary artifact path cannot contain NUL.");
  }
  if (isAbsolute(name) || posix.isAbsolute(name) || win32.isAbsolute(name)) {
    throw new TypeError("Temporary artifact paths must be relative.");
  }

  const candidate = resolve(root, name);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${pathSeparator()}`) ||
    isAbsolute(fromRoot) ||
    posix.isAbsolute(fromRoot) ||
    win32.isAbsolute(fromRoot)
  ) {
    throw new TypeError("Temporary artifact path must stay within its scope.");
  }
  return candidate;
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
