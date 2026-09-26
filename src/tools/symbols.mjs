/**
 * Heuristic symbol and reference lookup (no language server).
 * Good enough for common JS/TS/Python/Go/Rust/C# definition shapes.
 */

import path from "node:path";

import { enclosingTag, formatOutline, getOutline, isCodeFile } from "../outline.mjs";
import {
  collectFiles,
  MAX_FILES_SCANNED,
  pathKind,
  readTextFile,
  resolveWithinRoot,
  toRel,
  truncateOutput,
} from "../workspace.mjs";

const DEFAULT_MAX = 40;
const MAX_CAP = 100;
const CONTEXT_RADIUS = 2;
const DEFAULT_BODY_LINES = 200;
const BODY_LINES_CAP = 800;
const FALLBACK_RADIUS = 25;
const MAX_OUTLINE_FILES = 40;

/** Escape a string for use inside a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Definition-oriented patterns. `{name}` is replaced with the escaped symbol.
 * Keep these line-anchored / keyword-prefixed to reduce false positives.
 */
const DEFINITION_PATTERNS = [
  // JS/TS: function / async function / class / interface / type / enum
  String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\*?{name}\b`,
  String.raw`^\s*(?:export\s+)?(?:default\s+)?class\s+{name}\b`,
  String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+{name}\b`,
  String.raw`^\s*(?:export\s+)?(?:interface|type|enum|const\s+enum)\s+{name}\b`,
  // JS/TS: const/let/var name = (...)/function / =>
  String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+{name}\s*=`,
  String.raw`^\s*(?:export\s+)?(?:async\s+)?{name}\s*\([^)]*\)\s*\{`,
  // Methods / object methods roughly
  String.raw`^\s*(?:async\s+)?{name}\s*\([^)]*\)\s*\{`,
  String.raw`^\s*(?:public|private|protected|static|readonly|async)\s+(?:async\s+)?{name}\s*\(`,
  // Python
  String.raw`^\s*(?:async\s+)?def\s+{name}\s*\(`,
  String.raw`^\s*class\s+{name}\s*[:(]`,
  // Go
  String.raw`^\s*func\s+(?:\([^)]+\)\s+)?{name}\s*\(`,
  String.raw`^\s*type\s+{name}\s+`,
  // Rust
  String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+{name}\s*[<(]`,
  String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|mod)\s+{name}\b`,
  // C#
  String.raw`^\s*(?:public|private|protected|internal|static|partial|abstract|sealed)\s+.*\b{name}\s*[<(]`,
  // Ruby
  String.raw`^\s*def\s+(?:self\.)?{name}\b`,
  String.raw`^\s*class\s+{name}\b`,
  String.raw`^\s*module\s+{name}\b`,
];

function assertSymbolName(name) {
  if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(name)) {
    throw new Error("name must be an identifier (letters, digits, _, optional dots).");
  }
}

/**
 * Build definition regexes for a symbol. For dotted names, also try the leaf.
 */
function definitionRegexes(symbol) {
  const parts = symbol.split(".");
  const leaf = parts[parts.length - 1];
  const names = leaf === symbol ? [symbol] : [symbol, leaf];
  const regexes = [];
  for (const name of names) {
    const esc = escapeRe(name);
    for (const tmpl of DEFINITION_PATTERNS) {
      regexes.push(new RegExp(tmpl.replace(/\{name\}/g, esc)));
    }
  }
  return regexes;
}

function formatHit(rel, lineNo, lines, radius = CONTEXT_RADIUS) {
  const from = Math.max(0, lineNo - 1 - radius);
  const to = Math.min(lines.length, lineNo + radius);
  const block = lines.slice(from, to).map((l, i) => {
    const n = from + i + 1;
    const mark = n === lineNo ? ">" : " ";
    return `${mark}${n}|${l}`;
  });
  return `${rel}:${lineNo}\n${block.join("\n")}`;
}

/**
 * Resolve a search scope into `/`-separated relative code-file paths.
 * @returns {Promise<{files: string[], truncated: boolean, kind: 'file'|'directory'|null}>}
 */
async function codeFilesUnder(root, searchPath) {
  const start = resolveWithinRoot(root, searchPath);
  const kind = await pathKind(start);
  if (kind === "file") return { files: [toRel(root, start)], truncated: false, kind };
  if (kind !== "directory") {
    throw new Error(`Path '${searchPath ?? "."}' does not exist in the workspace.`);
  }
  const { files, truncated } = await collectFiles(root, start);
  return { files: files.filter(isCodeFile), truncated, kind };
}

/** Does an outline symbol answer a lookup for `name` ('leaf' or 'Parent.leaf')? */
function symbolMatches(sym, name) {
  if (name.includes(".")) {
    return sym.qualified === name || sym.qualified.endsWith(`.${name}`) || sym.name === name;
  }
  return sym.leaf === name || sym.name === name;
}

/** Numbered source for one symbol extent, capped at maxLines. */
function renderBody(rel, sym, lines, maxLines) {
  const total = sym.endLine - sym.line + 1;
  const shown = Math.min(total, maxLines);
  const header = `${rel}:${sym.line}-${sym.endLine} ${sym.kind} ${sym.qualified}${sym.exported ? " [exported]" : ""}`;
  const body = [];
  for (let n = sym.line; n < sym.line + shown; n++) {
    body.push(`${n}|${lines[n - 1] ?? ""}`);
  }
  if (shown < total) {
    const nextStart = sym.line + shown;
    body.push(
      `… ${total - shown} more line(s); read_file path='${rel}' offset=${nextStart} limit=${sym.endLine - nextStart + 1} for the rest.`,
    );
  }
  return { text: `${header}\n${body.join("\n")}`, shown };
}

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createSymbolTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "get_symbol",
      description:
        "Return the full source of a function, class, method, type, or top-level constant by name, with line numbers. " +
        "Call this instead of find_symbol + read_file when you already know the name. " +
        "Accepts 'name' or 'Parent.name' (e.g. 'Widget.load', 'Server.Start'). " +
        "If several definitions share the name, the first body is returned and the others are listed with path:start-end; " +
        "pass 'path' to pick one. Falls back to a context window when the definition shape is not recognised.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Symbol name, optionally qualified: 'parse', 'Parser.parse'." },
          path: {
            type: "string",
            description: "File or directory to look in (relative). Use to disambiguate. Defaults to whole workspace.",
          },
          max_lines: {
            type: "integer",
            description: `Cap on body lines returned (default ${DEFAULT_BODY_LINES}, max ${BODY_LINES_CAP}). Longer bodies are cut with a read_file hint.`,
          },
        },
        required: ["name"],
      },
      async execute({ name, path: searchPath, max_lines }) {
        const symbol = String(name ?? "").trim();
        if (!symbol) throw new Error("name must not be empty.");
        assertSymbolName(symbol);
        const maxLines = Math.min(Math.max(5, max_lines ?? DEFAULT_BODY_LINES), BODY_LINES_CAP);
        const { files, truncated } = await codeFilesUnder(root, searchPath);

        // Pass 1: outline-based exact matches.
        const matches = [];
        for (const rel of files) {
          const outline = await getOutline(path.join(root, rel));
          if (!outline) continue;
          for (const sym of outline.symbols) {
            if (symbolMatches(sym, symbol)) matches.push({ rel, sym });
            if (matches.length >= 50) break;
          }
          if (matches.length >= 50) break;
        }

        if (matches.length > 0) {
          // Exact qualified matches first, then definitions over impl blocks, then shorter bodies.
          const rank = (m) =>
            (m.sym.qualified === symbol ? 0 : 1) * 10 + (m.sym.kind === "impl" ? 1 : 0);
          matches.sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel) || a.sym.line - b.sym.line);

          const out = [];
          let budget = maxLines;
          let rendered = 0;
          const rest = [];
          for (const m of matches) {
            const size = m.sym.endLine - m.sym.line + 1;
            if (rendered === 0 || size <= budget) {
              const text = await readTextFile(path.join(root, m.rel));
              if (text == null) continue;
              const lines = text.split(/\r?\n/);
              const { text: body, shown } = renderBody(m.rel, m.sym, lines, rendered === 0 ? maxLines : budget);
              out.push(body);
              budget -= shown;
              rendered++;
            } else {
              rest.push(m);
            }
          }
          if (rest.length) {
            out.push(
              `Also defined at (${rest.length}) — pass path to select:\n` +
                rest
                  .map((m) => `  ${m.rel}:${m.sym.line}-${m.sym.endLine} ${m.sym.kind} ${m.sym.qualified}: ${m.sym.signature}`)
                  .join("\n"),
            );
          }
          if (truncated) out.push(`(only first ${MAX_FILES_SCANNED} files scanned)`);
          return truncateOutput(out.join("\n\n"));
        }

        // Pass 2: line-pattern fallback with a context window.
        const defs = definitionRegexes(symbol);
        for (const rel of files) {
          const text = await readTextFile(path.join(root, rel));
          if (text == null) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (!defs.some((re) => re.test(lines[i]))) continue;
            const from = Math.max(1, i + 1 - 3);
            const to = Math.min(lines.length, i + 1 + FALLBACK_RADIUS);
            const block = [];
            for (let n = from; n <= to; n++) block.push(`${n}|${lines[n - 1]}`);
            return truncateOutput(
              `${rel}:${i + 1} (definition shape not recognised; showing lines ${from}-${to} — use read_file for more)\n${block.join("\n")}`,
            );
          }
        }

        return (
          `No definition found for '${symbol}' in ${files.length} code file(s)` +
          `${truncated ? ` (only first ${MAX_FILES_SCANNED} scanned)` : ""}. ` +
          `Try find_references or grep_search.`
        );
      },
    },
    {
      name: "file_outline",
      description:
        "Structure of a file without reading it: functions, classes, methods, types, and top-level constants " +
        "with line ranges, signatures, nesting, and the file's imports. Call this instead of read_file to orient " +
        "in a file, then use get_symbol or read_file with offset/limit for just the parts you need. " +
        "Given a directory, lists top-level symbols of each code file in it.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File (or directory) path relative to the workspace root." },
          include_imports: { type: "boolean", description: "Include the imports line (default true)." },
        },
        required: ["path"],
      },
      async execute({ path: target, include_imports = true }) {
        if (!target) throw new Error("path is required.");
        const abs = resolveWithinRoot(root, target);
        const kind = await pathKind(abs);
        if (kind === "file") {
          const rel = toRel(root, abs);
          const outline = await getOutline(abs);
          if (!outline) {
            return isCodeFile(rel)
              ? `${rel}: could not read as text (binary, missing, or over size limit).`
              : `${rel}: outline not supported for this file type; use read_file.`;
          }
          return truncateOutput(formatOutline(rel, outline, { includeImports: include_imports !== false }));
        }
        if (kind !== "directory") throw new Error(`Path '${target}' does not exist in the workspace.`);

        const { files, truncated } = await collectFiles(root, abs);
        const code = files.filter(isCodeFile);
        const shown = code.slice(0, MAX_OUTLINE_FILES);
        const out = [`${toRel(root, abs)}/ — ${code.length} code file(s)${shown.length < code.length ? `, showing ${shown.length}` : ""}${truncated ? `; only first ${MAX_FILES_SCANNED} files scanned` : ""}`];
        for (const rel of shown) {
          const outline = await getOutline(path.join(root, rel));
          if (!outline) continue;
          const roots = outline.roots.slice(0, 40);
          const items = roots.map((s) => `${s.kind} ${s.name}${s.exported ? "*" : ""} @${s.line}${s.endLine !== s.line ? `-${s.endLine}` : ""}`);
          out.push(
            `\n${rel} (${outline.lineCount} lines): ${items.join(", ") || "(no symbols)"}${outline.roots.length > roots.length ? ", …" : ""}`,
          );
        }
        if (shown.length) out.push("\n* = exported. Use file_outline on one file for methods and imports.");
        return truncateOutput(out.join("\n"));
      },
    },
    {
      name: "find_symbol",
      description:
        "Find where a symbol (function, class, type, const) is defined; returns path:line with a few lines of context. " +
        "Use when you need locations or aren't sure of the exact name. If you want the body, call get_symbol instead.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Symbol name, e.g. 'McpClient' or 'resolveWithinRoot'." },
          path: {
            type: "string",
            description: "Directory or file to search under (relative). Defaults to whole workspace.",
          },
          max_results: {
            type: "integer",
            description: `Max definition hits (default ${DEFAULT_MAX}, max ${MAX_CAP}).`,
          },
        },
        required: ["name"],
      },
      async execute({ name, path: searchPath, max_results }) {
        const symbol = String(name ?? "").trim();
        if (!symbol) throw new Error("name must not be empty.");
        assertSymbolName(symbol);
        const maxHits = Math.min(Math.max(1, max_results ?? DEFAULT_MAX), MAX_CAP);
        const { files, truncated } = await codeFilesUnder(root, searchPath);

        const defs = definitionRegexes(symbol);
        const hits = [];
        for (const rel of files) {
          if (hits.length >= maxHits) break;
          const text = await readTextFile(path.join(root, rel));
          if (text == null) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= maxHits) break;
            if (defs.some((re) => re.test(lines[i]))) {
              hits.push(formatHit(rel, i + 1, lines));
            }
          }
        }

        if (hits.length === 0) {
          return (
            `No definition-like matches for '${symbol}' in ${files.length} code file(s). ` +
            `Try find_references or grep_search (case_insensitive) if the exact name is uncertain.`
          );
        }
        const notes = [];
        if (hits.length >= maxHits) notes.push(`stopped at ${maxHits} hits`);
        if (truncated) notes.push(`only first ${MAX_FILES_SCANNED} files scanned`);
        const header = `${hits.length} definition hit(s) for '${symbol}'${notes.length ? ` (${notes.join("; ")})` : ""}:`;
        return truncateOutput([header, "", ...hits].join("\n\n"));
      },
    },
    {
      name: "find_references",
      description:
        "Find call sites and other references to a symbol (identifier word-boundary matches). " +
        "Each hit is tagged with the enclosing function/class ('[in Class.method]') so you can see who uses it " +
        "without reading the file. Excludes definition-like lines unless include_definitions is set.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Symbol name to find references for." },
          path: {
            type: "string",
            description: "Directory or file to search under (relative). Defaults to whole workspace.",
          },
          include_definitions: {
            type: "boolean",
            description: "Keep definition-like lines in the results (default false).",
          },
          max_results: {
            type: "integer",
            description: `Max reference hits (default ${DEFAULT_MAX}, max ${MAX_CAP}).`,
          },
        },
        required: ["name"],
      },
      async execute({ name, path: searchPath, include_definitions, max_results }) {
        const symbol = String(name ?? "").trim();
        if (!symbol) throw new Error("name must not be empty.");
        assertSymbolName(symbol);
        const leaf = symbol.includes(".") ? symbol.split(".").pop() : symbol;
        const maxHits = Math.min(Math.max(1, max_results ?? DEFAULT_MAX), MAX_CAP);
        const { files, truncated } = await codeFilesUnder(root, searchPath);

        const wordRe = new RegExp(`\\b${escapeRe(leaf)}\\b`);
        const defs = include_definitions ? [] : definitionRegexes(leaf);
        const hits = [];
        for (const rel of files) {
          if (hits.length >= maxHits) break;
          const text = await readTextFile(path.join(root, rel));
          if (text == null) continue;
          const lines = text.split(/\r?\n/);
          let outline;
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= maxHits) break;
            const line = lines[i];
            if (!wordRe.test(line)) continue;
            if (defs.some((re) => re.test(line))) continue;
            if (outline === undefined) outline = await getOutline(path.join(root, rel));
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}${enclosingTag(outline, i + 1)}`);
          }
        }

        if (hits.length === 0) {
          return `No references for '${symbol}' in ${files.length} code file(s).`;
        }
        const notes = [];
        if (hits.length >= maxHits) notes.push(`stopped at ${maxHits} hits`);
        if (truncated) notes.push(`only first ${MAX_FILES_SCANNED} files scanned`);
        const header = `${hits.length} reference(s) for '${symbol}'${notes.length ? ` (${notes.join("; ")})` : ""}:`;
        return truncateOutput([header, ...hits].join("\n"));
      },
    },
  ];
}
