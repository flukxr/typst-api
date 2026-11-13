import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { TypstInvalidArgumentError } from "../core/errors.js";
import type { CompileInput, CompileSourceInput } from "../types/public.js";

/**
 * Build an in-memory source input. A plain string passed as `input` is a file
 * path; wrap Typst markup with `source()` instead. `virtualPath` names the
 * in-memory file, which matters for relative paths and error locations.
 *
 * ```js
 * await typst.pdf(source("= Hello"));
 * await typst.pdf(source("#include \"chapter.typ\"", "book/main.typ"));
 * ```
 */
export function source(
  data: string | Uint8Array,
  virtualPath?: string,
): CompileSourceInput {
  if (typeof data !== "string" && !(data instanceof Uint8Array)) {
    throw new TypstInvalidArgumentError(
      "source() data must be a string or Uint8Array.",
    );
  }
  if (virtualPath !== undefined && typeof virtualPath !== "string") {
    throw new TypstInvalidArgumentError(
      "source() virtualPath must be a string.",
    );
  }
  return virtualPath === undefined
    ? Object.freeze({ kind: "source", data })
    : Object.freeze({ kind: "source", data, virtualPath });
}

/**
 * Encode a structured value for `inputs`. `sys.inputs` only carries strings;
 * decode it in the document with `json(bytes(sys.inputs.key))`.
 *
 * ```js
 * await typst.pdf("invoice.typ", { inputs: { data: jsonInput(invoice) } });
 * ```
 */
export function jsonInput(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypstInvalidArgumentError(
      "jsonInput() value cannot be serialized as JSON.",
      { cause: error },
    );
  }
  if (encoded === undefined) {
    throw new TypstInvalidArgumentError(
      "jsonInput() value has no JSON representation.",
    );
  }
  return encoded;
}

/** Typst markup openings that are very unlikely to start a file name. */
const MARKUP_START = /^\s*(?:=+\s|#(?:set|show|let|import|include)\b|\[)/u;

/**
 * A plain string input is a file path. When it is evidently Typst markup
 * instead, fail early with a hint rather than with the compiler's
 * "file not found". Multi-line strings are never paths; a single line is only
 * reported when it looks like markup and no such file exists.
 */
export async function checkPathShorthand(
  input: CompileInput | undefined,
  cwd: string,
): Promise<void> {
  if (typeof input !== "string") return;
  const hint =
    'A string input is a file path. For Typst markup use source("...") or { kind: "source", data: "..." }.';
  if (input.includes("\n")) {
    throw new TypstInvalidArgumentError(
      `input contains a line break, so it cannot be a file path. ${hint}`,
    );
  }
  if (!MARKUP_START.test(input)) return;
  try {
    await stat(isAbsolute(input) ? input : resolve(cwd, input));
  } catch {
    throw new TypstInvalidArgumentError(
      `input ${JSON.stringify(input)} looks like Typst markup and is not an existing file. ${hint}`,
    );
  }
}
