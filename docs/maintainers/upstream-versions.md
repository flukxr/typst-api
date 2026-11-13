# Exact upstream stable versions

Checked against the official Typst changelog on 2026-07-18. At the `1.0.0`
release the current upstream stable is `0.15.1`; the table below is the
complete exact-version inventory the API is verified against.

| Version  |       Date | Kind  | Snapshot reason                                                                        |
| -------- | ---------: | ----- | -------------------------------------------------------------------------------------- |
| `0.1.0`  | 2023-04-04 | minor | Initial public CLI generation: compile, watch, fonts; non-zero failure status; --open. |
| `0.2.0`  | 2023-04-11 | minor | Behavioral fixes; no known new public CLI command.                                     |
| `0.3.0`  | 2023-04-26 | minor | TYPST_FONT_PATHS and TYPST_ROOT environment support.                                   |
| `0.4.0`  | 2023-05-20 | minor | TTY/color behavior changes; no known new public command.                               |
| `0.5.0`  | 2023-06-09 | minor | PNG export and short diagnostic format.                                                |
| `0.6.0`  | 2023-06-30 | minor | Project-root restrictions and package management.                                      |
| `0.7.0`  | 2023-08-07 | minor | query command; placement of shared CLI options changed.                                |
| `0.8.0`  | 2023-09-13 | minor | update command, explicit --format, custom CA certificate.                              |
| `0.9.0`  | 2023-10-31 | minor | Fontconfig and output-extension/watch behavior changes.                                |
| `0.10.0` | 2023-12-04 | minor | Primarily behavior changes; exact CLI surface must be snapshot-verified.               |
| `0.11.0` | 2024-03-15 | minor | init, stdin, sys.inputs, color selection, timings.                                     |
| `0.11.1` | 2024-05-17 | patch | Patch release; separate regression snapshot required.                                  |
| `0.12.0` | 2024-10-18 | minor | Pages, stdout output, package paths, jobs, dependency/PDF options.                     |
| `0.13.0` | 2025-02-19 | minor | Experimental HTML and watch HTTP server.                                               |
| `0.13.1` | 2025-03-07 | patch | Fixes high CPU usage in typst watch on Linux.                                          |
| `0.14.0` | 2025-10-24 | minor | info, completions, dependency formats, accessibility/PDF options.                      |
| `0.14.1` | 2025-12-03 | patch | Patch release; dependency-output behavior regression fixed.                            |
| `0.14.2` | 2025-12-12 | patch | Security patch; separate regression snapshot required.                                 |
| `0.15.0` | 2026-06-15 | minor | eval, bundle, multiple PDF standards, CLI output/behavior changes.                     |
| `0.15.1` | 2026-07-17 | patch | eval failures now exit with code 1.                                                    |

## Patch-release rule

The inventory intentionally contains patch releases as independent rows. A patch can change process behavior even without adding a flag.

Examples:

- `0.13.1`: Linux `watch` behavior fix.
- `0.15.1`: failed `eval` gets exit code 1.

Do not generate versions by incrementing only the minor component. Discover exact stable releases and store their full SemVer.
