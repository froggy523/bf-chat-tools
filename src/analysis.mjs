/**
 * Shared analysis helpers used by several tool modules: read-only git,
 * import resolution, source ↔ test mapping, symbol lookup / indexing,
 * reference scanning, and unified-diff parsing.
 *
 * Everything here is heuristic (no language server) and built on the cached
 * outline parser in ./outline.mjs.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { enclosingSymbol, getOutline, isCodeFile, languageFor } from "./outline.mjs";
import { createResolver } from "./resolver.mjs";
import { collectFiles, pathKind, readTextFile, resolveWithinRoot, toRel } from "./workspace.mjs";

export { createResolver };

// ---------------------------------------------------------------------------
// Small utilities

/** Escape a string for use inside a RegExp. */
export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary regex for an identifier. Handles Ruby-style trailing `?` / `!`
 * (no `\b` after a non-word char) and rejects a following `?`/`!` for plain
 * names so `valid` does not match `valid?`.
 */
export function wordRegex(name, flags = "") {
  const esc = escapeRe(name);
  const tail = /[?!]$/.test(name) ? "" : "(?![\\w?!])";
  const head = /^[\w$]/.test(name) ? "\\b" : "";
  return new RegExp(`${head}${esc}${tail}`, flags);
}

export async function exists(abs) {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and normalise a symbol name: `A::B::c` → `A.B.c`, `Foo#bar` → `Foo.bar`,
 * trailing Ruby `?`/`!` allowed, `$` allowed. Throws on anything else.
 * @returns {string} normalised dotted name
 */
export function normalizeSymbolName(raw) {
  const name = String(raw ?? "")
    .trim()
    .replace(/::/g, ".")
    .replace(/#/g, ".")
    .replace(/\(\)$/, "");
  if (!name) throw new Error("name must not be empty.");
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*[?!]?$/.test(name)) {
    throw new Error("name must be an identifier (letters, digits, _, optional dots or ::, optional trailing ?/!).");
  }
  return name;
}

/** Backwards-compatible validator; prefer normalizeSymbolName. */
export function assertSymbolName(name) {
  normalizeSymbolName(name);
}

// ---------------------------------------------------------------------------
// Git

/**
 * Run git in the workspace. Throws on failure unless allowFail, in which case
 * null is returned.
 */
export function runGit(root, args, { timeoutMs = 10_000, allowFail = false, maxBuffer = 4_000_000 } = {}) {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer,
  });
  if (result.error) {
    if (allowFail) return null;
    throw new Error(`git failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFail) return null;
    const err = (result.stderr || result.stdout || "").trim() || `git exited ${result.status}`;
    throw new Error(err);
  }
  return (result.stdout ?? "").trimEnd();
}

export function isGitRepo(root) {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

export function ensureGitRepo(root) {
  if (!isGitRepo(root)) throw new Error("Workspace is not inside a git work tree.");
}

/**
 * Commits touching a line range of a file (most recent first), via `git log -L`.
 * @returns {{hash: string, date: string, author: string, subject: string}[]}
 */
export function commitsForRange(root, rel, startLine, endLine, { max = 10 } = {}) {
  const out = runGit(
    root,
    [
      "log",
      `-L${startLine},${endLine}:${rel}`,
      "-n",
      String(max),
      "--date=short",
      "--format=@@COMMIT@@%h|%ad|%an|%s",
    ],
    { allowFail: true, timeoutMs: 20_000 },
  );
  if (out == null) return [];
  const commits = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^@@COMMIT@@([0-9a-f]+)\|(\S+)\|([^|]*)\|(.*)$/);
    if (m) commits.push({ hash: m[1], date: m[2], author: m[3], subject: m[4] });
  }
  return commits;
}

/** `git log` for a path, formatted one commit per line. */
export function commitsForPath(root, rel, { max = 3 } = {}) {
  const out = runGit(root, ["log", "-n", String(max), "--date=short", "--format=%h %ad %an %s", "--", rel], {
    allowFail: true,
  });
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

/** Contents of a file at a ref (or null if it does not exist there). */
export function gitFileAt(root, ref, rel) {
  return runGit(root, ["show", `${ref}:${rel}`], { allowFail: true, timeoutMs: 20_000 });
}

// ---------------------------------------------------------------------------
// Imports

/** `- spec → file` display row for a resolver.importsOf() entry. */
export function formatImportRow({ spec, files }) {
  if (files == null) return `- ${spec}`;
  if (!files.length) return `- ${spec}  (unresolved)`;
  if (files.length === 1) return `- ${spec} → ${files[0]}`;
  return `- ${spec} → ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` (+${files.length - 3})` : ""}`;
}

/**
 * Files in `files` that import `rel`, via the per-workspace resolver (handles
 * JS/TS aliases, Python packages, Go modules, Rust modules, Java/C# namespaces).
 * Pass `resolver` when you already have one to reuse its caches.
 * @returns {Promise<{file: string, via: string}[]>}
 */
export async function importersOf(root, rel, files, { max = 80, resolver } = {}) {
  const r = resolver ?? createResolver(root, files);
  return r.importersOf(rel, { max });
}

// ---------------------------------------------------------------------------
// Tests

export function isTestPath(fileRel) {
  const p = fileRel.replace(/\\/g, "/");
  const n = p.toLowerCase();
  return (
    /(^|\/)(tests?|__tests__|spec|specs|testing|e2e|integration-tests?)(\/|$)/.test(n) ||
    /(^|\/)[^/]+\.(unit|integration)?tests?\//.test(n) || // C#: Foo.Tests/, Foo.UnitTests/
    /(^|\/)src\/test\//.test(n) || // Maven/Gradle
    /\.(test|spec|e2e|integration)\.[^.]+$/.test(n) ||
    /_test\.[^.]+$/.test(n) ||
    /_spec\.[^.]+$/.test(n) ||
    /(^|\/)test_[^/]+\.(py|rb)$/.test(n) ||
    /(^|\/)[A-Z]\w*(?:Test|Tests|IT|Spec|Specs|TestCase)\.(java|kt|kts|scala|cs|php|swift|groovy)$/.test(p) ||
    /(^|\/)Test[A-Z]\w*\.(java|cs|php)$/.test(p)
  );
}

/** Basename (no ext) forms a test file for `stem` may take, across ecosystems. */
const TEST_SUFFIX = String.raw`(?:[_.-](?:tests?|specs?|it|e2e|integration)|Tests?|IT|Specs?|TestCase)`;

export function testStemRegex(stem) {
  return new RegExp(`^(?:test_|Test)?${escapeRe(stem)}${TEST_SUFFIX}?$`);
}

/** Derive the likely source stem from a test file's basename, or null if it carries no test marker. */
export function sourceStemFromTestBasename(baseNoExt) {
  let m;
  if ((m = baseNoExt.match(/^test_(.+)$/))) return m[1];
  if ((m = baseNoExt.match(/^Test([A-Z].*)$/))) return m[1];
  if ((m = baseNoExt.match(new RegExp(`^(.+?)${TEST_SUFFIX}$`)))) return m[1];
  return null;
}

export function sourceCandidatesFromTest(testRel) {
  const posix = testRel.replace(/\\/g, "/");
  const dir = path.posix.dirname(posix);
  const base = path.posix.basename(posix);
  const ext = path.posix.extname(base);
  const baseNoExt = base.slice(0, -ext.length || undefined);
  const stemNoExt = sourceStemFromTestBasename(baseNoExt) ?? baseNoExt;
  const stem = stemNoExt + ext;
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };

  const dirPrefix = dir === "." ? "" : dir + "/";
  push(`${dirPrefix}${stem}`);

  // Strip test directories / mirror well-known layouts.
  const stripped = (dirPrefix + stem)
    .replace(/(^|\/)src\/test\/(java|kotlin|scala|groovy)\//, "$1src/main/$2/")
    .replace(/(^|\/)([^/]+)\.(?:Unit|Integration)?Tests?\//, "$1$2/")
    .replace(/(^|\/)(__tests__|tests?|specs?|e2e)\//gi, "$1");
  push(stripped);
  for (const srcRoot of ["src", "lib", "app"]) {
    push(`${srcRoot}/${stripped}`);
    push(`${srcRoot}/${stemNoExt}${ext}`);
    if (ext === ".mjs" || ext === ".js" || ext === ".ts") {
      for (const e of [".mjs", ".js", ".ts", ".tsx"]) push(`${srcRoot}/${stemNoExt}${e}`);
    }
  }
  return out.filter((p) => p && p !== posix);
}

export function testCandidatesFromSource(srcRel) {
  const posix = srcRel.replace(/\\/g, "/");
  const dir = path.posix.dirname(posix);
  const base = path.posix.basename(posix);
  const ext = path.posix.extname(base);
  const stem = base.slice(0, -ext.length || undefined);
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  const withoutSrc = posix.replace(/^(src|lib|app)\//, "");
  const withoutExt = withoutSrc.replace(/\.[^.]+$/, "");
  const relDir = path.posix.dirname(withoutSrc);
  const relDirPrefix = relDir === "." ? "" : relDir + "/";

  // Generic same-dir / __tests__ / test-root mirrors (JS-style suffixes).
  push(path.posix.join(dir, `${stem}.test${ext}`));
  push(path.posix.join(dir, `${stem}.spec${ext}`));
  push(path.posix.join(dir, `${stem}_test${ext}`));
  push(path.posix.join(dir, `__tests__/${stem}${ext}`));
  push(path.posix.join(dir, `__tests__/${stem}.test${ext}`));
  for (const testRoot of ["test", "tests", "spec", "__tests__"]) {
    push(`${testRoot}/${withoutExt}.test${ext}`);
    push(`${testRoot}/${withoutExt}.spec${ext}`);
    push(`${testRoot}/${withoutExt}${ext}`);
    push(`${testRoot}/${stem}.test${ext}`);
    push(`${testRoot}/${stem}${ext}`);
  }

  switch (ext.toLowerCase()) {
    case ".py":
      push(path.posix.join(dir, `test_${stem}.py`));
      for (const testRoot of ["tests", "test"]) {
        push(`${testRoot}/test_${stem}.py`);
        push(`${testRoot}/${relDirPrefix}test_${stem}.py`);
        push(`${testRoot}/${withoutExt}_test.py`);
      }
      break;
    case ".java":
    case ".kt":
    case ".kts":
    case ".scala":
    case ".groovy": {
      const mirrorDir = dir.replace(/(^|\/)src\/main\/(java|kotlin|scala|groovy)(\/|$)/, "$1src/test/$2$3");
      for (const d of [...new Set([mirrorDir, dir])]) {
        for (const suffix of ["Test", "Tests", "IT", "Spec", "TestCase"]) push(path.posix.join(d, `${stem}${suffix}${ext}`));
        push(path.posix.join(d, `Test${stem}${ext}`));
      }
      break;
    }
    case ".cs": {
      const segs = posix.split("/");
      const proj = segs.length > 1 ? segs[0] : null;
      const inner = segs.slice(1, -1).join("/");
      const targets = [dir];
      if (proj) {
        for (const suffix of [".Tests", ".UnitTests", ".Test", "Tests"]) {
          targets.push(path.posix.join(`${proj}${suffix}`, inner));
          targets.push(path.posix.join("tests", `${proj}${suffix}`, inner));
          targets.push(path.posix.join("test", `${proj}${suffix}`, inner));
        }
      }
      for (const d of [...new Set(targets)]) {
        for (const suffix of ["Tests", "Test", "Specs"]) push(path.posix.join(d, `${stem}${suffix}.cs`));
      }
      break;
    }
    case ".rb":
      push(`spec/${withoutExt}_spec.rb`);
      push(`test/${withoutExt}_test.rb`);
      push(`test/test_${stem}.rb`);
      push(path.posix.join(dir, `${stem}_spec.rb`));
      break;
    case ".php":
      push(`tests/${withoutExt}Test.php`);
      push(`tests/${stem}Test.php`);
      push(`tests/Unit/${stem}Test.php`);
      push(`tests/Feature/${stem}Test.php`);
      break;
    case ".swift":
      push(`Tests/${relDirPrefix}${stem}Tests.swift`);
      push(`Tests/${stem}Tests.swift`);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Existing test files for a source file: naming candidates that exist, test
 * files whose basename is a test form of the source stem, and test files that
 * import it (via the resolver). Rust in-file `#[cfg(test)]` modules are
 * reported separately.
 * @param {string[]} files  Workspace file list (relative posix paths).
 * @returns {Promise<{found: string[], missing: string[], inFile: string[]}>}
 */
export async function findTestsFor(root, rel, files, { max = 40, resolver } = {}) {
  const candidates = testCandidatesFromSource(rel);
  const fileSet = new Set(files);
  const found = [];
  const missing = [];
  for (const c of candidates) {
    if (fileSet.has(c) || (await exists(path.join(root, c)))) found.push(c);
    else missing.push(c);
  }

  // Basename match anywhere under a test path (FooTest.java in any test dir, test_foo.py, …).
  const stem = path.posix.basename(rel).replace(/\.[^.]+$/, "");
  const stemRe = testStemRegex(stem);
  const srcExt = path.posix.extname(rel).toLowerCase();
  for (const f of files) {
    if (found.length >= max) break;
    if (found.includes(f) || f === rel || !isTestPath(f)) continue;
    const ext = path.posix.extname(f).toLowerCase();
    if (!sameEcosystem(srcExt, ext)) continue;
    const base = path.posix.basename(f, ext);
    if (stemRe.test(base)) found.push(f);
  }

  // Reverse imports.
  if (found.length < max && isCodeFile(rel)) {
    const r = resolver ?? createResolver(root, files);
    const importers = await r.importersOf(rel, { max: 200, candidates: files.filter(isTestPath) });
    for (const { file } of importers) {
      if (!found.includes(file)) found.push(file);
      if (found.length >= max) break;
    }
  }

  // Rust / others: tests inside the source file itself.
  const inFile = [];
  if (srcExt === ".rs") {
    const text = await readTextFile(path.join(root, rel));
    if (text) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*#\[cfg\(test\)\]/.test(lines[i])) {
          const modLine = lines.slice(i + 1, i + 3).find((l) => /^\s*(?:pub\s+)?mod\s+\w+/.test(l));
          const name = modLine?.match(/mod\s+(\w+)/)?.[1] ?? "tests";
          inFile.push(`${rel}:${i + 1} mod ${name}`);
        }
      }
    }
  }
  return { found, missing: missing.slice(0, 12), inFile };
}

const ECOSYSTEM = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js", ".ts": "js", ".tsx": "js", ".mts": "js", ".cts": "js",
  ".py": "py", ".pyi": "py",
  ".go": "go",
  ".rs": "rs",
  ".java": "jvm", ".kt": "jvm", ".kts": "jvm", ".scala": "jvm", ".groovy": "jvm",
  ".cs": "cs",
  ".rb": "rb",
  ".php": "php",
  ".swift": "swift",
  ".c": "c", ".h": "c", ".cpp": "c", ".cc": "c", ".hpp": "c",
};

function sameEcosystem(a, b) {
  return (ECOSYSTEM[a] ?? a) === (ECOSYSTEM[b] ?? b);
}

/**
 * Source files a test file likely covers: naming candidates that exist,
 * non-test files whose stem matches the test's derived stem, and non-test
 * files the test imports.
 * @returns {Promise<{found: string[], missing: string[]}>}
 */
export async function findSourceForTest(root, testRel, files, { max = 20, resolver } = {}) {
  const candidates = sourceCandidatesFromTest(testRel);
  const fileSet = new Set(files);
  const found = [];
  const missing = [];
  for (const c of candidates) {
    if (fileSet.has(c) || (await exists(path.join(root, c)))) found.push(c);
    else missing.push(c);
  }
  const ext = path.posix.extname(testRel).toLowerCase();
  const stem = sourceStemFromTestBasename(path.posix.basename(testRel, ext));
  if (stem) {
    const re = new RegExp(`^${escapeRe(stem)}$`, "i");
    for (const f of files) {
      if (found.length >= max) break;
      if (f === testRel || found.includes(f) || isTestPath(f)) continue;
      const fext = path.posix.extname(f).toLowerCase();
      if (!sameEcosystem(ext, fext)) continue;
      if (re.test(path.posix.basename(f, fext))) found.push(f);
    }
  }
  if (isCodeFile(testRel) && found.length < max) {
    const r = resolver ?? createResolver(root, files);
    for (const { files: targets } of await r.importsOf(testRel)) {
      for (const t of targets ?? []) {
        if (t !== testRel && !isTestPath(t) && !found.includes(t)) found.push(t);
      }
    }
  }
  return { found, missing: missing.slice(0, 12) };
}

// ---------------------------------------------------------------------------
// Symbols

/**
 * Resolve a search scope into `/`-separated relative code-file paths.
 * @returns {Promise<{files: string[], allFiles: string[], truncated: boolean, kind: 'file'|'directory'|null}>}
 */
export async function codeFilesUnder(root, searchPath) {
  const start = resolveWithinRoot(root, searchPath);
  const kind = await pathKind(start);
  if (kind === "file") {
    const rel = toRel(root, start);
    return { files: isCodeFile(rel) ? [rel] : [], allFiles: [rel], truncated: false, kind };
  }
  if (kind !== "directory") {
    throw new Error(`Path '${searchPath ?? "."}' does not exist in the workspace.`);
  }
  const { files, truncated } = await collectFiles(root, start);
  return { files: files.filter(isCodeFile), allFiles: files, truncated, kind };
}

/** Does an outline symbol answer a lookup for `name` ('leaf' or 'Parent.leaf')? */
export function symbolMatches(sym, name) {
  if (name.includes(".")) {
    return sym.qualified === name || sym.qualified.endsWith(`.${name}`) || sym.name === name;
  }
  return sym.leaf === name || sym.name === name;
}

/**
 * Outline-based definitions of `name` across `files`, ranked: exact qualified
 * match first, then non-impl kinds, then path/line.
 * @returns {Promise<{rel: string, sym: import("./outline.mjs").OutlineSymbol}[]>}
 */
export async function findDefinitions(root, files, name, { limit = 50 } = {}) {
  const matches = [];
  for (const rel of files) {
    const outline = await getOutline(path.join(root, rel));
    if (!outline) continue;
    for (const sym of outline.symbols) {
      if (symbolMatches(sym, name)) matches.push({ rel, sym });
      if (matches.length >= limit) break;
    }
    if (matches.length >= limit) break;
  }
  const rank = (m) => (m.sym.qualified === name ? 0 : 1) * 10 + (m.sym.kind === "impl" ? 1 : 0);
  matches.sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel) || a.sym.line - b.sym.line);
  return matches;
}

/**
 * Map of leaf name → [{rel, sym}] for every symbol in `files`.
 * @returns {Promise<Map<string, {rel: string, sym: import("./outline.mjs").OutlineSymbol}[]>>}
 */
export async function buildSymbolIndex(root, files, { maxSymbols = 60_000 } = {}) {
  const index = new Map();
  let count = 0;
  for (const rel of files) {
    if (!isCodeFile(rel)) continue;
    const outline = await getOutline(path.join(root, rel));
    if (!outline) continue;
    for (const sym of outline.symbols) {
      let list = index.get(sym.leaf);
      if (!list) {
        list = [];
        index.set(sym.leaf, list);
      }
      list.push({ rel, sym });
      if (++count >= maxSymbols) return index;
    }
  }
  return index;
}

/**
 * Top-level symbols with namespace / module wrappers unwrapped (C# `namespace X { class A }`,
 * TS `namespace`, Ruby `module`): the things a reader thinks of as "in this file".
 */
export function effectiveRoots(outline) {
  const out = [];
  const walk = (syms) => {
    for (const s of syms) {
      if ((s.kind === "namespace" || s.kind === "module") && s.children.length) walk(s.children);
      else if (s.kind !== "namespace") out.push(s);
    }
  };
  walk(outline?.roots ?? []);
  return out;
}

/** Numbered source for one symbol extent, capped at maxLines. */
export function renderBody(rel, sym, lines, maxLines, { markLine } = {}) {
  const total = sym.endLine - sym.line + 1;
  const shown = Math.min(total, maxLines);
  const header = `${rel}:${sym.line}-${sym.endLine} ${sym.kind} ${sym.qualified}${sym.exported ? " [exported]" : ""}`;
  const body = [];
  for (let n = sym.line; n < sym.line + shown; n++) {
    const mark = markLine === n ? ">" : "";
    body.push(`${mark}${n}|${lines[n - 1] ?? ""}`);
  }
  if (shown < total) {
    const nextStart = sym.line + shown;
    body.push(
      `… ${total - shown} more line(s); read_file path='${rel}' offset=${nextStart} limit=${sym.endLine - nextStart + 1} for the rest.`,
    );
  }
  return { text: `${header}\n${body.join("\n")}`, shown };
}

/** Numbered lines around a target line. */
export function renderContext(rel, lines, lineNo, radius = 3) {
  const from = Math.max(1, lineNo - radius);
  const to = Math.min(lines.length, lineNo + radius);
  const out = [];
  for (let n = from; n <= to; n++) out.push(`${n === lineNo ? ">" : " "}${n}|${lines[n - 1] ?? ""}`);
  return `${rel}:${lineNo}\n${out.join("\n")}`;
}

/** Ancestor chain for a symbol: "Outer.Inner.leaf" style path list. */
export function symbolChain(sym) {
  const chain = [];
  for (let s = sym; s; s = s.parent) chain.unshift(s);
  return chain;
}

/** Keywords and global constructors that look like calls but are never workspace symbols worth listing. */
const JS_CONTROL = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "catch", "try", "finally", "return", "throw",
  "new", "delete", "typeof", "void", "await", "yield", "function", "import", "export", "with", "super",
  "this", "const", "let", "var", "class", "extends", "instanceof", "in", "of", "async", "def", "elif",
  "isinstance", "self", "cls", "fn", "pub", "func", "defer", "require", "console", "Math", "JSON",
  "Object", "Array", "String", "Number", "Boolean", "Promise", "Error", "Map", "Set", "Symbol", "Date",
  "RegExp", "parseInt", "parseFloat", "public", "private", "static", "sizeof",
]);

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * Identifiers that appear in call position (`name(`) within a range of lines,
 * excluding the definition line itself, comments, and string contents.
 * @returns {string[]} unique names in first-seen order
 */
export function calledIdentifiers(lines, startLine, endLine, { skipLine, language } = {}) {
  const seen = new Set();
  const out = [];
  const ruby = language === "ruby";
  for (let n = startLine; n <= endLine; n++) {
    if (n === skipLine) continue;
    let line = lines[n - 1] ?? "";
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*")) continue;
    line = line.replace(STRING_LITERAL, '""').replace(/\/\/.*$/, "");
    const re = /([A-Za-z_$][\w$]*[?!]?)\s*(?:\(|\{(?=\s*[\w|]))/g; // `name(` or Kotlin/Ruby-style `name { x ->`
    let m;
    while ((m = re.exec(line))) {
      const name = m[1];
      if (JS_CONTROL.has(name) || seen.has(name) || name.length < 2) continue;
      seen.add(name);
      out.push(name);
    }
    if (ruby) {
      // Paren-less calls: `helper arg`, `render :x`, `puts "hi"`, `validate! obj`
      const pm = line.match(/^\s*(?:[\w@.]+\s*=\s*)?([a-z_]\w*[?!]?)\s+(?=[\w"':@\[-])/);
      if (pm && !RUBY_KEYWORDS.has(pm[1]) && !seen.has(pm[1])) {
        seen.add(pm[1]);
        out.push(pm[1]);
      }
      // `obj.method arg` without parens
      const dm = /\.([a-z_]\w*[?!]?)(?=\s+[\w"':@\[]|\s*$)/g;
      let d;
      while ((d = dm.exec(line))) {
        if (!seen.has(d[1]) && !RUBY_KEYWORDS.has(d[1])) {
          seen.add(d[1]);
          out.push(d[1]);
        }
      }
    }
  }
  return out;
}

const RUBY_KEYWORDS = new Set([
  "if", "unless", "while", "until", "case", "when", "then", "else", "elsif", "end", "do", "return", "yield",
  "def", "class", "module", "require", "require_relative", "include", "extend", "attr_reader", "attr_writer",
  "attr_accessor", "private", "public", "protected", "raise", "puts", "print", "p", "pp", "new", "not", "and",
  "or", "in", "begin", "rescue", "ensure", "self", "super", "nil", "true", "false", "lambda", "proc", "loop",
]);

// ---------------------------------------------------------------------------
// References

/** Import / require / use lines: references, but not callers. */
export const IMPORT_LINE =
  /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s*(?:from\b|;|$)|from\s+[\w.]+\s+import\b|use\s+[\w:]+|using\s+[\w.]+;|require\s*\(|#\s*include\b|require(?:_relative)?\s+['"])/;

/**
 * True when a reference hit is an import rather than a use: an import line, or a
 * bare `name,` continuation line of a multi-line import at module level.
 */
export function isImportHit(text, sym) {
  const t = String(text).trim();
  return IMPORT_LINE.test(t) || (!sym && /^[\w$]+\s*,?$/.test(t));
}

/**
 * Word-boundary references to `leaf` across `files`, each tagged with the
 * enclosing symbol. Definition-like lines are excluded unless includeDefinitions.
 * @returns {Promise<{hits: {rel: string, line: number, text: string, sym: import("./outline.mjs").OutlineSymbol|null, isDef: boolean}[], truncatedAt: boolean}>}
 */
export async function scanReferences(root, files, leaf, { maxHits = 40, includeDefinitions = false, skipDefOf } = {}) {
  const wordRe = wordRegex(leaf);
  const hits = [];
  let truncatedAt = false;
  for (const rel of files) {
    if (hits.length >= maxHits) {
      truncatedAt = true;
      break;
    }
    const text = await readTextFile(path.join(root, rel));
    if (text == null) continue;
    const lines = text.split(/\r?\n/);
    let outline;
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= maxHits) {
        truncatedAt = true;
        break;
      }
      const line = lines[i];
      const m = wordRe.exec(line);
      if (!m) continue;
      if (outline === undefined) outline = isCodeFile(rel) ? await getOutline(path.join(root, rel)) : null;
      const sym = enclosingSymbol(outline, i + 1);
      const isDef = Boolean(sym && sym.defLine === i + 1 && sym.leaf === leaf);
      if (isDef && !includeDefinitions) continue;
      if (skipDefOf && sym && sym === skipDefOf) continue;
      // Member access (`x.leaf`, `x->leaf`, `X::leaf`, `obj#leaf`) vs a bare identifier.
      const before = line.slice(0, m.index).trimEnd();
      const member = /(?:\.|->|::|#|\?\.)$/.test(before);
      hits.push({ rel, line: i + 1, text: line.trim().slice(0, 300), sym, isDef, isImport: isImportHit(line, sym), member });
    }
  }
  return { hits, truncatedAt };
}

/**
 * Group reference hits by (file, enclosing symbol).
 * @returns {{rel: string, caller: string|null, kind: string|null, lines: number[]}[]}
 */
export function groupHitsByCaller(hits) {
  const groups = new Map();
  for (const h of hits) {
    const key = `${h.rel}\u0000${h.sym ? h.sym.qualified : ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { rel: h.rel, caller: h.sym ? h.sym.qualified : null, kind: h.sym ? h.sym.kind : null, lines: [] };
      groups.set(key, g);
    }
    g.lines.push(h.line);
  }
  return [...groups.values()].sort((a, b) => b.lines.length - a.lines.length || a.rel.localeCompare(b.rel));
}

// ---------------------------------------------------------------------------
// Diff parsing

/**
 * Parse `git diff` output into per-file hunks.
 * @returns {{oldPath: string|null, newPath: string|null, status: 'added'|'deleted'|'modified'|'renamed', hunks: {oldStart: number, oldCount: number, newStart: number, newCount: number}[], added: number, removed: number}[]}
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      cur = { oldPath: null, newPath: null, status: "modified", hunks: [], added: 0, removed: 0 };
      files.push(cur);
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        cur.oldPath = m[1];
        cur.newPath = m[2];
        if (m[1] !== m[2]) cur.status = "renamed";
      }
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      cur.oldPath = p === "/dev/null" ? null : p.replace(/^a\//, "");
      if (p === "/dev/null") cur.status = "added";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur.newPath = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (p === "/dev/null") cur.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) cur.status = "renamed";
    if (line.startsWith("new file mode")) cur.status = "added";
    if (line.startsWith("deleted file mode")) cur.status = "deleted";
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      cur.hunks.push({
        oldStart: Number(h[1]),
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newCount: h[4] === undefined ? 1 : Number(h[4]),
      });
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) cur.added++;
    else if (line.startsWith("-") && !line.startsWith("---")) cur.removed++;
  }
  return files;
}

/** True when [aStart, aEnd] and [bStart, bEnd] overlap (inclusive). A zero-count range is a point. */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// ---------------------------------------------------------------------------
// Misc extraction

/**
 * Leading documentation for a file: first block comment, docstring, or run of
 * line comments (skipping shebang / pragma lines). Returns up to maxLines lines.
 */
export function leadingComment(lines, maxLines = 12) {
  let i = 0;
  while (
    i < lines.length &&
    (/^#!/.test(lines[i]) || /^\s*$/.test(lines[i]) || /^\s*(["']use strict["'];?|# -\*-|# coding)/.test(lines[i]))
  ) {
    i++;
  }
  if (i >= lines.length) return [];
  const first = lines[i].trim();
  const out = [];
  const clean = (s) =>
    s
      .replace(/^\s*\/\*+\s?/, "")
      .replace(/\*+\/\s*$/, "")
      .replace(/^\s*\*\s?/, "")
      .replace(/^\s*["']{3}\s?/, "")
      .replace(/["']{3}\s*$/, "")
      .trimEnd();
  if (first.startsWith("/*") || first.startsWith('"""') || first.startsWith("'''")) {
    const closer = first.startsWith("/*") ? "*/" : first.slice(0, 3);
    for (let j = i; j < lines.length && out.length < maxLines; j++) {
      out.push(clean(lines[j]));
      const t = lines[j].trim();
      const closes = j === i ? t.length > closer.length && t.endsWith(closer) : t.includes(closer);
      if (closes) break;
    }
  } else if (/^(\/\/|#|--)/.test(first)) {
    for (let j = i; j < lines.length && out.length < maxLines; j++) {
      const t = lines[j].trim();
      if (!/^(\/\/|#|--)/.test(t)) break;
      out.push(t.replace(/^(\/\/|#|--)\s?/, "").trimEnd());
    }
  }
  while (out.length && !out[out.length - 1]) out.pop();
  while (out.length && !out[0]) out.shift();
  return out;
}

/** Remove `<…>` generic argument lists, including nested ones. `->` and `=>` arrows are preserved. */
export function stripGenerics(text) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" && (depth > 0 || /[\w$>\]]$/.test(out))) {
      depth++;
      continue;
    }
    if (ch === ">" && depth > 0) {
      if (text[i - 1] === "-" || text[i - 1] === "=") {
        // arrow inside generics is unusual; treat as literal
      } else {
        depth--;
        continue;
      }
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * Parse parent types out of a definition signature.
 * @returns {string[]} leaf type names (generics stripped)
 */
export function parentsFromSignature(sym, language) {
  // Strip (possibly nested) generic argument lists first so `Map<K, V>` does not split on its comma.
  const sig = stripGenerics(sym.signature ?? "");
  const out = [];
  const push = (list) => {
    for (const raw of String(list).split(",")) {
      const cleaned = raw
        .replace(/\([^)]*\)/g, "")
        .replace(/\bwhere\b.*$/, "")
        .replace(/^\s*(?:public|private|protected|virtual)\s+/, "")
        .trim();
      if (!cleaned || /^(metaclass|object)$/.test(cleaned) || /=/.test(cleaned)) continue;
      const leaf = cleaned.split(/::|\.|\\/).pop().replace(/[^\w$]/g, "");
      if (leaf && !out.includes(leaf)) out.push(leaf);
    }
  };
  let m;
  if (language === "python") {
    if ((m = sig.match(/^class\s+\w+\s*\(([^)]*)\)/))) push(m[1]);
    return out;
  }
  if (language === "c") {
    // C++: class A : public B, private C<T> {
    if ((m = sig.match(/\b(?:class|struct)\s+\w+\s*(?:final\s*)?:\s*([^{;]+?)(?=\s*\{|\s*$)/))) push(m[1]);
    return out;
  }
  if (language === "ruby") {
    if ((m = sig.match(/^class\s+[\w:]+\s*<\s*([\w:]+)/))) push(m[1]);
    return out;
  }
  if (language === "rust") {
    if (sym.kind === "impl" && sym.name.includes(" as ")) push(sym.name.split(" as ")[1]);
    return out;
  }
  if ((m = sig.match(/\bextends\s+([^{]+?)(?=\s+implements\b|\s*\{|\s*$)/))) push(m[1]);
  if ((m = sig.match(/\bimplements\s+([^{]+?)(?=\s*\{|\s*$)/))) push(m[1]);
  if (language === "clike-oo" || language === "kotlin") {
    if ((m = sig.match(/\b(?:class|struct|interface|record|enum|object|protocol|actor)\s+\w+(?:<[^>]*>)?\s*(?:\([^)]*\))?\s*:\s*([^{]+?)(?=\s*\{|\s+where\b|\s*$)/))) push(m[1]);
  }
  if (language === "php" && (m = sig.match(/\b(?:extends|implements)\s+([\w\\, ]+)/g))) {
    for (const part of m) push(part.replace(/^\w+\s+/, "").replace(/\\/g, "."));
  }
  return out;
}
