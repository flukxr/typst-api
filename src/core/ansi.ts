/**
 * Remove ANSI escape sequences (colors, styles). Typst `0.1.0`–`0.4.0` color
 * their diagnostics even when stderr is not a terminal, so the best-effort
 * parsers strip them first. Raw process output is never modified.
 */
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}
