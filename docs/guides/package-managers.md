# Package-manager behavior

`@flukxr/typst-api` is installable through every mainstream Node package
manager. Executable discovery is manager-agnostic, but each manager changes
how the optional `@flukxr/typst-cli` launcher package is laid out on disk, so
the discovery outcome can differ per manager.

Every statement below is marked either **verified** (exercised end to end by
`npm run pm:check`, which installs the packed tarball into a fresh fixture and
compiles a real document through default discovery) or **expected** (based on
how Node module resolution and the manager's layout work, but not automated in
CI).

## Discovery recap

The API resolves the executable in this order (first hit wins):

1. an explicit `executable` option;
2. the installed `@flukxr/typst-cli` launcher, resolved from the API package's
   own location;
3. the `TYPST_PATH` environment variable;
4. `typst` on `PATH`.

The launcher is an optional convenience. It never needs post-install scripts,
and it selects a platform-specific optional dependency
(`@flukxr/typst-cli-win32-x64`, `@flukxr/typst-cli-linux-arm64`, …) that
contains the binary.

## Pinning the compiler

Every Typst release gets a `typst-<version>` dist-tag on `@flukxr/typst-cli`
that always points at the newest packaging revision of that exact compiler
version. Pin the compiler without tracking `-npm.N` suffixes:

```sh
npm install @flukxr/typst-cli@typst-0.15.1
```

The API compares the launcher-declared version with the real `typst --version`
output and treats disagreement as an integrity/configuration error.

## npm

- The launcher is a dependency of the consumer project; npm hoists it into a
  location the API can resolve. **Verified** locally on Windows and in CI on Linux.
- Do not install with `--no-optional` (or `--omit=optional` in CI): the
  platform package holding the binary is an optional dependency of the
  launcher, and the launcher fails with a descriptive error when it is
  missing.
- `npm ci` with a committed lockfile is fully reproducible: the dist-tag
  resolves to the pinned exact compiler version.
- Installing the API tarball with `--ignore-scripts` works; there are no
  install scripts to skip.

## pnpm

- pnpm's strict `node_modules` layout only symlinks declared dependencies, but
  the consumer's direct dependencies still live in the project root
  `node_modules`, and Node's upward resolution from the API package reaches
  them. Installing the launcher as a direct dependency works.
  **Verified** with pnpm 11 on Windows.
- In a workspace, install the launcher in the workspace root and it is
  resolved by every workspace package that has the API installed; or install
  it per-package for per-package compiler versions.
- pnpm does not hoist the launcher into the API package's own `node_modules`
  unless it is declared there. Declaring it as a dependency of the package
  that uses the API is the supported pattern. **Expected.**

## Yarn

- Yarn classic (1.x) hoists like npm. **Verified** with Yarn 1.22 on Windows.
- Yarn Berry (2+): with the default `node-modules` linker, behavior matches
  npm/pnpm. **Expected.**
- Yarn Berry with the Plug'n'Play linker has no physical `node_modules`; the
  API resolves the launcher through the PnP runtime against the API package's
  own dependency set. A launcher installed only in the consumer project is
  therefore **not** resolvable, even as a direct dependency. **Expected.**
  Use one of:
  - the `node-modules` linker (`nodeLinker: node-modules` in `.yarnrc.yml`);
  - set `TYPST_PATH` to a native Typst binary.

## Monorepos

- Workspace installs (npm/pnpm/Yarn workspaces) hoist shared dependencies to
  the workspace root; the launcher installed there is reachable from every
  workspace package. **Expected.**
- Different workspace packages can pin different compiler versions via
  `typst-<version>` dist-tags; the API instance resolves the launcher that is
  installed (or hoisted) nearest to it.
- For a single shared compiler across all workspaces, set `TYPST_PATH` once
  (for example in a root `.env` consumed by CI) instead of installing the
  launcher everywhere.
- Never let two launcher versions with different compiler versions land
  hoisted into the same resolution chain without checking which one the API
  actually resolves; `diagnose()` reports the resolved executable and source.

## Verification

`npm run pm:check` packs the current source, installs the tarball with every
available manager (npm always; pnpm and yarn via the bare command or
corepack), and compiles a real document through default discovery in each
fixture. Managers that are not installed are reported as skipped; npm must
always pass.
