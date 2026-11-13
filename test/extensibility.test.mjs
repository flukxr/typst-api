import assert from "node:assert/strict";
import test from "node:test";

import {
  TypstInvalidArgumentError,
  configure,
  defaultClient,
  source,
} from "../dist/index.js";
import { result, client, node } from "./helpers/mock-typst.mjs";

function recorder(version, stdout = "") {
  const seen = [];
  const typst = client(version, (args) => {
    seen.push(args);
    return result(args, stdout);
  });
  return { typst, seen };
}

test("unknown features and PDF standards pass through to the compiler", async () => {
  const { typst, seen } = recorder("0.15.1", "%PDF-");
  await typst.pdf(source("x"), {
    features: ["html", "future-feature"],
    pdfStandards: ["a-9z"],
  });
  const args = seen.at(-1);
  assert.equal(args[args.indexOf("--features") + 1], "html,future-feature");
  assert.equal(args[args.indexOf("--pdf-standard") + 1], "a-9z");
  // Malformed names are still rejected before spawn.
  await assert.rejects(
    typst.pdf(source("x"), { features: [""] }),
    TypstInvalidArgumentError,
  );
});

test("extraArgs reach every high-level command before positional arguments", async () => {
  const extra = ["--future-flag", "value"];
  const { typst, seen } = recorder("0.15.1", "[]");
  const before = (args, positional) => {
    const flag = args.indexOf("--future-flag");
    assert.ok(flag > 0, args.join(" "));
    assert.equal(args[flag + 1], "value");
    if (positional !== undefined) assert.ok(flag < args.indexOf(positional));
  };

  await typst
    .compile("main.typ", "out.pdf", { extraArgs: extra })
    .catch(() => {});
  before(seen.at(-1), "main.typ");
  await typst.query("doc.typ", "heading", { extraArgs: extra });
  before(seen.at(-1));
  await typst.eval("1", { extraArgs: extra });
  before(seen.at(-1));
  await typst.fonts({ extraArgs: extra });
  before(seen.at(-1));
  await typst.info({ extraArgs: extra });
  before(seen.at(-1));

  for (const extraArgs of ["--flag", [""], [42]]) {
    await assert.rejects(
      typst.pdf(source("x"), { extraArgs }),
      TypstInvalidArgumentError,
    );
  }
});

test("--root and --font-path precede the subcommand before 0.7.0", async () => {
  for (const [version, globalBefore] of [
    ["0.6.0", true],
    ["0.7.0", false],
  ]) {
    const { typst, seen } = recorder(version);
    await typst
      .compile("doc.typ", "out.pdf", { root: "proj", fontPaths: ["fonts"] })
      .catch(() => {});
    const args = seen.at(-1);
    const command = args.indexOf("compile");
    assert.equal(
      args.indexOf("--root") < command,
      globalBefore,
      args.join(" "),
    );
    assert.equal(args.indexOf("--font-path") < command, globalBefore);
  }
});

test("a dashed eval expression goes last, after the options", async () => {
  const { typst, seen } = recorder("0.15.1", "-1");
  await typst.eval("-1", { input: "doc.typ", pretty: true });
  const args = seen.at(-1);
  assert.deepEqual(args.slice(-2), ["--", "-1"]);
  assert.ok(args.indexOf("--in") < args.indexOf("--"));
  assert.ok(args.indexOf("--pretty") < args.indexOf("--"));
});

test("module-level functions share one lazily created, reconfigurable client", async () => {
  configure({ executable: node, discovery: { package: false } });
  const first = await defaultClient();
  assert.equal(await defaultClient(), first, "the client is reused");
  assert.equal(first.executable, node);

  configure({ executable: node, timeoutMs: 1234 });
  const second = await defaultClient();
  assert.notEqual(second, first, "configure() replaces the client");
  assert.equal(second.timeoutMs, 1234);

  assert.throws(() => configure({ timeoutMs: -1 }), TypstInvalidArgumentError);

  // A failed creation is not cached.
  configure({ executable: "definitely-not-a-typst-binary.exe" });
  await assert.rejects(defaultClient());
  configure({ executable: node });
  assert.equal((await defaultClient()).executable, node);
  configure();
});

test("watch passes --format only from exact 0.8.0", async () => {
  const { prepareWatchInvocation } = await import("../dist/commands/watch.js");
  const options = {
    input: { kind: "file", path: "doc.typ" },
    output: { kind: "file", path: "out.pdf" },
    format: "pdf",
  };
  const before = await prepareWatchInvocation(
    undefined,
    "0.7.0",
    "pdf",
    options,
  );
  assert.equal(before.args.includes("--format"), false);
  const since = await prepareWatchInvocation(
    undefined,
    "0.8.0",
    "pdf",
    options,
  );
  assert.equal(since.args[since.args.indexOf("--format") + 1], "pdf");
});

test("compileMany settles a job with a malformed signal instead of failing the batch", async () => {
  const { typst } = recorder("0.15.1", "%PDF-");
  const settled = await typst.compileMany(
    [{ input: source("a") }, { input: source("b"), signal: {} }],
    { signal: new AbortController().signal },
  );
  assert.equal(settled[0].ok, true);
  assert.equal(settled[1].ok, false);
  assert.ok(settled[1].error instanceof TypstInvalidArgumentError);
});
