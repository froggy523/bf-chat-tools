/**
 * Heuristic symbol-extent parser shared by file_outline, get_symbol, and the
 * "enclosing symbol" annotations on grep_search / find_references.
 *
 * No language server: definitions are recognised by line-anchored regexes and
 * extents are computed by bracket balancing (brace languages) or indentation
 * (Python / Ruby). Results are cached per file by mtime + size.
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import { readTextFile } from "./workspace.mjs";

/**
 * @typedef {object} OutlineSymbol
 * @property {string} name        Display name, e.g. "execute", "Server.Start" (Go receiver), "Point as Display" (Rust impl).
 * @property {string} leaf        Short name used for lookups, e.g. "Start".
 * @property {string} qualified   Dotted path, e.g. "createSymbolTools.execute".
 * @property {string} kind        function | method | class | interface | type | enum | struct | trait | impl | const | variable | namespace | module | macro | property | constructor | define
 * @property {number} line        1-based first line (includes decorators / attributes).
 * @property {number} endLine     1-based last line (inclusive).
 * @property {number} indent      Leading whitespace width of the definition line.
 * @property {boolean} exported   Best-effort visibility flag.
 * @property {string} signature   Trimmed definition line, without trailing '{'.
 * @property {OutlineSymbol|null} parent
 * @property {OutlineSymbol[]} children
 */

/**
 * @typedef {object} Outline
 * @property {string} language
 * @property {number} lineCount
 * @property {OutlineSymbol[]} symbols   Flat list in line order.
 * @property {OutlineSymbol[]} roots     Top-level symbols only.
 * @property {string[]} imports          Module specifiers / import lines.
 */

const EXT_LANGUAGE = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "js",
  ".ts": "js",
  ".tsx": "js",
  ".mts": "js",
  ".cts": "js",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "clike-oo",
  ".cs": "clike-oo",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "kotlin",
  ".swift": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "c",
  ".cc": "c",
  ".cxx": "c",
  ".hpp": "c",
  ".hh": "c",
  ".m": "c",
  ".mm": "c",
};

const INDENT_LANGUAGES = new Set(["python", "ruby"]);

/** Kinds whose bodies legitimately contain members (methods, nested types, fields). */
const CONTAINER_KINDS = new Set([
  "class",
  "interface",
  "struct",
  "trait",
  "impl",
  "object",
  "enum",
  "record",
  "protocol",
  "extension",
  "actor",
  "namespace",
  "module",
  "union",
]);

/** Language family for a path, or null when the outline parser cannot help. */
export function languageFor(filePath) {
  return EXT_LANGUAGE[path.extname(filePath).toLowerCase()] ?? null;
}

/** True when the outline parser understands this file type. */
export function isCodeFile(filePath) {
  return languageFor(filePath) != null;
}

const JS_CONTROL_WORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "catch",
  "try",
  "finally",
  "return",
  "throw",
  "new",
  "delete",
  "typeof",
  "void",
  "await",
  "yield",
  "function",
  "import",
  "export",
  "with",
  "super",
  "this",
]);

const ID = String.raw`[A-Za-z_$][\w$]*`;
/** Double-, single-, and backtick-quoted literals (single line, escape-aware). */
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const MODS = String.raw`(?:(?:public|private|protected|internal|static|abstract|virtual|override|async|final|synchronized|native|sealed|new|extern|unsafe|partial|default|readonly|open|data|inline|suspend|operator|export|declare|const|lateinit|mutating|convenience|required|fileprivate)\s+)`;

/**
 * Per-language definition matchers. Each returns
 * `{name, kind, exported?, requiresParent?}` or null.
 * `requiresParent` marks shapes that are only credible when nested (methods).
 */
const MATCHERS = {
  js(line) {
    let m;
    if ((m = line.match(new RegExp(String.raw`^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(${ID})`)))) {
      return { name: m[2], kind: "function", exported: Boolean(m[1]) };
    }
    if ((m = line.match(new RegExp(String.raw`^\s*(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+(${ID})`)))) {
      return { name: m[2], kind: "class", exported: Boolean(m[1]) };
    }
    if ((m = line.match(new RegExp(String.raw`^\s*(export\s+)?(?:declare\s+)?(interface|type|enum|namespace|module)\s+(${ID})`)))) {
      return { name: m[3], kind: m[2], exported: Boolean(m[1]) };
    }
    if ((m = line.match(new RegExp(String.raw`^\s*(export\s+)?(?:declare\s+)?const\s+enum\s+(${ID})`)))) {
      return { name: m[2], kind: "enum", exported: Boolean(m[1]) };
    }
    if ((m = line.match(new RegExp(String.raw`^\s*(export\s+)?(?:const|let|var)\s+(${ID})\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|${ID})\s*(?::[^=]+)?=>`)))) {
      return { name: m[2], kind: "function", exported: Boolean(m[1]), variableLike: true };
    }
    if ((m = line.match(new RegExp(String.raw`^\s*(export\s+)?(?:const|let|var)\s+(${ID})\s*(?::[^=]+)?=`)))) {
      return { name: m[2], kind: "const", exported: Boolean(m[1]), variableLike: true };
    }
    if ((m = line.match(new RegExp(String.raw`^\s*module\.exports\.(${ID})\s*=`)))) {
      return { name: m[1], kind: "const", exported: true, variableLike: true };
    }
    // Methods: optional modifiers, name, optional generics, params, optional return type, '{' (or params continue on next line).
    // Match against a copy with string literals blanked so default values like `mode = "log"` don't break the param scan.
    const noStrings = line.replace(STRING_LITERAL, "0");
    if (
      (m = noStrings.match(
        new RegExp(
          String.raw`^\s*((?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*)\*?\s*(${ID})\s*(?:<[^>]*>)?\s*\((?:[^()"'\x60]*\)\s*(?::\s*[^{;=]+)?\s*\{|[^()"'\x60]*$)`,
        ),
      ))
    ) {
      const name = m[2];
      if (JS_CONTROL_WORDS.has(name)) return null;
      const hasMods = m[1].trim().length > 0;
      return {
        name,
        kind: name === "constructor" ? "constructor" : "method",
        exported: false,
        // `async foo() {` is a strong signal anywhere; bare `foo() {` only inside a class/object.
        requiresParent: true,
        requiresClassParent: !hasMods,
      };
    }
    return null;
  },

  python(line) {
    let m;
    if ((m = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/))) {
      return { name: m[1], kind: "function", exported: !m[1].startsWith("_") };
    }
    if ((m = line.match(/^\s*class\s+([A-Za-z_]\w*)/))) {
      return { name: m[1], kind: "class", exported: !m[1].startsWith("_") };
    }
    if ((m = line.match(/^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/))) {
      return { name: m[1], kind: "const", exported: !m[1].startsWith("_"), variableLike: true };
    }
    return null;
  },

  go(line) {
    let m;
    if ((m = line.match(/^func\s+\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)\s*\)\s+([A-Za-z_]\w*)/))) {
      return { name: `${m[1]}.${m[2]}`, kind: "method", exported: /^[A-Z]/.test(m[2]) };
    }
    if ((m = line.match(/^func\s+([A-Za-z_]\w*)/))) {
      return { name: m[1], kind: "function", exported: /^[A-Z]/.test(m[1]) };
    }
    if ((m = line.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/))) {
      return { name: m[1], kind: m[2], exported: /^[A-Z]/.test(m[1]) };
    }
    if ((m = line.match(/^type\s+([A-Za-z_]\w*)\s+/))) {
      return { name: m[1], kind: "type", exported: /^[A-Z]/.test(m[1]) };
    }
    if ((m = line.match(/^(?:var|const)\s+([A-Za-z_]\w*)\b/))) {
      return { name: m[1], kind: "const", exported: /^[A-Z]/.test(m[1]), variableLike: true };
    }
    return null;
  },

  rust(line) {
    let m;
    const pub = /^\s*pub\b/.test(line);
    if ((m = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/))) {
      return { name: m[1], kind: "function", exported: pub };
    }
    if ((m = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|mod|union)\s+([A-Za-z_]\w*)/))) {
      return { name: m[2], kind: m[1], exported: pub };
    }
    if ((m = line.match(/^\s*impl(?:<[^>]*>)?\s+(?:([\w:<>, ]+?)\s+for\s+)?([\w:]+(?:<[^>]*>)?)/))) {
      const target = m[2].replace(/<.*$/, "");
      const name = m[1] ? `${target} as ${m[1].trim()}` : target;
      return { name, kind: "impl", exported: false, leaf: target };
    }
    if ((m = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:/))) {
      return { name: m[1], kind: "const", exported: pub, variableLike: true };
    }
    if ((m = line.match(/^\s*macro_rules!\s+([A-Za-z_]\w*)/))) {
      return { name: m[1], kind: "macro", exported: false };
    }
    return null;
  },

  "clike-oo"(line) {
    let m;
    const exported = /\b(public|internal|protected)\b/.test(line);
    if ((m = line.match(new RegExp(String.raw`^\s*${MODS}*(class|interface|struct|enum|record)\s+([A-Za-z_]\w*)`)))) {
      return { name: m[2], kind: m[1], exported };
    }
    if ((m = line.match(/^\s*namespace\s+([\w.]+)/))) {
      return { name: m[1], kind: "namespace", exported: true };
    }
    // Constructor: visibility + CapitalName(
    if ((m = line.match(/^\s*(?:public|private|protected|internal)\s+([A-Z]\w*)\s*\(/))) {
      return { name: m[1], kind: "constructor", exported, requiresParent: true };
    }
    // Method: at least one modifier, a return type, name, '('
    if ((m = line.match(new RegExp(String.raw`^\s*${MODS}+[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(`)))) {
      return { name: m[1], kind: "method", exported };
    }
    // C# property: modifiers, type, Name { get; ... } or Name =>
    if ((m = line.match(new RegExp(String.raw`^\s*${MODS}+[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*(?:\{|=>)`)))) {
      return { name: m[1], kind: "property", exported };
    }
    return null;
  },

  kotlin(line) {
    let m;
    const exported = !/\b(private|fileprivate|internal)\b/.test(line);
    if ((m = line.match(new RegExp(String.raw`^\s*${MODS}*(?:(?:data|sealed|enum|annotation|inner|open|final|abstract|case)\s+)*(class|interface|object|trait|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)`)))) {
      return { name: m[2], kind: m[1], exported };
    }
    if ((m = line.match(new RegExp(String.raw`^\s*${MODS}*(?:fun|func|def)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)`)))) {
      return { name: m[1], kind: "function", exported };
    }
    if ((m = line.match(new RegExp(String.raw`^\s*${MODS}*(?:val|var|let|const val)\s+([A-Za-z_]\w*)\b`)))) {
      return { name: m[1], kind: "const", exported, variableLike: true };
    }
    return null;
  },

  ruby(line) {
    let m;
    if ((m = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/))) {
      return { name: m[1], kind: "function", exported: true };
    }
    if ((m = line.match(/^\s*(class|module)\s+([A-Z]\w*(?:::[A-Z]\w*)*)/))) {
      return { name: m[2], kind: m[1], exported: true };
    }
    return null;
  },

  php(line) {
    let m;
    const exported = !/\bprivate\b/.test(line);
    if ((m = line.match(/^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/))) {
      return { name: m[2], kind: m[1], exported: true };
    }
    if ((m = line.match(/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?\s*([A-Za-z_]\w*)/))) {
      return { name: m[1], kind: "function", exported };
    }
    if ((m = line.match(/^\s*namespace\s+([\w\\]+)/))) {
      return { name: m[1], kind: "namespace", exported: true };
    }
    return null;
  },

  c(line) {
    let m;
    if (/^\s*#\s*define\s+/.test(line)) {
      m = line.match(/^\s*#\s*define\s+([A-Za-z_]\w*)/);
      return m ? { name: m[1], kind: "define", exported: true, singleLine: true } : null;
    }
    if (/^\s*(?:#|\/\/|\/\*|\*|return\b|else\b|typedef\b.*;$)/.test(line)) return null;
    if ((m = line.match(/^\s*(?:typedef\s+)?(struct|class|enum|union|namespace)\s+([A-Za-z_]\w*)\s*(?:\{|:|$)/))) {
      return { name: m[2], kind: m[1], exported: true };
    }
    // Function definition at column 0 or inside a class/namespace: type words, name, '(' and no trailing ';'.
    if (
      !/;\s*$/.test(line) &&
      (m = line.match(/^\s*(?:(?:static|inline|extern|virtual|constexpr|explicit|friend|const|unsigned|signed|struct|enum|template\s*<[^>]*>)\s+)*[\w:<>*&,\s]*?[\s*&]([A-Za-z_~][\w:~]*)\s*\([^;]*$/))
    ) {
      const name = m[1].replace(/^.*::/, "");
      if (["if", "for", "while", "switch", "return", "sizeof", "else"].includes(name)) return null;
      return { name, kind: "function", exported: !/^\s*static\b/.test(line) };
    }
    return null;
  },
};

/** Width of leading whitespace (tabs count as 4). */
function indentOf(line) {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w += 1;
    else if (ch === "\t") w += 4;
    else break;
  }
  return w;
}

/** Remove string literals and comments (approximate, per line) before bracket counting. */

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PREFIX = /[(,=:[!&|?{};+\-*%<>~^]$|\b(?:return|typeof|case|do|else|in|of|instanceof|new|delete|void|throw|yield|await)$|^$/;

/**
 * JS/TS: single left-to-right pass that blanks strings, template literals, regex
 * literals and comments together, so a quote inside a regex (or a slash inside a
 * string) cannot desynchronise the bracket count.
 */
function stripJsNoise(line) {
  let out = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      out += '""';
      i = j + 1;
      continue;
    }
    if (ch === "/") {
      const next = line[i + 1];
      if (next === "/") break; // line comment: drop the rest
      if (next === "*") {
        const end = line.indexOf("*/", i + 2);
        if (end === -1) break;
        i = end + 2;
        continue;
      }
      if (REGEX_PREFIX.test(out.trimEnd())) {
        let j = i + 1;
        let inClass = false;
        for (; j < n; j++) {
          const c = line[j];
          if (c === "\\") {
            j++;
            continue;
          }
          if (inClass) {
            if (c === "]") inClass = false;
          } else if (c === "[") inClass = true;
          else if (c === "/") break;
        }
        while (j + 1 < n && /[dgimsuyv]/.test(line[j + 1])) j++;
        out += '""';
        i = j + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function stripNoise(line, lang) {
  if (lang === "js") return stripJsNoise(line);
  let s = line.replace(STRING_LITERAL, '""');
  if (lang === "python" || lang === "ruby") {
    s = s.replace(/#.*$/, "");
  } else {
    s = s.replace(/\\./g, "").replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
  }
  return s;
}

function bracketDelta(s) {
  let d = 0;
  for (const ch of s) {
    if (ch === "{" || ch === "(" || ch === "[") d++;
    else if (ch === "}" || ch === ")" || ch === "]") d--;
  }
  return d;
}

const CONTINUATION_TAIL = /(?:=>|=|,|\(|\[|\{|\|\||&&|\+|-|\*|\/|\?|:|\.|\bextends|\bimplements|\bwhere)\s*$/;

/**
 * Extent for brace-family definitions.
 * Balances {}, (), [] from the definition line; falls back to "single line"
 * when nothing opens and the statement looks complete.
 */
function braceExtent(lines, startIdx, lang, maxScan = 20_000) {
  let depth = 0;
  let opened = false;
  const first = stripNoise(lines[startIdx], lang);
  depth += bracketDelta(first);
  if (depth > 0) opened = true;

  /** Allman style: the opening brace sits alone on the next non-blank line. */
  const nextOpensBlock = (from) => {
    for (let j = from + 1; j < Math.min(lines.length, from + 4); j++) {
      const t = lines[j].trim();
      if (t === "") continue;
      return t.startsWith("{");
    }
    return false;
  };

  if (depth < 0) return startIdx;
  if (depth === 0 && !CONTINUATION_TAIL.test(first.trimEnd()) && !nextOpensBlock(startIdx)) {
    return startIdx;
  }

  const limit = Math.min(lines.length, startIdx + maxScan);
  for (let i = startIdx + 1; i < limit; i++) {
    const s = stripNoise(lines[i], lang);
    depth += bracketDelta(s);
    if (depth > 0) opened = true;
    if (depth <= 0) {
      if (opened) return i;
      // Nothing opened yet: a multi-line assignment / signature that never bracketed.
      if (!CONTINUATION_TAIL.test(s.trimEnd()) && !nextOpensBlock(i)) return i;
    }
  }
  return lines.length - 1;
}

/**
 * Extent for indentation-family definitions (Python, Ruby).
 * Skips past a multi-line signature, then consumes deeper-indented lines.
 */
function indentExtent(lines, startIdx, lang) {
  const baseIndent = indentOf(lines[startIdx]);
  let i = startIdx;
  let depth = bracketDelta(stripNoise(lines[i], lang));
  while (depth > 0 && i + 1 < lines.length) {
    i++;
    depth += bracketDelta(stripNoise(lines[i], lang));
  }
  let last = i;
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === "") continue;
    if (indentOf(line) <= baseIndent) break;
    last = j;
  }
  if (lang === "ruby") {
    // Ruby closes blocks with `end` at the base indent; include it.
    const next = lines[last + 1];
    if (next && indentOf(next) === baseIndent && /^\s*end\b/.test(next)) last += 1;
  }
  return last;
}

/** Include decorators / attributes / doc comments directly above a definition. */
function leadingAnnotationStart(lines, defIdx, lang) {
  let i = defIdx;
  while (i > 0) {
    const prev = lines[i - 1].trim();
    if (lang === "python" && prev.startsWith("@")) i--;
    else if (lang === "rust" && prev.startsWith("#[")) i--;
    else if ((lang === "clike-oo" || lang === "kotlin") && /^[@\[]/.test(prev)) i--;
    else if (lang === "js" && prev.startsWith("@")) i--;
    else break;
  }
  return i;
}

const IMPORT_PATTERNS = {
  js: [
    /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/,
    /^\s*(?:const|let|var)\s+.*?=\s*require\(\s*['"]([^'"]+)['"]\s*\)/,
    /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/,
  ],
  python: [/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/, /^\s*from\s+([\w.]+)\s+import\b/],
  go: [/^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"\s*$/],
  rust: [/^\s*(?:pub\s+)?use\s+(\w+(?:::\w+)*(?:::\{[^}]*\}|::\*)?)/, /^\s*(?:extern\s+crate|mod)\s+(\w+)\s*;/],
  "clike-oo": [/^\s*(?:global\s+)?(?:import|using)\s+(?:static\s+)?(?!var\b)([\w.]+)\*?\s*(?:;|$)/, /^\s*(?:global\s+)?using\s+\w+\s*=\s*([\w.]+)\s*;/],
  kotlin: [/^\s*import\s+([\w.]+)/],
  ruby: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/],
  php: [/^\s*use\s+([\w\\]+)/, /^\s*(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/],
  c: [/^\s*#\s*include\s+[<"]([^>"]+)[>"]/],
};

function collectImports(lines, lang) {
  const patterns = IMPORT_PATTERNS[lang] ?? [];
  const out = [];
  const seen = new Set();
  let inGoImportBlock = false;
  for (let i = 0; i < lines.length && i < 400; i++) {
    const line = lines[i];
    if (lang === "go") {
      if (/^\s*import\s*\(/.test(line)) {
        inGoImportBlock = true;
        continue;
      }
      if (inGoImportBlock) {
        if (/^\s*\)/.test(line)) {
          inGoImportBlock = false;
          continue;
        }
      } else if (!/^\s*import\b/.test(line)) {
        continue;
      }
    }
    for (const re of patterns) {
      const m = line.match(re);
      if (m && m[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
        break;
      }
    }
  }
  return out;
}

/**
 * Parse an outline from source text.
 * @param {string} text
 * @param {string} filePath  Used to pick the language by extension.
 * @returns {Outline|null}  null when the language is unsupported.
 */
export function parseOutline(text, filePath) {
  const lang = languageFor(filePath);
  if (!lang) return null;
  const matcher = MATCHERS[lang];
  const lines = text.split(/\r?\n/);
  const indentBased = INDENT_LANGUAGES.has(lang);

  /** @type {OutlineSymbol[]} */
  const symbols = [];
  const stack = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!indentBased) {
      // Skip lines inside /* ... */ blocks (approximate).
      if (inBlockComment) {
        if (line.includes("*/")) inBlockComment = false;
        continue;
      }
      const trimmed = line.trimStart();
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        continue;
      }
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    } else if (/^\s*#/.test(line)) {
      continue;
    }
    if (line.trim() === "") continue;

    const hit = matcher(line);
    if (!hit) continue;

    // Pop the nesting stack to the innermost symbol that still contains this line.
    while (stack.length && stack[stack.length - 1].endLine < i + 1) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : null;

    if (hit.requiresParent && !parent) continue;
    if (hit.requiresClassParent && !(parent && CONTAINER_KINDS.has(parent.kind))) continue;
    // Locals: variable-like declarations inside a function body are noise.
    if (hit.variableLike && parent && !CONTAINER_KINDS.has(parent.kind)) continue;

    const endIdx = hit.singleLine
      ? i
      : indentBased
        ? indentExtent(lines, i, lang)
        : braceExtent(lines, i, lang);
    let endLine = endIdx + 1;
    if (parent && endLine > parent.endLine) endLine = parent.endLine;

    let kind = hit.kind;
    if (kind === "function" && parent && CONTAINER_KINDS.has(parent.kind) && parent.kind !== "namespace" && parent.kind !== "module") {
      kind = "method";
    }

    const startIdx = leadingAnnotationStart(lines, i, lang);
    const signature = line
      .trim()
      .replace(/\s*\{\s*$/, "")
      .replace(/\s*:\s*$/, lang === "python" ? "" : ":")
      .slice(0, 140);

    const leaf = hit.leaf ?? hit.name.split(".").pop();
    const sym = {
      name: hit.name,
      leaf,
      qualified: parent ? `${parent.qualified}.${leaf}` : hit.name,
      kind,
      line: startIdx + 1,
      defLine: i + 1,
      endLine,
      indent: indentOf(line),
      exported: Boolean(hit.exported) && (!parent || parent.kind === "namespace" || parent.kind === "module"),
      signature,
      parent,
      children: [],
    };
    // Go receiver methods carry their type in the name; keep qualified = "Type.Method".
    if (lang === "go" && hit.kind === "method") sym.qualified = hit.name;
    // Rust impl blocks qualify their members by the target type ("Point.fmt"), not "Point as Display.fmt".
    if (kind === "impl") sym.qualified = parent ? `${parent.qualified}.${leaf}` : leaf;

    symbols.push(sym);
    if (parent) parent.children.push(sym);
    stack.push(sym);
  }

  return {
    language: lang,
    lineCount: lines.length,
    symbols,
    roots: symbols.filter((s) => !s.parent),
    imports: collectImports(lines, lang),
  };
}

/**
 * Deepest symbol whose extent contains `line` (1-based), or null.
 * @param {Outline|null} outline
 * @param {number} line
 * @returns {OutlineSymbol|null}
 */
export function enclosingSymbol(outline, line) {
  if (!outline) return null;
  let best = null;
  for (const s of outline.symbols) {
    if (s.line <= line && line <= s.endLine) {
      if (!best || s.line >= best.line) best = s;
    }
  }
  return best;
}

/**
 * Suffix for search hits: `[def X]` when the line is X's definition line,
 * `[in X]` when inside its body, empty when no symbol contains the line.
 */
export function enclosingTag(outline, lineNo) {
  const sym = enclosingSymbol(outline, lineNo);
  if (!sym) return "";
  return lineNo === sym.defLine ? `  [def ${sym.qualified}]` : `  [in ${sym.qualified}]`;
}

// ---------------------------------------------------------------------------
// Per-file cache keyed by absolute path, invalidated by mtime + size.

const cache = new Map();
const CACHE_MAX = 2000;

/**
 * Cached outline for a file on disk. Returns null for unsupported, unreadable,
 * binary, or oversized files.
 * @param {string} absPath
 * @returns {Promise<Outline|null>}
 */
export async function getOutline(absPath) {
  if (!isCodeFile(absPath)) return null;
  let st;
  try {
    st = await stat(absPath);
  } catch {
    return null;
  }
  const key = absPath;
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.outline;

  const text = await readTextFile(absPath);
  const outline = text == null ? null : parseOutline(text, absPath);
  if (cache.size >= CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { stamp, outline });
  return outline;
}

/** Test hook: forget cached outlines. */
export function clearOutlineCache() {
  cache.clear();
}

/**
 * Render an outline as compact text for a model.
 * @param {string} rel
 * @param {Outline} outline
 * @param {{maxSymbols?: number, includeImports?: boolean}} [opts]
 */
export function formatOutline(rel, outline, { maxSymbols = 300, includeImports = true } = {}) {
  const out = [];
  out.push(`${rel} — ${outline.lineCount} lines, ${outline.symbols.length} symbol(s), ${outline.language}`);
  if (includeImports && outline.imports.length) {
    const shown = outline.imports.slice(0, 40);
    out.push(`imports: ${shown.join(", ")}${outline.imports.length > shown.length ? ", …" : ""}`);
  }
  if (outline.symbols.length === 0) {
    out.push("(no recognised symbols)");
    return out.join("\n");
  }
  let count = 0;
  const walk = (syms, depth) => {
    for (const s of syms) {
      if (count >= maxSymbols) return;
      count++;
      const range = s.line === s.endLine ? `${s.line}` : `${s.line}-${s.endLine}`;
      const flag = s.exported ? " [exported]" : "";
      out.push(`${"  ".repeat(depth)}${range} ${s.kind} ${s.name}${flag}: ${s.signature}`);
      if (s.children.length) walk(s.children, depth + 1);
    }
  };
  walk(outline.roots, 0);
  if (count >= maxSymbols && outline.symbols.length > count) {
    out.push(`… ${outline.symbols.length - count} more symbol(s) omitted`);
  }
  return out.join("\n");
}
