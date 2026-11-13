import { loadValidatedM0Data } from "./data-validation.mjs";

const { releases, sweepEvidence } = await loadValidatedM0Data();

console.log(
  `Validated 4 M0 data files, ${sweepEvidence.length} per-platform sweep evidence files, and ${releases.size} exact stable Typst releases.`,
);
