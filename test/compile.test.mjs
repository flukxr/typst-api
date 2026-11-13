import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse as parsePath } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  TypstAbortError,
  TypstCompilationError,
  TypstInvalidArgumentError,
  TypstSpawnError,
  TypstTimeoutError,
  UnsupportedTypstFeatureError,
  UnsupportedTypstVersionError,
} from "../dist/index.js";
import { TypstClientImpl } from "../dist/client/index.js";
import { pageFilePattern } from "../dist/commands/compile.js";
import { result, client, node, writeOutput } from "./helpers/mock-typst.mjs";

test("compile accepts string input/output shorthands as file paths", async () => {
  const calls = [];
  const typst = client("0.15.1", (args) => {
    calls.push(args);
    writeOutput(args);
    return result(args, "PDF");
  });
  await typst.compile({ input: "main.typ", output: "out.pdf" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "compile");
  assert.equal(calls[0].at(-2), "main.typ");
  assert.equal(calls[0].at(-1), "out.pdf");

  const memory = [];
  const toMemory = client("0.15.1", (args) => {
    memory.push(args);
    return result(args, "PDF");
  });
  await toMemory.compile({ input: "main.typ" });
  assert.equal(memory[0].at(-2), "main.typ");
});

test("compile rejects empty or NUL string inputs before spawn", async () => {
  const typst = client("0.15.1", () => result([], "PDF"));
  await assert.rejects(typst.compile({ input: "" }), TypstInvalidArgumentError);
  await assert.rejects(
    typst.compile({ input: "a\0b" }),
    TypstInvalidArgumentError,
  );
  await assert.rejects(
    typst.compile({ input: "main.typ", output: "" }),
    TypstInvalidArgumentError,
  );
  await assert.rejects(
    typst.compile({ input: "main.typ", output: "out\0.pdf" }),
    TypstInvalidArgumentError,
  );
});

test("compile preserves exact root/font option placement across 0.7.0", async () => {
  const before = [];
  const old = client("0.6.0", (args) => {
    before.push(args);
    writeOutput(args);
    return result(args, "PDF");
  });
  await old.compile({
    input: { kind: "source", data: "= hi" },
    root: "root with spaces",
    fontPaths: ["fonts/ü"],
    output: { kind: "memory" },
  });
  assert.equal(before[0][0], "--root");
  assert.equal(before[0][4], "compile");

  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    const after = [];
    const modern = client("0.7.0", (args) => {
      after.push(args);
      writeFileSync(join(directory, "result.pdf"), "PDF");
      return result(args, "PDF");
    });
    await modern.compile({
      input: { kind: "file", path: "document.typ" },
      root: "root with spaces",
      fontPaths: ["fonts/ü"],
      output: { kind: "file", path: join(directory, "result.pdf") },
    });
    assert.deepEqual(after[0].slice(0, 5), [
      "compile",
      "--root",
      "root with spaces",
      "--font-path",
      "fonts/ü",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("0.1.0 uses temporary source files and gates PNG at the exact 0.5.0 boundary", async () => {
  let inputPath;
  let existsDuringRun;
  let seenArgs;
  let seenOptions;
  const old = client("0.1.0", (args, options) => {
    seenArgs = args;
    seenOptions = options;
    inputPath = args[args.length - 2];
    existsDuringRun = existsSync(inputPath);
    writeOutput(args);
    return result(args, "PDF");
  });
  const output = await old.compile({
    input: { kind: "source", data: "= hello" },
    root: "proj",
    fontPaths: ["fonts"],
    output: { kind: "memory" },
  });
  assert.deepEqual(seenArgs.slice(0, 5), [
    "--root",
    "proj",
    "--font-path",
    "fonts",
    "compile",
  ]);
  assert.equal(seenArgs.at(-2), inputPath);
  assert.equal(existsDuringRun, true);
  assert.equal(existsSync(inputPath), false);
  assert.equal(seenOptions.stdin, undefined);
  assert.equal(output.outputs[0].mediaType, "application/pdf");
  assert.equal(output.outputs[0].data.toString(), "PDF");

  const pngBefore = client("0.1.0", () => result(["compile"]));
  await assert.rejects(
    pngBefore.compile({
      input: { kind: "file", path: "document.typ" },
      format: "png",
    }),
    UnsupportedTypstFeatureError,
  );
});

test("explicit formats are represented by extensions before 0.8.0", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    let oldArgs;
    const old = client("0.7.0", (args) => {
      oldArgs = args;
      writeFileSync(join(directory, "document.pdf"), "PDF");
      return result(args, "PDF");
    });
    await old.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "document.pdf") },
      format: "pdf",
    });
    assert.deepEqual(oldArgs.slice(0, 2), ["compile", "document.typ"]);
    assert.equal(oldArgs.includes("--format"), false);

    const mismatch = client("0.7.0", () => result(["compile"]));
    await assert.rejects(
      mismatch.compile({
        input: { kind: "file", path: "document.typ" },
        output: { kind: "file", path: join(directory, "document.pdf") },
        format: "png",
      }),
    );
    const unknownExtension = client("0.7.0", () => result(["compile"]));
    await assert.rejects(
      unknownExtension.compile({
        input: { kind: "file", path: "document.typ" },
        output: { kind: "file", path: join(directory, "document.typstout") },
        format: "png",
      }),
    );

    let modernArgs;
    const modern = client("0.8.0", (args) => {
      modernArgs = args;
      writeFileSync(join(directory, "document.png"), "PDF");
      return result(args, "PDF");
    });
    await modern.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "document.png") },
      format: "pdf",
    });
    assert.deepEqual(modernArgs.slice(0, 3), ["compile", "--format", "pdf"]);
    assert.equal(basename(modernArgs.at(-1)), "document.png");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ppi is gated at exact 0.5.0 boundary", async () => {
  const before = client("0.4.0", () => result(["compile"]));
  await assert.rejects(
    before.compile({
      input: { kind: "file", path: "document.typ" },
      ppi: 144,
    }),
    UnsupportedTypstFeatureError,
  );
  const since = client("0.5.0", (args) => {
    writeFileSync(args.at(-1).replace("{n}", "01"), "PNG");
    return result(args);
  });
  const png = await since.compile({
    input: { kind: "file", path: "document.typ" },
    output: { kind: "memory" },
    format: "png",
    ppi: 144,
  });
  assert.equal(png.outputs[0].page, 1);
  assert.equal(png.outputs[0].data.toString(), "PNG");
  assert.equal(png.outputs[0].mediaType, "image/png");
});

test("SVG is gated at exact 0.8.0 and uses the {n} template with its media type", async () => {
  const before = client("0.7.0", () => result(["compile"]));
  await assert.rejects(
    before.compile({
      input: { kind: "file", path: "document.typ" },
      format: "svg",
    }),
    UnsupportedTypstFeatureError,
  );

  let seenArgs;
  const since = client("0.8.0", (args) => {
    seenArgs = args;
    writeFileSync(args.at(-1).replace("{n}", "1"), "<svg/>");
    return result(args);
  });
  const output = await since.compile({
    input: { kind: "file", path: "document.typ" },
    output: { kind: "memory" },
    format: "svg",
  });
  assert.deepEqual(seenArgs.slice(0, 3), ["compile", "--format", "svg"]);
  assert.equal(seenArgs.at(-1).endsWith("-{n}.svg"), true);
  assert.equal(output.outputs[0].page, 1);
  assert.equal(output.outputs[0].data.toString(), "<svg/>");
  assert.equal(output.outputs[0].mediaType, "image/svg+xml");
});

test("unknown output formats are rejected before spawn", async () => {
  let calls = 0;
  const compiler = client("0.15.1", (args) => {
    calls += 1;
    return result(args);
  });
  await assert.rejects(
    compiler.compile({
      input: { kind: "file", path: "document.typ" },
      format: "jpeg",
    }),
    TypstInvalidArgumentError,
  );
  assert.equal(calls, 0);
});

test("multiple PDF standards are enabled only at exact 0.15.0", async () => {
  for (const version of ["0.14.2"]) {
    const old = client(version, () => result(["compile"]));
    await assert.rejects(
      old.compile({
        input: { kind: "file", path: "document.typ" },
        pdfStandards: ["1.7", "a-2b"],
      }),
      UnsupportedTypstFeatureError,
    );
  }
  for (const version of ["0.15.0", "0.15.1"]) {
    let args;
    const modern = client(version, (observed) => {
      args = observed;
      return result(observed, "PDF");
    });
    await modern.compile({
      input: { kind: "file", path: "document.typ" },
      pdfStandards: ["1.7", "a-2b"],
    });
    assert.deepEqual(args.slice(-4, -2), ["--pdf-standard", "1.7,a-2b"]);
  }
});

test("source strategy changes at 0.11.0 and stdout memory output at 0.12.0", async () => {
  let oldInput;
  let oldExistsDuringRun;
  let oldOptions;
  const old = client("0.10.0", (args, options) => {
    oldInput = args[args.length - 2];
    oldExistsDuringRun = existsSync(oldInput);
    oldOptions = options;
    writeOutput(args);
    return result(args, "PDF");
  });
  await old.compile({ input: { kind: "source", data: "= old" } });
  assert.notEqual(oldInput, "-");
  assert.equal(oldExistsDuringRun, true);
  assert.equal(existsSync(oldInput), false);
  assert.equal(oldOptions?.stdin, undefined);

  let modernArgs;
  let modernOptions;
  const modern = client("0.12.0", (args, options) => {
    modernArgs = args;
    modernOptions = options;
    return result(args, "PDF");
  });
  const output = await modern.compile({
    input: { kind: "source", data: "= new" },
  });
  assert.equal(modernArgs.at(-2), "-");
  assert.equal(modernArgs.at(-1), "-");
  assert.equal(modernOptions.stdin, "= new");
  assert.equal(output.outputs[0].data.toString(), "PDF");
  assert.equal(output.outputs[0].mediaType, "application/pdf");

  for (const version of ["0.11.0", "0.11.1"]) {
    let observed;
    const boundary = client(version, (args, options) => {
      observed = { args, options };
      writeOutput(args);
      return result(args);
    });
    await boundary.compile({ input: { kind: "source", data: "= boundary" } });
    assert.equal(observed.args.at(-2), "-");
    assert.equal(observed.options.stdin, "= boundary");
  }
});

test("PNG page outputs are numerically ordered and carry page numbers", async () => {
  const seen = [];
  const png = client("0.15.1", (args) => {
    const template = args.at(-1);
    seen.push(template);
    if (template === "-") {
      return result(
        args,
        "",
        1,
        "warning: ignored diagnostic\n\nerror: cannot export multiple images to stdout\n",
      );
    }
    writeFileSync(template.replace("{p}-of-{t}", "10-of-10"), "ten");
    writeFileSync(template.replace("{p}-of-{t}", "2-of-10"), "two");
    return result(args);
  });
  const output = await png.compile({
    input: { kind: "file", path: "document.typ" },
    output: { kind: "memory" },
    format: "png",
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], "-");
  assert.match(seen[1], /output-\{p\}-of-\{t\}\.png$/u);
  assert.deepEqual(
    output.outputs.map((item) => item.page),
    [2, 10],
  );
  assert.deepEqual(
    output.outputs.map((item) => item.data.toString()),
    ["two", "ten"],
  );
  assert.equal(output.outputs[0].mediaType, "image/png");
});

test("memory PNG/SVG stream a single page through stdout from 0.12.0", async () => {
  for (const [version, format, payload] of [
    ["0.12.0", "png", "PNG"],
    ["0.15.1", "svg", "<svg/>"],
  ]) {
    let seen;
    const compiler = client(version, (args) => {
      seen = args;
      return result(args, payload);
    });
    const output = await compiler.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "memory" },
      format,
    });
    assert.equal(seen.at(-1), "-");
    assert.equal(output.outputs.length, 1);
    assert.equal(output.outputs[0].kind, "memory");
    assert.equal(output.outputs[0].page, 1);
    assert.equal(output.outputs[0].data.toString(), payload);
    assert.equal(
      output.outputs[0].mediaType,
      format === "png" ? "image/png" : "image/svg+xml",
    );
  }
});

test("PNG/SVG stdout failures that are not the multi-image diagnostic are not retried", async () => {
  for (const format of ["png", "svg"]) {
    const seen = [];
    const broken = client("0.15.1", (args) => {
      seen.push(args.at(-1));
      return result(
        args,
        "",
        1,
        "error: unknown variable: missing\n  ┌─ document.typ:1:1\n",
      );
    });
    await assert.rejects(
      broken.compile({
        input: { kind: "file", path: "document.typ" },
        output: { kind: "memory" },
        format,
      }),
      (error) => {
        assert.ok(error instanceof TypstCompilationError);
        assert.equal(error.process.exitCode, 1);
        assert.match(
          error.process.stderr.toString(),
          /unknown variable: missing/u,
        );
        assert.equal(error.process.args.at(-1), "-");
        return true;
      },
    );
    assert.deepEqual(seen, ["-"], `${format} must run only once`);
  }
});

test("memory PNG with an explicit pages selection keeps page files", async () => {
  const seen = [];
  const png = client("0.15.1", (args) => {
    const template = args.at(-1);
    seen.push(template);
    writeFileSync(template.replace("{p}-of-{t}", "2-of-10"), "two");
    return result(args);
  });
  const output = await png.compile({
    input: { kind: "file", path: "document.typ" },
    output: { kind: "memory" },
    format: "png",
    pages: ["2"],
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /output-\{p\}-of-\{t\}\.png$/u);
  assert.equal(output.outputs[0].page, 2);
  assert.equal(output.outputs[0].data.toString(), "two");
});

test("ignoreSystemFonts is gated at exact 0.12.0", async () => {
  const before = client("0.11.0", () => result(["compile"]));
  await assert.rejects(
    before.compile({
      input: { kind: "file", path: "document.typ" },
      ignoreSystemFonts: true,
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "ignoreSystemFonts" &&
      error.requiredVersion === "0.12.0",
  );

  let seen;
  const since = client("0.12.0", (args) => {
    seen = args;
    return result(args, "PDF");
  });
  await since.compile({
    input: { kind: "file", path: "document.typ" },
    ignoreSystemFonts: true,
  });
  assert.equal(seen.includes("--ignore-system-fonts"), true);

  const invalid = client("0.15.1", () => result(["compile"]));
  await assert.rejects(
    invalid.compile({
      input: { kind: "file", path: "document.typ" },
      ignoreSystemFonts: 1,
    }),
    TypstInvalidArgumentError,
  );
});

test("file PNG destinations use deterministic page templates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    const png = client("0.15.1", (args) => {
      const template = args.at(-1);
      writeFileSync(template.replace("{0p}-of-{t}", "02-of-10"), "two");
      writeFileSync(template.replace("{0p}-of-{t}", "10-of-10"), "ten");
      return result(args);
    });
    const output = await png.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "document.png") },
    });
    assert.deepEqual(
      output.outputs.map((item) => item.page),
      [2, 10],
    );
    assert.match(output.outputs[0].path, /02-of-10\.png$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-0.12.0 file PNG destinations use the {n} page template", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    let observed;
    const png = client("0.11.0", (args) => {
      observed = args;
      const template = args.at(-1);
      writeFileSync(template.replace("{n}", "02"), "two");
      writeFileSync(template.replace("{n}", "10"), "ten");
      return result(args);
    });
    const output = await png.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "document.png") },
    });
    assert.equal(basename(observed.at(-1)), "document-{n}.png");
    assert.deepEqual(
      output.outputs.map((item) => item.page),
      [2, 10],
    );
    assert.match(output.outputs[0].path, /-02\.png$/u);
    assert.equal(output.outputs[0].mediaType, "image/png");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("extension-less file PNG/SVG destinations synthesize the format extension", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    let modernArgs;
    const modern = client("0.15.1", (args) => {
      modernArgs = args;
      writeFileSync(args.at(-1).replace("{0p}-of-{t}", "1-of-1"), "PNG");
      return result(args);
    });
    const png = await modern.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "image") },
      format: "png",
    });
    assert.equal(basename(modernArgs.at(-1)), "image-{0p}-of-{t}.png");
    assert.equal(modernArgs.includes("--format"), true);
    assert.equal(png.outputs[0].path, join(directory, "image-1-of-1.png"));
    assert.equal(png.outputs[0].page, 1);
    assert.equal(png.outputs[0].mediaType, "image/png");

    let legacyArgs;
    const legacy = client("0.11.0", (args) => {
      legacyArgs = args;
      writeFileSync(args.at(-1).replace("{n}", "1"), "PNG");
      return result(args);
    });
    const oldPng = await legacy.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "image") },
      format: "png",
    });
    assert.equal(basename(legacyArgs.at(-1)), "image-{n}.png");
    assert.equal(oldPng.outputs[0].path, join(directory, "image-1.png"));
    assert.equal(oldPng.outputs[0].page, 1);
    assert.equal(oldPng.outputs[0].mediaType, "image/png");

    let svgArgs;
    const svgClient = client("0.15.1", (args) => {
      svgArgs = args;
      writeFileSync(args.at(-1).replace("{0p}-of-{t}", "1-of-1"), "<svg/>");
      return result(args);
    });
    const svg = await svgClient.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "image") },
      format: "svg",
    });
    assert.equal(basename(svgArgs.at(-1)), "image-{0p}-of-{t}.svg");
    assert.equal(svg.outputs[0].path, join(directory, "image-1-of-1.svg"));
    assert.equal(svg.outputs[0].page, 1);
    assert.equal(svg.outputs[0].mediaType, "image/svg+xml");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file PNG output never deletes unrelated or stale files in the destination", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    writeFileSync(join(directory, "document-02-of-10.png"), "stale-two");
    writeFileSync(join(directory, "document-10-of-10.png"), "stale-ten");
    let template;
    const png = client("0.15.1", (args) => {
      template = args.at(-1);
      writeFileSync(template.replace("{0p}-of-{t}", "01-of-01"), "current");
      return result(args);
    });
    const output = await png.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "document.png") },
    });
    // The compiler renders into a private staging directory.
    assert.equal(basename(template), "document-{0p}-of-{t}.png");
    assert.notEqual(dirname(template), directory);
    assert.deepEqual(
      output.outputs.map((item) => item.path),
      [join(directory, "document-01-of-01.png")],
    );
    assert.equal(
      readFileSync(join(directory, "document-01-of-01.png"), "utf8"),
      "current",
    );
    // Files this run did not produce are left alone.
    assert.equal(existsSync(join(directory, "document-02-of-10.png")), true);
    assert.equal(existsSync(join(directory, "document-10-of-10.png")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed file PNG compile leaves the destination untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    writeFileSync(join(directory, "document-01-of-01.png"), "previous");
    const png = client("0.15.1", (args) => {
      writeFileSync(args.at(-1).replace("{0p}-of-{t}", "01-of-01"), "partial");
      return result(args, "", 1, "error: boom");
    });
    await assert.rejects(
      png.compile({
        input: { kind: "file", path: "document.typ" },
        output: { kind: "file", path: join(directory, "document.png") },
      }),
      TypstCompilationError,
    );
    assert.equal(
      readFileSync(join(directory, "document-01-of-01.png"), "utf8"),
      "previous",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("page numbers come from the template placeholder, not from dashes or dots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    const png = client("0.15.1", (args) => {
      writeFileSync(args.at(-1).replace("{p}", "3"), "three");
      writeFileSync(args.at(-1).replace("{p}", "12"), "twelve");
      return result(args);
    });
    const output = await png.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "a-1.5-{p}.png") },
    });
    assert.deepEqual(
      output.outputs.map((item) => item.page),
      [3, 12],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relative paths that start with a dash are not passed as flags", async () => {
  let observed;
  const pdf = client("0.15.1", (args) => {
    observed = args;
    return result(args);
  });
  await pdf
    .compile({ input: "-draft.typ", output: "-out.pdf" })
    .catch(() => undefined);
  assert.equal(observed.includes("-draft.typ"), false);
  assert.equal(observed.includes("./-draft.typ"), true);
  assert.equal(observed.includes("./-out.pdf"), true);
});

test("file PNG results include a pre-existing page overwritten by the run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    writeFileSync(join(directory, "document-01-of-01.png"), "old");
    writeFileSync(join(directory, "document-02-of-10.png"), "stale");
    const png = client("0.15.1", (args) => {
      writeFileSync(args.at(-1).replace("{0p}-of-{t}", "01-of-01"), "current");
      return result(args);
    });
    const output = await png.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "document.png") },
    });
    assert.deepEqual(
      output.outputs.map((item) => item.page),
      [1],
    );
    assert.deepEqual(
      output.outputs.map((item) => item.path),
      [join(directory, "document-01-of-01.png")],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file PNG page collection does not rely on timestamp granularity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    const fixed = new Date("2020-01-01T00:00:00Z");
    writeFileSync(join(directory, "document-01-of-01.png"), "stale");
    utimesSync(join(directory, "document-01-of-01.png"), fixed, fixed);
    const before = statSync(join(directory, "document-01-of-01.png"));
    const png = client("0.15.1", (args) => {
      // Simulate a coarse filesystem: the overwrite keeps the exact same
      // size and an unchanged mtime as the stale file it replaces.
      const target = args.at(-1).replace("{0p}-of-{t}", "01-of-01");
      writeFileSync(target, "stale");
      utimesSync(target, fixed, fixed);
      return result(args);
    });
    const output = await png.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "document.png") },
    });
    // Even though size and mtime are identical before and after, the page
    // must be reported because the destination is cleaned before the run.
    assert.deepEqual(
      output.outputs.map((item) => item.page),
      [1],
    );
    assert.deepEqual(
      output.outputs.map((item) => item.path),
      [join(directory, "document-01-of-01.png")],
    );
    const after = statSync(join(directory, "document-01-of-01.png"));
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("page numbers are parsed from the file basename only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  const target = join(directory, "docs-2024.1");
  mkdirSync(target, { recursive: true });
  try {
    const png = client("0.15.1", (args) => {
      writeFileSync(args.at(-1).replace("{0p}-of-{t}", "01-of-01"), "PNG");
      return result(args);
    });
    const output = await png.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(target, "document.png") },
    });
    assert.deepEqual(
      output.outputs.map((item) => item.page),
      [1],
    );

    const legacy = client("0.11.0", (args) => {
      writeFileSync(args.at(-1).replace("{n}", "1"), "PNG");
      return result(args);
    });
    const oldOutput = await legacy.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(target, "legacy.png") },
    });
    assert.deepEqual(
      oldOutput.outputs.map((item) => item.page),
      [1],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("drive-root destinations keep the full page template basename", () => {
  const root = parsePath(process.cwd()).root;
  const legacy = pageFilePattern(`${root}page-{n}.png`, root);
  assert.equal(legacy.directory, root);
  assert.equal(legacy.matcher.test("page-1.png"), true);
  assert.equal(legacy.matcher.test("xpage-1.png"), false);

  const modern = pageFilePattern(`${root}page-{0p}-of-{t}.png`, root);
  assert.equal(modern.matcher.test("page-02-of-10.png"), true);
  assert.equal(modern.matcher.test("page-2.png"), false);
});
test("modern page placeholders are rejected before 0.12.0", async () => {
  const old = client("0.11.0", () => result(["compile"]));
  for (const placeholder of ["{p}", "{0p}", "{t}"]) {
    await assert.rejects(
      old.compile({
        input: { kind: "file", path: "document.typ" },
        output: { kind: "file", path: `page-${placeholder}.png` },
        format: "png",
      }),
      TypstInvalidArgumentError,
    );
  }
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    const legacy = client("0.11.0", (args) => {
      writeFileSync(args.at(-1).replace("{n}", "01"), "PNG");
      return result(args);
    });
    await legacy.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "page-{n}.png") },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relative file outputs use compile cwd for inspection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-cwd-"));
  try {
    let seenArgs;
    let seenOptions;
    const compiler = client("0.15.1", (args, options) => {
      seenArgs = args;
      seenOptions = options;
      writeFileSync(join(directory, args.at(-1)), "PDF");
      return result(args);
    });
    const output = await compiler.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "relative.pdf" },
      cwd: directory,
    });
    assert.equal(seenArgs.at(-1), "relative.pdf");
    assert.equal(seenOptions.cwd, directory);
    assert.equal(output.outputs[0].path, join(directory, "relative.pdf"));
    assert.equal(output.outputs[0].mediaType, "application/pdf");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("client-level cwd is honored when collecting relative outputs", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "typst-api-compile-client-cwd-"),
  );
  try {
    let seenOptions;
    const compiler = new TypstClientImpl(
      {
        executable: node,
        source: "explicit",
        cwd: directory,
        env: process.env,
      },
      {},
    );
    compiler.run = async (args, options) => {
      if (args[0] === "--version") return result(args, "Typst 0.15.1");
      seenOptions = options;
      writeFileSync(join(directory, args.at(-1)), "PDF");
      return result(args);
    };
    const output = await compiler.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "relative.pdf" },
    });
    assert.equal(seenOptions.cwd, directory);
    assert.equal(output.outputs[0].path, join(directory, "relative.pdf"));
    assert.equal(output.outputs[0].mediaType, "application/pdf");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("client-level cwd is honored for per-page png outputs", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "typst-api-compile-client-cwd-"),
  );
  try {
    const compiler = new TypstClientImpl(
      {
        executable: node,
        source: "explicit",
        cwd: directory,
        env: process.env,
      },
      {},
    );
    compiler.run = async (args, options) => {
      if (args[0] === "--version") return result(args, "Typst 0.15.1");
      writeFileSync(args.at(-1).replace("{0p}-of-{t}", "1-of-1"), "PNG");
      return result(args);
    };
    const output = await compiler.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "pages-{0p}-of-{t}.png" },
    });
    assert.equal(output.outputs.length, 1);
    assert.equal(output.outputs[0].path, join(directory, "pages-1-of-1.png"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown versions and unsupported features fail before compile spawn", async () => {
  let calls = 0;
  const unknown = client("0.16.0", (args) => {
    calls += 1;
    return result(args);
  });
  await assert.rejects(
    unknown.compile({ input: { kind: "file", path: "doc.typ" } }),
    UnsupportedTypstVersionError,
  );
  assert.equal(calls, 0);

  const unsupported = client("0.12.0", () => {
    calls += 1;
    return result(["compile"]);
  });
  await assert.rejects(
    unsupported.compile({
      input: { kind: "file", path: "doc.typ" },
      format: "html",
      features: ["html"],
    }),
    UnsupportedTypstFeatureError,
  );
});

test("experimental feature values respect their exact release boundaries", async () => {
  const html = client("0.13.0", (args) => {
    writeFileSync(args.at(-1), "html");
    return result(args);
  });
  const htmlResult = await html.compile({
    input: { kind: "file", path: "doc.typ" },
    format: "html",
    features: ["html"],
    output: { kind: "memory" },
  });
  assert.equal(htmlResult.outputs[0].data.toString(), "html");
  assert.equal(htmlResult.outputs[0].mediaType, "text/html");

  // The html feature flag is implied by the html format.
  let impliedArgs;
  const htmlWithoutFeature = client("0.13.0", (args) => {
    impliedArgs = args;
    writeFileSync(args.at(-1), "html");
    return result(args);
  });
  await htmlWithoutFeature.compile({
    input: { kind: "file", path: "doc.typ" },
    format: "html",
  });
  assert.equal(impliedArgs[impliedArgs.indexOf("--features") + 1], "html");
  // Before 0.13.0 there is no html output at all.
  const htmlBefore = client("0.12.0", () => result(["compile"]));
  await assert.rejects(
    htmlBefore.compile({
      input: { kind: "file", path: "doc.typ" },
      format: "html",
    }),
    UnsupportedTypstFeatureError,
  );

  const a11yBefore = client("0.13.1", () => result(["compile"]));
  await assert.rejects(
    a11yBefore.compile({
      input: { kind: "file", path: "doc.typ" },
      features: ["a11y-extras"],
    }),
    UnsupportedTypstFeatureError,
  );
  const a11ySince = client("0.14.0", (args) => result(args, "PDF"));
  await a11ySince.compile({
    input: { kind: "file", path: "doc.typ" },
    features: ["a11y-extras"],
  });

  const bundleBefore = client("0.14.2", () => result(["compile"]));
  await assert.rejects(
    bundleBefore.compile({
      input: { kind: "file", path: "doc.typ" },
      format: "bundle",
      features: ["bundle"],
      output: { kind: "memory" },
    }),
    UnsupportedTypstFeatureError,
  );

  // From 0.15.0 bundle output is available and still needs the `bundle`
  // feature flag, which the bundle format implies.
  let bundleArgs;
  const bundleWithoutFeature = client("0.15.0", (args) => {
    bundleArgs = args;
    writeFileSync(join(args.at(-1), "index.html"), "<html></html>");
    return result(args);
  });
  await bundleWithoutFeature.compile({
    input: { kind: "file", path: "doc.typ" },
    format: "bundle",
    output: { kind: "memory" },
  });
  assert.equal(bundleArgs[bundleArgs.indexOf("--features") + 1], "bundle");
  // The feature value keeps its exact 0.15.0 boundary; bundle *output* is
  // exercised separately with a mocked multi-file directory.
  const bundleFeature = client("0.15.0", (args) => result(args, "PDF"));
  await bundleFeature.compile({
    input: { kind: "file", path: "doc.typ" },
    features: ["bundle"],
  });
});

test("virtual source paths remain nested for temp fallback and reject escapes", async () => {
  let observed;
  const old = client("0.10.0", (args) => {
    observed = args.at(-2);
    writeOutput(args);
    return result(args);
  });
  await old.compile({
    input: { kind: "source", data: "= hi", virtualPath: "nested/ü.typ" },
  });
  assert.match(observed, /nested[\\/]ü\.typ$/u);
  const unsafe = client("0.10.0", () => result(["compile"]));
  await assert.rejects(
    unsafe.compile({
      input: { kind: "source", data: "= no", virtualPath: "../escape.typ" },
    }),
  );
});

test("natural non-zero compile exits retain raw evidence", async () => {
  let sourcePath;
  const failing = client("0.10.0", (args) => {
    sourcePath = args.at(-2);
    return result(args, "out", 2, "diagnostic");
  });
  await assert.rejects(
    failing.compile({ input: { kind: "source", data: "= fail" } }),
    (error) => {
      assert.equal(error instanceof TypstCompilationError, true);
      assert.equal(error.compilerVersion, "0.10.0");
      assert.equal(error.process.exitCode, 2);
      assert.equal(error.process.stderr.toString(), "diagnostic");
      return true;
    },
  );
  assert.equal(existsSync(sourcePath), false);
});

test("compile temporary source is cleaned on abort", async () => {
  let sourcePath;
  const aborted = client("0.10.0", (args) => {
    sourcePath = args.at(-2);
    throw new TypstAbortError("aborted", result(args));
  });
  await assert.rejects(
    aborted.compile({ input: { kind: "source", data: "= abort" } }),
    TypstAbortError,
  );
  assert.equal(existsSync(sourcePath), false);
});

test("compile temporary source is cleaned on timeout and spawn failure", async () => {
  let timeoutPath;
  const timedOut = client("0.10.0", (args) => {
    timeoutPath = args.at(-2);
    throw new TypstTimeoutError("timeout", result(args));
  });
  await assert.rejects(
    timedOut.compile({ input: { kind: "source", data: "= timeout" } }),
    TypstTimeoutError,
  );
  assert.equal(existsSync(timeoutPath), false);

  let spawnPath;
  const spawned = client("0.10.0", (args) => {
    spawnPath = args.at(-2);
    throw new TypstSpawnError("spawn", result(args));
  });
  await assert.rejects(
    spawned.compile({ input: { kind: "source", data: "= spawn" } }),
    TypstSpawnError,
  );
  assert.equal(existsSync(spawnPath), false);
});

test("successful compile with missing output is a typed failure", async () => {
  const missing = client("0.15.1", (args) => result(args));
  await assert.rejects(
    missing.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "missing.pdf" },
    }),
    (error) => {
      assert.equal(error instanceof TypstCompilationError, true);
      assert.equal(error.process.exitCode, 0);
      return true;
    },
  );
});

test("deps gates --make-deps at exact 0.12.0 and reads the file back", async () => {
  const before = client("0.11.1", () => result(["compile"]));
  await assert.rejects(
    before.compile({
      input: { kind: "file", path: "document.typ" },
      depsPath: "deps.mk",
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "depsPath" &&
      error.requiredVersion === "0.12.0",
  );

  const directory = mkdtempSync(join(tmpdir(), "typst-api-deps-test-"));
  try {
    let seen;
    const at = client("0.12.0", (args) => {
      seen = args;
      writeFileSync(join(directory, "out.pdf"), "PDF");
      writeFileSync(join(directory, "deps.mk"), "out.pdf: main.typ\n");
      return result(args);
    });
    const outcome = await at.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "out.pdf") },
      depsPath: join(directory, "deps.mk"),
    });
    assert.equal(seen.includes("--make-deps"), true);
    assert.equal(
      seen[seen.indexOf("--make-deps") + 1],
      join(directory, "deps.mk"),
    );
    assert.equal(seen.includes("--deps"), false);
    assert.deepEqual(outcome.dependencies, {
      format: "make",
      path: join(directory, "deps.mk"),
      data: Buffer.from("out.pdf: main.typ\n"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deps uses --deps and --deps-format from exact 0.14.0", async () => {
  const before = client("0.13.1", () => result(["compile"]));
  await assert.rejects(
    before.compile({
      input: { kind: "file", path: "document.typ" },
      depsPath: "deps.json",
      depsFormat: "json",
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "depsFormat" &&
      error.requiredVersion === "0.14.0",
  );

  const directory = mkdtempSync(join(tmpdir(), "typst-api-deps-test-"));
  try {
    let seen;
    const at = client("0.14.0", (args) => {
      seen = args;
      writeFileSync(join(directory, "out.pdf"), "PDF");
      writeFileSync(join(directory, "deps.json"), '{"inputs":["main.typ"]}');
      return result(args);
    });
    const outcome = await at.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "out.pdf") },
      depsPath: join(directory, "deps.json"),
      depsFormat: "json",
    });
    assert.equal(seen.includes("--make-deps"), false);
    assert.equal(
      seen[seen.indexOf("--deps") + 1],
      join(directory, "deps.json"),
    );
    assert.deepEqual(
      seen.slice(
        seen.indexOf("--deps-format"),
        seen.indexOf("--deps-format") + 2,
      ),
      ["--deps-format", "json"],
    );
    assert.deepEqual(outcome.dependencies, {
      format: "json",
      path: join(directory, "deps.json"),
      data: Buffer.from('{"inputs":["main.typ"]}'),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deps '-' streams to stdout and is rejected with memory output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-deps-test-"));
  try {
    let seen;
    const typst = client("0.15.1", (args) => {
      seen = args;
      writeFileSync(join(directory, "out.pdf"), "PDF");
      return result(args, '{"inputs":["main.typ"]}');
    });
    const outcome = await typst.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "out.pdf") },
      depsPath: "-",
    });
    assert.deepEqual(
      seen.slice(seen.indexOf("--deps"), seen.indexOf("--deps") + 2),
      ["--deps", "-"],
    );
    assert.deepEqual(outcome.dependencies, {
      format: "json",
      data: Buffer.from('{"inputs":["main.typ"]}'),
    });

    const conflict = client("0.15.1", () => result(["compile"]));
    await assert.rejects(
      conflict.compile({
        input: { kind: "file", path: "document.typ" },
        output: { kind: "memory" },
        depsPath: "-",
      }),
      TypstInvalidArgumentError,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deps '-' is rejected before 0.14.0", async () => {
  const old = client("0.13.1", () => result(["compile"]));
  await assert.rejects(
    old.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: "out.pdf" },
      depsPath: "-",
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.requiredVersion === "0.14.0",
  );
});

test("deps defaults to json format from 0.14.0 without an explicit format", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-deps-test-"));
  try {
    const typst = client("0.15.1", (args) => {
      writeFileSync(join(directory, "out.pdf"), "PDF");
      writeFileSync(join(directory, "deps.json"), "[]");
      return result(args);
    });
    const outcome = await typst.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "out.pdf") },
      depsPath: join(directory, "deps.json"),
    });
    assert.equal(outcome.dependencies.format, "json");
    assert.equal(outcome.dependencies.path, join(directory, "deps.json"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deps rejects unknown formats and a missing deps file is a typed failure", async () => {
  const bad = client("0.15.1", () => result(["compile"]));
  await assert.rejects(
    bad.compile({
      input: { kind: "file", path: "document.typ" },
      depsPath: "deps.json",
      depsFormat: "xml",
    }),
    TypstInvalidArgumentError,
  );

  const directory = mkdtempSync(join(tmpdir(), "typst-api-deps-test-"));
  try {
    const missing = client("0.15.1", (args) => {
      writeOutput(args);
      return result(args);
    });
    await assert.rejects(
      missing.compile({
        input: { kind: "file", path: join(directory, "document.typ") },
        output: { kind: "file", path: join(directory, "out.pdf") },
        depsPath: join(directory, "missing-deps.json"),
      }),
      (error) => {
        assert.equal(error instanceof TypstCompilationError, true);
        assert.equal(error.process.exitCode, 0);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pretty is gated at the exact 0.15.0 boundary", async () => {
  const before = client("0.14.2", () => result(["compile"]));
  await assert.rejects(
    before.compile({
      input: { kind: "file", path: "document.typ" },
      pretty: true,
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "pretty" &&
      error.requiredVersion === "0.15.0",
  );

  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    let seen;
    const at = client("0.15.0", (args) => {
      seen = args;
      writeOutput(args);
      return result(args);
    });
    await at.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "out.pdf") },
      pretty: true,
    });
    assert.equal(seen.includes("--pretty"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("noPdfTags is gated at the exact 0.14.0 boundary", async () => {
  const before = client("0.13.1", () => result(["compile"]));
  await assert.rejects(
    before.compile({
      input: { kind: "file", path: "document.typ" },
      noPdfTags: true,
    }),
    (error) =>
      error instanceof UnsupportedTypstFeatureError &&
      error.feature === "noPdfTags" &&
      error.requiredVersion === "0.14.0",
  );

  const directory = mkdtempSync(join(tmpdir(), "typst-api-compile-test-"));
  try {
    let seen;
    const at = client("0.14.0", (args) => {
      seen = args;
      writeOutput(args);
      return result(args);
    });
    await at.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: join(directory, "out.pdf") },
      noPdfTags: true,
    });
    assert.equal(seen.includes("--no-pdf-tags"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bundle serializes the destination as a directory root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-bundle-test-"));
  try {
    const root = join(directory, "out.bundle");
    // The compiler writes into the staging directory passed as the output.
    const typst = client("0.15.1", (args) => {
      const staged = args.at(-1);
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(staged, "index.html"), "<html>Hello</html>");
      writeFileSync(join(staged, "styles.css"), "body{}");
      return result(args);
    });
    const outcome = await typst.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "file", path: root },
      format: "bundle",
      features: ["bundle"],
    });
    assert.equal(outcome.format, "bundle");
    assert.equal(outcome.outputs.length, 2);
    const html = outcome.outputs.find(
      (item) => item.relativePath === "index.html",
    );
    assert.equal(html.kind, "file");
    assert.equal(html.mediaType, "text/html");
    assert.equal(html.path, join(root, "index.html"));
    const css = outcome.outputs.find(
      (item) => item.relativePath === "styles.css",
    );
    assert.equal(css.mediaType, "text/css");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bundle memory output reads the temporary bundle root into buffers", async () => {
  let seenRoot;
  const typst = client("0.15.1", (args) => {
    seenRoot = args.at(-1);
    mkdirSync(join(seenRoot, "nested"), { recursive: true });
    writeFileSync(join(seenRoot, "index.html"), "<html>Hello</html>");
    writeFileSync(join(seenRoot, "nested", "asset.png"), "PNG");
    return result(args);
  });
  const outcome = await typst.compile({
    input: { kind: "source", data: '#document("index.html")[hi]' },
    output: { kind: "memory" },
    format: "bundle",
    features: ["bundle"],
  });
  assert.equal(outcome.outputs.length, 2);
  const nested = outcome.outputs.find(
    (item) => item.relativePath === "nested/asset.png",
  );
  assert.equal(nested.kind, "memory");
  assert.equal(nested.data.toString(), "PNG");
  assert.equal(nested.mediaType, "image/png");
  assert.equal(existsSync(seenRoot), false);
});

test("bundle output with no produced files is a typed compilation error", async () => {
  const typst = client("0.15.1", (args) => {
    mkdirSync(args.at(-1), { recursive: true });
    return result(args);
  });
  await assert.rejects(
    typst.compile({
      input: { kind: "file", path: "document.typ" },
      output: { kind: "memory" },
      format: "bundle",
      features: ["bundle"],
    }),
    (error) => {
      assert.equal(error instanceof TypstCompilationError, true);
      assert.equal(error.process.exitCode, 0);
      return true;
    },
  );
});

test("file bundle output lists only this run's files and keeps the rest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-bundle-file-"));
  const target = join(directory, "site");
  mkdirSync(join(target, "old"), { recursive: true });
  writeFileSync(join(target, "old", "stale.html"), "stale");
  writeFileSync(join(target, "index.html"), "previous");
  try {
    let staged;
    const typst = client("0.15.1", (args) => {
      staged = args.at(-1);
      mkdirSync(join(staged, "posts"), { recursive: true });
      writeFileSync(join(staged, "index.html"), "<html>new</html>");
      writeFileSync(join(staged, "posts", "a.html"), "<html>a</html>");
      return result(args);
    });
    const output = await typst.compile({
      input: "site.typ",
      output: target,
      format: "bundle",
    });
    assert.notEqual(
      staged,
      target,
      "the compiler writes into a staging directory",
    );
    assert.deepEqual(output.outputs.map((item) => item.relativePath).sort(), [
      "index.html",
      "posts/a.html",
    ]);
    assert.equal(
      readFileSync(join(target, "index.html"), "utf8"),
      "<html>new</html>",
    );
    assert.equal(
      readFileSync(join(target, "old", "stale.html"), "utf8"),
      "stale",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
