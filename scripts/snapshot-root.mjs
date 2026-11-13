import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

const ENV_OVERRIDE = "TYPST_API_SNAPSHOT_ROOT";

/**
 * The snapshot corpus lives in its own public repository
 * (`flukxr/typst-snapshots`). A sibling checkout is the default location so a
 * working tree that has both repositories cloned side by side resolves without
 * configuration; CI and custom layouts use `TYPST_API_SNAPSHOT_ROOT`.
 */
const SIBLING_CHECKOUT = path.join(REPOSITORY_ROOT, "..", "typst-snapshots");
const IN_REPOSITORY = path.join(REPOSITORY_ROOT, "snapshots");

/**
 * Resolves the snapshot corpus root used by the collector, normaliser,
 * differ, behavior probes, and release-inventory review scripts.
 *
 * Precedence: an explicit override argument, then the
 * `TYPST_API_SNAPSHOT_ROOT` environment variable, then a sibling
 * `typst-snapshots` checkout, then the legacy in-repository `snapshots/`
 * directory.
 */
export function repositorySnapshotRoot(override) {
  if (typeof override === "string" && override.length > 0) {
    return path.resolve(override);
  }
  if (process.env[ENV_OVERRIDE]) {
    return path.resolve(process.env[ENV_OVERRIDE]);
  }
  if (existsSync(SIBLING_CHECKOUT)) {
    return path.resolve(SIBLING_CHECKOUT);
  }
  return IN_REPOSITORY;
}
