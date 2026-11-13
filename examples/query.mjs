// Extracts heading elements from a document with query().
import { createTypst, source } from "@flukxr/typst-api";

const typst = await createTypst();
const { elements } = await typst.query(
  source("= First heading\n#pagebreak()\n== Second heading"),
  "heading",
);

for (const element of elements) {
  console.log(
    `found ${element.func} level=${element.level} body=${JSON.stringify(element.body)}`,
  );
}
console.log(`matched=${elements.length}`);
