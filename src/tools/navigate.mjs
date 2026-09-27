/**
 * Navigation shortcuts: everything about a symbol (body, callers, callees,
 * tests, hierarchy, history), explain a location or stack trace, and search
 * symbols by pattern.
 */

import path from "node:path";

import {
  buildSymbolIndex,
  calledIdentifiers,
  codeFilesUnder,
  commitsForRange,
  findDefinitions,
  groupHitsByCaller,
  isGitRepo,
  isTestPath,
  normalizeSymbolName,
  parentsFromSignature,
  renderBody,
  renderContext,
  scanReferences,
  symbolChain,
  wordRegex,
} from "../analysis.mjs";
import { enclosingSymbol, getOutline, isCodeFile, languageFor } from "../outline.mjs";
import { collectFiles, MAX_FILES_SCANNED, pathKind, readTextFile, resolveWithinRoot, toRel, truncateOutput } from "../workspace.mjs";

const CONTAINER_KINDS = new Set([
  "class",
  "interface",
  "struct",
  "trait",
  "enum",
  "type",
  "record",
  "object",
  "protocol",
  "extension",
  "actor",
  "impl",
]);

const clamp = (v, lo, hi, dflt) => Math.min(Math.max(lo, v ?? dflt), hi);

function formatCallerRows(groups, max) {
  const rows = [];
  for (const g of groups.slice(0, max)) {
    const who = g.caller ? `${g.kind} ${g.caller}` : "(module level)";
    const lines = g.lines.slice(0, 8).join(",") + (g.lines.length > 8 ? ",…" : "");
    rows.push(`${g.rel}  ${who}  ×${g.lines.length}  @${lines}`);
  }
  if (groups.length > max) rows.push(`… ${groups.length - max} more caller(s)`);
  return rows;
}

// ---------------------------------------------------------------------------
// Hierarchy (for symbol_context on classes / interfaces / traits)

const isTypeEntry = (e) => CONTAINER_KINDS.has(e.sym.kind) && e.sym.kind !== "impl";

/**
 * Supertypes (declared, resolved when defined in the workspace) and subtypes /
 * implementers (recursive, by leaf name) for a container symbol.
 *
 * @param {{rel: string, sym: object}} def
 * @param {Map<string, Array<{rel: string, sym: object}>>} index From buildSymbolIndex.
 * @param {string} leaf
 * @param {number} [maxDepth]
 * @returns {string[]}
 */
function renderHierarchy(def, index, leaf, maxDepth = 3) {
  const out = [];
  // Supertypes
  const ancestors = [];
  let frontier = parentsFromSignature(def.sym, languageFor(def.rel));
  const seenA = new Set([leaf]);
  for (let level = 0; frontier.length && level < maxDepth; level++) {
    const next = [];
    for (const p of frontier) {
      if (seenA.has(p)) continue;
      seenA.add(p);
      const target = (index.get(p) ?? []).find(isTypeEntry);
      ancestors.push(`${"  ".repeat(level)}↑ ${p}${target ? `  (${target.rel}:${target.sym.line}-${target.sym.endLine} ${target.sym.kind})` : "  (external)"}`);
      if (target) next.push(...parentsFromSignature(target.sym, languageFor(target.rel)));
    }
    frontier = next;
  }
  out.push("\n## Supertypes");
  out.push(ancestors.length ? ancestors.join("\n") : "(none declared)");

  // Subtypes: parent leaf → container entries naming it in their signature.
  const childrenOf = new Map();
  for (const list of index.values()) {
    for (const entry of list) {
      if (!CONTAINER_KINDS.has(entry.sym.kind)) continue;
      for (const parent of parentsFromSignature(entry.sym, languageFor(entry.rel))) {
        let arr = childrenOf.get(parent);
        if (!arr) childrenOf.set(parent, (arr = []));
        arr.push(entry);
      }
    }
  }
  const descendants = [];
  const seenD = new Set();
  const walk = (parentLeaf, level) => {
    if (level > maxDepth) return;
    for (const entry of childrenOf.get(parentLeaf) ?? []) {
      const key = `${entry.rel}:${entry.sym.line}`;
      if (seenD.has(key)) continue;
      seenD.add(key);
      const isImpl = entry.sym.kind === "impl";
      const label = isImpl ? `impl ${entry.sym.name}` : `${entry.sym.kind} ${entry.sym.qualified}`;
      descendants.push(`${"  ".repeat(level - 1)}↓ ${label}  (${entry.rel}:${entry.sym.line}-${entry.sym.endLine})`);
      if (descendants.length >= 100) return;
      if (!isImpl) walk(entry.sym.leaf, level + 1);
    }
  };
  walk(leaf, 1);
  out.push("\n## Subtypes / implementers");
  out.push(descendants.length ? descendants.join("\n") : "(none found in workspace)");

  // Rust: traits implemented for this type
  const impls = (index.get(leaf) ?? []).filter((e) => e.sym.kind === "impl" && e.sym.name.includes(" as "));
  if (impls.length) {
    out.push("\n## Trait impls for this type");
    out.push(impls.map((e) => `${e.sym.name.split(" as ")[1]}  (${e.rel}:${e.sym.line}-${e.sym.endLine})`).join("\n"));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stack-trace parsing

const FRAME_PATTERNS = [
  // Python: File "path", line N
  { re: /File "([^"]+)", line (\d+)/g, path: 1, line: 2 },
  // .NET: in path:line N
  { re: /\bin ((?:[A-Za-z]:)?[^\s:*?"<>|]+):line (\d+)/g, path: 1, line: 2 },
  // PHP: #0 /path/file.php(12): Class->method()   |   in /path/file.php on line 12   |   in /path/file.php:12
  { re: /((?:[A-Za-z]:)?[\w./\\@~+-]+\.php)\((\d+)\)/g, path: 1, line: 2 },
  { re: /\bin ((?:[A-Za-z]:)?[\w./\\@~+-]+\.php) on line (\d+)/g, path: 1, line: 2 },
  // Generic path.ext:line (Node, Go, Rust, Java "(File.java:12)", Ruby "file.rb:12:in", C#, etc.)
  { re: /((?:file:\/\/\/?)?(?:[A-Za-z]:)?[\w./\\@~+-]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?/g, path: 1, line: 2 },
];

function parseFrames(trace) {
  const frames = [];
  const seen = new Set();
  for (const { re, path: pi, line: li } of FRAME_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(trace))) {
      const raw = m[pi];
      const line = Number(m[li]);
      if (!line) continue;
      const key = `${raw.toLowerCase()}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Function name heuristic: "at fn (" before the match, or ", in fn" after (Python).
      const before = trace.slice(Math.max(0, m.index - 120), m.index);
      const after = trace.slice(m.index + m[0].length, m.index + m[0].length + 80);
      let fn = null;
      const nodeFn = before.match(/\bat\s+([\w$.<>\[\] ]+?)\s*\($/);
      // .NET: "at Ns.Class.Method(Type arg) in path:line N" — before ends with ") in "
      const dotnetFn = before.match(/\bat\s+([\w$.<>`\[\], ]+?)\s*\([^()]*\)\s*in\s*$/);
      const pyFn = after.match(/^,\s*in\s+([\w<>.]+)/);
      // PHP: "#0 file.php(12): Class->method()" — fn follows the match
      const phpFn = /\.php$/i.test(raw) ? after.match(/^:\s*([\w\\]+(?:->|::)\w+|\w+)\(/) : null;
      // Ruby: "file.rb:12:in `meth'" / "file.rb:12:in 'Class#meth'" — fn follows the match
      const rubyFn = /\.rb$/i.test(raw) ? after.match(/^:in\s+[`'](?:block (?:\(\d+ levels\) )?in )?([\w:#.?!<>]+)'/) : null;
      // Java: "at pkg.Class.method(File.java:12)" — before ends with "method("
      const javaFn = /\.(java|kt|scala|groovy)$/i.test(raw) ? before.match(/\bat\s+([\w$.<>]+)\s*\($/) : null;
      const goFn = before.match(/([\w./()*]+)\(\.{0,3}[^)]*\)\s*$/m);
      if (dotnetFn) fn = dotnetFn[1].trim();
      else if (javaFn) fn = javaFn[1];
      else if (nodeFn) fn = nodeFn[1].trim();
      else if (pyFn) fn = pyFn[1];
      else if (phpFn) fn = phpFn[1];
      else if (rubyFn) fn = rubyFn[1];
      else if (goFn && /\.go$/.test(raw)) fn = goFn[1];
      frames.push({ raw, line, fn, index: m.index });
    }
  }
  frames.sort((a, b) => a.index - b.index);
  return frames;
}

function resolveFramePath(root, raw, allFiles, lowerMap) {
  let p = raw.replace(/^file:\/\/\/?/, "").replace(/\\/g, "/");
  if (/(^|\/)node_modules\/|^node:|<anonymous>|^internal\/|^webpack|^https?:/.test(p)) return null;
  const rootPosix = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (p.toLowerCase().startsWith(rootPosix.toLowerCase() + "/")) p = p.slice(rootPosix.length + 1);
  p = p.replace(/^\.\//, "").replace(/^\/+/, "");
  const direct = lowerMap.get(p.toLowerCase());
  if (direct) return { rel: direct, ambiguous: false };
  const suffix = "/" + p.toLowerCase();
  const cands = allFiles.filter((f) => ("/" + f.toLowerCase()).endsWith(suffix));
  if (cands.length) return { rel: cands[0], ambiguous: cands.length > 1 };
  const base = path.posix.basename(p).toLowerCase();
  const byBase = allFiles.filter((f) => f.toLowerCase().endsWith("/" + base) || f.toLowerCase() === base);
  if (byBase.length) return { rel: byBase[0], ambiguous: byBase.length > 1 };
  return null;
}

async function describeLocation(root, rel, lineNo, { bodyLines, full }) {
  const abs = path.join(root, rel);
  const text = await readTextFile(abs);
  if (text == null) return `${rel}: could not read as text.`;
  const lines = text.split(/\r?\n/);
  if (lineNo < 1 || lineNo > lines.length) return `${rel}: line ${lineNo} is out of range (file has ${lines.length} lines).`;
  const outline = isCodeFile(rel) ? await getOutline(abs) : null;
  const sym = enclosingSymbol(outline, lineNo);
  const out = [];
  if (sym) {
    const chain = symbolChain(sym).map((s) => `${s.kind} ${s.name}`).join(" > ");
    out.push(`in: ${chain}  (${rel}:${sym.line}-${sym.endLine})`);
    if (full) {
      // Show the body, but make sure the target line is inside the shown window.
      const total = sym.endLine - sym.line + 1;
      if (total <= bodyLines || lineNo - sym.line < bodyLines) {
        out.push(renderBody(rel, sym, lines, bodyLines, { markLine: lineNo }).text);
      } else {
        out.push(`${rel}:${sym.line}-${sym.endLine} ${sym.kind} ${sym.qualified} (body is ${total} lines; showing window around ${lineNo})`);
        out.push(renderContext(rel, lines, lineNo, Math.floor(bodyLines / 2)));
      }
    } else {
      out.push(renderContext(rel, lines, lineNo, 3));
    }
  } else {
    out.push(`in: (no enclosing symbol${outline ? "" : "; not a code file"})`);
    out.push(renderContext(rel, lines, lineNo, full ? 10 : 3));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createNavigateTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "symbol_context",
      description:
        "Everything about one symbol in a single call: its definition body, callers grouped by enclosing " +
        "function/class, callees it invokes that are defined in the workspace, test files that reference it, " +
        "for classes/interfaces the supertypes and workspace subtypes/implementers, and the commits that " +
        "touched it (history=N for more than the last one). Use this instead of get_symbol + find_references " +
        "+ tests_for + git blame when you are about to change or explain a function/class.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Symbol name, optionally qualified: 'parse', 'Parser.parse'." },
          path: { type: "string", description: "File or directory to look for the definition in (relative). Callers are always searched workspace-wide." },
          max_lines: { type: "integer", description: "Cap on definition body lines (default 80, max 400)." },
          max_callers: { type: "integer", description: "Max caller rows (default 25, max 100)." },
          history: { type: "integer", description: "How many commits touching the symbol's line range to list (default 1, max 40). Answers 'who changed this and why'." },
        },
        required: ["name"],
      },
      async execute({ name, path: searchPath, max_lines, max_callers, history }) {
        const symbol = normalizeSymbolName(name);
        const maxLines = clamp(max_lines, 5, 400, 80);
        const maxCallers = clamp(max_callers, 1, 100, 25);
        const historyMax = clamp(history, 1, 40, 1);
        const leaf = symbol.split(".").pop();

        const { files: all, truncated } = await collectFiles(root, root);
        const allCode = all.filter(isCodeFile);
        const scope = searchPath ? (await codeFilesUnder(root, searchPath)).files : allCode;

        const defs = await findDefinitions(root, scope, symbol);
        if (!defs.length) {
          return `No definition found for '${symbol}' in ${scope.length} code file(s). Try find_symbol (fuzzy) or grep_search.`;
        }
        const primary = defs[0];
        const text = await readTextFile(path.join(root, primary.rel));
        if (text == null) throw new Error(`Could not read ${primary.rel}.`);
        const lines = text.split(/\r?\n/);

        const out = [`# Symbol context: ${symbol}`];
        out.push("\n## Definition");
        out.push(renderBody(primary.rel, primary.sym, lines, maxLines).text);
        if (defs.length > 1) {
          out.push(
            `\nAlso defined at (${defs.length - 1}) — pass path to select:\n` +
              defs.slice(1, 8).map((m) => `  ${m.rel}:${m.sym.line}-${m.sym.endLine} ${m.sym.kind} ${m.sym.qualified}`).join("\n"),
          );
        }

        // Callers (workspace-wide), excluding hits inside the primary body.
        const { hits, truncatedAt } = await scanReferences(root, allCode, leaf, { maxHits: 300, skipDefOf: primary.sym });
        const testHits = hits.filter((h) => isTestPath(h.rel));
        const importFiles = new Set(hits.filter((h) => h.isImport && !isTestPath(h.rel)).map((h) => h.rel));
        const codeHits = hits.filter((h) => !isTestPath(h.rel) && !h.isImport);

        // Precision for members: `x.leaf(` / same-file / owner-name-on-line are likely; bare `leaf(` elsewhere is weak.
        const owner = primary.sym.parent && CONTAINER_KINDS.has(primary.sym.parent.kind) ? primary.sym.parent.leaf : null;
        const isMemberLookup = Boolean(owner) || symbol.includes(".");
        const ownerRe = owner ? wordRegex(owner) : null;
        const likely = isMemberLookup
          ? codeHits.filter((h) => h.member || h.rel === primary.rel || (ownerRe && ownerRe.test(h.text)))
          : codeHits;
        const weak = isMemberLookup ? codeHits.filter((h) => !likely.includes(h)) : [];
        const callerGroups = groupHitsByCaller(likely);
        out.push(`\n## Callers (${likely.length} reference(s) in ${callerGroups.length} place(s)${truncatedAt ? ", scan capped" : ""})`);
        out.push(callerGroups.length ? formatCallerRows(callerGroups, maxCallers).join("\n") : "(none outside tests)");
        if (weak.length) {
          const weakGroups = groupHitsByCaller(weak);
          out.push(`\n### Bare '${leaf}' references (may be other symbols with the same name): ${weak.length} in ${weakGroups.length} place(s)`);
          out.push(formatCallerRows(weakGroups, Math.min(10, maxCallers)).join("\n"));
        }
        if (importFiles.size) out.push(`imported by ${importFiles.size} file(s): ${[...importFiles].slice(0, 10).join(", ")}${importFiles.size > 10 ? ", …" : ""}`);

        // Callees: identifiers called inside the body that are defined in the workspace.
        const called = calledIdentifiers(lines, primary.sym.line, primary.sym.endLine, {
          skipLine: primary.sym.defLine,
          language: languageFor(primary.rel),
        });
        const index = await buildSymbolIndex(root, allCode);
        const calleeRows = [];
        for (const id of called) {
          if (id === leaf) continue;
          const targets = index.get(id);
          if (!targets?.length) continue;
          const t = targets[0];
          calleeRows.push(`${id} → ${t.rel}:${t.sym.line}-${t.sym.endLine} ${t.sym.kind}${targets.length > 1 ? ` (+${targets.length - 1} more def)` : ""}`);
          if (calleeRows.length >= 30) break;
        }
        out.push(`\n## Callees defined in workspace (${calleeRows.length})`);
        out.push(calleeRows.length ? calleeRows.join("\n") : "(none recognised)");

        // Tests
        const testFiles = [...new Set(testHits.map((h) => h.rel))];
        out.push(`\n## Tests referencing it (${testFiles.length})`);
        out.push(testFiles.length ? testFiles.slice(0, 20).join("\n") : "(none)");

        // Hierarchy (container types only): declared supertypes and workspace subtypes / implementers.
        if (CONTAINER_KINDS.has(primary.sym.kind) && primary.sym.kind !== "impl") {
          out.push(...renderHierarchy(primary, index, leaf));
        }

        // History
        if (isGitRepo(root)) {
          const commits = commitsForRange(root, primary.rel, primary.sym.line, primary.sym.endLine, { max: historyMax });
          out.push(historyMax > 1 ? `\n## History (${commits.length} commit(s), newest first)` : "\n## Last change");
          if (!commits.length) out.push("(no git history for this range; file may be untracked)");
          else for (const c of commits) out.push(`${c.hash} ${c.date} ${c.author}: ${c.subject}`);
          if (commits.length && historyMax > 1) out.push(`Use git_history mode='show' ref='<hash>' path='${primary.rel}' for a patch.`);
        }
        if (truncated) out.push(`\n(only first ${MAX_FILES_SCANNED} files scanned)`);
        return truncateOutput(out.join("\n"));
      },
    },

    {
      name: "locate",
      description:
        "Explain a code location. Give path + line to get the enclosing function/class chain and its body with " +
        "the target line marked; or paste a stack trace (Node, Python, Go, Rust, Java, .NET) and get each " +
        "workspace frame resolved to its enclosing symbol. Replaces file_outline + get_symbol/read_file when " +
        "you start from a line number or an error.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File relative to the workspace root (with line)." },
          line: { type: "integer", description: "1-based line number (with path)." },
          trace: { type: "string", description: "Raw stack trace text. Frames outside the workspace are skipped." },
          body_lines: { type: "integer", description: "Max body lines for the primary location (default 80, max 400)." },
          max_frames: { type: "integer", description: "Max trace frames to resolve (default 8, max 20)." },
        },
      },
      async execute({ path: filePath, line, trace, body_lines, max_frames } = {}) {
        const bodyLines = clamp(body_lines, 5, 400, 80);
        if (trace && String(trace).trim()) {
          const maxFrames = clamp(max_frames, 1, 20, 8);
          const frames = parseFrames(String(trace));
          if (!frames.length) return "No file:line frames recognised in the trace.";
          const { files: all } = await collectFiles(root, root);
          const lowerMap = new Map(all.map((f) => [f.toLowerCase(), f]));
          const out = [`# Locate: stack trace (${frames.length} frame(s) parsed)`];
          let shown = 0;
          let skipped = 0;
          for (const fr of frames) {
            if (shown >= maxFrames) break;
            const resolved = resolveFramePath(root, fr.raw, all, lowerMap);
            if (!resolved) {
              skipped++;
              continue;
            }
            shown++;
            out.push(`\n## Frame ${shown}: ${resolved.rel}:${fr.line}${fr.fn ? `  (${fr.fn})` : ""}${resolved.ambiguous ? "  [path ambiguous; best guess]" : ""}`);
            out.push(await describeLocation(root, resolved.rel, fr.line, { bodyLines, full: shown === 1 }));
          }
          if (!shown) out.push("\n(no frames resolved to workspace files)");
          if (skipped) out.push(`\n(${skipped} frame(s) outside the workspace skipped)`);
          return truncateOutput(out.join("\n"));
        }

        if (!filePath || !line) throw new Error("Provide path and line, or trace.");
        const abs = resolveWithinRoot(root, filePath);
        if ((await pathKind(abs)) !== "file") throw new Error(`Path '${filePath}' is not a file.`);
        const rel = toRel(root, abs);
        const out = [`# Locate: ${rel}:${line}`];
        out.push(await describeLocation(root, rel, Number(line), { bodyLines, full: true }));
        return truncateOutput(out.join("\n"));
      },
    },

    {
      name: "symbol_search",
      description:
        "Search symbol names (not file contents) with a regex, optionally filtered by kind and export status. " +
        "Answers 'all handle* functions', 'every exported class under src/', 'methods named execute'. " +
        "More precise and cheaper than grep_search for structural questions; exported_only over a directory " +
        "gives its public API.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex tested against the symbol name and qualified name (e.g. '^handle', 'Service$')." },
          kind: { type: "string", description: "Comma-separated kinds to keep: function, method, class, interface, type, enum, struct, trait, impl, const, variable, namespace, module, macro, property, constructor." },
          exported_only: { type: "boolean", description: "Only exported / public symbols (default false)." },
          path: { type: "string", description: "Directory or file to search under (relative). Defaults to whole workspace." },
          in_signature: { type: "boolean", description: "Also match the pattern against the full signature line (default false)." },
          case_insensitive: { type: "boolean", description: "Ignore case (default true)." },
          max_results: { type: "integer", description: "Max rows (default 60, max 200)." },
        },
        required: ["pattern"],
      },
      async execute({ pattern, kind, exported_only, path: searchPath, in_signature, case_insensitive = true, max_results }) {
        if (!pattern) throw new Error("pattern must not be empty.");
        let re;
        try {
          re = new RegExp(pattern, case_insensitive === false ? "" : "i");
        } catch (err) {
          throw new Error(`Invalid regular expression '${pattern}': ${err.message}`);
        }
        const kinds = kind ? new Set(String(kind).split(",").map((k) => k.trim().toLowerCase()).filter(Boolean)) : null;
        const max = clamp(max_results, 1, 200, 60);
        const { files, truncated } = await codeFilesUnder(root, searchPath);
        const rows = [];
        const byKind = new Map();
        let total = 0;
        for (const rel of files) {
          const outline = await getOutline(path.join(root, rel));
          if (!outline) continue;
          for (const s of outline.symbols) {
            if (kinds && !kinds.has(s.kind)) continue;
            if (exported_only && !s.exported) continue;
            if (!(re.test(s.name) || re.test(s.qualified) || (in_signature && re.test(s.signature)))) continue;
            total++;
            byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
            if (rows.length < max) {
              const range = s.line === s.endLine ? `${s.line}` : `${s.line}-${s.endLine}`;
              rows.push(`${rel}:${range} ${s.kind} ${s.qualified}${s.exported ? " [exported]" : ""}: ${s.signature}`);
            }
          }
        }
        if (!total) return `No symbols matching /${pattern}/${kinds ? ` of kind ${[...kinds].join(",")}` : ""} in ${files.length} code file(s).`;
        const kindSummary = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(", ");
        const notes = [];
        if (total > rows.length) notes.push(`showing ${rows.length} of ${total}`);
        if (truncated) notes.push(`only first ${MAX_FILES_SCANNED} files scanned`);
        const header = `${total} symbol(s) matching /${pattern}/ [${kindSummary}]${notes.length ? ` (${notes.join("; ")})` : ""}:`;
        return truncateOutput([header, ...rows].join("\n"));
      },
    },
  ];
}
