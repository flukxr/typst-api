// Compiles a multi-file bundle (Typst 0.15.0+) into memory.
import { createTypst, source } from "@flukxr/typst-api";

const typst = await createTypst();
const { outputs } = await typst.compile({
  input: source(
    '#document("index.html", title: [Home])[= Hello from a bundle]',
  ),
  format: "bundle", // implies the bundle feature flag
  features: ["html"], // the bundle contains an HTML document
});

for (const output of outputs) {
  console.log(`${output.relativePath} bytes=${output.data.length}`);
}
