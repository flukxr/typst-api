// Compiles Typst markup from a string straight into a PDF Buffer.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTypst, source } from "@flukxr/typst-api";

let created = false;
const outDir =
  process.env.TYPST_EXAMPLES_DIR ??
  ((created = true), await mkdtemp(join(tmpdir(), "typst-api-example-")));

try {
  await mkdir(outDir, { recursive: true });

  const typst = await createTypst();
  const pdf = await typst.pdf(
    source("= From a string\n\nNo file input needed."),
  );
  console.log(`format=pdf bytes=${pdf.length}`);

  const path = join(outDir, "from-source.pdf");
  await writeFile(path, pdf);
  console.log(`wrote ${path}`);
} finally {
  if (created) await rm(outDir, { recursive: true, force: true });
}
