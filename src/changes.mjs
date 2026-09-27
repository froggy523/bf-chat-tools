/**
 * Map git diffs to the symbols they touch.
 *
 * Used by the `changed_symbols` tool (the `recent_focus` alias maps onto its
 * `commits` / `since` modes).
 * Old/new file contents come from git (or the working tree) and are outlined
 * with the same heuristic parser as everything else.
 */

import path from "node:path";

import {
  createResolver,
  ensureGitRepo,
  findTestsFor,
  gitFileAt,
  isTestPath,
  parseUnifiedDiff,
  rangesOverlap,
  runGit,
} from "./analysis.mjs";
import { isCodeFile, parseOutline } from "./outline.mjs";
import { collectFiles, readTextFile } from "./workspace.mjs";

/**
 * @typedef {object} SymbolChange
 * @property {'added'|'modified'|'deleted'} status
 * @property {string} kind
 * @property {string} qualified
 * @property {number} line      (new side; old side for deleted)
 * @property {number} endLine
 */

/**
 * @typedef {object} FileChange
 * @property {string} path
 * @property {'added'|'modified'|'deleted'|'renamed'} status
 * @property {string|null} oldPath
 * @property {number} added
 * @property {number} removed
 * @property {boolean} isCode
 * @property {SymbolChange[]} symbols
 * @property {string|null} note
 */

/** SHA-1 of git's empty tree; valid as a diff base in every repository. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function hunkRange(start, count) {
  // A zero-count side is a point where something was inserted/removed; cover the neighbour too.
  return count === 0 ? [start, start + 1] : [start, start + count - 1];
}

/** Keep only the deepest touched symbols (drop ancestors that have a touched descendant). */
function deepestOnly(syms) {
  const set = new Set(syms);
  return syms.filter((s) => !hasTouchedDescendant(s, set));
}

function hasTouchedDescendant(sym, set) {
  for (const c of sym.children ?? []) {
    if (set.has(c) || hasTouchedDescendant(c, set)) return true;
  }
  return false;
}

function touchedSymbols(outline, ranges) {
  if (!outline || !ranges.length) return [];
  const hit = outline.symbols.filter((s) => ranges.some(([a, b]) => rangesOverlap(s.line, s.endLine, a, b)));
  return deepestOnly(hit);
}

/**
 * Resolve the diff invocation for a mode.
 * @returns {{label: string, args: string[], oldRef: string|null, newSide: 'worktree'|'index'|string, includeUntracked: boolean}}
 */
function resolveMode(root, { since, ref, staged, commits } = {}) {
  const headOk = runGit(root, ["rev-parse", "--verify", "HEAD"], { allowFail: true }) != null;
  if (!headOk) throw new Error("Repository has no commits yet; nothing to diff against.");

  if (staged) {
    return { label: "staged (index vs HEAD)", args: ["diff", "-U0", "--cached"], oldRef: "HEAD", newSide: "index", includeUntracked: false };
  }
  if (since) {
    const base = runGit(root, ["merge-base", since, "HEAD"], { allowFail: true }) ?? since;
    if (runGit(root, ["rev-parse", "--verify", `${base}^{commit}`], { allowFail: true }) == null) {
      throw new Error(`Could not resolve '${since}' as a git ref.`);
    }
    return { label: `since ${since} (${base.slice(0, 10)}..HEAD)`, args: ["diff", "-U0", `${base}..HEAD`], oldRef: base, newSide: "HEAD", includeUntracked: false };
  }
  if (commits) {
    const n = Math.max(1, commits);
    let oldRef = `HEAD~${n}`;
    if (runGit(root, ["rev-parse", "--verify", `${oldRef}^{commit}`], { allowFail: true }) == null) {
      // Fewer than n commits: diff the whole history against git's empty tree.
      oldRef = EMPTY_TREE;
    }
    return { label: `last ${n} commit(s)`, args: ["diff", "-U0", `${oldRef}..HEAD`], oldRef, newSide: "HEAD", includeUntracked: false };
  }
  if (ref) {
    const m = String(ref).match(/^(.+?)\.{2,3}(.+)$/);
    if (m) {
      return { label: `${m[1]}..${m[2]}`, args: ["diff", "-U0", String(ref)], oldRef: m[1], newSide: m[2], includeUntracked: false };
    }
    return { label: `${ref} vs working tree`, args: ["diff", "-U0", String(ref)], oldRef: String(ref), newSide: "worktree", includeUntracked: true };
  }
  return { label: "working tree vs HEAD", args: ["diff", "-U0", "HEAD"], oldRef: "HEAD", newSide: "worktree", includeUntracked: true };
}

async function sideText(root, side, rel) {
  if (!rel) return null;
  if (side === "worktree") return readTextFile(path.join(root, rel));
  if (side === "index") return gitFileAt(root, "", rel); // `git show :path`
  return gitFileAt(root, side, rel);
}

/**
 * Compute changed symbols for a diff mode.
 * @param {string} root
 * @param {{since?: string, ref?: string, staged?: boolean, commits?: number, maxFiles?: number, pathFilter?: string, withTests?: boolean}} opts
 */
export async function computeChangedSymbols(root, opts = {}) {
  ensureGitRepo(root);
  const mode = resolveMode(root, opts);
  const maxFiles = Math.min(Math.max(1, opts.maxFiles ?? 40), 150);
  const args = [...mode.args];
  if (opts.pathFilter) args.push("--", opts.pathFilter);
  const diffText = runGit(root, args, { timeoutMs: 30_000 }) ?? "";
  const parsed = parseUnifiedDiff(diffText);

  /** @type {FileChange[]} */
  const files = [];
  let truncated = false;

  for (const f of parsed) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const rel = f.newPath ?? f.oldPath;
    if (!rel) continue;
    const isCode = isCodeFile(rel) || (f.oldPath ? isCodeFile(f.oldPath) : false);
    const change = {
      path: rel,
      status: f.status,
      oldPath: f.status === "renamed" ? f.oldPath : null,
      added: f.added,
      removed: f.removed,
      isCode,
      symbols: [],
      note: null,
    };
    files.push(change);
    if (!isCode) continue;

    const newText = f.status === "deleted" ? null : await sideText(root, mode.newSide, f.newPath);
    const oldText = f.status === "added" ? null : await sideText(root, mode.oldRef, f.oldPath);
    const newOutline = newText != null ? parseOutline(newText, f.newPath) : null;
    const oldOutline = oldText != null ? parseOutline(oldText, f.oldPath) : null;
    if (!newOutline && !oldOutline) {
      change.note = "could not read either side";
      continue;
    }

    const newRanges = f.hunks.map((h) => hunkRange(h.newStart, h.newCount));
    const oldRanges = f.hunks.map((h) => hunkRange(h.oldStart, h.oldCount));
    const newByQ = new Map((newOutline?.symbols ?? []).map((s) => [s.qualified, s]));
    const oldByQ = new Map((oldOutline?.symbols ?? []).map((s) => [s.qualified, s]));

    const seen = new Set();
    for (const s of touchedSymbols(newOutline, newRanges)) {
      seen.add(s.qualified);
      change.symbols.push({
        status: oldByQ.has(s.qualified) ? "modified" : "added",
        kind: s.kind,
        qualified: s.qualified,
        line: s.line,
        endLine: s.endLine,
      });
    }
    for (const s of touchedSymbols(oldOutline, oldRanges)) {
      if (seen.has(s.qualified)) continue;
      seen.add(s.qualified);
      if (!newByQ.has(s.qualified)) {
        change.symbols.push({ status: "deleted", kind: s.kind, qualified: s.qualified, line: s.line, endLine: s.endLine });
      } else {
        const n = newByQ.get(s.qualified);
        change.symbols.push({ status: "modified", kind: n.kind, qualified: n.qualified, line: n.line, endLine: n.endLine });
      }
    }
    change.symbols.sort((a, b) => a.line - b.line);
    if (!change.symbols.length && f.hunks.length) change.note = "changes outside any recognised symbol (imports, top-level statements, comments)";
  }

  if (mode.includeUntracked && files.length < maxFiles) {
    const untracked = runGit(root, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }) ?? "";
    for (const rel of untracked.split(/\r?\n/).filter(Boolean)) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (opts.pathFilter && !rel.startsWith(opts.pathFilter.replace(/\/$/, ""))) continue;
      const isCode = isCodeFile(rel);
      const change = { path: rel, status: "added", oldPath: null, added: 0, removed: 0, isCode, symbols: [], note: "untracked" };
      files.push(change);
      if (!isCode) continue;
      const text = await readTextFile(path.join(root, rel));
      const outline = text != null ? parseOutline(text, rel) : null;
      change.added = text ? text.split(/\r?\n/).length : 0;
      for (const s of outline?.roots ?? []) {
        change.symbols.push({ status: "added", kind: s.kind, qualified: s.qualified, line: s.line, endLine: s.endLine });
      }
    }
  }

  let tests = null;
  if (opts.withTests !== false && files.length) {
    const { files: all } = await collectFiles(root, root);
    const resolver = createResolver(root, all);
    const found = new Set();
    const uncovered = [];
    for (const f of files) {
      if (f.status === "deleted") continue;
      if (isTestPath(f.path)) {
        found.add(f.path);
        continue;
      }
      if (!f.isCode) continue;
      const { found: hits, inFile } = await findTestsFor(root, f.path, all, { resolver });
      if (hits.length || inFile.length) {
        hits.forEach((h) => found.add(h));
        inFile.forEach((h) => found.add(`${h} (in-file)`));
      } else {
        uncovered.push(f.path);
      }
    }
    tests = { found: [...found].sort(), uncovered };
  }

  return { mode: mode.label, files, truncated, tests };
}

/** Render a changed-symbols report as compact text. */
export function formatChangedSymbols(report, { title = "Changed symbols", maxSymbolsPerFile = 40 } = {}) {
  const out = [`# ${title} (${report.mode})`];
  const totalSyms = report.files.reduce((n, f) => n + f.symbols.length, 0);
  out.push(`files: ${report.files.length}${report.truncated ? "+" : ""}, symbols: ${totalSyms}`);
  if (!report.files.length) {
    out.push("\n(no changes)");
    return out.join("\n");
  }
  out.push("");
  for (const f of report.files) {
    const stat = f.added || f.removed ? ` (+${f.added} -${f.removed})` : "";
    const rename = f.oldPath ? ` (from ${f.oldPath})` : "";
    const flag = f.status !== "modified" ? ` [${f.status}]` : "";
    out.push(`${f.path}${flag}${rename}${stat}${!f.isCode ? "  (not code)" : ""}`);
    if (f.status === "added" && f.symbols.length > 3) {
      // Whole new file: one summary line instead of a row per symbol.
      const names = f.symbols.map((s) => s.qualified);
      out.push(`  added    ${f.symbols.length} symbol(s): ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}`);
      continue;
    }
    for (const s of f.symbols.slice(0, maxSymbolsPerFile)) {
      const range = s.line === s.endLine ? `${s.line}` : `${s.line}-${s.endLine}`;
      out.push(`  ${s.status.padEnd(8)} ${s.kind} ${s.qualified} @${range}`);
    }
    if (f.symbols.length > maxSymbolsPerFile) out.push(`  … ${f.symbols.length - maxSymbolsPerFile} more symbol(s)`);
    if (f.note && !f.symbols.length) out.push(`  (${f.note})`);
  }
  if (report.tests) {
    out.push("\n## Affected tests");
    out.push(report.tests.found.length ? report.tests.found.join("\n") : "(no test files matched)");
    if (report.tests.uncovered.length) {
      out.push(`\n(no tests found for: ${report.tests.uncovered.slice(0, 15).join(", ")}${report.tests.uncovered.length > 15 ? ", …" : ""})`);
    }
  }
  if (report.truncated) out.push("\n(file list truncated; narrow with path or raise max_files)");
  return out.join("\n");
}
