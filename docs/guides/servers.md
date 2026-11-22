# Running on a server

Every call starts a new `typst` process. For a small document most of that
time is not compiling: the compiler starts, then scans the fonts installed on
the system. A server that renders many documents can skip the scan.

## Fonts: the main cost

Typst reads the system font directories on every start. Give it the fonts the
documents need and turn the scan off:

```js
import { createTypst } from "@flukxr/typst-api";

const typst = await createTypst({
  defaults: {
    fontPaths: ["./fonts"],
    ignoreSystemFonts: true,
  },
});
```

`ignoreSystemFonts` is available from Typst 0.12.0. The fonts embedded in the
compiler stay available unless `ignoreEmbeddedFonts` is set too.

This also makes output the same on every machine: a document can no longer
pick up a font that happens to be installed on one host and missing on
another.

Measured with `pdf()` on a two-line document, median of 21 calls (Typst
0.15.1, Windows 11 x64, Node 26):

| Defaults                  | Time per call |
| ------------------------- | ------------- |
| none                      | 112 ms        |
| `ignoreSystemFonts: true` | 37 ms         |

The gain depends on how many fonts the host has installed. A container with
few fonts gains less; measure on the target host before relying on a number.

## Many documents

`compileMany()` runs several processes at once with a bound on concurrency
(see [Many documents](../../README.md#many-documents)). Keep the concurrency
at or below the number of cores: Typst itself also uses several threads for
one large document.

## The executable

Pin the compiler so that every host renders with the same release, either
with the launcher package (`npm install @flukxr/typst-cli@typst-0.15.1`) or
with an explicit `executable` path. Pass `verifyExecutable: true` to reject a
wrong binary when the client is created rather than on the first request. The
[Docker example](../../examples/docker/) pins a release with a checksum.

## Wrapper overhead

The wrapper itself adds about 2 ms per call compared with starting the same
process directly (`npm run bench`, baseline in
[`benchmarks/baselines.json`](../../benchmarks/baselines.json)).
