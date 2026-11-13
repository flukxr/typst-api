// Compiles HTML from Typst 0.13.0+; the html feature flag is implied.
import { createTypst, source } from "@flukxr/typst-api";

const typst = await createTypst();
const html = await typst.html(source("= Hello HTML"));
console.log(`format=html bytes=${Buffer.byteLength(html)}`);
