import assert from "node:assert/strict";
import test from "node:test";

import {
  TypstFontsError,
  TypstInvalidArgumentError,
  UnsupportedTypstFeatureError,
  UnsupportedTypstVersionError,
} from "../dist/index.js";
import { result, client, node } from "./helpers/mock-typst.mjs";

const FONT_LIST =
  "New Computer Modern\tRegular\tdejavusans.ttf\n" +
  "New Computer Modern\tBold\tdejavusans-bold.ttf\n";

test("fonts returns the raw output text and process record", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, FONT_LIST);
  });
  const outcome = await typst.fonts();
  assert.deepEqual(seen[0], ["fonts"]);
  assert.equal(outcome.raw, FONT_LIST);
  assert.equal(outcome.compilerVersion, "0.15.1");
  assert.equal(outcome.process.exitCode, 0);
});

test("fonts parses a best-effort family list without --variants", async () => {
  const typst = client("0.15.1", () => result(["fonts"], FONT_LIST));
  const outcome = await typst.fonts();
  assert.deepEqual(outcome.families, [
    "New Computer Modern",
    "New Computer Modern",
  ]);
});

test("fonts parses family headers from --variants output", async () => {
  const variants =
    "Agency FB\n" +
    "  ├ C:\\WINDOWS\\Fonts\\AGENCYB.TTF\n" +
    "  │   Style: Normal, Weight: 700\n" +
    "  └ C:\\WINDOWS\\Fonts\\AGENCYR.TTF\n" +
    "      Style: Normal, Weight: 400\n" +
    "\n" +
    "Alef\n" +
    "  ├ C:\\WINDOWS\\Fonts\\Alef-Bold.ttf\n";
  const typst = client("0.15.1", () =>
    result(["fonts", "--variants"], variants),
  );
  const outcome = await typst.fonts({ variants: true });
  assert.deepEqual(outcome.families, ["Agency FB", "Alef"]);
});

test("unrecognized fonts output does not fail the call and retains raw", async () => {
  const typst = client("0.15.1", () =>
    result(["fonts"], "??? no recognizable font data ???"),
  );
  const outcome = await typst.fonts();
  assert.equal(outcome.raw, "??? no recognizable font data ???");
  assert.equal(outcome.process.exitCode, 0);
});

test("fonts preserves exact root-to-command font-path placement across 0.7.0", async () => {
  const before = [];
  const old = client("0.6.0", (args) => {
    before.push(args);
    return result(args, FONT_LIST);
  });
  await old.fonts({ fontPaths: ["fonts/ü"] });
  assert.deepEqual(before[0], ["--font-path", "fonts/ü", "fonts"]);

  const after = [];
  const modern = client("0.7.0", (args) => {
    after.push(args);
    return result(args, FONT_LIST);
  });
  await modern.fonts({ fontPaths: ["fonts/ü"] });
  assert.deepEqual(after[0], ["fonts", "--font-path", "fonts/ü"]);
});

test("fonts serializes every flag as a separate argument", async () => {
  const seen = [];
  const typst = client("0.15.1", (args) => {
    seen.push(args);
    return result(args, FONT_LIST);
  });
  await typst.fonts({
    fontPaths: ["path one", "path two"],
    variants: true,
    ignoreSystemFonts: true,
    ignoreEmbeddedFonts: true,
  });
  assert.deepEqual(seen[0], [
    "fonts",
    "--font-path",
    "path one",
    "--font-path",
    "path two",
    "--ignore-system-fonts",
    "--ignore-embedded-fonts",
    "--variants",
  ]);
});

test("fonts gates ignoreSystemFonts at the exact 0.12.0 boundary", async () => {
  const old = client("0.11.1", () => result(["fonts"], FONT_LIST));
  await assert.rejects(
    old.fonts({ ignoreSystemFonts: true }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "ignoreSystemFonts" &&
      error.requiredVersion === "0.12.0" &&
      error.actualVersion === "0.11.1",
  );

  const boundary = client("0.12.0", (args) => result(args, FONT_LIST));
  const outcome = await boundary.fonts({ ignoreSystemFonts: true });
  assert.ok(outcome.raw.length > 0);
});

test("fonts gates ignoreEmbeddedFonts at the exact 0.14.0 boundary", async () => {
  const old = client("0.13.1", () => result(["fonts"], FONT_LIST));
  await assert.rejects(
    old.fonts({ ignoreEmbeddedFonts: true }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "ignoreEmbeddedFonts" &&
      error.requiredVersion === "0.14.0",
  );

  const boundary = client("0.14.0", (args) => result(args, FONT_LIST));
  const outcome = await boundary.fonts({ ignoreEmbeddedFonts: true });
  assert.ok(outcome.raw.length > 0);
});

test("fonts rejects unknown future versions before spawn", async () => {
  const unknown = client("0.16.0", () => result(["fonts"], FONT_LIST));
  await assert.rejects(
    unknown.fonts(),
    (error) =>
      error instanceof UnsupportedTypstVersionError &&
      error.actualVersion === "0.16.0",
  );
});

test("fonts throws a typed error for unsuccessful exits with raw evidence", async () => {
  const stderr = "error: typst: failed to list fonts\n";
  const typst = client("0.15.1", (args) => result(args, "", 2, stderr));
  await assert.rejects(
    typst.fonts(),
    (error) =>
      error instanceof TypstFontsError &&
      error.code === "ERR_TYPST_FONTS" &&
      error.compilerVersion === "0.15.1" &&
      error.process.exitCode === 2 &&
      error.process.stderr.toString("utf8") === stderr &&
      error.process.args.includes("fonts"),
  );
});

test("fonts uses stderr text as raw when stdout is empty", async () => {
  const stderr = "New Computer Modern\tRegular\n";
  const typst = client("0.15.1", (args) => result(args, "", 0, stderr));
  const outcome = await typst.fonts();
  assert.equal(outcome.raw, stderr);
});

test("fonts rejects malformed options before spawn", async () => {
  for (const options of [
    null,
    [],
    "fonts",
    { fontPaths: "fonts" },
    { fontPaths: [""] },
    { variants: "yes" },
    { ignoreSystemFonts: 1 },
    { ignoreEmbeddedFonts: {} },
    { timeoutMs: -1 },
    { envMode: "upsert" },
  ]) {
    const typst = client("0.15.1", () => result(["fonts"], FONT_LIST));
    await assert.rejects(
      typst.fonts(options),
      TypstInvalidArgumentError,
      JSON.stringify(options),
    );
  }
});

test("fonts forwards run options to the process runner", async () => {
  const seenOptions = [];
  const typst = client("0.15.1", (_args, options) => {
    seenOptions.push(options);
    return result(["fonts"], FONT_LIST);
  });
  const signal = new AbortController().signal;
  await typst.fonts({
    cwd: "custom-dir",
    env: { FONTS_ONLY: "1" },
    timeoutMs: 5_000,
    terminationGraceMs: 200,
    signal,
  });
  assert.equal(seenOptions[0].cwd, "custom-dir");
  assert.equal(seenOptions[0].env.FONTS_ONLY, "1");
  assert.equal(seenOptions[0].timeoutMs, 5_000);
  assert.equal(seenOptions[0].terminationGraceMs, 200);
  assert.equal(seenOptions[0].signal, signal);
});
