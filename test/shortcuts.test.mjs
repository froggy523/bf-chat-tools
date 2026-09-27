import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { parseUnifiedDiff, leadingComment, parentsFromSignature } from "../src/analysis.mjs";
import { createToolset, resolveToolCall } from "../src/tools/index.mjs";

let dir;
let tools;
let firstHash;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `git ${args.join(" ")} failed`);
  return r.stdout.trim();
}

const w = (rel, text) => writeFile(path.join(dir, ...rel.split("/")), text);

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "halo-scan-shortcuts-"));
  for (const d of ["src", "test", "tests", "packages/a", "docs"]) await mkdir(path.join(dir, ...d.split("/")), { recursive: true });

  await w(
    "package.json",
    JSON.stringify(
      {
        name: "shortcut-fixture",
        version: "0.0.1",
        type: "module",
        main: "src/index.mjs",
        workspaces: ["packages/*"],
        dependencies: { express: "4.19.0" },
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
  );
  await w("packages/a/package.json", JSON.stringify({ name: "@fx/a", version: "1.0.0", scripts: { build: "tsc" } }));
  await w(".env.example", "API_KEY=\nPORT=3000\n");
  await w("Dockerfile", "FROM node:20\nENV API_KEY=changeme\n");
  await w("src/index.mjs", 'export { greet } from "./greet.mjs";\n\nexport function unusedThing() {\n  return 1;\n}\n');
  await w(
    "src/format.mjs",
    ["/**", " * Formatting helpers.", " */", "export function format(s) {", "  // TODO: localise greeting", "  return `hi ${s}`;", "}", ""].join("\n"),
  );
  await w(
    "src/greet.mjs",
    [
      'import { format } from "./format.mjs";',
      "",
      "export function greet(name) {",
      "  return format(name);",
      "}",
      "",
      "export class Base {",
      "  run() {",
      "    return 1;",
      "  }",
      "}",
      "",
      "export class Child extends Base {",
      "  run() {",
      "    return greet('x');",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await w(
    "src/server.mjs",
    [
      'import express from "express";',
      'import { greet } from "./greet.mjs";',
      "",
      "const app = express();",
      "const key = process.env.API_KEY;",
      "",
      'app.get("/users", (req, res) => res.send(greet("u")));',
      'app.post("/users/:id", (req, res) => res.send(key));',
      'const cache = new Map(); cache.get("not-a-route");',
      "",
    ].join("\n"),
  );
  await w(
    "test/greet.test.mjs",
    [
      'import { test, describe, it } from "node:test";',
      'import { greet } from "../src/greet.mjs";',
      "",
      'test("greet says hi", () => {',
      '  if (greet("a") !== "hi a") throw new Error("nope");',
      "});",
      "",
      'describe("Child", () => {',
      '  it("runs", () => {});',
      "});",
      "",
    ].join("\n"),
  );
  await w("tests/test_util.py", "def test_one():\n    assert True\n\nclass TestFoo:\n    def test_two(self):\n        assert True\n");

  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  firstHash = git(dir, ["rev-parse", "--short", "HEAD"]);

  // Second commit: change greet's body only.
  await w(
    "src/greet.mjs",
    [
      'import { format } from "./format.mjs";',
      "",
      "export function greet(name) {",
      "  const trimmed = String(name).trim();",
      "  return format(trimmed);",
      "}",
      "",
      "export class Base {",
      "  run() {",
      "    return 1;",
      "  }",
      "}",
      "",
      "export class Child extends Base {",
      "  run() {",
      "    return greet('x');",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  git(dir, ["add", "src/greet.mjs"]);
  git(dir, ["commit", "-m", "trim names in greet"]);

  // Working tree: modify format(), add an untracked file.
  await w(
    "src/format.mjs",
    ["/**", " * Formatting helpers.", " */", "export function format(s) {", "  // TODO: localise greeting", "  const v = String(s);", "  return `hi ${v}`;", "}", ""].join("\n"),
  );
  await w("src/new.mjs", "export function brandNew() {\n  return 2;\n}\n");

  tools = Object.fromEntries(createToolset({ workspaceRoot: dir }).map((t) => [t.name, t]));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// analysis helpers

test("parseUnifiedDiff reads hunks, status, and counts", () => {
  const diff = [
    "diff --git a/src/a.mjs b/src/a.mjs",
    "--- a/src/a.mjs",
    "+++ b/src/a.mjs",
    "@@ -3,2 +3,3 @@",
    "-old",
    "+new",
    "+more",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 2);
  assert.equal(files[0].newPath, "src/a.mjs");
  assert.deepEqual(files[0].hunks[0], { oldStart: 3, oldCount: 2, newStart: 3, newCount: 3 });
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 1);
  assert.equal(files[1].status, "deleted");
  assert.equal(files[1].hunks[0].newCount, 0);
});

test("leadingComment handles block, docstring, and line comments", () => {
  assert.deepEqual(leadingComment(["/**", " * Hello", " * World", " */", "code"]), ["Hello", "World"]);
  assert.deepEqual(leadingComment(['"""Doc."""', "x = 1"]), ["Doc."]);
  assert.deepEqual(leadingComment(["#!/usr/bin/env node", "// one", "// two", "let x;"]), ["one", "two"]);
  assert.deepEqual(leadingComment(["let x;"]), []);
});

test("parentsFromSignature parses extends/implements/python/c#/rust shapes", () => {
  const sym = (signature, extra = {}) => ({ signature, name: "X", kind: "class", ...extra });
  assert.deepEqual(parentsFromSignature(sym("export class A extends B<T> implements C, D"), "js"), ["B", "C", "D"]);
  assert.deepEqual(parentsFromSignature(sym("class A(Base, metaclass=Meta):"), "python"), ["Base"]);
  assert.deepEqual(parentsFromSignature(sym("public class A : Base, IThing"), "clike-oo"), ["Base", "IThing"]);
  assert.deepEqual(parentsFromSignature(sym("impl Display for Point", { kind: "impl", name: "Point as Display" }), "rust"), ["Display"]);
  assert.deepEqual(parentsFromSignature(sym("class A < B"), "ruby"), ["B"]);
});

// ---------------------------------------------------------------------------
// navigate

test("symbol_context bundles definition, callers, callees, tests, and last change", async () => {
  const text = await tools.symbol_context.execute({ name: "greet" });
  assert.match(text, /## Definition\nsrc\/greet\.mjs:3-6 function greet \[exported\]/);
  assert.match(text, /## Callers[^\n]*\n[\s\S]*src\/greet\.mjs\s+method Child\.run/);
  assert.match(text, /src\/server\.mjs\s+\(module level\)/);
  assert.match(text, /imported by \d+ file\(s\)/);
  assert.match(text, /## Callees defined in workspace \(1\)\nformat → src\/format\.mjs:4-/);
  assert.match(text, /## Tests referencing it \(1\)\ntest\/greet\.test\.mjs/);
  assert.match(text, /## Last change\n[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Test: trim names in greet/);
});

test("symbol_context reports a miss", async () => {
  const text = await tools.symbol_context.execute({ name: "doesNotExist" });
  assert.match(text, /No definition found/);
});

test("locate explains path:line with the enclosing chain and marked body", async () => {
  const text = await tools.locate.execute({ path: "src/greet.mjs", line: 16 });
  assert.match(text, /in: class Child > method run/);
  assert.match(text, /^>16\|\s+return greet\('x'\);$/m);
});

test("locate resolves stack-trace frames inside the workspace and skips the rest", async () => {
  const abs = path.join(dir, "src", "greet.mjs");
  const trace = [
    "Error: boom",
    `    at greet (${abs}:5:10)`,
    "    at node:internal/process/task_queues:95:5",
    `    at file:///${dir.replace(/\\/g, "/")}/src/server.mjs:7:40`,
    '  File "/somewhere/else/thing.py", line 12, in run',
  ].join("\n");
  const text = await tools.locate.execute({ trace });
  assert.match(text, /## Frame 1: src\/greet\.mjs:5\s+\(greet\)/);
  assert.match(text, /in: function greet/);
  assert.match(text, /## Frame 2: src\/server\.mjs:7/);
  assert.match(text, /frame\(s\) outside the workspace skipped/);
});

test("symbol_search filters by regex, kind, and exported", async () => {
  const methods = await tools.symbol_search.execute({ pattern: "^run$", kind: "method" });
  assert.match(methods, /2 symbol\(s\) matching/);
  assert.match(methods, /Base\.run/);
  assert.match(methods, /Child\.run/);
  const classes = await tools.symbol_search.execute({ pattern: ".", kind: "class", exported_only: true, path: "src" });
  assert.match(classes, /class Base \[exported\]/);
  assert.match(classes, /class Child \[exported\]/);
  assert.doesNotMatch(classes, /function greet/);
});

test("symbol_context shows supertypes and subtypes for classes (type_hierarchy merged in)", async () => {
  const base = await tools.symbol_context.execute({ name: "Base" });
  assert.match(base, /## Supertypes\n\(none declared\)/);
  assert.match(base, /## Subtypes \/ implementers\n↓ class Child\s+\(src\/greet\.mjs:/);
  const child = await tools.symbol_context.execute({ name: "Child" });
  assert.match(child, /## Supertypes\n↑ Base\s+\(src\/greet\.mjs:/);
  const fn = await tools.symbol_context.execute({ name: "greet" });
  assert.doesNotMatch(fn, /## Supertypes/);
});

test("symbol_context history=N lists commits touching the symbol range (symbol_history merged in)", async () => {
  const one = await tools.symbol_context.execute({ name: "greet" });
  assert.match(one, /## Last change\n[0-9a-f]{7,} .*trim names in greet/);
  assert.doesNotMatch(one, /initial/);
  const text = await tools.symbol_context.execute({ name: "greet", history: 10 });
  assert.match(text, /## History \(2 commit\(s\), newest first\)/);
  assert.match(text, /trim names in greet/);
  assert.match(text, new RegExp(`${firstHash}.*initial`));
  assert.match(text, /git_history mode='show'/);
});

test("get_symbol names[] returns several bodies and reports misses (get_symbols merged in)", async () => {
  const text = await tools.get_symbol.execute({ names: ["greet", "format", "nope"] });
  assert.match(text, /## greet\nsrc\/greet\.mjs:3-6 function greet/);
  assert.match(text, /## format\nsrc\/format\.mjs:/);
  assert.match(text, /## nope\n\(no definition found\)/);
  await assert.rejects(() => tools.get_symbol.execute({}), /name .*or names/);
  await assert.rejects(() => tools.get_symbol.execute({ names: Array.from({ length: 13 }, (_, i) => `s${i}`) }), /At most 12/);
});

test("read_file paths[] reads several files with per-file caps (read_many merged in)", async () => {
  const text = await tools.read_file.execute({ paths: ["package.json", "src/index.mjs", "missing.txt", "src"], limit: 5 });
  assert.match(text, /## package\.json \(\d+ lines\)\n1\|\{/);
  assert.match(text, /read_file path='package\.json' offset=6/);
  assert.match(text, /## src\/index\.mjs/);
  assert.match(text, /## missing\.txt\n\(not found\)/);
  assert.match(text, /## src\n\(is a directory\)/);
  await assert.rejects(() => tools.read_file.execute({}), /path .*or paths/);
});

test("aliases resolve hallucinated and merged names onto real tools", async () => {
  const all = Object.values(tools);
  const search = resolveToolCall(all, "search", { query: "greet", path: "src" });
  assert.equal(search.tool.name, "grep_search");
  assert.equal(search.alias, "search");
  assert.deepEqual(search.args, { pattern: "greet", path: "src" });

  const open = resolveToolCall(all, "open_file", { path: "src/greet.mjs", line_start: 3, line_end: 6 });
  assert.equal(open.tool.name, "read_file");
  assert.deepEqual(open.args, { path: "src/greet.mjs", offset: 3, limit: 4 });

  const hist = resolveToolCall(all, "symbol_history", { name: "greet", max_count: 5 });
  assert.equal(hist.tool.name, "symbol_context");
  assert.equal(hist.args.history, 5);

  const many = resolveToolCall(all, "read_many", { paths: ["package.json"] });
  assert.equal(many.tool.name, "read_file");

  const direct = resolveToolCall(all, "grep_search", { pattern: "x" });
  assert.equal(direct.alias, null);
  assert.equal(resolveToolCall(all, "nope", {}), null);
  // alias target not in the active toolset → unresolved
  assert.equal(resolveToolCall(all.filter((t) => t.name !== "grep_search"), "search", {}), null);
});

// ---------------------------------------------------------------------------
// changes

test("changed_symbols default mode maps working-tree hunks and untracked files to symbols", async () => {
  const text = await tools.changed_symbols.execute({});
  assert.match(text, /working tree vs HEAD/);
  assert.match(text, /src\/format\.mjs \(\+\d+ -\d+\)\n\s+modified function format @4-/);
  assert.match(text, /src\/new\.mjs \[added\][\s\S]*added\s+function brandNew/);
  assert.match(text, /## Affected tests/);
  assert.match(text, /no tests found for: src\/format\.mjs/);
});

test("changed_symbols commits mode and since/ref modes", async () => {
  const last = await tools.changed_symbols.execute({ commits: 1 });
  assert.match(last, /last 1 commit\(s\)/);
  assert.match(last, /src\/greet\.mjs[^\n]*\n\s+modified function greet @3-6/);
  assert.doesNotMatch(last, /Child\.run/);
  assert.match(last, /## Affected tests\ntest\/greet\.test\.mjs/);

  const range = await tools.changed_symbols.execute({ ref: `${firstHash}..HEAD`, include_tests: false });
  assert.match(range, /modified function greet/);
  assert.doesNotMatch(range, /Affected tests/);
});

test("changed_symbols honours path filter", async () => {
  const text = await tools.changed_symbols.execute({ path: "src/format.mjs" });
  assert.match(text, /src\/format\.mjs/);
  assert.doesNotMatch(text, /src\/new\.mjs/);
});

test("file_brief summarises a file in one call", async () => {
  const text = await tools.file_brief.execute({ path: "src/greet.mjs" });
  assert.match(text, /^# src\/greet\.mjs\n\d+ bytes, \d+ lines, js, \d+ symbol\(s\)/);
  assert.match(text, /## Top-level symbols \(3\)/);
  assert.match(text, /class Child \[exported\]: export class Child extends Base\s+\{1 member\(s\)\}/);
  assert.match(text, /## Imports \(1\)\n- \.\/format\.mjs → src\/format\.mjs/);
  assert.match(text, /## Imported by \(\d+\)[\s\S]*src\/index\.mjs/);
  assert.match(text, /## Likely tests \(1\)\ntest\/greet\.test\.mjs/);
  assert.match(text, /## Recent commits\n[0-9a-f]{7,} .*trim names in greet/);

  const fmt = await tools.file_brief.execute({ path: "src/format.mjs" });
  assert.match(fmt, /## Header comment\nFormatting helpers\./);
});

// ---------------------------------------------------------------------------
// deps

test("who_imports lists importers and manifest status", async () => {
  const text = await tools.who_imports.execute({ specifier: "express" });
  assert.match(text, /1 file\(s\)/);
  assert.match(text, /package\.json dependencies: express@4\.19\.0/);
  assert.match(text, /src\/server\.mjs\s+\(express\)/);
  const rel = await tools.who_imports.execute({ specifier: "./greet.mjs" });
  assert.match(rel, /src\/server\.mjs/);
  assert.match(rel, /src\/index\.mjs/);
});

test("repo_overview shows declared workspaces and nested manifests (packages_map merged in)", async () => {
  const text = await tools.repo_overview.execute({ include_readme: false });
  assert.match(text, /## Packages \/ projects\ndeclared workspaces:\n  package\.json: packages\/\*/);
  assert.match(text, /packages\/a\/\s+\[package\.json\] ✓\s+@fx\/a@1\.0\.0\s+deps=0\s+scripts: build/);
});

test("config_key_usage separates code reads from config definitions", async () => {
  const text = await tools.config_key_usage.execute({ key: "API_KEY" });
  assert.match(text, /## Read in code \(1\)\nsrc\/server\.mjs:5: const key = process\.env\.API_KEY;/);
  assert.match(text, /## Config files \/ scripts \(2\)/);
  assert.match(text, /\.env\.example:1: API_KEY=/);
  assert.match(text, /Dockerfile:2: ENV API_KEY=changeme/);
  await assert.rejects(() => tools.config_key_usage.execute({ key: "bad key" }), /identifier/);
});

test("unused_exports finds exports with no external references and flags entry files", async () => {
  const text = await tools.unused_exports.execute({ path: "src" });
  assert.match(text, /src\/index\.mjs:3-5 function unusedThing\s+\[entry file\]/);
  assert.match(text, /src\/new\.mjs:1-3 function brandNew/);
  assert.doesNotMatch(text, /function greet/);
  assert.doesNotMatch(text, /function format/);
});

// ---------------------------------------------------------------------------
// surface

test("test_inventory lists JS and Python test names", async () => {
  const text = await tools.test_inventory.execute({});
  assert.match(text, /2 test file\(s\), 6 case\(s\)/);
  assert.match(text, /test\/greet\.test\.mjs \(3\)\ntest: greet says hi\ndescribe: Child\n\s+it: runs/);
  assert.match(text, /tests\/test_util\.py \(3\)\ntest: test_one\nclass: TestFoo\n\s+test: test_two/);
  const filtered = await tools.test_inventory.execute({ filter: "runs" });
  assert.match(filtered, /1 test file\(s\), 1 case\(s\)/);
});

test("http_surface lists routes and ignores Map.get", async () => {
  const text = await tools.http_surface.execute({});
  assert.match(text, /2 route\(s\)/);
  assert.match(text, /GET\s+\/users\s+:7/);
  assert.match(text, /POST\s+\/users\/:id\s+:8/);
  assert.doesNotMatch(text, /not-a-route/);
});

test("markers finds TODOs with the enclosing symbol", async () => {
  const text = await tools.markers.execute({});
  assert.match(text, /# Markers \(1; TODO:1\)/);
  assert.match(text, /src\/format\.mjs:5: \/\/ TODO: localise greeting\s+\[in format\]/);
  const none = await tools.markers.execute({ tags: "FIXME" });
  assert.match(none, /No FIXME markers/);
});

// ---------------------------------------------------------------------------
// option-level shortcuts

test("grep_search expand=symbol returns deduplicated enclosing bodies", async () => {
  const text = await tools.grep_search.execute({ pattern: "greet\\(", path: "src", expand: "symbol", expand_lines: 10 });
  assert.match(text, /enclosing symbol\(s\)/);
  assert.match(text, /matches @16\nsrc\/greet\.mjs:15-17 method Child\.run\n15\|/);
  assert.match(text, /^>16\|/m);
  // module-level hits (server.mjs) fall back to a context window
  assert.match(text, /src\/server\.mjs:7\n/);
});

test("find_references group_by=caller collapses hits and separates imports", async () => {
  const text = await tools.find_references.execute({ name: "greet", group_by: "caller" });
  assert.match(text, /reference\(s\) for 'greet' in \d+ caller\(s\)/);
  assert.match(text, /src\/greet\.mjs\s+method Child\.run\s+×1\s+@16/);
  assert.match(text, /imported by \d+ file\(s\): .*src\/server\.mjs/);
  assert.doesNotMatch(text, /^src\/server\.mjs:2:/m);
});
