import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchUpstreamReleases,
  missingStableVersions,
  runNodeScript,
} from "./release-inventory.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const INVENTORY_PATH = path.join(ROOT, "data", "typst-releases.json");

const mode = process.argv.includes("--prepare") ? "prepare" : "check";

/**
 * Scheduled upstream watcher.
 *
 * Fetches the exact stable Typst releases published on GitHub and compares them
 * with the committed inventory. With `--check` (the default) it reports any new
 * release and exits non-zero so a scheduler can alert. With `--prepare` it also
 * runs the release-inventory updater for each new release, producing the
 * inventory record, CLI snapshots, and review report that constitute the
 * data-update change.
 *
 * Coverage is never advanced automatically: a new release always lands in
 * `pending-review` and requires snapshot, behavior, capability, and platform
 * review before any support claim is made.
 */
const inventory = JSON.parse(await fs.readFile(INVENTORY_PATH, "utf8"));
const upstream = await fetchUpstreamReleases();
const missing = missingStableVersions(inventory, upstream);

if (missing.length === 0) {
  console.log(
    "Upstream watcher: no new exact stable Typst releases since the inventory.",
  );
} else {
  console.log(
    `Upstream watcher: new exact stable release(s): ${missing.join(", ")}`,
  );
  if (mode === "prepare") {
    for (const version of missing) {
      console.log(`Preparing data-update change for ${version}...`);
      await runNodeScript(
        path.join(ROOT, "scripts", "update-release-inventory.mjs"),
        ["--prepare", version],
        ROOT,
      );
    }
  }
  console.log(
    "Coverage was not advanced automatically; review each new release before any support claim.",
  );
  process.exitCode = 1;
}
