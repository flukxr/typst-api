// Standalone compile script run inside the Docker image. The API discovers the
// Typst binary placed on PATH by the Dockerfile; no download happens at runtime.
import { createTypst } from "@flukxr/typst-api";

const typst = await createTypst();
const result = await typst.compile("/work/main.typ", "/work/main.pdf");
console.log(`compiled ${result.outputs[0].path}`);
