import assert from "node:assert/strict";
import { test } from "node:test";

import { enclosingSymbol, enclosingTag, formatOutline, isCodeFile, languageFor, parseOutline } from "../src/outline.mjs";

const byName = (outline, name) => outline.symbols.find((s) => s.qualified === name || s.name === name);

test("languageFor / isCodeFile map extensions", () => {
  assert.equal(languageFor("a/b.ts"), "js");
  assert.equal(languageFor("x.PY"), "python");
  assert.equal(languageFor("main.go"), "go");
  assert.equal(languageFor("lib.rs"), "rust");
  assert.equal(languageFor("Foo.cs"), "clike-oo");
  assert.equal(languageFor("README.md"), null);
  assert.equal(isCodeFile("notes.txt"), false);
  assert.equal(parseOutline("hello", "notes.txt"), null);
});

test("JS: functions, arrow consts, classes with nested methods, extents, imports", () => {
  const src = [
    'import path from "node:path";',
    'import { a, b } from "./util.mjs";',
    "",
    "const LIMIT = 10;",
    "",
    "export function outer(x) {",
    "  const inner = 1; // local, should not be a symbol",
    '  if (x) { return "}"; }',
    "  return x;",
    "}",
    "",
    "export const handler = async (req) => {",
    "  return req;",
    "};",
    "",
    "export default class Widget extends Base {",
    "  constructor(name) {",
    "    this.name = name;",
    "  }",
    "",
    "  async load({ mode = \"fast\" } = {}) {",
    "    return mode;",
    "  }",
    "",
    "  static create() {",
    "    return new Widget();",
    "  }",
    "}",
  ].join("\n");
  const o = parseOutline(src, "widget.mjs");
  assert.ok(o);
  assert.deepEqual(o.imports, ["node:path", "./util.mjs"]);

  const limit = byName(o, "LIMIT");
  assert.equal(limit.kind, "const");
  assert.equal(limit.line, 4);
  assert.equal(limit.endLine, 4);

  const outer = byName(o, "outer");
  assert.equal(outer.kind, "function");
  assert.equal(outer.exported, true);
  assert.equal(outer.line, 6);
  assert.equal(outer.endLine, 10, "string containing '}' must not close the body early");
  assert.equal(byName(o, "inner"), undefined, "locals inside a function are not symbols");

  const handler = byName(o, "handler");
  assert.equal(handler.kind, "function");
  assert.equal(handler.line, 12);
  assert.equal(handler.endLine, 14);

  const widget = byName(o, "Widget");
  assert.equal(widget.kind, "class");
  assert.equal(widget.line, 16);
  assert.equal(widget.endLine, 28);
  assert.deepEqual(
    widget.children.map((c) => [c.qualified, c.kind, c.line, c.endLine]),
    [
      ["Widget.constructor", "constructor", 17, 19],
      ["Widget.load", "method", 21, 23],
      ["Widget.create", "method", 25, 27],
    ],
  );
  assert.deepEqual(o.roots.map((r) => r.name), ["LIMIT", "outer", "handler", "Widget"]);
});

test("JS: bare method shapes are only accepted inside a container", () => {
  const src = ["function f() {", "  foo() {", "  }", "}", "", "if (x) {", "}"].join("\n");
  const o = parseOutline(src, "x.js");
  assert.deepEqual(o.symbols.map((s) => s.name), ["f"]);
});

test("Python: indentation extents, decorators, methods, dunder privacy", () => {
  const src = [
    "import os",
    "from typing import List",
    "",
    "MAX = 3",
    "",
    "@dataclass",
    "class Greeter:",
    "    def __init__(self, name):",
    "        self.name = name",
    "",
    "    def greet(self,",
    "              loud=False):",
    "        if loud:",
    "            return self.name.upper()",
    "        return self.name",
    "",
    "def _helper():",
    "    pass",
    "",
    "def main():",
    "    g = Greeter('x')",
    "    print(g.greet())",
  ].join("\n");
  const o = parseOutline(src, "app.py");
  assert.deepEqual(o.imports, ["os", "typing"]);

  const greeter = byName(o, "Greeter");
  assert.equal(greeter.kind, "class");
  assert.equal(greeter.line, 6, "decorator is included in the extent");
  assert.equal(greeter.defLine, 7);
  assert.equal(greeter.endLine, 15);

  const greet = byName(o, "Greeter.greet");
  assert.equal(greet.kind, "method");
  assert.equal(greet.line, 11);
  assert.equal(greet.endLine, 15, "multi-line signature then body");

  assert.equal(byName(o, "_helper").exported, false);
  assert.equal(byName(o, "main").exported, true);
  assert.equal(byName(o, "main").endLine, 22);
  assert.equal(byName(o, "g"), undefined, "function locals are skipped");
});

test("Go: receiver methods, types, exported by capitalisation", () => {
  const src = [
    "package main",
    "",
    "import (",
    '\t"fmt"',
    '\t"net/http"',
    ")",
    "",
    "type Server struct {",
    "\taddr string",
    "}",
    "",
    "func (s *Server) Start() error {",
    "\treturn nil",
    "}",
    "",
    "func helper() {}",
  ].join("\n");
  const o = parseOutline(src, "main.go");
  assert.deepEqual(o.imports, ["fmt", "net/http"]);
  const server = byName(o, "Server");
  assert.equal(server.kind, "struct");
  assert.equal(server.endLine, 10);
  const start = byName(o, "Server.Start");
  assert.equal(start.kind, "method");
  assert.equal(start.leaf, "Start");
  assert.equal(start.exported, true);
  assert.equal(start.endLine, 14);
  assert.equal(byName(o, "helper").exported, false);
  assert.equal(byName(o, "helper").endLine, 16, "single-line body");
});

test("Rust: impl blocks nest methods, attributes included", () => {
  const src = [
    "use std::fmt;",
    "",
    "#[derive(Debug)]",
    "pub struct Point { x: i32 }",
    "",
    "impl fmt::Display for Point {",
    "    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {",
    '        write!(f, "{}", self.x)',
    "    }",
    "}",
    "",
    "impl Point {",
    "    pub fn new(x: i32) -> Self { Point { x } }",
    "}",
  ].join("\n");
  const o = parseOutline(src, "lib.rs");
  assert.deepEqual(o.imports, ["std::fmt"]);
  const point = byName(o, "Point");
  assert.equal(point.line, 3);
  assert.equal(point.endLine, 4);
  const display = o.symbols.find((s) => s.kind === "impl" && s.name.includes(" as "));
  assert.equal(display.name, "Point as fmt::Display");
  assert.equal(display.endLine, 10);
  assert.equal(display.children[0].qualified, "Point.fmt");
  assert.equal(display.children[0].kind, "method");
  const newFn = byName(o, "Point.new");
  assert.equal(newFn.line, 13);
  assert.equal(newFn.endLine, 13);
});

test("C#: namespace, class, methods, properties, Allman braces", () => {
  const src = [
    "using System;",
    "",
    "namespace Demo",
    "{",
    "    public class Account",
    "    {",
    "        public decimal Balance { get; private set; }",
    "",
    "        public Account(decimal opening)",
    "        {",
    "            Balance = opening;",
    "        }",
    "",
    "        public void Deposit(decimal amount)",
    "        {",
    "            Balance += amount;",
    "        }",
    "    }",
    "}",
  ].join("\n");
  const o = parseOutline(src, "Account.cs");
  assert.deepEqual(o.imports, ["System"]);
  const ns = byName(o, "Demo");
  assert.equal(ns.kind, "namespace");
  assert.equal(ns.endLine, 19);
  const account = byName(o, "Demo.Account");
  assert.equal(account.kind, "class");
  assert.equal(account.endLine, 18);
  assert.deepEqual(
    account.children.map((c) => [c.leaf, c.kind, c.line, c.endLine]),
    [
      ["Balance", "property", 7, 7],
      ["Account", "constructor", 9, 12],
      ["Deposit", "method", 14, 17],
    ],
  );
});

test("enclosingSymbol picks the innermost symbol; enclosingTag distinguishes def vs body", () => {
  const src = ["class A {", "  m() {", "    x();", "  }", "}", "", "const y = 1;"].join("\n");
  const o = parseOutline(src, "a.js");
  assert.equal(enclosingSymbol(o, 3).qualified, "A.m");
  assert.equal(enclosingSymbol(o, 1).qualified, "A");
  assert.equal(enclosingSymbol(o, 6), null);
  assert.equal(enclosingTag(o, 2), "  [def A.m]");
  assert.equal(enclosingTag(o, 3), "  [in A.m]");
  assert.equal(enclosingTag(o, 6), "");
  assert.equal(enclosingTag(null, 1), "");
});

test("formatOutline renders ranges, nesting, exported flags, and caps symbols", () => {
  const src = ["export class A {", "  m() {", "  }", "}", "function b() {}"].join("\n");
  const o = parseOutline(src, "a.ts");
  const text = formatOutline("src/a.ts", o);
  assert.match(text, /^src\/a\.ts — 5 lines, 3 symbol\(s\), js$/m);
  assert.match(text, /^1-4 class A \[exported\]: export class A$/m);
  assert.match(text, /^  2-3 method m: m\(\)$/m);
  assert.match(text, /^5 function b: function b\(\) \{\}$/m);

  const capped = formatOutline("src/a.ts", o, { maxSymbols: 1 });
  assert.match(capped, /… 2 more symbol\(s\) omitted/);

  const empty = formatOutline("x.js", parseOutline("// nothing here\n", "x.js"));
  assert.match(empty, /no recognised symbols/);
});
