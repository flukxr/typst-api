// Generated from data/capabilities.seed.json. Do not edit by hand.
import type { CapabilityRegistry } from "./types.js";

export const CAPABILITY_REGISTRY = {
  $schema: "../schemas/capabilities.schema.json",
  status: "verified",
  verification: {
    milestone: "M0",
    platform: "win32",
    arch: "x64",
  },
  warning:
    "Verified against Windows x64 binary snapshots, exact tagged CLI source, and official changelogs. Cross-platform behavior remains limited to documented gaps.",
  checkedAt: "2026-07-18",
  features: {
    "commands.compile": {
      since: "0.1.0",
    },
    "commands.watch": {
      since: "0.1.0",
    },
    "commands.fonts": {
      since: "0.1.0",
    },
    "commands.query": {
      since: "0.7.0",
      deprecatedIn: "0.15.0",
      replacement: "commands.eval",
      compatStrategy:
        "Use native query before 0.15; use eval plus JS normalisation on 0.15+.",
    },
    "commands.update": {
      since: "0.8.0",
      apiPolicy: "blocked",
      reason: "The npm package manager owns the executable version.",
    },
    "commands.init": {
      since: "0.11.0",
    },
    "commands.info": {
      since: "0.14.0",
    },
    "commands.completions": {
      since: "0.14.0",
    },
    "commands.eval": {
      since: "0.15.0",
      behaviorChanges: [
        {
          version: "0.15.1",
          change: "Evaluation failures return exit code 1.",
        },
      ],
    },
    "formats.pdf": {
      since: "0.1.0",
    },
    "formats.png": {
      since: "0.5.0",
    },
    "formats.svg": {
      since: "0.8.0",
    },
    "formats.html": {
      since: "0.13.0",
      experimental: true,
      requiredFeature: "html",
    },
    "formats.bundle": {
      since: "0.15.0",
      experimental: true,
      requiredFeature: "bundle",
    },
    "options.root": {
      since: "0.1.0",
      env: "TYPST_ROOT",
      behaviorChanges: [
        {
          version: "0.3.0",
          change: "Added TYPST_ROOT environment binding.",
        },
        {
          version: "0.7.0",
          change: "Moved from a root-level option to command-level options.",
        },
      ],
    },
    "options.fontPaths": {
      since: "0.1.0",
      env: "TYPST_FONT_PATHS",
      behaviorChanges: [
        {
          version: "0.3.0",
          change: "Added TYPST_FONT_PATHS environment binding.",
        },
        {
          version: "0.7.0",
          change: "Moved from a root-level option to command-level options.",
        },
      ],
    },
    "options.diagnosticFormatShort": {
      since: "0.5.0",
    },
    "options.explicitOutputFormat": {
      since: "0.8.0",
    },
    "options.customCertificate": {
      since: "0.8.0",
      env: "TYPST_CERT",
    },
    "options.stdinInput": {
      since: "0.11.0",
    },
    "options.sysInputs": {
      since: "0.11.0",
    },
    "options.timings": {
      since: "0.11.0",
      behaviorChanges: [
        {
          version: "0.15.0",
          change: "Requires an explicit output file.",
        },
      ],
    },
    "options.pages": {
      since: "0.12.0",
    },
    "options.stdoutOutput": {
      since: "0.12.0",
    },
    "options.packagePath": {
      since: "0.12.0",
      env: "TYPST_PACKAGE_PATH",
    },
    "options.packageCachePath": {
      since: "0.12.0",
      env: "TYPST_PACKAGE_CACHE_PATH",
    },
    "options.jobs": {
      since: "0.12.0",
    },
    "options.makeDeps": {
      since: "0.12.0",
      deprecatedIn: "0.14.0",
      replacement: "options.deps",
      compatStrategy:
        "Use --make-deps (Makefile only) before 0.14.0; use --deps with --deps-format from 0.14.0.",
    },
    "options.pdfStandard": {
      since: "0.12.0",
    },
    "options.features": {
      since: "0.13.0",
      env: "TYPST_FEATURES",
    },
    "options.watchServer": {
      since: "0.13.0",
      compatStrategy:
        "The HTML watch server options --no-serve, --no-reload, and --port exist from 0.13.0 and require the HTML feature for meaningful output.",
    },
    "options.deps": {
      since: "0.14.0",
    },
    "options.depsFormat": {
      since: "0.14.0",
    },
    "options.noPdfTags": {
      since: "0.14.0",
    },
    "options.compilePretty": {
      since: "0.15.0",
    },
    "options.multiplePdfStandards": {
      since: "0.15.0",
    },
    "options.evalIn": {
      since: "0.15.0",
    },
    "options.evalFormat": {
      since: "0.15.0",
    },
    "options.evalPretty": {
      since: "0.15.0",
    },
    "options.evalTarget": {
      since: "0.15.0",
    },
  },
  evidence: {
    binarySnapshots: "../snapshots/<exact-version>/",
    taggedSources:
      "Exact sourceArgsFile URLs in typst-releases.json; 0.1.0 uses cli/src/main.rs, 0.2.0-0.6.0 use cli/src/args.rs, and 0.7.0+ use crates/typst-cli/src/args.rs.",
    officialChangelogs: "Exact officialChangelog URLs in typst-releases.json.",
    platform: "win32-x64",
    behaviorProbes: [
      "0.14.2 compile --timings accepts an omitted output path; 0.15.0 rejects it with exit code 2.",
      "0.15.0 eval failure exits 0; 0.15.1 exits 1 with equivalent raw diagnostics.",
      "0.15.1 compile --format png/svg with a positional stdout output streams one page; a multi-page document exits 1 and writes no stdout.",
    ],
  },
} as const satisfies CapabilityRegistry;

export type CapabilityName = keyof typeof CAPABILITY_REGISTRY.features;
