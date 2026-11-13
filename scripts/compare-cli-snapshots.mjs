import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { repositorySnapshotRoot } from "./snapshot-root.mjs";

const HANDOFF_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const RELEASES_PATH = path.join(HANDOFF_ROOT, "data", "typst-releases.json");
const SNAPSHOT_ROOT = repositorySnapshotRoot();
const DIFF_ROOT = path.join(SNAPSHOT_ROOT, "_diffs");

const PROBES = [
  "root-help",
  "compile-help",
  "watch-help",
  "fonts-help",
  "query-help",
  "update-help",
  "init-help",
  "info-help",
  "completions-help",
  "eval-help",
];

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

function normalise(text) {
  return text
    .replaceAll("\r\n", "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function lineDelta(before, after) {
  const beforeLines = new Set(normalise(before).split("\n"));
  const afterLines = new Set(normalise(after).split("\n"));

  return {
    removed: [...beforeLines].filter((line) => !afterLines.has(line)),
    added: [...afterLines].filter((line) => !beforeLines.has(line)),
  };
}

function fenced(lines, prefix) {
  if (!lines.length) return "_None_\n";
  return [
    "```diff",
    ...lines.map((line) => `${prefix}${line}`),
    "```",
    "",
  ].join("\n");
}

const releaseDocument = JSON.parse(await fs.readFile(RELEASES_PATH, "utf8"));
await fs.mkdir(DIFF_ROOT, { recursive: true });

for (let index = 1; index < releaseDocument.releases.length; index += 1) {
  const previous = releaseDocument.releases[index - 1].version;
  const current = releaseDocument.releases[index].version;
  const sections = [`# CLI snapshot diff: ${previous} -> ${current}`, ""];

  for (const probe of PROBES) {
    const previousStdout = await readText(
      path.join(SNAPSHOT_ROOT, previous, `${probe}.stdout.txt`),
    );
    const previousStderr = await readText(
      path.join(SNAPSHOT_ROOT, previous, `${probe}.stderr.txt`),
    );
    const currentStdout = await readText(
      path.join(SNAPSHOT_ROOT, current, `${probe}.stdout.txt`),
    );
    const currentStderr = await readText(
      path.join(SNAPSHOT_ROOT, current, `${probe}.stderr.txt`),
    );

    if (
      previousStdout === null &&
      previousStderr === null &&
      currentStdout === null &&
      currentStderr === null
    ) {
      continue;
    }

    const before = `${previousStdout ?? ""}\n${previousStderr ?? ""}`;
    const after = `${currentStdout ?? ""}\n${currentStderr ?? ""}`;

    if (normalise(before) === normalise(after)) continue;

    const delta = lineDelta(before, after);
    sections.push(`## ${probe}`, "", "### Removed", "");
    sections.push(fenced(delta.removed, "-"));
    sections.push("### Added", "");
    sections.push(fenced(delta.added, "+"));
  }

  if (sections.length === 2) {
    sections.push(
      "_No textual help-output differences found, or snapshots are unavailable._",
      "",
    );
  }

  const output = path.join(DIFF_ROOT, `${previous}__${current}.md`);
  await fs.writeFile(output, sections.join("\n"), "utf8");
  console.log(`Wrote ${path.relative(HANDOFF_ROOT, output)}`);
}
