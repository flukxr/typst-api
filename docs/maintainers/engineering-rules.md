# Engineering rules

These rules apply to every change in this repository. They exist because Typst
patch releases are real compatibility checkpoints and because the package runs
an external executable on behalf of its users.

## Non-negotiable rules

1. **Exact SemVer only.** `0.15.0` and `0.15.1` are different compatibility
   checkpoints.
2. Never use `parseFloat`, lexical string comparison, prefix matching such as
   `startsWith("0.15")`, or a `major.minor` tuple for compatibility decisions.
3. Stable patch releases are snapshotted, diffed and tested independently.
4. Use `spawn` with `shell: false`; never construct a shell command from user
   input.
5. No runtime binary downloads and no install scripts that fetch Typst.
6. Preserve raw stdout/stderr and exit metadata.
7. Raw `run(args)` remains available for unknown/new CLI surface.
8. Static capabilities must be backed by evidence. Unknown is better than
   guessed.
9. Tagged source and actual binary are primary compatibility evidence;
   changelogs are supporting evidence.
10. `@flukxr/typst-api` does not update the executable.
11. The public API must work with an executable outside `@flukxr/typst-cli`.
12. Temporary artifacts must be removed across success, failure, abort and
    timeout.
13. Avoid parsing localized/human output unless the result is explicitly
    marked best effort and raw text is retained.
14. Releases are published only by the tagged CI workflow, never from a local
    machine.

## Technical baseline

- Node.js >=20
- TypeScript strict mode
- ESM package
- Node built-in test runner
- Public types are emitted and frozen in `spec/public-api.d.ts`.
- Prefer built-in Node APIs and small dependencies.
- No synchronous process execution in public runtime methods.

## Compatibility data shape

A capability may include:

```ts
{
  since?: ExactTypstVersion;
  deprecatedIn?: ExactTypstVersion;
  removedIn?: ExactTypstVersion;
  behaviorChanges?: Array<{
    version: ExactTypstVersion;
    change: string;
  }>;
}
```

Version ranges may be derived only after exact per-release snapshots establish
equivalence.

## Review checklist

- Were all new version checks tested at the immediately adjacent patch/minor
  boundary?
- Is there a raw-output escape hatch?
- Can the same code run on Windows, Linux and macOS?
- Are paths passed as arguments rather than interpolated?
- Is unknown-version behavior conservative rather than fatal?
- Did any code accidentally assume every release ends with `.0`?
