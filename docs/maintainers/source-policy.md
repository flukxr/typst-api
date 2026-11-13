# Source and evidence policy

Use primary sources.

## Priority

1. Actual released binary: `--version`, root help, command help, behavior tests.
2. Exact tagged source: `crates/typst-cli/src/args.rs` and closely related code.
3. Official Typst changelog.
4. Explicitly marked inference.

## Official locations

- Changelog index: https://typst.app/docs/changelog/
- Per-version changelog: `https://typst.app/docs/changelog/<version>/`
- Source repository: https://github.com/typst/typst
- Exact CLI args source:
  `https://github.com/typst/typst/blob/v<version>/crates/typst-cli/src/args.rs`

## Rules

- Do not use third-party summaries as capability evidence.
- Changelog omissions are not proof that a flag did not change.
- Human help output and tagged source may differ due to build features; record the build/package used.
- Feature-gated commands/options must record the feature context.
- If exact evidence is unavailable, keep the capability unknown.
- Every behavior assertion should record its exact version, not only a minor family.
