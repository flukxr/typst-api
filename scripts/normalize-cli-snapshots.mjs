import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { repositorySnapshotRoot } from "./snapshot-root.mjs";

const HANDOFF_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const SNAPSHOT_ROOT = repositorySnapshotRoot();

function portableExecutable(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return value;
  return path.relative(HANDOFF_ROOT, value).replaceAll(path.sep, "/");
}

for (const entry of await fs.readdir(SNAPSHOT_ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^\d+\.\d+\.\d+$/.test(entry.name)) continue;
  const versionDir = path.join(SNAPSHOT_ROOT, entry.name);
  const files = await fs.readdir(versionDir, {
    recursive: true,
    withFileTypes: true,
  });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const filePath = path.join(file.parentPath, file.name);
    const document = JSON.parse(await fs.readFile(filePath, "utf8"));
    if ("executable" in document)
      document.executable = portableExecutable(document.executable);
    if (file.name === "manifest.json") delete document.host;
    await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);
  }
}

console.log("Normalised snapshot executable paths and removed hostnames.");
