import fs from "node:fs/promises";

import { format } from "prettier";

import { loadValidatedM0Data } from "./data-validation.mjs";

const GENERATED_URL = new URL(
  "../src/capabilities/registry.generated.ts",
  import.meta.url,
);
const arguments_ = process.argv.slice(2);
const checkOnly = arguments_.length === 1 && arguments_[0] === "--check";

if (arguments_.length > 0 && !checkOnly) {
  throw new Error("Usage: node scripts/generate-capabilities.mjs [--check]");
}

const { capabilities } = await loadValidatedM0Data();
const generated = await format(
  `// Generated from data/capabilities.seed.json. Do not edit by hand.
import type { CapabilityRegistry } from "./types.js";

export const CAPABILITY_REGISTRY = ${JSON.stringify(capabilities, null, 2)} as const satisfies CapabilityRegistry;

export type CapabilityName = keyof typeof CAPABILITY_REGISTRY.features;
`,
  { parser: "typescript", endOfLine: "lf" },
);

if (checkOnly) {
  let existing;
  try {
    existing = await fs.readFile(GENERATED_URL, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Generated capability registry is missing. Run npm run generate:capabilities.",
      );
    }
    throw error;
  }
  // The generated file is written with LF endings. On a Windows checkout git
  // may convert the committed file to CRLF, so normalise before comparing to
  // keep the check identical on every platform.
  if (existing.replace(/\r\n/gu, "\n") !== generated) {
    throw new Error(
      "Generated capability registry is stale. Run npm run generate:capabilities and commit the result.",
    );
  }
  console.log("Generated capability registry is current.");
} else {
  await fs.mkdir(new URL("../src/capabilities/", import.meta.url), {
    recursive: true,
  });
  await fs.writeFile(GENERATED_URL, generated, "utf8");
  console.log("Generated src/capabilities/registry.generated.ts.");
}
