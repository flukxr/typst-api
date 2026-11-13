import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  InvalidExactStableVersionError,
  compareExactStableVersions,
  compareParsedExactStableVersions,
  parseExactStableVersion,
} from "../dist/core/version.js";

const inventory = JSON.parse(
  await readFile(
    new URL("../data/typst-releases.json", import.meta.url),
    "utf8",
  ),
);
const versions = inventory.releases.map((release) => release.version);

test("parses every exact stable version in the release inventory", () => {
  for (const version of versions) {
    const parsed = parseExactStableVersion(version);
    assert.equal(parsed.raw, version);
    assert.equal(`${parsed.major}.${parsed.minor}.${parsed.patch}`, version);
  }
});

test("orders every adjacent release boundary independently", async (context) => {
  for (let index = 1; index < versions.length; index += 1) {
    const previous = versions[index - 1];
    const current = versions[index];
    assert.notEqual(previous, undefined);
    assert.notEqual(current, undefined);

    await context.test(`${previous} < ${current}`, () => {
      assert.equal(compareExactStableVersions(previous, current), -1);
      assert.equal(compareExactStableVersions(current, previous), 1);
      assert.equal(compareExactStableVersions(previous, previous), 0);
      assert.equal(compareExactStableVersions(current, current), 0);
    });
  }
});

test("compares parsed versions without string or prefix ordering", () => {
  const left = parseExactStableVersion("0.9.0");
  const right = parseExactStableVersion("0.10.0");
  assert.equal(compareParsedExactStableVersions(left, right), -1);
  assert.equal(compareParsedExactStableVersions(right, left), 1);
});

test("preserves patch releases as distinct compatibility checkpoints", () => {
  assert.equal(compareExactStableVersions("0.11.0", "0.11.1"), -1);
  assert.equal(compareExactStableVersions("0.13.0", "0.13.1"), -1);
  assert.equal(compareExactStableVersions("0.14.0", "0.14.1"), -1);
  assert.equal(compareExactStableVersions("0.14.1", "0.14.2"), -1);
  assert.equal(compareExactStableVersions("0.15.0", "0.15.1"), -1);
});

test("accepts the largest exactly representable numeric component", () => {
  const version = `${Number.MAX_SAFE_INTEGER}.0.0`;
  assert.equal(parseExactStableVersion(version).major, Number.MAX_SAFE_INTEGER);
});

test("rejects ambiguous, unstable, and unsafe versions", () => {
  const invalidVersions = [
    "",
    "0",
    "0.15",
    "0.15.1.0",
    "v0.15.1",
    " 0.15.1",
    "0.15.1 ",
    "00.15.1",
    "0.015.1",
    "0.15.01",
    "0.15.-1",
    "0.15.1-rc.1",
    "0.15.1+build.1",
    `${BigInt(Number.MAX_SAFE_INTEGER) + 1n}.0.0`,
  ];

  for (const version of invalidVersions) {
    assert.throws(
      () => parseExactStableVersion(version),
      (error) =>
        error instanceof InvalidExactStableVersionError &&
        error.value === version,
      version,
    );
  }
});

test("comparison rejects non-exact inputs instead of coercing them", () => {
  assert.throws(
    () => compareExactStableVersions("0.15", "0.15.0"),
    InvalidExactStableVersionError,
  );
  assert.throws(
    () => compareExactStableVersions("0.15.0", "0.15.0-rc.1"),
    InvalidExactStableVersionError,
  );
});

test("runtime parsing rejects non-string inputs instead of coercing them", () => {
  for (const value of [undefined, null, 15, {}, []]) {
    assert.throws(
      () => parseExactStableVersion(value),
      (error) =>
        error instanceof InvalidExactStableVersionError &&
        error.value === value,
    );
  }
});
