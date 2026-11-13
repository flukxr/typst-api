import assert from "node:assert/strict";
import test from "node:test";

import { parseHelpFlags } from "../scripts/cli-help.mjs";
import {
  flagIsGlobal,
  flagSince,
  flagValueSince,
  hasFlag,
} from "../dist/commands/cli-flags.js";

// Two help formats clap produced over the Typst releases.
const INLINE_HELP = `Options:
      --open [<OPEN>]
          Opens the output file after compilation
      --ppi <PPI>
          The PPI to use if exported as PNG
      --diagnostic-format <DIAGNOSTIC_FORMAT>
          In which format to emit diagnostics [default: human] [possible values: human, short]
  -h, --help
          Print help
`;

const LIST_HELP = `Options:
      --pdf-standard <PDF_STANDARD>
          One (or multiple comma-separated) PDF standards

          Possible values:
          - 1.7:  PDF 1.7
          - a-2b: PDF/A-2b

      --no-pdf-tags
          Disable tagged PDF
`;

test("parses flags, value kinds and inline possible values", () => {
  const flags = parseHelpFlags(INLINE_HELP);
  assert.deepEqual(
    [...flags.keys()],
    ["--open", "--ppi", "--diagnostic-format"],
  );
  assert.equal(flags.get("--open").value, "optional");
  assert.equal(flags.get("--ppi").value, "required");
  assert.deepEqual(flags.get("--diagnostic-format").values, ["human", "short"]);
});

test("parses listed possible values and switches", () => {
  const flags = parseHelpFlags(LIST_HELP);
  assert.deepEqual(flags.get("--pdf-standard").values, ["1.7", "a-2b"]);
  assert.equal(flags.get("--no-pdf-tags").value, "none");
});

// The committed inventory, checked against boundaries verified on binaries.
test("the inventory reproduces the verified flag boundaries", () => {
  assert.equal(flagSince("compile", "--ignore-system-fonts"), "0.12.0");
  assert.equal(flagSince("compile", "--ignore-embedded-fonts"), "0.14.0");
  assert.equal(flagSince("compile", "--format"), "0.8.0");
  assert.equal(flagSince("compile", "--deps"), "0.14.0");
  assert.equal(flagValueSince("compile", "--features", "html"), "0.13.0");
  assert.equal(flagValueSince("compile", "--pdf-standard", "a-3b"), "0.13.0");
  assert.equal(hasFlag("0.13.1", "compile", "--deps"), false);
  assert.equal(hasFlag("0.14.0", "compile", "--deps"), true);
});

test("--root is global before 0.7.0 and a subcommand option from 0.7.0", () => {
  assert.equal(flagSince("compile", "--root"), "0.1.0");
  assert.equal(flagIsGlobal("0.6.0", "compile", "--root"), true);
  assert.equal(flagIsGlobal("0.7.0", "compile", "--root"), false);
  assert.equal(flagIsGlobal("0.6.0", "fonts", "--font-path"), true);
  assert.equal(flagIsGlobal("0.7.0", "fonts", "--font-path"), false);
});

test("a flag that leaves the help is not treated as removed", () => {
  // --make-deps is hidden but still accepted from 0.14.0 (verified on the
  // binaries); it must stay usable on 0.15.1.
  assert.equal(hasFlag("0.15.1", "compile", "--make-deps"), true);
});
