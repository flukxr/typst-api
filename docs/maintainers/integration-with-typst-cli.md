# Integration with `@flukxr/typst-cli`

The launcher package:

- exposes `typstPath` and upstream `version`;
- selects a platform-specific optional dependency;
- uses exact package versions `<typst-version>-npm.<packaging-revision>`;
- blocks native `typst update`;
- contains/downloads no binary at runtime;
- targets Node.js 20+.

## Loading the CommonJS launcher from ESM

```ts
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const launcher = require("@flukxr/typst-cli");

const executable = launcher.typstPath;
const declaredVersion = launcher.version;
```

Still execute `typst --version` and compare it with `declaredVersion`. Treat disagreement as an integrity/configuration error, not as a reason to guess.

## Discovery

The API must not require the launcher package:

```ts
await createTypst({ executable: "/custom/path/to/typst" });
```

Package discovery is a convenience.

## Historical platforms

The launcher repository currently records notable target exceptions:

- Typst `0.6.0`–`0.8.0`: no Windows ARM64 package.
- Early releases may use source-built targets.
- Packaging metadata may select a pinned Rust toolchain.

The test matrix queries availability instead of assuming that every version exists on every platform.

## Packaging revisions

The snapshot collector resolves the greatest published `npm.N` for each exact upstream version. It records both:

```json
{
  "typstVersion": "0.15.1",
  "packageVersion": "0.15.1-npm.2"
}
```

Compatibility is keyed to the compiler version. Reproducibility reports include the full package version.
