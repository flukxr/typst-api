// Watches a file, waits for the initial compile cycle, then closes cleanly.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTypst } from "@flukxr/typst-api";

let created = false;
const outDir =
  process.env.TYPST_EXAMPLES_DIR ??
  ((created = true), await mkdtemp(join(tmpdir(), "typst-api-example-")));

const typst = await createTypst();
try {
  const source = join(outDir, "document.typ");
  await mkdir(outDir, { recursive: true });
  await writeFile(source, "= Hello");

  const watcher = await typst.watch({
    input: source,
    output: join(outDir, "out.pdf"),
  });
  try {
    // `ready` resolves with the first compile cycle; bound the wait because
    // cycle detection is best effort.
    const ready = await Promise.race([
      watcher.ready,
      delay(15_000, undefined, { ref: false }).then(() => {
        throw new Error("watch never reported ready");
      }),
    ]);
    console.log(`initial cycle status=${ready.status} index=${ready.index}`);
  } finally {
    const result = await watcher.close();
    console.log(`closed exitCode=${result.exitCode} signal=${result.signal}`);
  }
} finally {
  if (created) await rm(outDir, { recursive: true, force: true });
}
