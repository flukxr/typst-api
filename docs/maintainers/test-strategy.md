# Test strategy

## Test levels

### Unit

- exact SemVer parser/comparator;
- capability resolution;
- argument serialization;
- process result normalisation;
- timeout and abort;
- temp cleanup;
- typed errors;
- executable discovery.

### Snapshot compatibility

For every exact stable version:

- root help;
- every known command candidate help;
- stdout/stderr/exit code;
- package and compiler version;
- consecutive diff.

Patch transitions are mandatory.

### Integration

- minimal PDF from file;
- minimal PDF from source string;
- output file and output buffer;
- path containing spaces;
- non-ASCII path where supported;
- expected compilation failure retaining raw stderr;
- explicit executable discovery;
- launcher-package discovery.

## Boundary versions

Unit tests exercise version gates at these exact releases (each next to its
immediate predecessor), and the historical sweep runs every stable release:

```text
0.1.0
0.5.0
0.7.0
0.8.0
0.11.0
0.11.1
0.12.0
0.13.0
0.13.1
0.14.0
0.14.1
0.14.2
0.15.0
0.15.1
latest stable
```

The patch versions are deliberate behavior boundaries.

## Full pre-release CI

Iterate all exact stable releases available for each runner platform. Unsupported target/version pairs are reported as unavailable, not failed compatibility.

## Assertions

- Never assert only that a command succeeded; verify output artifact or structured result.
- For expected failure, assert exit metadata and retain raw output.
- Snapshot text is evidence, not the public API.
- A packaging revision change should rerun smoke tests even when upstream compiler version is unchanged.
