# `@flukxr/typst-api`

[![npm](https://img.shields.io/npm/v/@flukxr/typst-api.svg)](https://www.npmjs.com/package/@flukxr/typst-api)
[![CI](https://github.com/flukxr/typst-api/actions/workflows/ci.yml/badge.svg)](https://github.com/flukxr/typst-api/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/@flukxr/typst-api.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A typed, version-aware Node.js API over the native Typst CLI.

This project is not affiliated with or endorsed by Typst GmbH.

Compile, query, watch, and evaluate Typst documents from Node.js with a frozen
TypeScript contract, exact-version capability checks, and raw process evidence
on every result and error. The package does not bundle or download Typst: it
discovers an installed executable and talks to it directly.

Verified against every stable Typst release from `0.1.0` through `0.15.1` on
Windows x64, Linux x64/arm64, and macOS arm64.

## Installation

Requires Node.js 20 or newer.

```sh
npm install @flukxr/typst-api
```

You also need a Typst executable. The simplest way is the launcher package,
which pins an exact compiler release:

```sh
npm install @flukxr/typst-cli@typst-0.15.1
```

Alternatively, provide one explicitly, set `TYPST_PATH`, or install Typst on
`PATH` — see [Executable discovery](#executable-discovery).

## Quick start

```js
import { createTypst, source } from "@flukxr/typst-api";

const typst = await createTypst();

// Typst markup → PDF Buffer. A plain string is a file path; wrap markup in
// source().
const pdf = await typst.pdf(source("= Hello"));

// A file → one PNG Buffer / SVG string per page, or an HTML string.
const pngs = await typst.png("main.typ", { ppi: 144 });
const svgs = await typst.svg("main.typ");
const html = await typst.html("main.typ"); // the html feature is implied

// File to file, like `typst compile main.typ out.pdf`, with the full result.
const result = await typst.compile("main.typ", "out.pdf");

// Query the document; warnings from a successful run are parsed for you.
const { elements, warnings } = await typst.query("main.typ", "heading");
```

### Without a client

For scripts, the same calls exist as plain functions backed by one shared
client, created on first use. `configure()` sets its options and may be called
at any point; use `createTypst()` when you need several independent clients.

```js
import { compile, configure, pdf, query, source } from "@flukxr/typst-api";

configure({ defaults: { fontPaths: ["./fonts"] } }); // optional

await compile("main.typ", "out.pdf");
const buffer = await pdf(source("= Hello"));
const { elements } = await query("main.typ", "heading");
```

### A multi-file project in memory

Imports and images resolve between the files; nothing has to be written to
disk by you, and the temporary project is removed afterwards.

```js
import { readFile } from "node:fs/promises";

const pdf = await typst.pdf({
  kind: "project",
  files: {
    "main.typ": '#import "template.typ": report\n#show: report\n= Q3',
    "template.typ": '#let report(body) = { set page(numbering: "1"); body }',
    "assets/logo.png": await readFile("logo.png"),
  },
});
```

### Shared defaults

Project options (`root`, `inputs`, `fontPaths`, `ignoreSystemFonts`,
`packagePath`, `creationTimestamp`, …) can be set once per client; a command
option always wins and `inputs` are merged.

```js
const typst = await createTypst({
  defaults: {
    fontPaths: ["./fonts"],
    ignoreSystemFonts: true, // deterministic output across machines
    inputs: { lang: "en" },
  },
});
```

### Structured inputs

`sys.inputs` only carries strings. `jsonInput()` encodes any JSON value and
the document decodes it with `json(bytes(...))`:

```js
import { jsonInput } from "@flukxr/typst-api";

await typst.pdf("invoice.typ", { inputs: { data: jsonInput(invoice) } });
// invoice.typ: #let invoice = json(bytes(sys.inputs.data))
```

### Many documents

`compileMany()` runs compiles with bounded parallelism and never rejects for a
single failed document:

```js
const settled = await typst.compileMany(
  invoices.map((invoice) => ({
    input: "invoice.typ",
    output: `out/${invoice.id}.pdf`,
    inputs: { data: jsonInput(invoice) },
  })),
  { concurrency: 4 },
);
for (const item of settled) {
  if (!item.ok) console.error(item.error.code, item.error.message);
}
```

### Newer Typst flags

Every high-level call accepts `extraArgs`: raw CLI arguments passed without
validation, for a flag a newer Typst added before this package supports it.
`PdfStandard` and `TypstFeature` are open types, so new standards and feature
names type-check as well.

```js
await typst.compile("main.typ", "out.pdf", { extraArgs: ["--new-flag"] });
```

### Watching

```js
const watcher = await typst.watch({ input: "main.typ", output: "out.pdf" });
await watcher.ready; // resolves with the first compile cycle
for await (const cycle of watcher) {
  console.log(cycle.index, cycle.status); // every cycle, including the first
}
```

## Typed usage

TypeScript consumers get inference without casts for the canonical paths:

```ts
import {
  createTypst,
  expectSingleMemoryOutput,
  source,
} from "@flukxr/typst-api";

const typst = await createTypst();

// A memory-output compile (the default) resolves to exactly one Buffer.
const { outputs } = await typst.compile({
  input: source("#set page(width: 10cm)\nHello"),
});
const pdf: Buffer = outputs[0].data;

// Or assert the single output at runtime for dynamic option objects:
const bytes = expectSingleMemoryOutput(
  await typst.compile({ input: "main.typ" }),
).data;

// Query elements and eval results with your own shapes:
const headings = await typst.query<{ level: number; body: string }>({
  input: "main.typ",
  selector: "heading",
});
const stats = await typst.eval<{ pages: number }>("(pages: 1)");
```

The generics on `query`/`queryOne`/`eval`/`info` are consumer assertions: the
package decodes JSON but does not validate your schema — the raw text stays on
the result and the raw stderr stays on every error. `compile()` narrows
statically known destinations: file destinations produce `CompileFileOutput`
entries and memory destinations produce `CompileMemoryOutput` entries; a single
result is guaranteed only for PDF/HTML, while PNG, SVG and bundle legitimately
produce several. Use `isMemoryOutput`/`isFileOutput`/`expectSingleOutput` when
the destination kind is not statically known.

## Key features

- **One API for every Typst version** — a single stable client that selects
  behavior from an evidence-backed capability registry instead of hard-coded
  version branches.
- **Full command surface** — `compile`, `query`/`queryOne`, `watch`, `eval`,
  `fonts`, `init`, `info`, `completions`, and `diagnose`, plus a raw
  `run(args)` escape hatch for anything new.
- **Short paths for common work** — `pdf()`, `png()`, `svg()` and `html()`
  return a `Buffer` or string directly; `compile()` keeps the full result.
- **File or in-memory I/O** — files, source strings, or whole multi-file
  projects in memory; Buffers, files, or multi-file bundles out.
- **Shared project defaults** — one place for fonts, inputs, roots and
  packages across `compile`, `query`, `eval` and `watch`.
- **Typed errors and diagnostics** — a `TypstError` hierarchy with a closed
  `TypstErrorCode` union and the raw process record attached, plus opt-in
  structured diagnostics parsed from stderr.
- **Raw output preserved** — stdout/stderr, exit code, signal, and duration
  are retained byte-for-byte for buffered commands. `watch()` is long-lived, so
  its final record keeps a bounded tail (1 MiB per stream by default) and
  reports `stdoutTruncated`/`stderrTruncated` plus total byte counts; the
  `output` event still delivers every chunk.
- **Safe process handling** — `spawn` with `shell: false`, no runtime binary
  downloads, no install scripts, temp-artifact cleanup on every exit path.

## Executable discovery

`createTypst()` finds a Typst executable in this order:

1. an explicit `executable` option;
2. the optional `@flukxr/typst-cli` launcher package, when installed;
3. the `TYPST_PATH` environment variable;
4. `PATH` (with Windows `PATHEXT` support).

`discoverTypstExecutable()` exposes the same logic directly, and the
`TypstExecutable*Error` family reports exactly what went wrong (not found, not
a file, not executable, version mismatch, …). `@flukxr/typst-cli` is a
convenience, not a requirement — any compatible executable works.

Discovery validates that the resolved path is a regular, executable file but
does not run it by default, so a non-Typst executable is only rejected at the
first call. Pass `createTypst({ verifyExecutable: true })` to probe the
resolved executable with `--version` at client creation and reject anything
that does not report a single exact stable Typst compiler version. The optional
launcher package is always verified against its declared version.

## Version-aware behavior

Typst patch releases are real compatibility checkpoints: `0.15.0` and
`0.15.1` differ. The capability registry records each command, format, and
option with exact `since` / `deprecatedIn` / `removedIn` boundaries and
behavior changes, backed by per-release binary snapshots and cross-platform
sweep evidence.

- `client.version()` reports the exact compiler version;
- `client.support()` reports the support level and coverage, including
  `fullySupportedThrough` — advanced only on hosts with committed sweep
  evidence;
- `client.capabilities()` reports per-feature state
  (`supported` / `unsupported` / `experimental` / `unknown`);
- unknown future versions stay conservative by default: capabilities report
  `unknown`, `run()` remains available, and nothing silently inherits a nearby
  version.

When a compiler version is absent from the release inventory, high-level
commands (`compile`, `watch`, `query`, `eval`, `fonts`, `info`, `init`,
`completions`) reject the call with `UnsupportedTypstVersionError` by default.
Set `createTypst({ unknownVersionPolicy: "assume-latest-known" })` to instead
apply the rules of the nearest known version that is not newer than the
detected one. This is an explicit opt-in for newly released compilers; it never
raises the reported support level (`support().level` stays `"unknown"` for the
new version) and `diagnose().issues` includes `ASSUMED_VERSION_RULES` so the
assumption stays visible.

## Typed errors and diagnostics

Every failure is an instance of `TypstError` with a machine-readable `code`
from the closed `TypstErrorCode` union, so a `switch` over it can be checked
for exhaustiveness.
Command failures are typed (`TypstCompilationError`, `TypstFontsError`,
`TypstQueryError`, …) and always carry the raw `error.process` record —
stdout, stderr, exit code, and signal. Request structured diagnostics with
`diagnostics: true` in any run or command option to attach a best-effort
parsed view (severity, spans, hints) while raw stderr stays authoritative.
`client.diagnose()` produces a single report of executable source, version,
support, capabilities, host, and issues.

## Examples and documentation

Runnable examples live in [`examples/`](examples/) and import the package by
name, so they work both in this repository (after `npm run build`) and when
copied into a consumer project:

| Example                              | Demonstrates                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `examples/compile-file.mjs`          | file input to a PDF file on disk                                                                       |
| `examples/compile-source-buffer.mjs` | markup string to a PDF Buffer with `source()` and `pdf()`                                              |
| `examples/custom-executable.mjs`     | explicit executable instead of discovery                                                               |
| `examples/watch.mjs`                 | managed watcher lifecycle (`ready`, `close`)                                                           |
| `examples/query.mjs`                 | querying heading elements with `query(input, selector)`                                                |
| `examples/html.mjs`                  | HTML compilation with the `html()` shortcut                                                            |
| `examples/bundle.mjs`                | multi-file bundle output                                                                               |
| `examples/scripting.mjs`             | module functions, `configure()`, `compile(input, output)`, `jsonInput()`, `compileMany()`, `extraArgs` |
| `examples/project.mjs`               | multi-file project (imports, images) held in memory                                                    |
| `examples/ci/`                       | GitHub Actions workflow + compile script for consumer projects                                         |
| `examples/docker/`                   | Docker image pinning an exact Typst release with a checksum                                            |

Documentation:

| Doc                                                                                      | Contents                                                         |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`docs/reference/api-contract.md`](docs/reference/api-contract.md)                       | The frozen public API contract                                   |
| [`docs/reference/versioning-and-coverage.md`](docs/reference/versioning-and-coverage.md) | Package SemVer and the exact historical coverage guarantee       |
| [`docs/guides/troubleshooting.md`](docs/guides/troubleshooting.md)                       | Common issues: discovery, Windows shims, version gates           |
| [`docs/guides/upgrading-typst.md`](docs/guides/upgrading-typst.md)                       | Moving between Typst releases and package versions               |
| [`docs/guides/package-managers.md`](docs/guides/package-managers.md)                     | npm, pnpm, and Yarn behavior and dist-tag pinning                |
| [`CHANGELOG.md`](CHANGELOG.md)                                                           | Release notes                                                    |
| [`docs/maintainers/`](docs/maintainers/)                                                 | Maintainer material: release process, decisions, evidence policy |

## Development

```sh
npm ci
npm run verify      # clean + lint + unit tests + freeze + consumer types
npm run package:smoke
```

Contributions, including how to add support for a new Typst release, are
described in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

The threat model is documented in [`SECURITY.md`](SECURITY.md). In short: no
shell, no runtime binary downloads, no install scripts, paths passed as
arguments, and package-owned temp files always cleaned up. Report
vulnerabilities privately via GitHub security advisories.

## License

MIT — see [`LICENSE`](LICENSE).
