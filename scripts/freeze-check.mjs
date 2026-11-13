// Freeze gate: the frozen spec in spec/public-api.d.ts is the authoritative
// public contract. `scripts/freeze-check-lib.mjs` parses both the spec and the
// emitted `dist/index.d.ts` declaration tree structurally, resolves
// re-exports, and compares exported declarations, members, overloads, generic
// constraints, optional and readonly modifiers, and result types.
//
// An exported-name addition or removal, a removed or changed member, an
// optional-to-required change, and any signature/type change fail the gate.
// Compatible additions (new members or overloads) are reported as advisories.
// A deliberate public change is made by editing spec/public-api.d.ts first.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { checkContract, formatResult } from "./freeze-check-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  let result;
  try {
    result = await checkContract({
      specPath: join(root, "spec", "public-api.d.ts"),
      distPath: join(root, "dist", "index.d.ts"),
    });
  } catch (error) {
    console.error(
      `freeze:check: cannot read or parse the contract files: ${error.message}`,
    );
    console.error("Run `npm run build` before the freeze check.");
    process.exitCode = 1;
    return;
  }

  const report = formatResult(result, {
    verbose: process.argv.includes("--verbose"),
  });
  if (result.ok) {
    console.log(report);
    return;
  }
  console.error(report);
  process.exitCode = 1;
}

await main();
