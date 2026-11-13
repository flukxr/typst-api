import type { CreateTypstOptions, TypstClient } from "../types/public.js";
import { createTypst, validateCreateOptions } from "./index.js";

/**
 * Module-level functions backed by one shared client.
 *
 * Scripts call `compile()`, `pdf()` or `query()` directly; the client is
 * created on the first call with the options from `configure()` (or the
 * defaults) and reused afterwards. `configure()` may be called at any time:
 * it replaces the options and the next call creates a fresh client.
 * Applications that need several independent clients use `createTypst()`.
 */

let configured: CreateTypstOptions = {};
let shared: Promise<TypstClient> | undefined;

/**
 * Set the options of the shared client used by the module-level functions.
 * Accepts the same options as `createTypst()` and validates them at once.
 */
export function configure(options: CreateTypstOptions = {}): void {
  validateCreateOptions(options);
  configured = { ...options };
  shared = undefined;
}

/** The shared client, created on first use with the configured options. */
export function defaultClient(): Promise<TypstClient> {
  if (shared === undefined) {
    const pending = createTypst(configured);
    shared = pending;
    // A failed discovery is not cached: the next call tries again.
    pending.catch(() => {
      if (shared === pending) shared = undefined;
    });
  }
  return shared;
}

function forward<K extends keyof TypstClient>(name: K): TypstClient[K] {
  const call = async (...args: unknown[]): Promise<unknown> => {
    const client = await defaultClient();
    const method = client[name] as unknown as (...rest: unknown[]) => unknown;
    return await method.apply(client, args);
  };
  return call as unknown as TypstClient[K];
}

export const compile: TypstClient["compile"] = forward("compile");
export const compileMany: TypstClient["compileMany"] = forward("compileMany");
export const pdf: TypstClient["pdf"] = forward("pdf");
export const png: TypstClient["png"] = forward("png");
export const svg: TypstClient["svg"] = forward("svg");
export const html: TypstClient["html"] = forward("html");
export const query: TypstClient["query"] = forward("query");
export const queryOne: TypstClient["queryOne"] = forward("queryOne");
export const watch: TypstClient["watch"] = forward("watch");
export const fonts: TypstClient["fonts"] = forward("fonts");
