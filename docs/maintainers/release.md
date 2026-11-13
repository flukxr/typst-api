# Release process

`@flukxr/typst-api` publishes only through reviewed CI with npm trusted
publishing and provenance. Nobody runs `npm publish` from a local machine
(engineering rule 14).

## Versioning

- Package SemVer is independent from Typst coverage: `1.0.0` is the frozen
  stable contract; `1.0.1` fixes, `1.1.0` compatible additions,
  `2.0.0` breaking changes.
- A breaking public change requires a deliberate change to
  `spec/public-api.d.ts` first; `npm run freeze:check` resolves the emitted
  declaration tree and compares exported declarations, signatures, member
  types, optional/readonly modifiers, overloads and generic constraints.
  Compatible additions are advisories; removals or shape changes fail.
- Every new exact stable Typst release follows the continuous release
  workflow in `CONTRIBUTING.md` (snapshot, diff, probes, registry, review);
  a new Typst version alone never bumps the package major.

## Typst changes and the frozen contract

The contract describes intent ("compile with these fonts"), not CLI flags, and
every option is promised only where the detected compiler supports it. A Typst
release is therefore absorbed without a breaking change in almost every case:

- **A flag is added, renamed or moved** — the regenerated CLI flag inventory
  (`src/capabilities/cli-flags.generated.ts`) shows it in the release review.
  Version gates and the placement before or after the subcommand follow the
  inventory automatically; a rename only needs the option table in
  `src/commands/shared.ts` to point at the new flag.
- **A feature or option is removed** — record `removedIn` in the capability
  registry. On that release the option rejects with
  `UnsupportedTypstFeatureError`; older releases keep working. This is not a
  breaking change of the package.
- **An experimental feature becomes stable** — record `stableIn` in
  `FEATURE_FLAGS`; the flag is no longer implied or passed.
- **New flags or values appear** — they work immediately through `extraArgs`
  and the open `PdfStandard`/`TypstFeature` types; add first-class options in
  a minor release.
- **Human-readable output changes** — the release review's output-format
  table shows the parser regression; fix the parser before the release is
  marked supported.

## Deprecation policy

A public declaration is never removed or changed incompatibly within a major
version. When an option or method has to give way:

1. add the replacement in a minor release;
2. mark the old declaration `@deprecated` in `spec/public-api.d.ts` and the
   source, naming the replacement, and note it under `Deprecated` in the
   changelog; it keeps working;
3. remove it only in the next major release, listed under `Removed`.

## Release gates

Run locally before tagging:

```sh
npm run release:check
```

It runs, and stops at the first failure: `verify` (clean, lint, unit and
real-binary tests, freeze gate, consumer types), `package:smoke` (the packed
tarball installs and imports), `bench:check` (relative performance guards),
`pm:check` (npm/pnpm/yarn install and compile) and `sweep:historical` (every
exact Typst release on the current host).

The operating-system and Node.js matrix (Node 20/22/24, real-binary
integration on Windows, Linux and macOS) runs in `ci.yml` on every push to
`main`; create a tag only when that CI is green. The publish workflow itself
runs on Ubuntu with Node 22 and re-checks `lint`, `test`, `freeze:check`,
`consumer:types`, `bench:check` and `pm:check` before `npm publish`.

## Publish prerequisites (one-time)

Trusted publishing can only be configured for a package that already exists,
so the first release is bootstrapped with npm staged publishing (npm CLI
≥ 11.15.0, Node.js ≥ 22.14.0):

1. Make `flukxr/typst-api` and `flukxr/typst-snapshots` public (provenance
   needs a public repository; CI reads the snapshot corpus) and wait for a
   green `ci.yml` on `main`.
2. Locally, set a throw-away version such as `0.0.1-bootstrap.0` in
   `package.json` (do not commit it) and run
   `npm stage publish --access public`. npm creates the package with a public
   `0.0.0-stage` placeholder; the staged version itself is not installable.
   Restore `1.0.0` afterwards.
3. On npmjs.com, package settings → Trusted publishing: GitHub Actions,
   `flukxr` / `typst-api` / `publish.yml`, and enable **`npm publish`** under
   allowed actions. Configurations created after 3 September 2026 allow only
   `npm stage publish` by default, and `publish.yml` runs `npm publish`.
4. The new trusted publisher must publish successfully within 48 hours or it
   expires, so tag the release right away (next section).
5. Reject the bootstrap version: `npm stage list @flukxr/typst-api`, then
   `npm stage reject <id>` (interactive, with 2FA). After the release, check
   that `npm view @flukxr/typst-api dist-tags` points `latest` at `1.0.0`.

`package.json` declares `"private": false`,
`"publishConfig": { "access": "public", "provenance": true }`, and a `files`
list of `dist`, `data/capabilities.seed.json`, `README.md` and `LICENSE`.

## Publishing (via CI, never locally)

```sh
# 1. Bump the version and date its CHANGELOG section.
npm version 1.0.0 --no-git-tag-version
# 2. Commit the version bump (reviewed, on main).
git add package.json package-lock.json
git commit -m "chore: release 1.0.0"
# 3. Tag the commit; the publish workflow runs on this tag.
git tag v1.0.0
git push origin main v1.0.0
```

`.github/workflows/publish.yml` then:

1. runs the full gate suite;
2. publishes with `npm publish --provenance` using npm trusted publishing
   (OIDC): the workflow holds `id-token: write`, publishes without any npm
   token, and the registry authenticates the `flukxr` scope against the
   configured OIDC identity provider;
3. verifies the published package imports and reports the provenance URL
   (the GitHub release page shows the attestation).

The `v` prefix is stripped by the workflow to derive the package version. The
workflow never publishes for `-beta`-style or arbitrary tags; only tags
matching `v<semver>` are accepted.

## Post-release

- `@flukxr/typst-cli` revisions are published separately through their own
  process; the API release does not depend on a matching launcher revision.
- If a new exact Typst stable appeared while the release was in flight, add it
  through the continuous workflow first so the release documents the current
  stable.
- Record the release in `docs/maintainers/verified-coverage.md` if the sweep
  record changed.

## Emergency patch

A patch release follows the same flow: bump to `1.0.1`, tag `v1.0.1`. The
freeze gate guarantees the patch cannot silently change the public surface.
