// Script-style use without a client: module-level functions, one optional
// configure() call, file-to-file compile, structured inputs and batches.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compile,
  compileMany,
  configure,
  jsonInput,
  pdf,
  query,
  source,
} from "@flukxr/typst-api";

let created = false;
const outDir =
  process.env.TYPST_EXAMPLES_DIR ??
  ((created = true), await mkdtemp(join(tmpdir(), "typst-api-example-")));

try {
  await mkdir(outDir, { recursive: true });

  // Optional: options for the shared client behind the module functions.
  configure({ timeoutMs: 60_000 });

  // A template that reads structured data from sys.inputs.
  const template = join(outDir, "invoice.typ");
  await writeFile(
    template,
    [
      "#let invoice = json(bytes(sys.inputs.data))",
      "= Invoice #invoice.id",
      "Total: #invoice.total",
    ].join("\n"),
  );

  // File to file, like `typst compile <input> <output>`.
  const single = await compile(template, join(outDir, "invoice-1.pdf"), {
    inputs: { data: jsonInput({ id: 1, total: 42 }) },
  });
  console.log(`single ${single.outputs[0].path}`);

  // Many documents with bounded parallelism; failures do not stop the batch.
  const settled = await compileMany(
    [2, 3].map((id) => ({
      input: template,
      output: join(outDir, `invoice-${id}.pdf`),
      inputs: { data: jsonInput({ id, total: id * 10 }) },
    })),
    { concurrency: 2 },
  );
  console.log(`batch ok=${settled.filter((item) => item.ok).length}`);

  // Markup straight to a Buffer; extraArgs passes flags a newer Typst added
  // before this package supports them (here an existing flag, for the demo).
  const buffer = await pdf(source("= From memory"), {
    extraArgs: ["--diagnostic-format", "short"],
  });
  console.log(`buffer bytes=${buffer.length}`);

  const { elements } = await query(template, "heading", {
    inputs: { data: jsonInput({ id: 4, total: 0 }) },
  });
  console.log(`headings=${elements.length}`);
} finally {
  if (created) await rm(outDir, { recursive: true, force: true });
}
