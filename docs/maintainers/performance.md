# Performance baselines

`scripts/benchmark.mjs` measures the wrapper's real cost on the three paths
that matter most, and `npm run bench:check` turns the measurements into CI
regression guards.

## Scenarios

| Scenario              | What is measured                                                                                                               | Guard in `--check`                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Cold discovery        | A fresh `createTypst()` plus the first `version()` probe, and the cached second lookup.                                        | The cached lookup must be strictly faster than the probing lookup (spawn vs in-memory).                            |
| Warm compile overhead | API compile wall time, the child process duration, and a bare spawn of the identical compile (`typst compile - -` with stdin). | Wrapper overhead (API wall minus child duration) must stay below 1.5x the bare child duration; API total below 3x. |
| Large output          | A 300-page document compiled to memory: wall time, payload bytes, retained heap delta.                                         | Retained heap must stay below 4x the payload bytes.                                                                |

## Why relative guards only

Shared CI runners make absolute millisecond thresholds flaky. Every guard is a
ratio or a relative comparison, so a slow machine still passes when the wrapper
adds no material cost. Absolute numbers are informational and are recorded in
`benchmarks/baselines.json` when running `npm run bench` locally.

## Running

```sh
npm run bench         # measure and write benchmarks/baselines.json
npm run bench:check   # measure and assert the relative guards (CI-safe)
```

The scripts require a real Typst executable (the `@flukxr/typst-cli`
development dependency provides one).

## Baseline policy

- `benchmarks/baselines.json` is committed for a record of one local host; it
  is never asserted against, because hosts and machines differ.
- The `bench` CI job runs only `npm run bench:check`, never absolute numbers.
- To refresh the committed baseline after machine upgrades, run
  `npm run bench` and review the diff.

## Known upstream behavior

The API writes in-memory PDF output to stdout with the positional `-` output
form (`typst compile - -`). Probe evidence collected across every exact
version from `0.12.0` through `0.15.1` shows that:

- positional `-` writes the PDF to stdout on every version, for both file and
  stdin input;
- the `-o -` flag form exits non-zero and writes nothing to stdout on every
  version.

So the positional form is the only evidence-backed stdout contract, and the
benchmark's bare baseline uses the identical invocation. The positional
stdout path is slower than file output inside Typst itself; the wrapper adds
only single-digit milliseconds on top of the child process.

The same positional form is used for in-memory PNG and SVG from exact `0.12.0`
when the document has one page. The compiler rejects multiple images on stdout
and writes nothing in that case, so the wrapper retries through temporary page
files. The retry is limited to the exact documented multi-image diagnostic;
syntax errors and other failures with empty stdout are surfaced immediately and
are never compiled twice. Multi-page documents therefore pay one failed attempt
before the page-file run.

## Long-lived watch memory

`watch()` does not retain a whole session's output. `spawnStreamProcess()`
keeps a bounded tail per stream (1 MiB by default, configurable internally for
tests) and counts every byte it observes. The final record carries
`stdoutBytes`/`stderrBytes`, `stdoutTruncated`/`stderrTruncated`, and the
`output_truncated` log event; the streaming `output` event still delivers every
chunk. `test/stream-process.test.mjs` emits 32 MiB through a watcher-style
process with a 256 KiB limit and asserts both the exact total and that the
post-GC retained memory does not grow with the emitted volume.
