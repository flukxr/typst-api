# Changelog

All notable changes to `@flukxr/typst-api` are documented here, based on
[Keep a Changelog](https://keepachangelog.com/). Package SemVer is
independent from Typst coverage, and exact Typst patch releases remain
separate compatibility checkpoints.

## [Unreleased]

## [1.0.1] - 2026-11-22

### Fixed

- `watch()` now inherits the client-level `diagnostics` and `onLog`
  defaults, like every other command. Options passed to `watch()` still win.
- A `for await` iterator over a watcher that is not reading keeps at most the
  last 64 cycles, the same bound as cycles reported before the first
  iterator. The oldest are dropped first; `cycle.index` shows the gap.
- `require("@flukxr/typst-api")` no longer fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`: the export map has a `default` condition,
  so CommonJS code loads the package on Node versions with `require(esm)`.

### Documentation

- The README states that executable discovery stops at the first configured
  source, and a new guide, `docs/guides/servers.md`, covers rendering many
  documents: font scanning, concurrency and pinning.

## [1.0.0] - 2026-11-13

First public release. The public contract is frozen in
`spec/public-api.d.ts`.

### Added

- `createTypst()` client with executable discovery (explicit path, the
  optional `@flukxr/typst-cli` launcher, `TYPST_PATH`, `PATH` with Windows
  `PATHEXT`) and opt-in `verifyExecutable` probing.
- High-level commands: `compile`, `query`/`queryOne`, `watch`, `eval`,
  `fonts`, `init`, `info`, `completions`, and `diagnose`, plus the raw
  `run(args)` escape hatch for any CLI surface.
- Format shortcuts `pdf()`, `png()`, `svg()` and `html()` that return a
  `Buffer` or string directly, `source()` for in-memory markup, and an early,
  explanatory error when markup is passed where a file path is expected.
- `compileMany()` with bounded parallelism that settles every job in order.
- `jsonInput()` to pass structured data through `sys.inputs`.
- Positional `compile(input, output, options)` mirroring
  `typst compile <input> <output>`, `query(input, selector, options)`/
  `queryOne(...)`, and a single-object `eval({ expression, ... })` form.
- `warnings` on every successful compile, query and eval result.
- Module-level `compile`, `compileMany`, `pdf`, `png`, `svg`, `html`, `query`,
  `queryOne`, `watch` and `fonts` backed by a shared client, with
  `configure()` and `defaultClient()`.
- `extraArgs` on every high-level command for flags of newer Typst releases.
- Open `PdfStandard` and `TypstFeature` types: known values autocomplete and
  newer ones still type-check; unknown feature names pass to the compiler.
- File and in-memory I/O: files, source strings, or multi-file projects held
  in memory (`{ kind: "project", files }`, with `#import` and `#image`
  resolving between the files) in; Buffers, files, or multi-file bundles out.
  `compile()` overloads narrow the result type by statically known
  destination and format.
- `TypstWorldOptions`, one set of project options (`root`, `inputs`,
  `fontPaths`, `ignoreSystemFonts`, `ignoreEmbeddedFonts`, `packagePath`,
  `packageCachePath`, `creationTimestamp`, `jobs`, `features`) shared by
  `compile`, `query`, `eval` and `watch`, and client-level `defaults` for them.
- The `html` and `bundle` feature flags are implied by html/bundle output or
  targets.
- Output helpers `isMemoryOutput`, `isFileOutput`, `expectSingleOutput`, and
  `expectSingleMemoryOutput`.
- Typed result generics on `query`, `queryOne`, `eval`, and `info`.
- Exact-version capability registry covering every stable Typst release from
  `0.1.0` through `0.15.1`, backed by per-release binary snapshots and
  cross-platform sweep evidence (Windows x64, Linux x64/arm64, macOS arm64).
  The registry ships as data and can be overridden with
  `TYPST_API_CAPABILITY_REGISTRY`.
- `version()`, `support()`, and `capabilities()` introspection; unknown
  compiler versions are rejected by default, with an explicit
  `unknownVersionPolicy: "assume-latest-known"` opt-in.
- A `TypstError` hierarchy with a closed `TypstErrorCode` union; every process
  failure carries the raw stdout/stderr, exit code, and signal. Opt-in
  structured diagnostics are parsed from stderr on a best-effort basis.
- A discriminated `TypstLogEvent` union for the redaction-safe `onLog` hook.
- Long-lived `watch()` sessions with typed lifecycle events, a `ready`
  promise for the first compile cycle, `for await` iteration over cycles, abort/timeout support, async disposal,
  and bounded output capture (1 MiB per stream by default, with truncation
  flags and total byte counts). Watch processes never outlive the Node.js
  process that started them.
- `RunOptions.stdio` for the low-level process runner.
- Runnable examples, including GitHub Actions and Docker setups.

### Fixed

- Structured diagnostics, `warnings` and error-message hints are parsed on
  Typst `0.1.0`–`0.4.0`, which color their stderr even when it is not a
  terminal.

### Security

- Typst is always spawned with `shell: false`; paths and values are passed as
  separate arguments.
- No runtime binary downloads and no install scripts.
- Package-owned temporary files are removed on success, failure, timeout, and
  abort.
- On Windows only `.exe`/`.com` executables are accepted, because batch
  scripts cannot be started without a shell; discovery skips npm's
  `typst.cmd` shims and keeps searching `PATH` for a real `typst.exe`.
- Page-per-file PNG/SVG output and file bundles are staged privately and moved into the
  destination only after a successful compile; unrelated files are never
  deleted.

[Unreleased]: https://github.com/flukxr/typst-api/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/flukxr/typst-api/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/flukxr/typst-api/releases/tag/v1.0.0
