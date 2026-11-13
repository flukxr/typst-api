import { stripAnsi } from "./ansi.js";
/**
 * Best-effort structured diagnostic parser for Typst's human-readable stderr.
 *
 * Typst emits diagnostics in a form like:
 *
 *   error: something went wrong
 *     ┌─ path/to/file.typ:5:10
 *     │
 *   5 │ some code here
 *     │           ^^^^
 *     │           this is wrong
 *     │
 *     = hint: try this instead
 *     = help: more context
 *
 * Warning and info-level diagnostics follow the same layout.  The raw text is
 * always preserved in the process result; the parsed representation here is
 * best effort only.  Upstream may change the format in any release.
 *
 * @module
 */

/** The severity of a Typst diagnostic. */
export type TypstDiagnosticSeverity = "error" | "warning" | "info";

/**
 * A source-location span reported by the compiler.
 *
 * Fields are optional because some diagnostics do not carry a path or
 * precise coordinates (e.g., a package-level message).
 */
export interface TypstDiagnosticSpan {
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

/** A hint, note, or help block attached to a diagnostic. */
export interface TypstDiagnosticHint {
  readonly kind: "hint" | "help" | "note";
  readonly message: string;
}

/** One parsed diagnostic extracted from stderr on a best-effort basis. */
export interface TypstDiagnostic {
  readonly severity: TypstDiagnosticSeverity;
  readonly message: string;
  readonly spans: readonly TypstDiagnosticSpan[];
  readonly hints: readonly TypstDiagnosticHint[];
}

/** Event kind for the opt-in progress/log hook. */
export type TypstLogKind =
  "spawn" | "exit" | "stdout_chunk" | "stderr_chunk" | "output_truncated";

/** Fields shared by every redaction-safe log event. */
export interface TypstLogEventBase {
  /** Monotonic timestamp in milliseconds (relative to process start). */
  readonly timestamp: number;
  /** Always `"typst"` to avoid leaking executable path details. */
  readonly command: "typst";
}

/** The child process has spawned. */
export interface TypstSpawnLogEvent extends TypstLogEventBase {
  readonly kind: "spawn";
  readonly pid?: number;
}

/** The child process has settled. */
export interface TypstExitLogEvent extends TypstLogEventBase {
  readonly kind: "exit";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Elapsed wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

/** A stdout or stderr chunk arrived; the content itself is never logged. */
export interface TypstChunkLogEvent extends TypstLogEventBase {
  readonly kind: "stdout_chunk" | "stderr_chunk";
  readonly stream: "stdout" | "stderr";
  /** Byte length of the chunk. */
  readonly chunkLength: number;
}

/** A bounded capture started dropping the oldest bytes of a stream. */
export interface TypstOutputTruncatedLogEvent extends TypstLogEventBase {
  readonly kind: "output_truncated";
  readonly stream: "stdout" | "stderr";
  /** Total bytes observed on the stream so far. */
  readonly totalBytes: number;
  /** Bytes no longer retained by the bounded capture at that point. */
  readonly droppedBytes: number;
}

/**
 * A redaction-safe log event delivered to the `onLog` hook, discriminated by
 * `kind`.
 */
export type TypstLogEvent =
  | TypstSpawnLogEvent
  | TypstExitLogEvent
  | TypstChunkLogEvent
  | TypstOutputTruncatedLogEvent;

/** A log event before the constant `command` field is attached. */
export type TypstLogEventInput = TypstLogEvent extends infer E
  ? E extends TypstLogEvent
    ? Omit<E, "command">
    : never
  : never;

// ---------------------------------------------------------------------------
// Parser internals
// ---------------------------------------------------------------------------

const SEVERITY_PATTERN = /^(error|warning|info)\s*:\s*/u;
const SPAN_PATTERN = /^\s*┌─\s+(\S.+?):(\d+):(\d+)\s*$/u;
const HINT_PATTERN = /^\s*=\s+(hint|help|note)\s*:\s*(.*)$/u;
const DIAGNOSTIC_SEPARATOR = /^\s*$/u;
const BOX_CHARACTERS = /[│·╎]/u;

/** Strip the trailing line break from a token; returns the line text. */
function lineText(token: string): string {
  return token.replace(/\r?\n$/u, "");
}

/** Split text into line tokens that retain their trailing line break. */
function splitLineTokens(text: string): readonly string[] {
  const tokens: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") {
      tokens.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) tokens.push(text.slice(start));
  return tokens;
}

/**
 * Parse zero or more best-effort diagnostics from raw stderr text.
 *
 * The raw text is consumed conservatively: every parsed diagnostic is removed
 * from the returned `remainder`, and any undecodable output stays as-is.
 *
 * @returns An object with parsed diagnostics and the unparsed trailing text.
 */
export function parseDiagnostics(stderr: string): {
  diagnostics: readonly TypstDiagnostic[];
  remainder: string;
} {
  const tokens = splitLineTokens(stripAnsi(stderr));
  const diagnostics: TypstDiagnostic[] = [];
  const consumed = new Array<boolean>(tokens.length).fill(false);
  let i = 0;

  while (i < tokens.length) {
    const diag = tryParseDiagnostic(tokens, i);
    if (diag === null) {
      i++;
      continue;
    }
    diagnostics.push(diag.diagnostic);
    for (let j = i; j < diag.nextIndex; j++) consumed[j] = true;
    i = diag.nextIndex;
  }

  if (diagnostics.length === 0) return { diagnostics: [], remainder: stderr };

  const remainderStr = tokens.filter((_, index) => !consumed[index]).join("");

  return {
    diagnostics: Object.freeze(diagnostics),
    remainder: remainderStr,
  };
}

interface ParseResult {
  diagnostic: TypstDiagnostic;
  nextIndex: number;
}

function tryParseDiagnostic(
  tokens: readonly string[],
  startIndex: number,
): ParseResult | null {
  if (startIndex >= tokens.length) return null;

  // Skip leading blank lines (separators between diagnostics).
  let i = startIndex;
  while (i < tokens.length && DIAGNOSTIC_SEPARATOR.test(lineText(tokens[i]!))) {
    i++;
  }
  if (i >= tokens.length) return null;

  const firstLine = lineText(tokens[i]!);
  const severityMatch = SEVERITY_PATTERN.exec(firstLine);
  if (severityMatch === null) return null;
  const severity = severityMatch[1]! as TypstDiagnosticSeverity;
  const message = firstLine.slice(severityMatch[0]!.length).trim();
  i++;

  const spans: TypstDiagnosticSpan[] = [];
  const hints: TypstDiagnosticHint[] = [];

  // Parse spans and hints until a separator (blank line) or end.
  while (i < tokens.length) {
    const line = lineText(tokens[i]!);

    // Blank line separates diagnostics.
    if (DIAGNOSTIC_SEPARATOR.test(line)) {
      i++;
      break;
    }

    const spanMatch = SPAN_PATTERN.exec(line);
    if (spanMatch !== null) {
      const path = spanMatch[1]!;
      const lineNum = Number(spanMatch[2]!);
      const col = Number(spanMatch[3]!);
      if (!Number.isSafeInteger(lineNum) || !Number.isSafeInteger(col)) {
        i++;
        continue;
      }
      const span: TypstDiagnosticSpan = { line: lineNum, column: col };
      if (path.length > 0) {
        (span as Record<string, unknown>).path = path;
      }
      spans.push(span);
      i++;

      // Consume the source/caret block that follows a span. Every block line
      // carries the vertical border (│, ·, or ╎); a trailing blank line is
      // consumed so the next span or hint line is reached.
      while (i < tokens.length) {
        const inner = lineText(tokens[i]!);
        if (DIAGNOSTIC_SEPARATOR.test(inner)) {
          i++;
          break;
        }
        if (
          HINT_PATTERN.test(inner) ||
          SEVERITY_PATTERN.test(inner) ||
          SPAN_PATTERN.test(inner)
        ) {
          break;
        }
        if (BOX_CHARACTERS.test(inner)) {
          i++;
          continue;
        }
        break;
      }
      continue;
    }

    const hintMatch = HINT_PATTERN.exec(line);
    if (hintMatch !== null) {
      hints.push({
        kind: hintMatch[1]! as TypstDiagnosticHint["kind"],
        message: hintMatch[2]!.trim(),
      });
      i++;
      continue;
    }

    // Unrecognized line — end of this diagnostic.
    break;
  }

  // Discard trailing blank lines.
  while (i < tokens.length && DIAGNOSTIC_SEPARATOR.test(lineText(tokens[i]!))) {
    i++;
  }

  return {
    diagnostic: {
      severity,
      message,
      spans: Object.freeze(spans),
      hints: Object.freeze(hints),
    },
    nextIndex: i,
  };
}

/**
 * Best-effort warnings from the stderr of a successful run. Parsing never
 * fails the call: unrecognised output yields an empty list, and the raw
 * stderr stays authoritative on the process record.
 */
export function warningsFromStderr(
  stderr: Uint8Array,
): readonly TypstDiagnostic[] {
  if (stderr.length === 0) return Object.freeze([]);
  try {
    const { diagnostics } = parseDiagnostics(
      Buffer.from(stderr).toString("utf8"),
    );
    return Object.freeze(
      diagnostics.filter((diagnostic) => diagnostic.severity === "warning"),
    );
  } catch {
    return Object.freeze([]);
  }
}
