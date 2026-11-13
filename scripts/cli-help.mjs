// Parsing of clap `--help` output, shared by the CLI flag inventory
// generator and its tests.

/**
 * Parse the options of one clap help text. Returns a map from long flag to
 * `{ value: "none" | "required" | "optional", values: string[] }`.
 */
export function parseHelpFlags(help) {
  const lines = help.replace(/\r\n?/gu, "\n").split("\n");
  const flags = new Map();
  let current;
  let listing = false;
  for (const line of lines) {
    const flag =
      /^\s{2,}(?:-[A-Za-z0-9], )?--([a-z0-9][a-z0-9-]*)(?:[ =](\[)?<[^>]+>)?/u.exec(
        line,
      );
    if (flag !== null) {
      const name = `--${flag[1]}`;
      const value =
        flag[2] === "["
          ? "optional"
          : flag[0].includes("<")
            ? "required"
            : "none";
      current = { value, values: [] };
      if (name !== "--help" && name !== "--version") flags.set(name, current);
      listing = false;
    }
    if (current === undefined) continue;
    const inline = /\[possible values: ([^\]]+)\]/u.exec(line);
    if (inline !== null) {
      current.values.push(...inline[1].split(",").map((item) => item.trim()));
      continue;
    }
    if (/^\s+Possible values:\s*$/u.test(line)) {
      listing = true;
      continue;
    }
    if (listing) {
      const item = /^\s+- ([^:\s]+):?/u.exec(line);
      if (item !== null) current.values.push(item[1]);
      else if (line.trim().length > 0) listing = false;
    }
  }
  return flags;
}
