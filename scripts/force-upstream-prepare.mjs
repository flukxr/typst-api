import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchUpstreamReleases,
  runNodeScript,
  stableReleases,
} from "./release-inventory.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const UPDATER = path.join(ROOT, "scripts", "update-release-inventory.mjs");

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+$/u.test(version)) {
  console.error(
    "Usage: node scripts/force-upstream-prepare.mjs X.Y.Z (exact stable version)",
  );
  process.exitCode = 2;
} else {
  await forcePrepare(version);
}

/**
 * Force-prepare one exact stable release for review.
 *
 * This powers the manual `workflow_dispatch` path of the nightly upstream job.
 * A version that already exists in the upstream release feed is prepared with
 * live evidence and snapshot collection. A version that is not yet upstream
 * (for example a placeholder used to verify the pull-request flow) is prepared
 * from a synthesized upstream record without snapshot collection, so the
 * prepare → commit → pull-request pipeline can be exercised end to end before
 * a real release exists.
 */
async function forcePrepare(version) {
  const upstream = await fetchUpstreamReleases();
  const known = stableReleases(upstream).some(
    (release) => release.version === version,
  );
  if (known) {
    await runNodeScript(UPDATER, ["--prepare", version], ROOT);
    return;
  }

  const fixture = path.join(os.tmpdir(), `upstream-fixture-${version}.json`);
  const record = {
    tag_name: `v${version}`,
    published_at: new Date().toISOString(),
    draft: false,
    prerelease: false,
    version,
    evidence: {
      officialChangelog: `https://typst.app/docs/changelog/${version}/`,
      sourceArgsFile: `https://github.com/typst/typst/blob/v${version}/crates/typst-cli/src/args.rs`,
    },
  };
  try {
    await fs.writeFile(
      fixture,
      `${JSON.stringify([record], null, 2)}\n`,
      "utf8",
    );
    await runNodeScript(
      UPDATER,
      ["--prepare", version, "--upstream-file", fixture, "--no-collect"],
      ROOT,
    );
  } finally {
    await fs.rm(fixture, { force: true });
  }
  console.log(
    `Prepared placeholder review for ${version} (not yet present upstream).`,
  );
}
