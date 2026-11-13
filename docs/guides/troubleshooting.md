# Troubleshooting

## The executable is not found

`TypstExecutableNotFoundError` means no candidate was found at all. The
discovery order is: explicit `executable` option, the optional
`@flukxr/typst-cli` launcher package, `TYPST_PATH`, then `PATH`.

- Pass an explicit path: `createTypst({ executable: "/abs/path/typst" })`.
- Or install the launcher: `npm install @flukxr/typst-cli@typst-0.15.1`.
- Or set `TYPST_PATH` to the binary's absolute path.
- When the client can be created, `diagnose()` explains what it found:

  ```js
  const report = await (await createTypst()).diagnose();
  console.log(JSON.stringify(report.issues, null, 2));
  ```

  When discovery itself fails, `error.attempts` lists every candidate it
  tried and why each one was rejected.

A candidate that exists but is not a regular file, is not executable, or is
denied reports its own error class
(`TypstExecutableNotRegularFileError`, `TypstExecutableNotExecutableError`,
`TypstExecutablePermissionError`).

## The launcher is installed but not used

The launcher is discovered only when it is resolvable from the calling
module. Verify with `diagnose()`: `executableSource` and
`launcherAvailable` tell you which source won. Common causes:

- the launcher is a devDependency only, and the consumer install omitted it;
- the consumer uses a lockfile that predates the launcher; run
  `npm update @flukxr/typst-cli`;
- the platform has no launcher package (see the platform column of the
  `@flukxr/typst-cli` README) — supply the executable explicitly.

## Windows: spawn issues with `.cmd` shims

npm-installed command shims are `.cmd` batch files (plus an extensionless
POSIX script) and cannot be started with `shell: false`. The API deliberately
never uses a shell, so on Windows it only accepts `.exe`/`.com` files:

- `@flukxr/typst-cli` is resolved by launcher path to its real `typst.exe`;
- the `PATH` search skips `typst.cmd`, `typst.bat` and the extensionless shim
  and keeps looking for a real `typst.exe` further down `PATH`;
- an explicit `executable` or `TYPST_PATH` that points at a shim is rejected
  with `TypstExecutableNotExecutableError` explaining why. Pass the `.exe`
  path instead.

## Version mismatch or integrity failure

`TypstExecutableIntegrityError` (and its `Launcher`/`Probe` subclasses) means
the binary's `--version` output did not match what the launcher declared.
This happens after a partial launcher update.

- Reinstall the launcher: `npm install @flukxr/typst-cli@typst-0.15.1`.
- Or bypass it with an explicit `executable` or `TYPST_PATH`.

`UnsupportedTypstVersionError` means the resolved executable reported a
version the package cannot serve at all; use `diagnose()` to see the raw
version.

## A feature is rejected even though my Typst looks new

`UnsupportedTypstFeatureError` carries `feature`, `requiredVersion`, and
`actualVersion`. The rejection is exact-version based: for example `eval`
requires exact `0.15.0` or later, `info`/`completions` require exact `0.14.0`
or later, and
packaging revisions like `0.15.1-npm.2` never count as compiler versions.
Check `client.capabilities()` for the exact `since` boundaries.

## Unknown future Typst versions

A newer-than-known compiler is deliberately conservative by default:
capabilities report `unknown`, support reports `unknown`, and high-level
commands reject with `UnsupportedTypstVersionError` because
`unknownVersionPolicy` defaults to `"reject"`. `run()` remains available, and
you can opt into applying the nearest known rules with
`createTypst({ unknownVersionPolicy: "assume-latest-known" })`; that never
raises the reported support level. Please open an issue with the exact
version so it can be added to the release inventory.

## Compilation produces an unexpected failure

Every high-level error carries `error.process` — the full raw process record
(`args`, `stdout`, `stderr`, `exitCode`, `signal`, `durationMs`). Look there
first; it is authoritative. Enable `diagnostics: true` for the parsed
severity/spans/hints view without losing the raw text.

Every `TypstError` also carries a stable machine-readable `code`
(`ERR_TYPST_COMPILATION`, `ERR_TYPST_EVAL_PARSE`, ...). Prefer `instanceof`
checks for control flow and use `code` for logging and routing; the full code
table lives in `docs/reference/api-contract.md` (Errors section).

## TypeScript: output is a file/memory union

`compile()` narrows a statically known destination: string and
`{ kind: "file" }` destinations type `outputs` as `CompileFileOutput`, while an
omitted destination or `{ kind: "memory" }` types it as
`CompileMemoryOutput`. An explicit `format: "pdf" | "html"` also proves a
single artifact and returns a one-element tuple. PNG, SVG, bundle, formats
built from dynamic values, and dynamic destination unions keep arrays or the
full `CompileOutput` union. Use `isMemoryOutput`/`isFileOutput` guards, or
`expectSingleOutput`/`expectSingleMemoryOutput` when the call must produce
exactly one output. `query<T>`, `queryOne<T>`, `eval<T>`, and `info<T>` assert
decoded JSON shapes without runtime validation; validate externally when you
need guarantees.

Known upstream traps:

- Output to stdout: the positional `-` is the only form that writes output to
  stdout across `0.12.0`–`0.15.1`. `-o -` does **not** write to stdout
  (exit 2). The API already uses the positional form internally.
- `--root` blocks absolute paths outside the root from `0.6.0` onward. A
  file input outside the root fails, and a source input does not compose with
  `root` at all; use a `project` input (it is its own root) or a file input
  below `root`.
- Dependency output and compilation output cannot both stream to stdout.

## Watch: no events, or `ready` never fires

`ready` fires once for the initial cycle; every cycle (including the first)
fires `cycle` with a 1-based `index`. Detection is best-effort and marker
format dependent — an unknown marker never fires the event, and the raw text
is always in `WatchCycleInfo.raw`. If you need byte-level output, use the
`output` event, which is the authoritative raw chunk stream.

A watcher can run for hours. Its final `closed`/`close` record retains at most
1 MiB of each stream; `stdoutTruncated`/`stderrTruncated` and
`stdoutBytes`/`stderrBytes` make that explicit. The `output` event is never
truncated, so persist it yourself if you need the complete session log.

## Timeout or abort leaves a process behind

Timeout and abort are single-settlement and best-effort tree termination:
the direct child is always terminated, but descendants that escape the
process group (or that Windows denies killing) can survive. Keep
`terminationGraceMs` at a sane value and design documents so they cannot
spawn long-lived descendants.

## Performance

Every call starts one Typst process, so the cost per call is roughly the
compiler's own start-up and compile time; the wrapper adds about 2 ms. For
many documents, use `compileMany()` to run them in parallel, and set
`ignoreSystemFonts: true` with explicit `fontPaths` to skip scanning system
fonts.

## Environment variables do not reach Typst

`env` merges by default (`process.env` then client values then invocation
values). `envMode: "replace"` replaces the layer entirely, and an
`undefined` value removes a key. If a variable is missing, check which layer
removed it and that `envMode` is not `"replace"` unexpectedly.

## More help

- `client.diagnose()` — one structured report of executable, version,
  support, capabilities, host, and issues.
- `docs/reference/api-contract.md` — the full public contract.
- `docs/maintainers/verified-coverage.md` — exact versions and platforms
  that are verified.
- Report a bug with the raw `error.process` attached; without it the report
  cannot be diagnosed.

## Source input, root, and asset resolution

Verified against Typst 0.15.1:

- **Source input does not compose with `root`.** A `{kind:"source"}` input is
  passed through stdin (or staged to a temporary file when `virtualPath` is
  set). When `root` is also provided, the compiler rejects it with
  `source file must be contained in project root`, because the virtual or
  temporary source is not located under the root.
- **Without `root`, relative asset paths resolve against the process working
  directory**, not against the virtual source location. An `#image("pixel.png")`
  in a source string is searched relative to the process CWD.
- **Recommended pattern for asset-bearing templates:** use file input — stage
  the generated `.typ` (and its images) under one root directory and compile
  with `input: {kind:"file", path}` plus `root`. This is the recommended combination — the only one where the resolution
  base is explicit and predictable. The same
  applies to `query()` when it must observe a compiled document that contains
  images.
- **Font fallback is silent at the API level.** An unknown font family
  compiles successfully; the only signal is an upstream stderr warning
  (`unknown font family: ...`), which remains available in `process.stderr`
  and `process.diagnostics`. Consumers that care about reference-render
  fidelity should pre-flight with `fonts()` and accept ordered fallback lists
  in `#set text(font: (...))`.

These behaviors mirror the upstream CLI semantics; this section documents them
so consumers do not have to rediscover the staging pattern.
