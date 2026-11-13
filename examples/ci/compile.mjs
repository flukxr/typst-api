// Copy this script into a consumer project and compile a repository document
// in CI. Any failure exits non-zero and fails the job.
import { mkdir } from "node:fs/promises";
import { createTypst } from "@flukxr/typst-api";

await mkdir("dist", { recursive: true });

const typst = await createTypst();
// Paths are relative to the working directory.
const result = await typst.compile("main.typ", "dist/main.pdf");

console.log(
  `compiled ${result.outputs[0].path} with typst ${result.compilerVersion}`,
);
