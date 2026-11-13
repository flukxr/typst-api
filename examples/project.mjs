// Compiles a multi-file project held entirely in memory: an entry file, an
// imported module and an image, without writing anything yourself.
import { createTypst } from "@flukxr/typst-api";

// A 1x1 PNG; in real code read it with fs.readFile or fetch it.
const logo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const typst = await createTypst();
// The entry file defaults to main.typ; pass `main` to use another one.
const pdf = await typst.pdf({
  kind: "project",
  files: {
    "main.typ": [
      '#import "template.typ": report',
      '#show: report.with(title: "Quarterly report")',
      '#image("assets/logo.png", width: 1cm)',
      "All figures are preliminary.",
    ].join("\n"),
    "template.typ": [
      "#let report(title: none, body) = {",
      "  set document(title: title)",
      "  heading(title)",
      "  body",
      "}",
    ].join("\n"),
    "assets/logo.png": logo,
  },
});
console.log(`project pdf bytes=${pdf.length}`);
