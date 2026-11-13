# Contributing

Thanks for contributing to `@flukxr/typst-api`. This guide covers the
developer workflow. For policy and evidence rules, start with
[`docs/maintainers/engineering-rules.md`](docs/maintainers/engineering-rules.md) —
the non-negotiable rules apply to every change —
then see the maintainer docs listed at the end.

## Setup

Requirements: Node.js 20+ and npm.

```sh
npm ci
npm run build
```

The real-executable test suites and the historical sweep need a Typst binary.
The repository installs `@flukxr/typst-cli` as a dev dependency for that
purpose; the same suites skip gracefully when no binary is available on the
host platform. Everything else (unit tests, type checks, validation) is fully
offline.

## Validation commands

Run before submitting a change:

| Command                  | What it checks                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run validate:data`  | Capability seed, release inventory, release groups, package revisions, and sweep evidence against the schema and ordering rules |
| `npm run generate:check` | Generated capability registry matches the seed, and the CLI flag inventory matches the snapshots                                |
| `npm run typecheck`      | Strict TypeScript check without emitting                                                                                        |
| `npm run format:check`   | Prettier on the whole repository (exclusions in `.prettierignore`)                                                              |
| `npm test`               | Unit tests with the Node built-in test runner (after `npm run build`)                                                           |
| `npm run freeze:check`   | Emitted `dist/index.d.ts` matches `spec/public-api.d.ts` structurally (members, signatures, overloads, generics)                |
| `npm run consumer:types` | A strict ESM consumer (`moduleResolution: NodeNext`) type-checks against the packed tarball                                     |
| `npm run verify`         | The full local gate chain: clean + lint + test + freeze + consumer types                                                        |
| `npm run package:smoke`  | Packed tarball installs and imports in a blank fixture                                                                          |

Heavier, release-adjacent gates (may need network, binaries, or other
package managers): `npm run bench:check`, `npm run pm:check`, and
`npm run sweep:historical` (installs every exact Typst release and drives the
full high-level API against each).

## Test structure

- `test/*.test.mjs` — unit tests using the Node built-in test runner
  (`node --test`). Mocked processes keep them offline and fast; they run on
  Node 20, 22, and 24 in CI.
- `test/integration.real.test.mjs` — end-to-end tests against a real Typst
  binary; they skip when the platform has no package.
- `test/examples.test.mjs` — executes every runnable example in `examples/`
  against a real binary.
- `test/helpers/` — shared fixtures and harnesses.
- Tests cover every `before`, `since`, and `behaviorChanges.version` boundary
  in the capability registry; new version gates must be tested at the
  immediately adjacent patch/minor boundary, and temporary artifacts must be
  asserted clean on success, failure, timeout, and abort.

## The frozen public API

`spec/public-api.d.ts` is the reviewable public contract and `npm run
freeze:check` parses the emitted declaration tree (following re-exports) and
compares exported declarations, member types, optional/readonly modifiers,
overloads and generic constraints. Every public change starts with a
deliberate edit of the spec. Additions (a new export, member or overload) are
compatible and ship in a minor release; removing, renaming or changing an
existing declaration is breaking and requires a new major version. Semantics
documented in `docs/reference/api-contract.md` are frozen too; the
`docs/maintainers/decisions.md` log records why, and its latest section wins
where earlier entries were superseded. Internal implementation may change
freely.

## Adding support for a new Typst version

Every exact stable Typst release is an independent compatibility checkpoint.
The continuous workflow is:

1. Add the release record and the matching `@flukxr/typst-cli` package
   revision to `data/typst-releases.json` / `data/package-revisions.json`
   (or run the inventory updater: `npm run inventory:update -- X.Y.Z`), then
   review the generated report.
2. Collect CLI snapshots and behavior probes for the new version and diff
   against the immediate predecessor. The exact-version corpus lives in its
   own repository, [`flukxr/typst-snapshots`](https://github.com/flukxr/typst-snapshots);
   clone it next to this one and the collector resolves it
   through `scripts/snapshot-root.mjs` (a `TYPST_API_SNAPSHOT_ROOT` override or
   a sibling `typst-snapshots` checkout) and the snapshot change is reviewed and
   merged there, not in this repository.
3. Review the exact tagged source and the official changelog (primary
   evidence; changelogs alone are supporting evidence).
4. Add behavior probes for each relevant change, including patch-only
   changes. `npm run probes:format` (after `npm run build`) runs the package's own parsers (warnings,
   errors, font list, watch cycles) over the recorded raw output and fails
   when a format that parsed on the predecessor no longer does; the release
   review report includes the same table.
5. Regenerate the CLI flag inventory (`npm run generate:flags`; the release
   preparation does this automatically) and review its diff: it lists every
   flag and value the release adds or stops documenting. Version boundaries
   of options come from this inventory, so they are never typed by hand. A
   flag missing from the help is not necessarily removed; confirm removals
   on the binary and record them in the registry.
6. Update the capability registry seed and any compatibility strategies. When
   a release stabilises an experimental feature (`html`, `bundle`,
   `a11y-extras`), record its exact release as `stableIn` in `FEATURE_FLAGS`
   (`src/commands/shared.ts`) so the flag is no longer implied or passed.
7. Run the fast matrix, then the full pre-release matrix
   (`npm run sweep:historical`); update coverage evidence
   (`data/sweep/`), never inferring support from unchanged help snapshots.
8. Run every gate in the validation table.

Details and the review gates live in
[`docs/maintainers/release.md`](docs/maintainers/release.md),
[`docs/maintainers/engineering-rules.md`](docs/maintainers/engineering-rules.md), and
[`docs/maintainers/verified-coverage.md`](docs/maintainers/verified-coverage.md).

## Before you submit

- `git diff --check` clean;
- all offline gates green locally (or a concrete reason for any skip);
- no committed `dist/`, temp artifacts, or `.cache/` content;
- snapshots and evidence stay evidence-grade: raw stdout/stderr and exit
  metadata retained, nothing inferred;
- user-facing changes have an entry under `[Unreleased]` in `CHANGELOG.md`.
