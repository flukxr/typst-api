# Accepted decisions

This is a chronological log of design decisions. Later sections supersede
earlier ones; entries replaced before the first release are marked
**Superseded**. The two `1.0.0` sections at the end describe the current
behavior, and [`api-contract.md`](../reference/api-contract.md) is the
user-facing reference.

## Packages

- Keep `@flukxr/typst-cli` as the binary distribution and launcher.
- Build a separate `@flukxr/typst-api` high-level wrapper.
- The API package accepts any compatible Typst executable; the launcher package is only one discovery source.

## Versioning

- `@flukxr/typst-api` uses independent SemVer.
- Typst coverage is exposed separately.
- Exact patch versions are first-class coverage and test records.
- Packaging revisions such as `0.15.1-npm.2` are not Typst versions.

## Public API direction

Core:

```text
createTypst, version, support, capabilities, run
```

Compilation:

```text
compile
```

`compile()` accepts a discriminated file-or-source input and a discriminated
file-or-memory destination. An omitted destination means memory. Ordered
`outputs` represent both single-output and multi-page compilation, so separate
buffer/page methods would only be aliases. **Superseded in 1.0.0:** the
`pdf()`/`png()`/`svg()`/`html()` shortcuts return the value directly.

Later:

```text
watch, fonts, query, queryOne, init, dependencies, info, completions, eval
```

## Compatibility

- One stable high-level API, not one public class per Typst release.
- Declarative capability registry plus small compatibility strategies.
- `query()` uses the native query command on `0.7.0`–`0.14.2` (there is no
  query before `0.7.0`) and an
  eval-based query from exact `0.15.0`.
- `run(args)` is the escape hatch.
- `update()` is intentionally absent/blocked at the high level.

## Runtime

- No binary download.
- No shell.
- Raw output retained.
- Unknown future versions are not globally rejected: `run()` and the
  introspection methods keep working. **Superseded in 1.0.0** for high-level
  commands, which reject unknown versions unless
  `unknownVersionPolicy: "assume-latest-known"` is set.

## M0.5 API review

The review gate was resolved on 2026-08-01 with the following decisions.

### Raw process failures

- `run()` resolves after every successfully spawned process that reaches a
  natural exit, including non-zero exit codes and signal exits.
- A spawn failure, timeout, or abort throws a typed process error. The error
  carries the normalised process record, including any stdout/stderr collected
  before failure or termination.
- High-level commands interpret unsuccessful exits and throw their command
  error type. Compilation uses `TypstCompilationError`.
- The same first-terminal-event rule applies to natural exit, timeout, and
  abort. Once timeout or abort wins, a later exit does not turn the operation
  into success.
- `RunOptions.stdio` is a low-level escape hatch for pipe, ignore, inherit, file
  descriptor, or caller-provided stream wiring. Only piped streams are captured
  in the result record, logged as chunks, or parsed for diagnostics. Supplying
  stdin bytes with a non-pipe stdin is rejected before spawn. High-level command
  options omit `stdio` because their output contracts depend on the piped
  streams.

### Capability uncertainty

- Command, format, and option maps contain `TypstCapability` descriptors rather
  than booleans.
- Capability state is `supported`, `unsupported`, `experimental`, or `unknown`.
  Known absence is `unsupported`; lack of evidence is `unknown`.
- Descriptors retain exact stable boundaries and behavior changes. The overall
  result exposes verified registry metadata and, when requested, the raw
  runtime help probe.
- An unknown compiler version never inherits the nearest known version.
  **Superseded in 1.0.0:** callers may opt in with
  `unknownVersionPolicy: "assume-latest-known"`.

### Compilation

- M1 exposes one compilation method: `compile(options)`. **Superseded in
  1.0.0:** the positional `compile(input, output)` form and the
  `pdf()`/`png()`/`svg()`/`html()` shortcuts were added.
- Input is discriminated as `{ kind: "file", path }` or
  `{ kind: "source", data, virtualPath? }`.
- Output is discriminated as `{ kind: "file", path }` or `{ kind: "memory" }`.
  If omitted, output defaults to memory.
- Result outputs are also discriminated, so a result never ambiguously contains
  both `path` and `data`.
- `outputs` is always ordered. Page numbers are attached when the selected
  format produces separate page artifacts; no separate `compilePages()` API is
  needed.
- Explicit `format` wins. For file output, an omitted format is inferred from a
  recognized destination extension. For memory output, an omitted format means
  PDF. Failure to infer a supported format throws `TypstInvalidArgumentError`
  before spawn.
- In-memory PDF streams through positional stdout from exact `0.12.0`. In-memory
  PNG/SVG use stdout only for a single-page result; a multiple-image stdout
  failure is retried through temporary page files. The retry is deliberately
  narrow: unsuccessful natural exit, empty stdout, and the exact documented
  `error: cannot export multiple images to stdout` line. Any other failure keeps
  its original process record and is surfaced immediately. If upstream changes
  the wording, the wrapper stops retrying rather than double-running arbitrary
  failing documents; raw stderr remains authoritative.

### Environment

- `env` merges by default.
- At client creation, merge starts with `process.env`; client values override
  inherited values.
- At command invocation, merge starts with the client's effective environment;
  invocation values override client values.
- `envMode: "replace"` explicitly replaces the environment at its layer. An
  `undefined` value removes that key rather than serializing it.

### Abort, timeout, and process trees

- Typst is always spawned directly with `shell: false`.
- On POSIX, the runner uses an isolated process group and terminates the group.
  On Windows, it requests tree termination without constructing a shell command
  and falls back to terminating the direct child.
- Timeout and abort first request graceful termination, wait
  `terminationGraceMs` (1,000 milliseconds by default), then request forced
  termination. Tree cleanup remains best effort because the operating system
  may deny access or descendants may escape the group.
- The runner settles once, preserves termination metadata, and performs
  temporary-artifact cleanup after every success or failure path.

## M3 — Modern compilation and project workflows

### Dependency lists

- Dependency generation lives on `compile()` as `depsPath`/`depsFormat`; a
  separate `dependencies()` method is not added because it would only be an
  alias of compile plus parsing.
- Before `0.14.0` only the Makefile form (`--make-deps`) exists, so
  `depsFormat` must be omitted or `"make"`. From `0.14.0` the modern
  `--deps`/`--deps-format` flags are used with `json` (default), `zero`, and
  `make`.
- `depsPath: "-"` streams to stdout and requires a file output destination; the
  compiler rejects output and dependencies on the same stdout.
- The raw dependency content is returned as `dependencies.data` (a Buffer) with
  `path` set when a real file was written. The `zero` format is binary, so the
  content is never decoded to a string losslessly.
- `--make-deps` is gated at exact `0.12.0` and `--deps`/`--deps-format` at exact
  `0.14.0` in the capability registry.

### Init

- `init()` runs `typst init <TEMPLATE> [DIR]` from exact `0.11.0`;
  `--package-path`/`--package-cache-path` are gated at `0.12.0`.
- Safe destination handling is explicit: a provided `directory` is resolved
  against the effective cwd and a pre-existing destination throws
  `TypstInitConflictError` before spawn, because the compiler refuses to
  overwrite a project directory.
- When `directory` is omitted the compiler derives it from the template's
  package name, so no pre-spawn conflict check is possible; a conflicting
  destination surfaces as `TypstInitError` with the raw process record.
- Unsuccessful exits always throw `TypstInitError` carrying the raw evidence.

### Scale behavior

- The runner must preserve byte-for-byte large stdout/stderr and deliver large
  stdin with backpressure; no per-chunk reprocessing or unbounded parent-heap
  growth is acceptable.
- Concurrent compiles on one client must be isolated: distinct temporary scope
  roots, deterministic ordered page outputs, and no shared mutable state.
- Concurrent `version()`/`support()`/`capabilities()` probes share a single
  spawn and settle once.

## M4 — HTML and tooling

### Experimental HTML

- HTML output remains visibly experimental: `formats.html` is marked
  experimental and requires the `html` feature flag from exact `0.13.0`; a
  missing feature is rejected before spawn with `UnsupportedTypstFeatureError`.
- `--pretty` (HTML/SVG/PDF) is gated at exact `0.15.0`; `--no-pdf-tags` is
  gated at exact `0.14.0`.
- HTML minification by default upstream from `0.15.0` is an upstream display
  behavior; the wrapper does not reflow or interpret generated HTML.

### HTML watch server

- The watch server options `noServe`, `noReload`, and `port` are gated at exact
  `0.13.0` and require HTML output; they are rejected before spawn otherwise.
- The server startup message and URL are human log output, not a stable machine
  protocol. `output`/`ready` events deliver the raw text without pretending to
  parse it into a server contract.

### Info and completions

- `info()` returns the raw `typst info` text as the stable result; with
  `format: "json"` the output is also decoded into `data`, but `raw` remains
  authoritative. The human-readable report truncates the build commit hash;
  that truncation is never used as structured data.
- `completions(shell)` passes the shell name as a single positional argument
  for bash, elvish, fish, powershell, and zsh from exact `0.14.0`. The script
  text is the stable result; the caller passes it to the shell.
- Unsuccessful exits throw `TypstInfoError`/`TypstCompletionsError` with the
  raw process record.

## M5 — Eval, bundle, and unified query

### Eval

- `eval(expression, options?)` runs `typst eval <EXPRESSION>` from exact
  `0.15.0`. The expression is a single positional argument evaluated in code
  mode with no scope. An optional `input` is staged through `--in` (stdin for
  source input from `0.11.0`, temporary file otherwise).
- The `0.15.1` failure-exit transition is handled without parsing diagnostics:
  a successful eval always serializes a value, so an exit-`0` run with empty
  stdout is a failure on `0.15.0`; from `0.15.1` the compiler exits `1` and the
  normal unsuccessful-exit path applies. Both produce `TypstEvalError` with the
  raw process record.
- `format: "json"` (default) decodes `value` from the raw output;
  `format: "yaml"` retains `raw` only because no guaranteed YAML decoder exists.
  Undecodable JSON throws `TypstEvalParseError` with the raw output.
- The `html`/`bundle` eval targets require the corresponding feature flag and
  are rejected before spawn when it is missing.

### Bundle

- Bundle output is experimental from exact `0.15.0` and always requires the
  `bundle` feature flag; omitting it is rejected before spawn. A bundle is a
  multi-file directory, so a file destination path is the bundle root and
  memory output compiles into a temporary root that is read back before
  cleanup. Bundle cannot be written to stdout.
- The result model extends the discriminated `CompileOutput` entries with a
  forward-slash `relativePath` to the bundle root and a best-effort per-file
  media type derived from the file extension. Files are sorted for
  deterministic ordering.

### Unified query

- `query()`/`queryOne()` keep one public contract while the backend is
  internal and version-selected: native `typst query` through `0.14.2` and
  `typst eval query(<SELECTOR>) --in <INPUT>` with JavaScript normalisation
  from `0.15.0`, following the upstream deprecation hint verbatim.
- The selector is already a Typst expression (native query evaluates it in code
  mode), so the wrapper wraps it in `query(...)` rather than quoting it.
- JavaScript normalisation applies the public semantics that native query used
  to enforce in the compiler: `field` extraction keeps only the elements that
  carry the field, and `queryOne` requires exactly one match. An exactly-one
  violation throws `TypstQueryError` carrying the raw eval process record,
  which on `0.15.x` legitimately exited `0`; the wrapper does not invent a
  failure exit code.
- Equivalent public results (elements/element and raw JSON) are tested across
  the backend boundary, including the `0.15.0` exit-`0` eval failure detection
  and the `--field`/`--one` semantics.

### Multiple PDF standards

- From exact `0.15.0` several PDF standards may be requested together as
  comma-separated `--pdf-standard` values; the compiler validates that the
  combination is conformable. Single standards exist from `0.12.0`.

## M6 — Full historical and cross-platform coverage

- `coverage.testedVersions` reports the exact versions whose high-level API
  passed the committed sweep on the current host's platform/arch only; other
  hosts stay conservative and report none. The sweep records `tested`,
  `failed`, or `unavailable` per version, never inferred.
- `fullySupportedThrough` advances only across a contiguous exact-version range
  swept end to end for all high-level methods and relevant behaviors. It is
  reported as `0.15.1` on hosts with committed sweep evidence (`win32`/`x64`,
  `linux`/`x64`, `linux`/`arm64`, `darwin`/`arm64`) because the sweep covers the
  `watch` lifecycle and the behavior probes cover TTY/color and
  dependency-output regressions; other hosts report `null`.
- Behavior probes are exact-version CLI probes that retain raw stdout/stderr
  and exit metadata under `<corpus>/<version>/behavior/`, where `<corpus>` is
  the `flukxr/typst-snapshots` repository. Probes that do not
  apply to a version are recorded as `not-applicable`, and version-dependent
  option placement (such as `--root` before and after `0.7.0`) is handled per
  exact version. The probe runner accepts `--snapshot-root` so a platform
  runner can collect evidence into a dedicated root. All snapshot scripts
  resolve the corpus root through `scripts/snapshot-root.mjs`, which accepts
  an explicit override, the `TYPST_API_SNAPSHOT_ROOT` environment variable, or
  a sibling `typst-snapshots` checkout. The corpus was extracted to its own
  repository (`flukxr/typst-snapshots`) so the API repository keeps
  only tooling and the runtime seed; it is never consumed at runtime and ships
  in no package.
- The high-level sweep runner accepts `--out` so a platform runner writes
  per-platform evidence under `data/sweep/<platform>-<arch>.json`; every
  committed per-platform file is validated as build input. Cross-platform
  evidence is collected by `.github/workflows/sweep.yml` on Linux, Windows,
  macOS, and ARM64 runners and uploaded as an artifact for review and commit.
  It never auto-commits evidence and never marks a release supported.
- The upstream watcher reports new exact stable releases and, in prepare mode,
  produces the inventory/snapshot/review data-update change. It never marks a
  release supported automatically; new releases land in `pending-review`.
  **Superseded in 1.0.0:** the nightly CI job runs the prepare-mode watcher
  and opens review pull requests in this repository and in the snapshot
  corpus; nothing is merged or marked supported automatically.
- CI runs unit tests on Node 20, 22, and 24 and the real-executable integration
  suite on Windows, Linux, and macOS. The suite resolves
  `@flukxr/typst-cli` as a development dependency by launcher path, because the
  npm `.cmd` shim on Windows cannot be spawned with `shell: false`.

## M7 — Developer experience and operations

### Opt-in structured diagnostics

- Structured diagnostics are opt-in per invocation via
  `diagnostics: true` in `RunOptions` (and therefore on every high-level
  command). When disabled the result shape is unchanged.
- The structured view is a best-effort parse of Typst's human-readable stderr
  (severity line, `┌─` span header, source/caret block, `= hint`/`= help`/
  `= note` blocks). Raw stderr is always retained and remains authoritative;
  parse failures or unknown formats degrade to "no structured view" and never
  alter result or error behavior.
- Parsed diagnostics are attached to the process record, so they reach every
  high-level result and error through the existing `process` field without
  duplicating per-command fields.
- Upstream has no machine-readable diagnostics format yet; when one becomes
  stable the parser may be extended, but the raw stderr escape hatch stays.

### Progress/log hooks

- `onLog` receives redaction-safe lifecycle events (`spawn`, `exit`,
  `stdout_chunk`, `stderr_chunk`, `output_truncated`). Events never contain argument values,
  source content, or the executable path; `command` is always `"typst"` and
  chunks report byte length only.
- Hook exceptions are swallowed so a logging bug can never break a compile.
- The long-lived watch runner streams the same event kinds; the `output`
  events remain the authoritative raw chunk stream.

### `diagnose()`

- `diagnose()` reports executable path and discovery source, exact version,
  support level, capabilities, host platform/arch, launcher availability, cwd,
  and a best-effort `issues` list. It never fabricates evidence: every field is
  already known to discovery, version parsing, or the registry.
- Known issue codes: `LAUNCHER_NOT_INSTALLED` (only when discovery used
  implicit sources), `EXECUTABLE_FROM_PATH`, `UNKNOWN_COMPILER_VERSION`,
  `ASSUMED_VERSION_RULES` (with `unknownVersionPolicy:
"assume-latest-known"`), and `UNTESTED_PLATFORM`.

### Input/output string shorthands

- `CompileInput` and `CompileDestination` accept a plain string as a shorthand
  for the file form (`{ kind: "file", path }`). This mirrors the key-based
  discrimination used by the community WASM wrappers while keeping the
  canonical discriminated union inside the wrapper.
- Shorthands are normalised at each command entry (`compile`, `query`, `eval`,
  `watch`) before validation, so every downstream layer only ever sees the
  discriminated union. String shorthands receive identical validation, version
  gating, and result handling.
- `WatchOptions.output` accepts a string shorthand but remains file-only:
  memory output is still rejected before spawn.

### Watcher events and cancellation ergonomics

- `ready` fires exactly once, for the initial compile cycle only, matching its
  documented contract. Every detected cycle (including the first) fires the
  `cycle` event with a 1-based `index` in `WatchCycleInfo`; `ready` is a
  subset of `cycle`, not an alias with different content.
- Lifecycle order is `error` (when applicable) before `close`, for spawn
  failure, timeout, abort, and a natural unsuccessful exit. `close` is always
  the final lifecycle event and carries the same raw record as `closed`.
- `TypstWatchHandle` exposes `closed`, a promise that resolves with the final
  process record when the watcher settles for any reason (close, natural exit,
  timeout, abort, or spawn failure), and `pid`, the child process id once
  spawned.
- The final watcher record keeps a bounded tail per stream (1 MiB by default)
  rather than every chunk of a potentially hours-long session. Total byte
  counts and explicit `stdoutTruncated`/`stderrTruncated` flags make the loss
  checkable, and the streaming `output` event still carries every chunk.
- `close()` returns `Promise<TypstProcessResult>`; the implementation never
  lies about its payload type.

## 1.0.0 — Stable contract

### Public surface freeze

- `spec/public-api.d.ts` is the frozen, reviewable contract for the public
  surface. `scripts/freeze-check.mjs` (`npm run freeze:check`) resolves the
  emitted declaration tree and compares exported declarations, member types,
  optional/readonly modifiers, overloads, generic constraints and return
  types. Export additions/removals and shape changes fail; compatible
  additions are advisories. The check runs in CI on every PR and in the local
  `verify` chain.
- Every public change starts with a deliberate spec change. Adding an export,
  member or overload is compatible and ships in a minor release; removing,
  renaming or changing one is breaking and needs a new major version.
- `TypstOutputFormat` is a named public export so callers can annotate
  `format` values; it was added during the 1.0.0 surface audit.
- Type-level consumer compatibility is enforced by
  `scripts/consumer-typecheck.mjs` (`npm run consumer:types`): the packed
  tarball is installed into a blank ESM fixture and a strict consumer source
  type-checks under `moduleResolution: NodeNext` with the repository's
  TypeScript and `@types/node` versions.
- Capability semantics, result/error shapes, and command option contracts
  documented in `docs/reference/api-contract.md` and the sections above are
  part of the frozen contract; behavior additions are allowed, silent
  removal or semantic change is not.

### Release policy

- Package SemVer follows the exact rules from the `Versioning` section.
  `1.0.0` is the first public contract; there is no published pre-1.0 API to
  migrate from.
- Publishing happens only through the reviewed CI workflow
  (`.github/workflows/publish.yml`) using npm trusted publishing and
  provenance; the workflow requires the full gate suite to be green.
- Nobody runs `npm publish` from a local machine (engineering rule 14).

## M8 — Public API ergonomics (pre-1.0.0)

The ergonomics decisions below are part of the frozen contract record; their
user-facing consequences are documented in `docs/reference/api-contract.md`
and the README. The following decisions were accepted on 2026-08-08.

### Compile result inference

- `TypstClient.compile` gains a first overload for the statically
  single-output case: an in-memory destination (omitted `output` or
  `{ kind: "memory" }`) with `format` omitted or `"pdf"` narrows `outputs` to
  exactly one `CompileMemoryOutput`. The second overload keeps the full
  `CompileOutput` union for file destinations, PNG/SVG/bundle formats, and
  dynamic option objects.
- The overload is a typing convenience only; runtime behavior, version gating,
  and the raw `process` record are unchanged. PNG/SVG/bundle never promise a
  single output because the wrapper legitimately produces several.
- A convenience method matrix (`compilePdfToBuffer`, `compileSvgToFile`, ...)
  stays rejected; it would only add aliases. **Superseded in 1.0.0:** one
  in-memory shortcut per format (`pdf()`, `png()`, `svg()`, `html()`); the
  overloads grew to eight, narrowing by destination, by format and, in the
  positional form, by the destination extension.

### Output helpers

- Four small helpers are exported: `isMemoryOutput`, `isFileOutput`,
  `expectSingleOutput`, and `expectSingleMemoryOutput`. The `expect*` helpers
  throw `TypstUnexpectedResultError` when the result carries zero or several
  outputs (the memory variant also when the single output is a file).
- The helper set is intentionally minimal; no per-format or per-page
  convenience wrappers.

### Query / eval / info generics

- `QueryResult<T>`, `QueryOneResult<T>`, `EvalResult<T>`, and `InfoResult<T>`
  take a generic parameter defaulting to `unknown`; `query<T>()`,
  `queryOne<T>()`, `eval<T>()`, and `info<T>()` expose it.
- The generic is a consumer assertion over already-decoded JSON: the package
  performs no runtime schema validation and never depends on a schema
  library. `raw` (and the raw stderr in `process`) remain authoritative, and
  callers may validate externally.
- With the `field` option, `query<T>`'s `T` describes the extracted field
  values rather than the elements.
- Decoder/parser hooks are rejected: they would imply runtime validation
  policy in the core package.

### Errors

- The stable `code` strings are documented as a table in
  `docs/reference/api-contract.md`; they are part of the frozen contract.
  A readonly code-constants export is deferred until consumer demand exists
  (it would enlarge the public surface for marginal benefit).

### Deferred

- Subpath exports, format-specific `CompileOptions` unions, and watch
  per-cycle structured diagnostics are deferred until after `1.0.0` with
  consumer evidence. The shape-aware freeze gate and
  destination-aware `compile()` inference are implemented before `1.0.0`.

## 1.0.0 — Contract review before the first release

- `TypstWorldOptions` is the single definition of the project options shared
  by `compile`, `query`, `eval` and `watch`; validation and capability gates
  live in one place so the commands cannot drift. The font switches were added
  to `query`/`watch`/`compile` where the real binaries prove them
  (`--ignore-system-fonts` 0.11.1 → 0.12.0, `--ignore-embedded-fonts`
  0.13.1 → 0.14.0).
- `creationTimestamp` numbers are seconds; values beyond year 9999 are
  rejected as probable milliseconds instead of silently producing a wrong
  date.
- `html`/`bundle` feature flags are implied by the output or target that needs
  them. The capability gates still reject compilers without the feature.
- In-memory multi-file projects (`kind: "project"`) are staged below a private
  temporary root passed as `--root`; they are rejected for `watch`, which needs
  real files, and conflict with an explicit `root`.
- `ExactTypstVersion` uses `${bigint}` components so non-exact strings fail
  at compile time; `TypstError.code` is the closed `TypstErrorCode` union;
  `TypstLogEvent` is discriminated by `kind`; `InvalidExactStableVersionError`
  joined the `TypstError` hierarchy.
- Windows discovery accepts only `.exe`/`.com`: Node.js refuses to spawn
  batch files without a shell, and the extensionless npm shim is never
  started by `CreateProcess`.
- Page-per-file output is staged and moved after success, replacing the
  earlier "clean matching files before the run" strategy that could delete
  unrelated files and lost previous pages on failure.
- `assume-latest-known` orders prereleases exactly: `0.13.0-rc.1` uses the
  rules of the newest release strictly older than `0.13.0`.
- A plain string input stays a file path, matching the CLI. `source()` wraps
  markup, and evident markup passed as a path fails before spawn with a hint
  instead of the compiler's "file not found".
- Successful results always carry best-effort `warnings`; raw stderr remains
  authoritative.
- `compileMany()` bounds parallelism (default: CPUs, capped at 4) and settles
  every job instead of rejecting, because one broken document must not hide
  the results of the others.
- `jsonInput()` encodes structured `sys.inputs` explicitly; string values are
  never encoded implicitly, so the meaning of `inputs` does not change.
- `query(input, selector, options)` and `eval({ expression })` are additional
  overloads; the option-object forms remain canonical.
- A watch handle is async-iterable over cycles; leaving a loop early never
  stops the watcher.
- Experimental feature flags live in one table, `FEATURE_FLAGS`, with the
  exact release that introduced each flag and, once known, the release that
  made the feature stable (`stableIn`). Implied flags and `--features`
  serialization follow the table, so a stabilised feature keeps working when
  the compiler drops or rejects its flag.
- Version boundaries of CLI flags are generated, not written: the CLI flag
  inventory is derived from the per-release `--help` snapshots, and the option
  tables (`WORLD_FLAGS`, `OUTPUT_FLAGS`, `FEATURE_FLAGS`) only map options to
  flags. A flag that disappears from the help is reported as
  `undocumentedFrom`, never as removed: Typst hides deprecated flags that
  still work (`--make-deps` from 0.14.0, verified on the binaries). Behavior
  boundaries that the help cannot show (stdin sources from 0.11.0, stdout
  images and page templates from 0.12.0) stay in code, backed by probes.
