import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { repositorySnapshotRoot } from "../scripts/snapshot-root.mjs";

function withEnv(value, run) {
  const previous = process.env.TYPST_API_SNAPSHOT_ROOT;
  if (value === undefined) delete process.env.TYPST_API_SNAPSHOT_ROOT;
  else process.env.TYPST_API_SNAPSHOT_ROOT = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TYPST_API_SNAPSHOT_ROOT;
    else process.env.TYPST_API_SNAPSHOT_ROOT = previous;
  }
}

test("defaults to the sibling corpus checkout or the in-repository fallback", () => {
  withEnv(undefined, () => {
    const resolved = repositorySnapshotRoot();
    assert.ok(path.isAbsolute(resolved));
    // The corpus lives in its own repository; without configuration the
    // resolver prefers a sibling `typst-snapshots` checkout and otherwise
    // falls back to the legacy in-repository directory.
    assert.match(path.basename(resolved), /^(typst-snapshots|snapshots)$/u);
  });
});

test("resolves the sibling corpus checkout relative to the repository", () => {
  withEnv(undefined, () => {
    const resolved = repositorySnapshotRoot();
    if (path.basename(resolved) !== "typst-snapshots") return;
    // The sibling lives next to this repository, not inside it.
    const repositoryRoot = path.resolve(
      fileURLToPath(new URL("..", import.meta.url)),
    );
    assert.equal(
      resolved,
      path.resolve(repositoryRoot, "..", "typst-snapshots"),
    );
    assert.ok(existsSync(resolved));
  });
});

test("prefers an explicit override over the environment", () => {
  withEnv("override/env-root", () => {
    assert.equal(
      repositorySnapshotRoot("override/explicit-root"),
      path.resolve("override/explicit-root"),
    );
  });
});

test("honors the TYPST_API_SNAPSHOT_ROOT override", () => {
  withEnv("override/env-root", () => {
    assert.equal(repositorySnapshotRoot(), path.resolve("override/env-root"));
  });
});
