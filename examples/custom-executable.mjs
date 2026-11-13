// Uses an explicit Typst executable instead of executable discovery.
// Pass the path as the first argument or set TYPST_EXECUTABLE.
import { createTypst, source } from "@flukxr/typst-api";

const executable = process.env.TYPST_EXECUTABLE ?? process.argv[2];
if (!executable) {
  console.error("usage: node examples/custom-executable.mjs <path-to-typst>");
  console.error("       or set the TYPST_EXECUTABLE environment variable");
  process.exit(2);
}

const typst = await createTypst({ executable });
const { version } = await typst.version();
const pdf = await typst.pdf(source("= Hello"));

console.log(`executable=${typst.executable}`);
console.log(`executableSource=${typst.executableSource}`);
console.log(`version=${version}`);
console.log(`bytes=${pdf.length}`);
