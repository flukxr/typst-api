import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  TypstCompilationError,
  TypstEvalError,
  TypstQueryError,
  compareExactStableVersions,
  createTypst,
  jsonInput,
  source,
  configure,
  compile as compileFile,
  pdf as pdfOf,
} from "../dist/index.js";
import { resolveRealTypst } from "./helpers/resolve-real-typst.mjs";
import { keepEditing, withTimeout } from "./helpers/timing.mjs";

const PDF_MAGIC = "%PDF-";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const real = await resolveRealTypst();
const skip =
  real === undefined
    ? "no real Typst executable found (set TYPST_API_TEST_EXECUTABLE or TYPST_PATH)"
    : false;

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "typst-api-real-integration-"));
  return directory;
}

test(
  "real executable exposes an exact version and partial known support",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const version = await client.version();
    assert.match(version.version, /^\d+\.\d+\.\d+$/u);
    assert.ok(version.raw.includes("typst"), version.raw);
    const support = await client.support();
    assert.equal(support.compilerVersion, version.version);
    assert.ok(["partial", "full", "unknown"].includes(support.level));
  },
);

test("real PDF compile from file into memory", { skip }, async () => {
  const directory = temporaryDirectory();
  try {
    const source = join(directory, "document.typ");
    writeFileSync(source, '#set document(title: "hello")\n= Hello');
    const client = await createTypst({ executable: real.executable });
    const result = await client.compile({
      input: { kind: "file", path: source },
      output: { kind: "memory" },
    });
    assert.equal(result.format, "pdf");
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].kind, "memory");
    assert.equal(result.outputs[0].mediaType, "application/pdf");
    assert.equal(result.outputs[0].data.subarray(0, 5).toString(), PDF_MAGIC);
    assert.equal(result.compilerVersion, real.version.split(" ")[1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "real compile accepts string input/output shorthands",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "document.typ");
      writeFileSync(source, "= Hello");
      const client = await createTypst({ executable: real.executable });
      const result = await client.compile({
        input: source,
        output: join(directory, "out.pdf"),
      });
      assert.equal(result.format, "pdf");
      assert.equal(result.outputs.length, 1);
      assert.equal(result.outputs[0].kind, "file");
      assert.equal(result.outputs[0].path, join(directory, "out.pdf"));
      assert.equal(result.outputs[0].data, undefined);
      assert.equal(result.compilerVersion, real.version.split(" ")[1]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("real PDF compile from source string into memory", { skip }, async () => {
  const client = await createTypst({ executable: real.executable });
  const result = await client.compile({
    input: { kind: "source", data: "= From source\n\nHello." },
    output: { kind: "memory" },
  });
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].kind, "memory");
  assert.equal(result.outputs[0].data.subarray(0, 5).toString(), PDF_MAGIC);
});

test("real PDF compile into a file destination", { skip }, async () => {
  const directory = temporaryDirectory();
  try {
    const source = join(directory, "document.typ");
    const target = join(directory, "result.pdf");
    writeFileSync(source, "= Hello");
    const client = await createTypst({ executable: real.executable });
    const result = await client.compile({
      input: { kind: "file", path: source },
      output: { kind: "file", path: target },
    });
    assert.equal(result.outputs[0].kind, "file");
    assert.equal(result.outputs[0].path, target);
    assert.equal(result.outputs[0].mediaType, "application/pdf");
    assert.ok(existsSync(target));
    assert.equal(
      Buffer.from(readFileSync(target)).subarray(0, 5).toString(),
      PDF_MAGIC,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "real compile produces a dependency list when depsPath is requested",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "document.typ");
      const depsFile = join(directory, "deps.json");
      writeFileSync(source, '= Hello\n#let x = read("data.txt")');
      writeFileSync(join(directory, "data.txt"), "payload");
      const client = await createTypst({ executable: real.executable });
      const result = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "file", path: join(directory, "result.pdf") },
        depsPath: depsFile,
      });
      assert.ok(result.dependencies !== undefined);
      assert.equal(result.dependencies.format, "json");
      assert.equal(result.dependencies.path, depsFile);
      const decoded = JSON.parse(result.dependencies.data.toString("utf8"));
      assert.ok(Array.isArray(decoded.inputs));
      assert.ok(decoded.inputs.length >= 2, JSON.stringify(decoded));
      assert.ok(decoded.inputs.some((input) => input.includes("document.typ")));
      assert.ok(decoded.inputs.some((input) => input.includes("data.txt")));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real compile produces HTML when the html feature is enabled",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "document.typ");
      writeFileSync(source, "= Hello");
      const client = await createTypst({ executable: real.executable });
      const result = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "file", path: join(directory, "out.html") },
        format: "html",
        features: ["html"],
      });
      assert.equal(result.format, "html");
      assert.equal(result.outputs[0].kind, "file");
      const html = readFileSync(result.outputs[0].path, "utf8");
      assert.match(html, /<html/u);
      assert.match(html, />Hello</u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real HTML compile honors the pretty flag from 0.15.0",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "document.typ");
      writeFileSync(source, "= Hello");
      const client = await createTypst({ executable: real.executable });
      const version = (await client.version()).version;
      let modern = false;
      try {
        modern = compareExactStableVersions(version, "0.15.0") >= 0;
      } catch {
        // A prerelease binary is not an exact stable version; skip the flag.
      }
      if (!modern) {
        // The mocked boundary suite covers the gate; only modern binaries
        // exercise the flag end to end.
        return;
      }
      const minified = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "memory" },
        format: "html",
        features: ["html"],
      });
      const pretty = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "memory" },
        format: "html",
        features: ["html"],
        pretty: true,
      });
      const plain = minified.outputs[0].data.toString("utf8");
      const formatted = pretty.outputs[0].data.toString("utf8");
      assert.ok(formatted.length >= plain.length);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real info returns raw text and decodes json when requested",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const human = await client.info();
    assert.ok(human.raw.trim().length > 0, "info output must not be empty");
    assert.equal(human.process.exitCode, 0);
    const json = await client.info({ format: "json" });
    assert.equal(typeof json.data, "object");
    assert.ok(json.data !== null);
  },
);

test(
  "real completions generates a shell script for every documented shell",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    for (const shell of ["bash", "elvish", "fish", "powershell", "zsh"]) {
      const result = await client.completions(shell);
      assert.equal(result.process.exitCode, 0);
      assert.ok(
        result.raw.trim().length > 0,
        `${shell} completions must not be empty`,
      );
    }
  },
);

test("real compile handles spaces and non-ASCII paths", { skip }, async () => {
  const directory = join(tmpdir(), "typst-api real ü 输出");
  mkdirSync(directory, { recursive: true });
  try {
    const source = join(directory, "документ typ.typ");
    const target = join(directory, "out put.pdf");
    writeFileSync(source, "= Привет");
    const client = await createTypst({ executable: real.executable });
    const result = await client.compile({
      input: { kind: "file", path: source },
      output: { kind: "file", path: target },
    });
    assert.equal(result.outputs[0].path, target);
    assert.ok(existsSync(target));
    assert.equal(
      Buffer.from(readFileSync(target)).subarray(0, 5).toString(),
      PDF_MAGIC,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "real PNG compile produces ordered page artifacts with PNG magic",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "pages.typ");
      writeFileSync(source, "= Page 1\n#pagebreak()\n= Page 2");
      const client = await createTypst({ executable: real.executable });
      const result = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "memory" },
        format: "png",
        ppi: 72,
      });
      assert.equal(result.outputs.length, 2);
      assert.deepEqual(
        result.outputs.map((output) => output.page),
        [1, 2],
      );
      for (const output of result.outputs) {
        assert.equal(output.kind, "memory");
        assert.equal(output.mediaType, "image/png");
        assert.deepEqual(output.data.subarray(0, 4), PNG_MAGIC);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real single-page PNG and SVG stream into memory from stdout",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "one.typ");
      writeFileSync(source, "= Single page");
      const client = await createTypst({ executable: real.executable });
      const png = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "memory" },
        format: "png",
        ppi: 72,
      });
      assert.equal(png.outputs.length, 1);
      assert.equal(png.outputs[0].page, 1);
      assert.equal(png.outputs[0].mediaType, "image/png");
      assert.deepEqual(png.outputs[0].data.subarray(0, 4), PNG_MAGIC);

      const svg = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "memory" },
        format: "svg",
      });
      assert.equal(svg.outputs.length, 1);
      assert.equal(svg.outputs[0].page, 1);
      assert.equal(svg.outputs[0].mediaType, "image/svg+xml");
      assert.equal(svg.outputs[0].data.toString("utf8").includes("<svg"), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real invalid source is a typed failure retaining raw stderr",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "broken.typ");
      writeFileSync(source, "#unknown-function()");
      const client = await createTypst({ executable: real.executable });
      await assert.rejects(
        client.compile({
          input: { kind: "file", path: source },
          output: { kind: "memory" },
        }),
        (error) => {
          assert.ok(error instanceof TypstCompilationError);
          assert.notEqual(error.process.exitCode, 0);
          assert.equal(error.process.stderr.length > 0, true);
          assert.ok(error.process.stderr.toString().length > 0);
          return true;
        },
      );
      // A syntax error with empty stdout must not trigger the multi-page
      // page-file retry: the original stdout invocation remains the reported
      // process record.
      await assert.rejects(
        client.compile({
          input: { kind: "file", path: source },
          output: { kind: "memory" },
          format: "png",
        }),
        (error) => {
          assert.ok(error instanceof TypstCompilationError);
          assert.equal(error.process.args.at(-1), "-");
          assert.match(error.process.stderr.toString(), /unknown variable/u);
          return true;
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real compile with diagnostics parses structured diagnostics from stderr",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "broken.typ");
      writeFileSync(source, "#unknown-function()");
      const client = await createTypst({ executable: real.executable });
      await assert.rejects(
        client.compile({
          input: { kind: "file", path: source },
          output: { kind: "memory" },
          diagnostics: true,
        }),
        (error) => {
          assert.ok(error instanceof TypstCompilationError);
          assert.ok(Array.isArray(error.process.diagnostics));
          assert.ok(error.process.diagnostics.length >= 1);
          const diagnostic = error.process.diagnostics[0];
          assert.equal(diagnostic.severity, "error");
          assert.ok(diagnostic.message.length > 0);
          // Raw stderr remains authoritative alongside the structured view.
          assert.equal(error.process.stderr.toString().length > 0, true);
          return true;
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("real fonts lists discovered fonts as raw text", { skip }, async () => {
  const client = await createTypst({ executable: real.executable });
  const result = await client.fonts();
  assert.ok(result.raw.trim().length > 0, "fonts output must not be empty");
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.compilerVersion, real.version.split(" ")[1]);
});

test("real fonts exposes a best-effort family list", { skip }, async () => {
  const client = await createTypst({ executable: real.executable });
  const result = await client.fonts();
  assert.ok(Array.isArray(result.families));
  assert.ok(result.families.length > 0, "families must not be empty");
  for (const family of result.families) {
    assert.ok(
      result.raw.includes(family),
      `family ${family} must appear in the raw output`,
    );
  }
});

test(
  "real query decodes elements and queryOne decodes a single element",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const source = "= First\n#pagebreak()\n== Second";
    const result = await client.query({
      input: { kind: "source", data: source },
      selector: "heading",
    });
    assert.equal(result.elements.length, 2);
    for (const element of result.elements) {
      assert.equal(typeof element, "object");
      assert.equal(element.func, "heading");
    }
    assert.equal(result.process.exitCode, 0);

    const one = await client.queryOne({
      input: { kind: "source", data: "#metadata([hi]) <doc>" },
      selector: "<doc>",
    });
    assert.equal(typeof one.element, "object");
    assert.equal(one.element.func, "metadata");
  },
);

test(
  "real query failure is typed and retains raw evidence",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const version = (await client.version()).version;
    const evalBackend = compareExactStableVersions(version, "0.15.0") >= 0;

    // An invalid selector fails inside the compiler with a non-zero exit and
    // raw diagnostics regardless of the backend.
    await assert.rejects(
      client.query({
        input: { kind: "source", data: "= First" },
        selector: "does-not-exist",
      }),
      (error) => {
        assert.ok(error instanceof TypstQueryError);
        assert.notEqual(error.process.exitCode, 0);
        assert.ok(error.process.stderr.length > 0);
        return true;
      },
    );

    // The exactly-one rule is enforced by the compiler on native query and by
    // the wrapper on the eval backend; on 0.15.x the eval process that
    // produced the results genuinely exited 0, so the raw record reflects it.
    await assert.rejects(
      client.queryOne({
        input: { kind: "source", data: "= First\n#pagebreak()\n== Second" },
        selector: "heading",
      }),
      (error) => {
        assert.ok(error instanceof TypstQueryError);
        assert.ok(error.message.includes("expected exactly one element"));
        if (evalBackend) {
          assert.equal(error.process.exitCode, 0);
        } else {
          assert.notEqual(error.process.exitCode, 0);
        }
        return true;
      },
    );
  },
);

test(
  "real watch starts, reports ready, recompiles, and closes cleanly",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    let watcher = null;
    try {
      const source = join(directory, "document.typ");
      writeFileSync(source, "= Hello");
      const client = await createTypst({ executable: real.executable });
      watcher = await client.watch({
        input: { kind: "file", path: source },
        output: { kind: "file", path: join(directory, "out.pdf") },
      });
      assert.equal(watcher.compilerVersion, real.version.split(" ")[1]);

      const ready = new Promise((resolve) => {
        watcher.on("ready", (cycle) => resolve(cycle));
      });
      const first = await withTimeout(
        ready,
        15_000,
        "watcher never reported ready",
      );
      assert.ok(["success", "error"].includes(first.status));
      assert.equal(first.index, 1);

      const secondCycle = new Promise((resolve) => {
        watcher.on("cycle", (cycle) => resolve(cycle));
      });
      const stopEditing = keepEditing(source, "= Hello\n\nChanged");
      const second = await withTimeout(
        secondCycle,
        15_000,
        "watcher did not recompile after edit",
      ).finally(stopEditing);
      assert.equal(second.index, 2);

      const result = await watcher.close();
      const closedResult = await watcher.closed;
      watcher = null;
      assert.equal(closedResult, result);
      assert.equal(result.exitCode !== null || result.signal !== null, true);
      assert.equal(
        result.stdout.toString().length + result.stderr.toString().length > 0,
        true,
      );
    } finally {
      // Close the watcher even when an assertion above failed, so the long-lived
      // process cannot keep the test runner's event loop alive.
      if (watcher !== null) {
        await watcher.close().catch(() => {});
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real eval returns decoded JSON values and raw output",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const version = (await client.version()).version;
    const modern = compareExactStableVersions(version, "0.15.0") >= 0;
    if (!modern) return;

    const arithmetic = await client.eval("1 + 2");
    assert.equal(arithmetic.value, 3);
    assert.equal(arithmetic.raw.trim(), "3");
    assert.equal(arithmetic.format, "json");
    assert.equal(arithmetic.compilerVersion, version);

    const structured = await client.eval("(a: 1, b: (true, none))");
    assert.deepEqual(structured.value, { a: 1, b: [true, null] });

    const context = await client.eval("query(heading)", {
      input: { kind: "source", data: "= First\n#pagebreak()\n== Second" },
    });
    assert.ok(Array.isArray(context.value));
    assert.equal(context.value.length, 2);
    assert.equal(context.value[0].func, "heading");
  },
);

test(
  "real eval failures are typed errors retaining raw diagnostics",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const version = (await client.version()).version;
    if (compareExactStableVersions(version, "0.15.0") < 0) return;

    await assert.rejects(client.eval("does-not-exist"), (error) => {
      assert.ok(error instanceof TypstEvalError);
      assert.ok(error.process.stderr.toString().includes("unknown variable"));
      if (compareExactStableVersions(version, "0.15.1") >= 0) {
        assert.notEqual(error.process.exitCode, 0);
      }
      return true;
    });
  },
);

test(
  "real eval uses the context input and serializes yaml raw",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const version = (await client.version()).version;
    if (compareExactStableVersions(version, "0.15.0") < 0) return;

    const yaml = await client.eval("(1, 2, 3)", { format: "yaml" });
    assert.equal(yaml.format, "yaml");
    assert.match(yaml.raw, /^- 1/u);
    assert.equal("value" in yaml, false);
  },
);

test(
  "real bundle compile writes a multi-file directory",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "bundle.typ");
      writeFileSync(source, '#document("index.html", title: [Home])[= Hello]');
      const client = await createTypst({ executable: real.executable });
      const version = (await client.version()).version;
      if (compareExactStableVersions(version, "0.15.0") < 0) return;

      const root = join(directory, "out.bundle");
      const result = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "file", path: root },
        format: "bundle",
        features: ["bundle", "html"],
      });
      assert.equal(result.format, "bundle");
      assert.ok(result.outputs.length >= 1);
      const html = result.outputs.find(
        (output) => output.relativePath === "index.html",
      );
      assert.equal(html.kind, "file");
      assert.equal(html.mediaType, "text/html");
      assert.ok(existsSync(html.path));
      assert.match(readFileSync(html.path, "utf8"), /Hello/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real bundle compile into memory returns buffers with relative paths",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "bundle.typ");
      writeFileSync(source, '#document("index.html", title: [Home])[= Hello]');
      const client = await createTypst({ executable: real.executable });
      const version = (await client.version()).version;
      if (compareExactStableVersions(version, "0.15.0") < 0) return;

      const result = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "memory" },
        format: "bundle",
        features: ["bundle", "html"],
      });
      assert.ok(result.outputs.length >= 1);
      for (const output of result.outputs) {
        assert.equal(output.kind, "memory");
        assert.equal(typeof output.relativePath, "string");
        assert.ok(output.data.length > 0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "real unified query returns elements through the eval backend on 0.15+",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const version = (await client.version()).version;
    const result = await client.query({
      input: { kind: "source", data: "= First\n#pagebreak()\n== Second" },
      selector: "heading",
    });
    assert.equal(result.elements.length, 2);
    for (const element of result.elements) {
      assert.equal(typeof element, "object");
      assert.equal(element.func, "heading");
    }
    assert.equal(result.process.exitCode, 0);
    if (compareExactStableVersions(version, "0.15.0") >= 0) {
      assert.equal(result.process.args[0], "eval");
    } else {
      assert.equal(result.process.args[0], "query");
    }

    const fields = await client.query({
      input: { kind: "source", data: "= First\n#pagebreak()\n== Second" },
      selector: "heading",
      field: "level",
    });
    assert.deepEqual(fields.elements, [1, 2]);

    const one = await client.queryOne({
      input: { kind: "source", data: "#metadata([hi]) <doc>" },
      selector: "<doc>",
    });
    assert.equal(typeof one.element, "object");
    assert.equal(one.element.func, "metadata");
  },
);

test(
  "real multiple PDF standards are accepted from 0.15.0",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      const source = join(directory, "document.typ");
      writeFileSync(source, "= Hello");
      const client = await createTypst({ executable: real.executable });
      const version = (await client.version()).version;
      if (compareExactStableVersions(version, "0.15.0") < 0) return;

      const result = await client.compile({
        input: { kind: "file", path: source },
        output: { kind: "file", path: join(directory, "out.pdf") },
        pdfStandards: ["1.7", "a-2b"],
      });
      assert.equal(result.format, "pdf");
      assert.ok(existsSync(result.outputs[0].path));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("real executable is discovered through TYPST_PATH", { skip }, async () => {
  const client = await createTypst({
    env: { TYPST_PATH: real.executable },
    discovery: { package: false, path: false },
  });
  assert.equal(client.executableSource, "environment");
  assert.equal(client.executable, real.executable);
  const version = await client.version();
  assert.match(version.version, /^\d+\.\d+\.\d+$/u);
});

test("real executable is discovered through PATH", { skip }, async () => {
  const client = await createTypst({
    env: {
      PATH: `${dirname(real.executable)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    },
    discovery: { package: false, environment: false },
  });
  assert.equal(client.executableSource, "path");
  const version = await client.version();
  assert.match(version.version, /^\d+\.\d+\.\d+$/u);
});

test("real executable passes verifyExecutable probing", { skip }, async () => {
  const client = await createTypst({
    executable: real.executable,
    verifyExecutable: true,
    discovery: { package: false, environment: false, path: false },
  });
  assert.equal(client.executableSource, "explicit");
  const version = await client.version();
  assert.match(version.version, /^\d+\.\d+\.\d+$/u);
});

// A 1x1 transparent PNG, used as an in-memory project asset.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

test(
  "real multi-file project input resolves imports and images in memory",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const version = (await client.version()).version;
    if (compareExactStableVersions(version, "0.11.0") < 0) return;
    const input = {
      kind: "project",
      files: {
        "main.typ":
          '#import "lib/greet.typ": greet\n= #greet("World")\n#image("img/dot.png", width: 1cm)',
        "lib/greet.typ": "#let greet(name) = [Hello, #name!]",
        "img/dot.png": TINY_PNG,
      },
    };
    const pdf = await client.pdf(input);
    assert.equal(pdf.subarray(0, 5).toString("latin1"), PDF_MAGIC);
    const { elements } = await client.query({ input, selector: "heading" });
    assert.equal(elements.length, 1);
    // The project is its own root; combining it with root is rejected.
    await assert.rejects(client.pdf(input, { root: "." }), /project input/u);
  },
);

test("real format shortcuts return ready-to-use values", { skip }, async () => {
  const client = await createTypst({ executable: real.executable });
  const version = (await client.version()).version;
  const source = {
    kind: "source",
    data: "#set page(width: 4cm, height: 2cm)\nOne\n#pagebreak()\nTwo",
  };
  const pdf = await client.pdf(source);
  assert.equal(pdf.subarray(0, 5).toString("latin1"), PDF_MAGIC);
  const pngs = await client.png(source);
  assert.equal(pngs.length, 2);
  for (const png of pngs) assert.deepEqual(png.subarray(0, 4), PNG_MAGIC);
  const svgs = await client.svg(source);
  assert.equal(svgs.length, 2);
  for (const svg of svgs) assert.match(svg, /<svg/u);
  if (compareExactStableVersions(version, "0.13.0") >= 0) {
    // The html feature is implied by the html shortcut.
    const html = await client.html({ kind: "source", data: "= Title" });
    assert.match(html, /<h[12]>Title<\/h[12]>/u);
  }
});

test(
  "real client defaults apply to every compiling command",
  { skip },
  async () => {
    const client = await createTypst({
      executable: real.executable,
      defaults: { inputs: { who: "defaults", extra: "kept" } },
    });
    const source = {
      kind: "source",
      data: "#metadata(sys.inputs) <inputs>",
    };
    const { elements } = await client.query({
      input: source,
      selector: "<inputs>",
      field: "value",
      inputs: { who: "call" },
    });
    assert.deepEqual(elements[0], { who: "call", extra: "kept" });
  },
);

test("real watch exposes a ready promise", { skip }, async () => {
  const directory = temporaryDirectory();
  try {
    const source = join(directory, "document.typ");
    writeFileSync(source, "= Watched");
    const client = await createTypst({ executable: real.executable });
    const watcher = await client.watch({
      input: source,
      output: join(directory, "out.pdf"),
      timeoutMs: 60_000,
    });
    try {
      const cycle = await watcher.ready;
      assert.equal(cycle.index, 1);
      assert.equal(cycle.status, "success");
      assert.equal(existsSync(join(directory, "out.pdf")), true);
    } finally {
      await watcher.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "real compile rejects a millisecond creationTimestamp",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    await assert.rejects(
      client.pdf(
        { kind: "source", data: "x" },
        { creationTimestamp: Date.now() },
      ),
      /milliseconds/u,
    );
    const pdf = await client.pdf(
      { kind: "source", data: "x" },
      { creationTimestamp: new Date("2024-01-01T00:00:00Z") },
    );
    assert.equal(pdf.subarray(0, 5).toString("latin1"), PDF_MAGIC);
  },
);

test(
  "real ergonomics: source, warnings, jsonInput, positional query, eval object",
  { skip },
  async () => {
    const client = await createTypst({ executable: real.executable });
    const version = (await client.version()).version;

    // An unknown font family is a warning, not an error.
    const compiled = await client.compile({
      input: source('#set text(font: "No Such Font Family")\nHello'),
    });
    assert.ok(
      compiled.warnings.length >= 1,
      compiled.process.stderr.toString(),
    );
    assert.match(compiled.warnings[0].message, /font/u);

    // Structured data through sys.inputs.
    const { elements } = await client.query(
      source("#metadata(json(bytes(sys.inputs.data))) <data>"),
      "<data>",
      {
        field: "value",
        inputs: { data: jsonInput({ total: 3, tags: ["a"] }) },
      },
    );
    assert.deepEqual(elements[0], { total: 3, tags: ["a"] });

    if (compareExactStableVersions(version, "0.15.0") >= 0) {
      const evaluated = await client.eval({ expression: "(1, 2).len()" });
      assert.equal(evaluated.value, 2);
    }
  },
);

test("real compileMany settles every job in order", { skip }, async () => {
  const client = await createTypst({ executable: real.executable });
  const settled = await client.compileMany(
    [
      { input: source("= One") },
      { input: source("#let x = (") },
      { input: source("= Three"), format: "svg" },
    ],
    { concurrency: 2 },
  );
  assert.deepEqual(
    settled.map((item) => item.ok),
    [true, false, true],
  );
  assert.ok(settled[1].error instanceof TypstCompilationError);
  assert.match(settled[2].result.outputs[0].data.toString(), /<svg/u);
});

test("real watch is async-iterable over compile cycles", { skip }, async () => {
  const directory = temporaryDirectory();
  try {
    const sourcePath = join(directory, "document.typ");
    writeFileSync(sourcePath, "= First");
    const client = await createTypst({ executable: real.executable });
    const watcher = await client.watch({
      input: sourcePath,
      output: join(directory, "out.pdf"),
      timeoutMs: 60_000,
    });
    try {
      const seen = [];
      let stopEditing = () => undefined;
      try {
        for await (const cycle of watcher) {
          seen.push(cycle);
          if (seen.length > 1) break;
          stopEditing = keepEditing(sourcePath, "= Second");
        }
      } finally {
        stopEditing();
      }
      assert.deepEqual(
        seen.map((cycle) => cycle.index),
        [1, 2],
      );
      assert.equal(seen[1].status, "success");
    } finally {
      await watcher.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real positional compile writes a file to a file", { skip }, async () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(join(directory, "doc.typ"), "= Positional");
    const client = await createTypst({ executable: real.executable });
    const result = await client.compile(
      join(directory, "doc.typ"),
      join(directory, "doc.pdf"),
    );
    assert.equal(result.outputs.length, 1);
    assert.equal(
      readFileSync(join(directory, "doc.pdf")).subarray(0, 5).toString(),
      PDF_MAGIC,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "real module-level functions use the configured shared client",
  { skip },
  async () => {
    const directory = temporaryDirectory();
    try {
      configure({ executable: real.executable });
      const pdf = await pdfOf(source("= Module"));
      assert.equal(pdf.subarray(0, 5).toString("latin1"), PDF_MAGIC);
      writeFileSync(join(directory, "doc.typ"), "= File");
      const result = await compileFile(
        join(directory, "doc.typ"),
        join(directory, "doc.pdf"),
      );
      assert.equal(result.outputs.length, 1);
    } finally {
      configure();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
