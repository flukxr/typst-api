import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkContract,
  formatResult,
  parseModule,
  tokenize,
} from "../scripts/freeze-check-lib.mjs";

const SPEC = `
export interface Options {
  readonly name: string;
  readonly nested?: { readonly count: number };
}
export declare function run(options: Options): Promise<string>;
export declare function run(options: Options, limit: number): Promise<string>;
export declare function pick<T extends string>(value: T): T;
export declare class Box<T> {
  readonly value: T;
  get(): T;
}
`;

async function withFixture(distSource, specSource = SPEC, extraFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), "typst-api-freeze-"));
  const specPath = join(root, "spec", "public-api.d.ts");
  const distPath = join(root, "dist", "index.d.ts");
  await mkdir(join(root, "spec"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(specPath, specSource);
  for (const [relative, source] of Object.entries(extraFiles)) {
    const file = join(root, "dist", relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, source);
  }
  await writeFile(distPath, distSource);
  return { root, specPath, distPath };
}

async function check(distSource, specSource = SPEC, extraFiles = {}) {
  const fixture = await withFixture(distSource, specSource, extraFiles);
  try {
    return await checkContract({
      specPath: fixture.specPath,
      distPath: fixture.distPath,
    });
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
}

function symbols(result) {
  return result.violations.map((violation) => violation.symbol);
}

test("accepts an identical contract", async () => {
  const result = await check(SPEC);
  assert.equal(result.ok, true, formatResult(result));
  assert.equal(result.specExports, 4);
  assert.equal(result.distExports, 4);
});

test("resolves re-exported declarations through the emitted tree", async () => {
  const result = await check(
    `export { run, pick } from "./functions.js";\nexport type { Options } from "./options.js";\nexport { Box } from "./box.js";\n`,
    SPEC,
    {
      "functions.d.ts": `import type { Options } from "./options.js";\nexport declare function run(options: Options): Promise<string>;\nexport declare function run(options: Options, limit: number): Promise<string>;\nexport declare function pick<T extends string>(value: T): T;\n`,
      "options.d.ts": `export interface Options {\n  readonly name: string;\n  readonly nested?: { readonly count: number };\n}\n`,
      "box.d.ts": `export declare class Box<T> {\n  readonly value: T;\n  get(): T;\n}\n`,
    },
  );
  assert.equal(result.ok, true, formatResult(result));
});

test("detects a removed export", async () => {
  const result = await check(
    SPEC.replace(
      "export declare function pick<T extends string>(value: T): T;\n",
      "",
    ),
  );
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("pick"));
});

test("detects an added export that the spec does not declare", async () => {
  const result = await check(`${SPEC}export declare function extra(): void;\n`);
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("extra"));
});

test("detects a changed argument type", async () => {
  const result = await check(
    SPEC.replace(
      "export declare function run(options: Options): Promise<string>;",
      "export declare function run(options: unknown): Promise<string>;",
    ),
  );
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("run"));
  assert.match(formatResult(result), /parameter 1 type/);
});

test("detects a changed return type", async () => {
  const result = await check(
    SPEC.replace(
      "export declare function run(options: Options): Promise<string>;",
      "export declare function run(options: Options): Promise<number>;",
    ),
  );
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("run"));
  assert.match(formatResult(result), /return type changed/);
});

test("detects a removed required member", async () => {
  const result = await check(SPEC.replace("  readonly name: string;\n", ""));
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("Options.name"));
  assert.match(formatResult(result), /member removed/);
});

test("detects optional becoming required", async () => {
  const result = await check(
    SPEC.replace("readonly nested?:", "readonly nested:"),
  );
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("Options.nested"));
  assert.match(formatResult(result), /optional property became required/);
});

test("detects a removed overload", async () => {
  const result = await check(
    SPEC.replace(
      "export declare function run(options: Options, limit: number): Promise<string>;\n",
      "",
    ),
  );
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("run"));
  assert.match(formatResult(result), /overload/);
});

test("detects a generic constraint change", async () => {
  const result = await check(SPEC.replace("<T extends string>", "<T>"));
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("pick"));
  assert.match(formatResult(result), /generic constraint/);
});

test("detects a class method return type change", async () => {
  const result = await check(
    SPEC.replace("  get(): T;\n", "  get(): T | null;\n"),
  );
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("Box.get"));
});

test("allows compatible additions as advisories instead of breaking", async () => {
  const result = await check(
    `${SPEC.replace(
      "  readonly name: string;",
      "  readonly name: string;\n  readonly nickname?: string;",
    )}\nexport declare function run(options: Options, limit: number, mode: "strict"): Promise<string>;\n`,
  );
  assert.equal(result.ok, true, formatResult(result));
  assert.ok(
    result.advisories.some((item) => item.symbol === "Options.nickname"),
  );
  assert.ok(
    result.advisories.some(
      (item) => item.symbol === "run" && /overload/u.test(item.message),
    ),
  );
});

test("reports the changed symbol and semantic detail", async () => {
  const result = await check(
    SPEC.replace(
      "export declare class Box<T> {",
      "export declare class Box<T extends object> {",
    ),
  );
  const report = formatResult(result);
  assert.match(report, /\[breaking\] Box:/);
  assert.match(report, /generic type parameters changed/);
});

test("detects a type alias change", async () => {
  const spec = `export type Mode = "a" | "b";\n`;
  const result = await check(`export type Mode = "a" | "c";\n`, spec);
  assert.equal(result.ok, false);
  assert.ok(symbols(result).includes("Mode"));
  assert.match(formatResult(result), /type expression changed/);
});

test("normalises top-level union order", async () => {
  const spec = `export type Mode = "a" | "b";\n`;
  const result = await check(`export type Mode = "b" | "a";\n`, spec);
  assert.equal(result.ok, true, formatResult(result));
});

test("tokenizer keeps template literal types atomic", () => {
  const tokens = tokenize("export type V = `${number}.${number}.${number}`;");
  assert.ok(tokens.includes("`${number}.${number}.${number}`"));
});

test("parseModule retains function overloads and members", () => {
  const module = parseModule(SPEC);
  const run = module.declarations.get("run");
  assert.equal(run.signatures.length, 2);
  const box = module.declarations.get("Box");
  assert.ok(box.members.has("value"));
  assert.ok(box.members.has("get"));
});
