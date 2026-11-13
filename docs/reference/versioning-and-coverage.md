# Versioning and coverage

## Package SemVer

`@flukxr/typst-api` follows its own SemVer:

```text
1.0.0  first public release, frozen stable contract
1.0.1  compatible bug fix
1.1.0  compatible behavior or capability addition
2.0.0  breaking change (requires a deliberate spec change first)
```

It does not mirror Typst. There is no published pre-1.0 API to migrate from;
the `0.0.0` development versions never left this repository.

## Historical guarantee at 1.0.0

The exact historical guarantee, documented and enforced at `1.0.0`:

- Every exact stable release from `0.1.0` through `0.15.1` is a first-class
  compatibility checkpoint with committed snapshots, consecutive diffs,
  behavior probes, and sweep evidence (see
  `docs/maintainers/verified-coverage.md` and `data/sweep/`).
- `fullySupportedThrough` reports `0.15.1` only on hosts whose platform/arch
  has committed sweep evidence; every other host stays conservative and
  reports `null`. It is never inferred from unchanged help snapshots.
- An unknown or future compiler version is never treated as the nearest known
  version unless the caller opts in with
  `unknownVersionPolicy: "assume-latest-known"`: `run()` stays available as the raw escape hatch, capabilities
  report `unknown`, and support reports `unknown`.
- Patch releases are independent checkpoints. `0.15.1` is a different
  compatibility checkpoint than `0.15.0` (eval failure exit code), exactly as
  `0.13.1` differs from `0.13.0` (Linux watch CPU regression).
- The API keeps working with any executable outside `@flukxr/typst-cli`
  (explicit path, `TYPST_PATH`, or `PATH`); the optional launcher is only one
  discovery source.

## Coverage metadata

Use exact stable versions:

```ts
interface TypstCoverage {
  minimumKnown: string;
  fullySupportedThrough: string | null;
  knownVersions: readonly string[];
  testedVersions: readonly string[];
  supportByVersion: Readonly<Record<string, SupportLevel>>;
}

type SupportLevel =
  "full" | "partial" | "experimental" | "untested" | "unavailable" | "unknown";
```

Example, abbreviated, on a host with committed sweep evidence:

```json
{
  "minimumKnown": "0.1.0",
  "fullySupportedThrough": "0.15.1",
  "knownVersions": ["0.1.0", "…", "0.15.0", "0.15.1"],
  "testedVersions": ["0.1.0", "…", "0.15.0", "0.15.1"],
  "supportByVersion": {
    "0.15.0": "partial",
    "0.15.1": "partial"
  }
}
```

`supportByVersion` reports `"partial"` for every version in the release
inventory; the other `SupportLevel` values are reserved and not produced by
`1.0.0`. Whether a version is verified on the current host is expressed by
`testedVersions` and `fullySupportedThrough`.

## Patch releases

A patch release is never assumed to be equivalent to its predecessor. Each
exact release is snapshotted, diffed against the immediately preceding release,
and probed for behavior changes before it is added; for example `0.13.1` is a
separate Linux watch boundary and `0.15.1` a separate eval exit-code boundary.
The maintainer workflow is described in
[`docs/maintainers/release.md`](../maintainers/release.md) and
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Packaging revisions

`@flukxr/typst-cli@0.15.1-npm.2` means:

- upstream compiler: `0.15.1`;
- npm packaging revision: `2`.

The API compatibility key is `0.15.1`, while the test report should also record the full installed npm package version.

## New Typst releases

Release discovery accepts any exact stable version (`0.15.2`, `0.16.0`,
`0.16.1`, …) and never assumes that a release ends in `.0`. A new release is
added to the inventory only after review, so until then it behaves as an
unknown version (see above). Prereleases such as `0.16.0-rc.1` are never part
of the inventory and never advance `fullySupportedThrough`.
