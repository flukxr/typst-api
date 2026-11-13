# Upgrading Typst and the package

## Pre-1.0 to 1.0.0

`1.0.0` is the first public release of `@flukxr/typst-api`; there is no
earlier published API to migrate from.

## Within 1.x

`1.x` releases are contract-stable. Compatible changes may add optional
capabilities but never remove, rename, or change the meaning of existing
public symbols, options, or result fields. The freeze gate
(`npm run freeze:check`) compares the full exported declaration shape — not
only exported names — against `spec/public-api.d.ts`. The
`docs/maintainers/decisions.md` 1.0.0 section records the semantic guarantees.

If you see a break between `1.x` versions, it is a regression: report it
before working around it.

## To 2.0.0 (if it ever happens)

Breaking changes require a deliberate change to `spec/public-api.d.ts` and a
major bump. At that point this document will list, per symbol, what changed
and how to update:

```text
Breaking changes in 2.0.0
- <symbol>: <what changed, when, why>
- automated migration: <tool or codemod, if any>
```

Until then the 1.x contract is the reference.

## Typst version migration

Typst coverage is independent from package SemVer. Moving a project to a
newer Typst compiler:

1. Install the matching launcher revision with the dist-tag pin:
   `npm install @flukxr/typst-cli@typst-0.15.1` (see
   `docs/guides/package-managers.md`).
2. Let the API resolve the version automatically; version-sensitive behavior
   (stdin from `0.11.0`, stdout output from `0.12.0`, eval from `0.15.0`,
   and so on) is selected by the capability registry, not by your code.
3. Check `client.version()` / `client.support()` if your code branches on
   compiler behavior, and prefer the public capability model over parsing
   `--version` yourself.

Migrating _down_ to an older Typst is supported down to `0.1.0`; features the
older compiler does not have are rejected before spawn with
`UnsupportedTypstFeatureError` carrying the exact required and actual
versions.
