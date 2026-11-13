# Verified coverage (1.0.0)

This file records the verified coverage range of the high-level API. It
distinguishes versions exercised end to end with a
real Typst executable from versions covered through mocked-run boundary
integration. Claims here are per the coverage policy in
[`versioning-and-coverage.md`](../reference/versioning-and-coverage.md): exact versions only, patch releases as
independent checkpoints, and no silent nearest-version inheritance.

## High-level sweep

`scripts/high-level-sweep.mjs` (`npm run sweep:historical`) installs every
exact stable release through `@flukxr/typst-cli` and drives the built high-level
API against each binary. Committed evidence lives in
`data/high-level-sweep.json` (legacy single-host) and
`data/sweep/<platform>-<arch>.json` (per-platform); every file validates as
build input.

| Typst range                                     | Platform          | Arch  | Result                                                          |
| ----------------------------------------------- | ----------------- | ----- | --------------------------------------------------------------- |
| `0.1.0`–`0.15.1` (all 20 exact stable releases) | Windows (`win32`) | x64   | `tested` for every version; `contiguousTestedThrough: "0.15.1"` |
| `0.1.0`–`0.15.1` (all 20 exact stable releases) | Linux (`linux`)   | x64   | `tested` for every version; `contiguousTestedThrough: "0.15.1"` |
| `0.1.0`–`0.15.1` (all 20 exact stable releases) | Linux (`linux`)   | arm64 | `tested` for every version; `contiguousTestedThrough: "0.15.1"` |
| `0.1.0`–`0.15.1` (all 20 exact stable releases) | macOS (`darwin`)  | arm64 | `tested` for every version; `contiguousTestedThrough: "0.15.1"` |

Checks per version: `version` parse, PDF compile from source, `fonts`, the
`watch` lifecycle (initial compile, recompile after an edit, clean close),
`query` (`0.7.0+`), `info` (`0.14.0+`), `eval` (`0.15.0+`), bundle memory output
(`0.15.0+`), and multiple PDF standards (`0.15.0+`). A version is `tested` only
when every applicable check passed; `unavailable` means the binary could not be
installed or resolved on the platform. The committed range is reported as
`coverage.testedVersions` and `coverage.fullySupportedThrough` on a host whose
platform/arch has committed sweep evidence only.

## Behavior probes

`scripts/behavior-probes.mjs` (`npm run probes:behavior`) runs deterministic
CLI probes for the documented evidence gaps at their exact boundaries and
writes raw stdout/stderr/exit evidence under `<corpus>/<version>/behavior/`,
where `<corpus>` is a checkout of
[`flukxr/typst-snapshots`](https://github.com/flukxr/typst-snapshots):

- `compile-pdf-stdout` (since `0.12.0`): PDF output to stdout is a byte-exact
  `%PDF-` stream; collected for every release from `0.12.0`.
- Image output to stdout (no dedicated probe; tagged `0.12.0` source and the
  real-binary suite on `0.15.1`): a single-page PNG/SVG streams to stdout,
  while a multi-page document exits unsuccessfully with empty stdout
  (`cannot export multiple images to stdout`). The wrapper retries only that
  exact diagnostic line; other failures with empty stdout are not retried and
  keep their original process record.
- `compile-bundle-stdout` (since `0.15.0`): bundle output to stdout is
  rejected; collected for `0.15.0`, `0.15.1`.
- `root-restriction` (since `0.6.0`): an absolute path outside the configured
  `--root` is blocked; collected for every release from `0.6.0`. The probe places `--root` at the
  root level before `0.7.0` and at command level from `0.7.0`.
- `color-option` (since `0.11.0`): `--color=always` forces ANSI escape codes on
  stderr even on a non-TTY runner, `--color=never` suppresses them, and the
  default `auto` emits no color on a non-TTY runner; collected for `0.11.0`
  through `0.15.1`.
- `watch-lifecycle` (since `0.1.0`): `typst watch` completes an initial
  compile, recompiles after a source edit, and terminates on demand; collected
  for every exact stable version from `0.1.0` through `0.15.1`.
- `dependency-output` (since `0.12.0`): compilation writes a dependency list
  that includes the input file; Makefile form for `0.12.0`–`0.13.1`, JSON from
  `0.14.0`; collected across the range.
- `output-format` (since `0.1.0`): the raw warning, error and font-list output
  that the package parses on a best-effort basis; `npm run probes:format`
  runs the parsers over it and flags a release whose format stopped parsing.
  The font list excludes the collecting machine's system fonts.
- `deps-stdout-make-regression` (since `0.14.0`): compiling to stdout with
  `--deps --deps-format=make` errors and, from the exact `0.14.1` fix, no longer
  leaves an empty Make dependency file as a side effect; collected for `0.14.0`
  (side-effect file observed) and `0.14.1` through `0.15.1` (no side-effect
  file).

The behavior probes in the corpus were collected on Windows x64. The high-level
sweep has committed evidence for Windows x64, Linux x64, Linux arm64, and macOS
arm64.

## Real-executable verification

Suite: `test/integration.real.test.mjs`. It resolves a real Typst executable
from `TYPST_API_TEST_EXECUTABLE`, then `TYPST_PATH`, then `PATH`, probes
`--version`, and skips the whole suite with a message when none is available.

| Typst    | Platform          | Arch | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ----------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.15.1` | Windows (`win32`) | x64  | PDF file→memory and source→memory, file destination, spaces and non-ASCII paths, single-page PNG/SVG stdout, PNG page artifacts with page ordering, invalid-source typed failure with raw stderr, HTML, `--pretty`, dependency lists, `info`, `completions`, `watch`, `eval` (decoded values, context input, yaml, typed failures), bundle output to a directory and to memory, unified `query`/`queryOne` on the eval backend with `--field`, multiple PDF standards, `TYPST_PATH` and `PATH` discovery |

The version installed on the verifying runner is exercised when available; any
available known or unknown version is exercised when the suite runs elsewhere,
and the suite adapts expectations (native query backend before `0.15.0`,
eval backend from `0.15.0`).

## Fonts command

`client.fonts()` returns the raw `typst fonts` output
text as its stable result. Boundaries are mocked-run verified against the
snapshot evidence in `test/fonts.test.mjs` and exercised end to end with the
real `0.14.2` binary:

- `--font-path` root-level placement before `0.7.0`, command-level from
  `0.7.0`;
- `--ignore-system-fonts` gated at exact `0.12.0`;
- `--ignore-embedded-fonts` gated at exact `0.14.0`;
- `--variants` available on every snapshot-verified version from `0.1.0`;
- raw stdout retained; raw stderr becomes the raw result when stdout is empty;
- unknown versions and malformed options fail before spawn.

## Query command

`client.query()`/`client.queryOne()` expose one contract with an internal,
version-selected backend. For exact versions `0.7.0`–`0.14.2` they run the
native `typst query` command; from `0.15.0` they run
`typst eval query(<SELECTOR>) --in <INPUT>` and normalise the result in
JavaScript. `test/query.test.mjs` verifies both backends against every exact
boundary in the registry, and the real suite exercises the eval backend end to
end:

- native backend gated at exact `0.7.0`; eval backend from `0.15.0` with
  equivalent public results (elements/element and raw JSON);
- `--input` gated at `0.11.0`; `--creation-timestamp`, `--package-path`,
  `--package-cache-path`, `--jobs`, `--pretty` at `0.12.0`; `--features` at
  `0.13.0`; `--target` at `0.14.0`; the `bundle` target at `0.15.0`;
- stdin source input from `0.11.0`, temporary source files before;
- `--field` serialized as a single non-repeatable argument on native query and
  applied as JavaScript field extraction on the eval backend, with equivalent
  results;
- `queryOne` enforces the exactly-one rule in the compiler (native) or in the
  wrapper (eval backend); undecodable output throws `TypstQueryParseError` with
  raw stdout retained; failures throw `TypstQueryError` with raw process
  evidence;
- the `0.15.0` eval failure exits `0` with empty stdout and is still detected
  as `TypstQueryError`.

## Eval command

`client.eval(expression, options?)` runs `typst eval`
from exact `0.15.0`. `test/eval.test.mjs` verifies argument serialization,
capability gates, and the failure-exit transition against the snapshot
evidence, and the real `0.15.1` binary exercises decoded JSON values, context
input, yaml raw output, and typed failures:

- command gated at exact `0.15.0`; `--in`, `--target`, `--format`, and
  `--pretty` gated through the registry at `0.15.0`;
- `--root`/`--font-path` at `0.1.0`, `--input` at `0.11.0`, package paths and
  `--jobs` at `0.12.0`, `--features` at `0.13.0`,
  `--ignore-system-fonts`/`--ignore-embedded-fonts` at `0.12.0`/`0.14.0`;
- `html`/`bundle` targets imply the corresponding feature flag;
- an exit-`0` run with empty stdout is a failure (the `0.15.0` failure-exit
  transition) and from `0.15.1` the compiler's exit `1` is the normal failure
  path; both throw `TypstEvalError` with raw evidence;
- `format: "json"` decodes `value`; `format: "yaml"` retains `raw` only;
  undecodable JSON throws `TypstEvalParseError` with the raw output.

## Bundle output

Bundle output is experimental from exact `0.15.0`. `test/compile.test.mjs`
verifies the multi-file result model with mocked directories, and the real
`0.15.1` binary compiles a bundle to a directory and into memory:

- `bundle` format gated at `0.15.0` and always requires the `bundle` feature
  flag (missing flag rejected before spawn);
- a file destination is the bundle root directory; memory output compiles into
  a temporary root and reads files back as Buffers;
- every output carries a forward-slash `relativePath` and a best-effort
  `mediaType` derived from the file extension;
- bundle cannot be written to stdout; an empty or missing bundle root is a
  typed `TypstCompilationError`.

## Watch command

`client.watch()` manages `typst watch` as a
long-lived process. `test/watch.test.mjs` verifies argument serialization and
capability gates against every exact boundary in the registry, and
`test/stream-process.test.mjs` verifies streaming, close, abort, timeout, and
spawn-failure semantics with real node child processes. The real `0.14.2`
binary is exercised end to end in `test/integration.real.test.mjs`:

- `start`, `ready` (best-effort cycle classification with raw text), `output`
  chunks, typed `error`, and `close` events;
- recompilation after editing the watched source file;
- `close()` terminates the process tree and resolves with the final raw
  process record; `await using` disposal terminates too;
- `--ppi` gated at `0.5.0`, root/font placement at `0.7.0`, explicit format at
  `0.8.0`, `--input` at `0.11.0`, pages/pdf-standard/timestamp/packages/jobs at
  `0.12.0`, features and HTML at `0.13.0`.

The `watch` lifecycle is also swept end to end for every exact stable release:
`data/high-level-sweep.json` records a `watch` check per version (initial
compile, recompile after an edit, clean close) alongside the other high-level
methods, and `<corpus>/<version>/behavior/watch-lifecycle.json` in the
`flukxr/typst-snapshots` repository retains the raw probe evidence.

The Linux `0.13.1` watch CPU regression needs a Linux runner and is not
covered by the Windows integration suite.

## Mocked-run boundary integration

`test/compile.test.mjs` drives `compile` argument serialization and capability
gates against every exact boundary in the registry, without a real binary:

- source file strategy transitions at `0.11.0`; stdin from `0.11.0`; stdout
  memory output from `0.12.0`, including single-page PNG/SVG and a structural
  multi-page retry through page files;
- `--root`/`--font-path` placement transition at exact `0.7.0`;
  `--ignore-system-fonts` gated at exact `0.12.0`;
- PNG `since 0.5.0`, `--ppi` `since 0.5.0`, SVG and explicit `--format`
  `since 0.8.0`, single PDF standards `since 0.12.0`, multiple PDF standards
  `since 0.15.0`;
- experimental `features` (`html` since `0.13.0`, `a11y-extras` since
  `0.14.0`, `bundle` since `0.15.0`) with bundle output exercised through the
  multi-file result model;
- page templates `{n}` pre-`0.12.0` and `{0p}-of-{t}` from `0.12.0`, including
  stale-page exclusion and page parsing from basename;
- dependency generation `--make-deps` from `0.12.0` and `--deps`/`--deps-format`
  from `0.14.0`, including stdout `-` conflicts, format defaults, and raw file
  read-back;
- cleanup on success, compilation failure, abort, timeout, and spawn failure;
- unknown versions and unsupported features fail before spawn.

## Init command

`client.init()` scaffolds a project from a template.
`test/init.test.mjs` verifies argument serialization, capability gates, safe
destination handling, and typed errors against every exact boundary in the
registry:

- command gated at exact `0.11.0`; `--package-path` and
  `--package-cache-path` gated at `0.12.0`;
- template, directory, and package paths serialized as separate arguments;
- a provided `directory` is resolved against the effective cwd and reported in
  the result;
- an already-existing destination throws `TypstInitConflictError` before spawn;
- unsuccessful exits throw `TypstInitError` with the raw process record;
- unknown versions and malformed options fail before spawn.

`init` is not exercised with the real executable in the integration suite
because it downloads/reads templates from the package cache, which the CI
runner does not provision.

## HTML and tooling commands

Experimental HTML and tooling coverage:

- `client.compile()`/`client.watch()` serialize `pretty` (`--pretty`, gated at
  exact `0.15.0`) and `noPdfTags` (`--no-pdf-tags`, gated at `0.14.0`); the
  watch command additionally exposes the HTML server options `noServe`,
  `noReload`, and `port` (all gated at exact `0.13.0`, requiring HTML output);
- `client.info()` (`test/info.test.mjs`) runs `typst info` from `0.14.0`,
  returns raw text, and decodes `data` when `format: "json"`;
- `client.completions(shell)` (`test/completions.test.mjs`) runs
  `typst completions <SHELL>` from `0.14.0` for bash, elvish, fish,
  powershell, and zsh, with the shell as a single positional argument;
- real-executable HTML, `--pretty`, `info`, and `completions` integration
  tests are included in `test/integration.real.test.mjs` and skip when no
  binary is available.

The HTML watch server's startup message and URL are human log output, not a
stable machine protocol; `output`/`ready` events retain the raw text without
parsing it into a server contract.

## Scale tests

`test/scale.test.mjs` covers throughput and memory
requirements with real node child processes and concurrent mocked compiles:

- large stdout beyond a single OS chunk is preserved byte-for-byte;
- large stdin is delivered completely with backpressure;
- concurrent compiles on one client are isolated and never share output or
  temporary scope roots;
- parallel real processes settle independently;
- a 16 MiB output is collected without unbounded parent-heap growth;
- concurrent `version()` probes share a single spawn;
- rapid streamed watch output stays bounded and byte-exact.

## Not yet verified

- POSIX-only checks (signal exits, executable mode errors) are skipped on
  Windows.
- `fullySupportedThrough` is reported as `0.15.1` on hosts with committed sweep
  evidence (`win32`/`x64`, `linux`/`x64`, `linux`/`arm64`, `darwin`/`arm64`)
  and stays `null` elsewhere: the committed high-level sweep covers the `watch`
  lifecycle and the behavior probes cover TTY/color and dependency-output
  regressions, so the contiguous full-support claim is evidence-backed on those
  hosts.
- `init` with a real executable is not yet verified against a real binary.
- Behavior-probe snapshots for non-Windows platforms are collected by
  `.github/workflows/sweep.yml` into `snapshots-ci/<platform>-<arch>/` and
  uploaded as an artifact; the committed corpus lives in the
  `flukxr/typst-snapshots` repository, not in this one.

## Running the suite

```sh
npm run verify        # includes the real suite; skips when no executable
TYPST_API_TEST_EXECUTABLE=/path/to/typst npm run verify
```

Any exact stable compiler version is accepted; the suite does not assert a
specific version.
