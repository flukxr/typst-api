# Security

## Reporting a vulnerability

Do not open a public issue for security problems. Report them privately to
the maintainers at https://github.com/flukxr/typst-api/security/advisories/new
with:

- the affected `@flukxr/typst-api` version and Typst compiler version;
- a minimal reproduction (document source and invocation options);
- the observed impact.

Reports are acknowledged within 5 working days. A fix is released as a patch
version as soon as it is reviewed; if the issue is in Typst itself, the
package documents the affected exact versions and the upstream fix release.

## Scope

This package is a process wrapper. It does not execute attacker-controlled
shell commands, download binaries, or mutate the Typst executable. The
relevant trust boundary is the Typst document being compiled, which is
attacker-controlled input by design.

## Threat model

| Concern                  | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command injection        | Typst is always spawned directly with `shell: false`; every value is serialized as a separate argument (engineering rule 4).                                                                                                                                                                                                                                                                                                     |
| Runtime binary download  | The package never downloads Typst and has no install scripts (engineering rule 5). The optional `@flukxr/typst-cli` launcher ships the binary in the npm package.                                                                                                                                                                                                                                                                |
| Executable tampering     | A `@flukxr/typst-cli` binary is always probed and its `--version` output must match the launcher's declared version (`TypstExecutableIntegrityError` otherwise). Explicit, `TYPST_PATH` and `PATH` executables are only checked to be regular executable files; pass `verifyExecutable: true` to also require a single exact stable `--version` (`TypstExecutableProbeError`). On Windows only `.exe`/`.com` files are accepted. |
| Secret exposure          | `onLog` events are redaction-safe: they never contain argument values, source content, or the executable path. Errors and results carry raw process output by design; callers must not log those records if the document may contain secrets.                                                                                                                                                                                    |
| Temporary artifacts      | Package-owned temporary files are scoped and removed on success, failure, timeout, and abort (engineering rule 12).                                                                                                                                                                                                                                                                                                              |
| Dependency supply chain  | Runtime dependencies are deliberately minimal (none at the time of `1.0.0`); the launcher's packaged binary is pinned to an exact Typst release with a checksum recorded at pack time.                                                                                                                                                                                                                                           |
| Process tree termination | Timeout and abort use single-settlement semantics with best-effort process-tree termination; descendants that escape the group cannot be guaranteed to be killed.                                                                                                                                                                                                                                                                |
| Path handling            | Paths are passed as arguments, never interpolated; relative paths resolve against the effective `cwd` before spawn.                                                                                                                                                                                                                                                                                                              |

## Document input is untrusted

`compile({ input: { kind: "source", data } })` feeds an arbitrary document to
the Typst compiler. Typst isolates compilation in the process and (with
`--root`) restricts file access, but the wrapper does not add a sandbox:

- A document can read files the process can read, subject to the effective
  `--root` restriction.
- A document can request network access only through Typst packages, which
  are subject to Typst's own package cache behavior.
- `sys.inputs`, `env` access, and font paths follow the Typst CLI contract.

Do not run untrusted documents with a privileged `cwd`/`env`, without a root,
or on a machine where the Typst process has access to data the document must
not reach. For untrusted markup, use a `project` input (it is staged below its
own private root) or a file input below an explicit `root`.

## Supported versions

Security fixes are released for the latest stable package version. Older
exact-version support is limited to what the frozen contract documents; if a
Typst compiler version has a known security issue, `docs/maintainers/upstream-versions.md`
and the capability registry note it and the wrapper does not hide it.
