// Compiles a .typ file on disk into a PDF file on disk.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTypst } from "@flukxr/typst-api";

let created = false;
const outDir =
  process.env.TYPST_EXAMPLES_DIR ??
  ((created = true), await mkdtemp(join(tmpdir(), "typst-api-example-")));

try {
  const input = join(outDir, "document.typ");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    input,
    "= Hello from typst-api\n\nCompiled from a file input.",
  );

  const typst = await createTypst();
  // File to file, like `typst compile <input> <output>`; the output format
  // follows the extension.
  const result = await typst.compile(input, join(outDir, "document.pdf"));

  console.log(`format=${result.format} outputs=${result.outputs.length}`);
  console.log(`wrote ${result.outputs[0].path}`);
} finally {
  if (created) await rm(outDir, { recursive: true, force: true });
}
