import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createToolset } from "../src/tools/index.mjs";
import { globToRegExp, resolveWithinRoot, truncateOutput } from "../src/workspace.mjs";

let dir;
let tools;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "halo-scan-unit-"));
  await mkdir(path.join(dir, "lib"), { recursive: true });
  await writeFile(path.join(dir, "lib", "util.py"), "def greet(name):\n    return f'hi {name}'\n\nclass Greeter:\n    pass\n");
  await writeFile(path.join(dir, "lib", "use.py"), "from util import greet\nprint(greet('x'))\n");
  await writeFile(
    path.join(dir, "lib", "store.mjs"),
    [
      'import { greet } from "./util.mjs";',
      "",
      "export class Store {",
      "  constructor() {",
      "    this.items = [];",
      "  }",
      "",
      "  add(item) {",
      "    this.items.push(item);",
      "    return greet(item);",
      "  }",
      "}",
      "",
      "export function add(a, b) {",
      "  return a + b;",
      "}",
      "",
      "export const big = () => {",
      ...Array.from({ length: 30 }, (_, i) => `  step${i}();`),
      "};",
    ].join("\n"),
  );
  await writeFile(path.join(dir, "notes.txt"), "add a note\n");
  tools = Object.fromEntries(createToolset({ workspaceRoot: dir }).map((t) => [t.name, t]));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("resolveWithinRoot blocks escapes", () => {
  assert.equal(resolveWithinRoot(dir, "lib/util.py"), path.join(dir, "lib", "util.py"));
  assert.throws(() => resolveWithinRoot(dir, "../x"), /outside/);
});

test("globToRegExp matches ** patterns", () => {
  const re = globToRegExp("lib/**/*.py");
  assert.equal(re.test("lib/util.py"), true);
  assert.equal(re.test("lib/a/b.py"), true);
  assert.equal(re.test("src/util.py"), false);
});

test("truncateOutput keeps head and tail", () => {
  const s = "a".repeat(1000);
  const out = truncateOutput(s, 200);
  assert.ok(out.length < 1000);
  assert.match(out, /chars omitted/);
});

test("find_symbol finds Python defs", async () => {
  const text = await tools.find_symbol.execute({ name: "greet" });
  assert.match(text, /util\.py:1/);
});

test("find_references finds Python call sites", async () => {
  const text = await tools.find_references.execute({ name: "greet" });
  assert.match(text, /use\.py/);
});

test("find_references tags hits with the enclosing symbol", async () => {
  const text = await tools.find_references.execute({ name: "greet", path: "lib/store.mjs" });
  assert.match(text, /store\.mjs:10: return greet\(item\);  \[in Store\.add\]/);
  assert.doesNotMatch(text, /store\.mjs:1:.*\[in/, "import line is outside any symbol");
});

test("grep_search tags code hits but leaves plain text untagged", async () => {
  const text = await tools.grep_search.execute({ pattern: "add" });
  assert.match(text, /store\.mjs:8: add\(item\) \{  \[def Store\.add\]/);
  assert.match(text, /store\.mjs:14: export function add\(a, b\) \{  \[def add\]/);
  assert.match(text, /^notes\.txt:1: add a note$/m);
});

test("get_symbol returns the full body with line numbers", async () => {
  const text = await tools.get_symbol.execute({ name: "Store.add" });
  assert.match(text, /^lib\/store\.mjs:8-11 method Store\.add$/m);
  assert.match(text, /^8\|  add\(item\) \{$/m);
  assert.match(text, /^11\|  \}$/m);
  assert.doesNotMatch(text, /^12\|/m);
});

test("get_symbol renders every match that fits the budget, exact name first", async () => {
  const both = await tools.get_symbol.execute({ name: "add" });
  const fn = both.indexOf("lib/store.mjs:14-16 function add [exported]");
  const method = both.indexOf("lib/store.mjs:8-11 method Store.add");
  assert.ok(fn !== -1 && method !== -1);
  assert.ok(fn < method, "exact qualified match is rendered before the nested method");
  assert.match(both, /^10\|    return greet\(item\);$/m, "second body is rendered when it fits");
  assert.doesNotMatch(both, /Also defined/);
});

test("get_symbol lists definitions that exceed the budget and honours path to disambiguate", async () => {
  const cut = await tools.get_symbol.execute({ name: "add", max_lines: 5 });
  assert.match(cut, /^lib\/store\.mjs:14-16 function add \[exported\]$/m);
  assert.match(cut, /Also defined at \(1\) — pass path to select:/);
  assert.match(cut, /^  lib\/store\.mjs:8-11 method Store\.add: add\(item\)$/m);
  assert.doesNotMatch(cut, /^8\|/m, "over-budget body is listed, not rendered");

  const only = await tools.get_symbol.execute({ name: "greet", path: "lib/util.py" });
  assert.match(only, /^lib\/util\.py:1-2 function greet \[exported\]$/m);
  assert.doesNotMatch(only, /Also defined/);
});

test("get_symbol caps long bodies with a read_file hint", async () => {
  const text = await tools.get_symbol.execute({ name: "big", max_lines: 5 });
  assert.match(text, /^lib\/store\.mjs:18-49 function big \[exported\]$/m);
  assert.match(text, /^22\|/m);
  assert.doesNotMatch(text, /^23\|/m);
  assert.match(text, /27 more line\(s\); read_file path='lib\/store\.mjs' offset=23 limit=27/);
});

test("get_symbol reports a miss with alternatives", async () => {
  const text = await tools.get_symbol.execute({ name: "doesNotExist" });
  assert.match(text, /No definition found for 'doesNotExist'/);
  await assert.rejects(() => tools.get_symbol.execute({ name: "not valid!" }), /identifier/);
});

test("file_outline on a file shows structure and imports", async () => {
  const text = await tools.file_outline.execute({ path: "lib/store.mjs" });
  assert.match(text, /^lib\/store\.mjs — 49 lines, 5 symbol\(s\), js$/m);
  assert.match(text, /^imports: \.\/util\.mjs$/m);
  assert.match(text, /^3-12 class Store \[exported\]: export class Store$/m);
  assert.match(text, /^  4-6 constructor constructor: constructor\(\)$/m);
  assert.match(text, /^  8-11 method add: add\(item\)$/m);
  assert.match(text, /^14-16 function add \[exported\]/m);

  const noImports = await tools.file_outline.execute({ path: "lib/store.mjs", include_imports: false });
  assert.doesNotMatch(noImports, /^imports:/m);
});

test("file_outline on a directory lists top-level symbols per file", async () => {
  const text = await tools.file_outline.execute({ path: "lib" });
  assert.match(text, /^lib\/ — 3 code file\(s\)$/m);
  assert.match(text, /^lib\/store\.mjs \(49 lines\): class Store\* @3-12, function add\* @14-16, function big\* @18-49$/m);
  assert.match(text, /^lib\/util\.py \(\d+ lines\): function greet\* @1-2, class Greeter\* @4-5$/m);
});

test("file_outline rejects unsupported and missing paths", async () => {
  assert.match(await tools.file_outline.execute({ path: "notes.txt" }), /outline not supported/);
  await assert.rejects(() => tools.file_outline.execute({ path: "nope/missing.js" }), /does not exist/);
  await assert.rejects(() => tools.file_outline.execute({ path: "../x.js" }), /outside/);
});
