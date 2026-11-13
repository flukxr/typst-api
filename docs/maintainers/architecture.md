# Architecture

## Layers

```text
src/
  index.ts                  public entry point (re-exports only)
  types/public.ts           public option, result and client types
  client/
    index.ts                createTypst() and the TypstClient implementation
    default.ts              module-level functions and configure()
    support-data.ts         release inventory, support levels, rules version
    version.ts              `typst --version` parsing
  commands/
    compile.ts              compile, page staging, output collection
    query.ts  eval.ts  watch.ts  fonts.ts  init.ts  info.ts  completions.ts
    shared.ts               option tables, input staging, capability gates
    cli-flags.ts            version gates and placement from the flag inventory
    inputs.ts               source(), jsonInput(), path-shorthand checks
  core/
    process.ts              buffered runner (runProcess)
    stream-process.ts       long-lived runner used by watch
    executable.ts           discovery and the `--version` probe
    environment.ts          environment layering
    diagnostics.ts          best-effort stderr diagnostics and log events
    errors.ts               the TypstError hierarchy
    listeners.ts            isolated event listener invocation
    temp.ts                 scoped temporary directories
    version.ts              exact SemVer helpers
  capabilities/
    registry.ts             loads data/capabilities.seed.json at runtime
    registry.generated.ts   compiled fallback of the same registry
    cli-flags.generated.ts  CLI flags per release, generated from --help snapshots
    types.ts
```

Do not copy a full adapter for each release. Most changes are capability additions. A compatibility module is justified only when the invocation or interpretation changes.

## Diagnostics layer

`core/diagnostics.ts` parses Typst's human-readable stderr into best-effort
structured diagnostics and defines the redaction-safe `onLog` event types.
Parsing is strictly additive: the raw stderr Buffer is never replaced, and any
parse failure or format change degrades to "no structured view" rather than
altering results or errors. The `diagnostics` and `onLog` options flow through
every command layer (`buildRunOptions`, the compile/watch option builders, and
the client `run()` forwarding) to the process runners. The long-lived watch
runner (`stream-process.ts`) applies the same opt-in parsing to its final
record and streams log events without replacing the `output` events. Because a
watch session can outlive any fixed output budget, that runner keeps a bounded
tail per stream (1 MiB by default) and records total byte counts plus explicit
truncation flags instead of concatenating the whole session into memory.

## Capability resolution

Inputs:

1. exact compiler version;
2. verified static registry;
3. optional runtime help probe;
4. caller overrides only for advanced/unsafe use.

The static registry is loaded at runtime from the shipped
`data/capabilities.seed.json` so a new Typst release can be covered by a
data-only update; when that file is absent, unreadable, or fails structural
validation, the compiled `src/capabilities/registry.generated.ts` is the
deterministic fallback. The full schema is validated at build time
(`npm run validate:data`); the runtime loader performs only the structural
checks needed to select a usable verified registry. `TYPST_API_CAPABILITY_REGISTRY`
overrides the data path.

Output:

```ts
{
  compilerVersion: "0.15.1",
  level: "partial",
  commands: {
    compile: { state: "supported", since: "0.1.0" },
    eval: {
      state: "supported",
      since: "0.15.0",
      behaviorChanges: [
        { version: "0.15.1", change: "Failures exit with code 1." },
      ],
    },
  },
  formats: {
    pdf: { state: "supported", since: "0.1.0" },
    html: { state: "experimental", since: "0.13.0" },
  },
  options: { ... },
  evidence: { registry: { status: "verified", verifiedOnPlatform: "win32", ... } }
}
```

Known absence resolves to `unsupported`; missing evidence resolves to
`unknown`. Capability values are never collapsed to booleans.

Unknown newer versions:

- report `level: "unknown"` and `unknown` capabilities;
- keep `run(args)` available;
- reject high-level commands by default (`unknownVersionPolicy: "reject"`);
- apply the nearest older rules only with the explicit
  `unknownVersionPolicy: "assume-latest-known"` opt-in, which never raises the
  reported support level.

## Process layer

All commands return a normalised low-level record:

```ts
interface TypstProcessResult {
  executable: string;
  args: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}
```

High-level results include this raw record.

`RunOptions.stdio` can route a child standard stream to a pipe (default),
`"ignore"`, `"inherit"`, an existing file descriptor, or a Node stream. Only a
piped stream is captured in the result record, emitted through `onLog`, or
parsed for diagnostics; high-level commands omit `stdio` because they own the
streams they inspect.

Raw `run()` resolves for a naturally exited process regardless of its exit
status. Spawn failure, timeout, and abort throw typed errors carrying the raw
record. High-level commands turn unsuccessful command exits into typed command
errors.

The runner uses a single-settlement state machine. Abort and timeout terminate
an isolated process group on POSIX and request tree termination on Windows,
with direct-child fallback. Graceful termination escalates after the configured
grace period; descendant cleanup is explicitly best effort.

## Compile strategies

Source:

- `{ kind: "file", path }`: pass the path directly;
- `{ kind: "source", data }` without `virtualPath`, from exact `0.11.0`: use
  stdin;
- source data with a `virtualPath`, or before `0.11.0`: create a temporary
  `.typ` file;
- `{ kind: "project", files }`: write the files below a private temporary
  root that is passed as `--root`.

Output:

- `{ kind: "file", path }`: emit deterministic file outputs;
- omitted output or `{ kind: "memory" }` with safe stdout capability: use stdout;
  PDF always, and PNG/SVG when a single page turns out to be streamable;
- a multi-page PNG/SVG stdout attempt is retried through temporary page files
  only when the documented multi-image diagnostic is present; other failures
  surface immediately with their original process record;
- otherwise compile to a temporary output and read it into memory;
- multi-page PNG/SVG with an explicit `pages` selection: use a temporary
  directory and deterministic page template.

## Evidence precedence

1. Actual released binary behavior/help.
2. Tagged source for the exact release.
3. Official changelog.
4. Explicitly marked inference.

A lower-priority source never silently overrides observed binary behavior.
