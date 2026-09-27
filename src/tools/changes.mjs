/**
 * Change-oriented shortcuts: which symbols a diff touches, and a one-call
 * brief for a single file.
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import {
  commitsForPath,
  createResolver,
  effectiveRoots,
  findSourceForTest,
  findTestsFor,
  formatImportRow,
  isGitRepo,
  isTestPath,
  leadingComment,
} from "../analysis.mjs";
import { computeChangedSymbols, formatChangedSymbols } from "../changes.mjs";
import { getOutline, isCodeFile, languageFor } from "../outline.mjs";
import { collectFiles, pathKind, readTextFile, resolveWithinRoot, toRel, truncateOutput } from "../workspace.mjs";

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createChangeTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "changed_symbols",
      description:
        "Which functions/classes a diff touches, per file, with added/modified/deleted status, plus the test " +
        "files likely to cover them. Default: working tree vs HEAD (including untracked files). Use since for " +
        "a branch review, ref for 'A..B' or a single ref, staged for the index, commits for the last N " +
        "commits ('what was worked on recently'). Replaces git_history diff + file_outline per file.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "string", description: "Base branch/ref: compare merge-base(since, HEAD)..HEAD. Prefer for PR/branch review." },
          ref: { type: "string", description: "'A..B' to compare two refs, or a single ref to compare against the working tree." },
          staged: { type: "boolean", description: "Compare the index (staged changes) against HEAD." },
          commits: { type: "integer", description: "Look at the last N commits (HEAD~N..HEAD)." },
          path: { type: "string", description: "Restrict to a directory or file (relative)." },
          max_files: { type: "integer", description: "Max files (default 40, max 150)." },
          include_tests: { type: "boolean", description: "Append the affected-tests section (default true)." },
        },
      },
      async execute({ since, ref, staged, commits, path: filter, max_files, include_tests = true } = {}) {
        let pathFilter;
        if (filter) {
          const abs = resolveWithinRoot(root, filter);
          pathFilter = toRel(root, abs);
          if (pathFilter === ".") pathFilter = undefined;
        }
        const report = await computeChangedSymbols(root, {
          since,
          ref,
          staged: Boolean(staged),
          commits: commits ? Math.min(Math.max(1, commits), 100) : undefined,
          maxFiles: max_files,
          pathFilter,
          withTests: include_tests !== false,
        });
        return truncateOutput(formatChangedSymbols(report));
      },
    },

    {
      name: "file_brief",
      description:
        "One-call brief for a file: size, leading doc comment, top-level symbols, resolved imports, who imports " +
        "it (one-hop import graph), likely tests, and recent commits. Use instead of file_outline + tests_for + " +
        "git_history when orienting in an unfamiliar file or asking who imports it.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File relative to the workspace root." },
          max_symbols: { type: "integer", description: "Max top-level symbols to list (default 40, max 150)." },
        },
        required: ["path"],
      },
      async execute({ path: filePath, max_symbols }) {
        const abs = resolveWithinRoot(root, filePath);
        if ((await pathKind(abs)) !== "file") throw new Error(`Path '${filePath}' is not a file.`);
        const rel = toRel(root, abs);
        const maxSymbols = Math.min(Math.max(1, max_symbols ?? 40), 150);
        const st = await stat(abs);
        const text = await readTextFile(abs);
        const lines = text == null ? [] : text.split(/\r?\n/);
        const code = isCodeFile(rel);
        const outline = code ? await getOutline(abs) : null;

        const out = [`# ${rel}`];
        out.push(
          `${st.size} bytes, ${text == null ? "binary/oversized" : `${lines.length} lines`}${outline ? `, ${outline.language}, ${outline.symbols.length} symbol(s)` : ""}${isTestPath(rel) ? ", test file" : ""}`,
        );

        if (text != null) {
          const doc = leadingComment(lines, 12);
          if (doc.length) {
            out.push("\n## Header comment");
            out.push(doc.join("\n"));
          }
        }

        if (outline) {
          const roots = effectiveRoots(outline);
          const nsNames = outline.roots.filter((s) => s.kind === "namespace" || s.kind === "module").map((s) => s.name);
          out.push(`\n## Top-level symbols (${roots.length})${nsNames.length ? `  in ${nsNames.join(", ")}` : ""}`);
          if (!roots.length) out.push("(none recognised)");
          for (const s of roots.slice(0, maxSymbols)) {
            const range = s.line === s.endLine ? `${s.line}` : `${s.line}-${s.endLine}`;
            const kids = s.children.length ? `  {${s.children.length} member(s)}` : "";
            out.push(`${range} ${s.kind} ${s.name}${s.exported ? " [exported]" : ""}: ${s.signature}${kids}`);
          }
          if (roots.length > maxSymbols) out.push(`… ${roots.length - maxSymbols} more; use file_outline for all`);
        }

        const { files } = await collectFiles(root, root);
        const resolver = createResolver(root, files);
        if (outline) {
          const imports = await resolver.importsOf(rel);
          out.push(`\n## Imports (${imports.length})`);
          if (!imports.length) out.push("(none)");
          out.push(...imports.slice(0, 40).map(formatImportRow));
          if (imports.length > 40) out.push(`… ${imports.length - 40} more`);
        }
        if (code) {
          const lang = languageFor(rel);
          const importers = await resolver.importersOf(rel, { max: 60 });
          out.push(`\n## ${lang === "clike-oo" || lang === "kotlin" ? "Referenced by (type names)" : "Imported by"} (${importers.length})`);
          out.push(importers.length ? importers.slice(0, 15).map((i) => i.file).join("\n") + (importers.length > 15 ? `\n… ${importers.length - 15} more (grep_search the file's basename for all)` : "") : "(none found)");

          if (isTestPath(rel)) {
            const { found } = await findSourceForTest(root, rel, files, { resolver });
            out.push(`\n## Tests → source (${found.length})`);
            out.push(found.length ? found.slice(0, 15).join("\n") : "(none inferred)");
          } else {
            const { found, inFile } = await findTestsFor(root, rel, files, { resolver });
            out.push(`\n## Likely tests (${found.length + inFile.length})`);
            const rows = [...found.slice(0, 15), ...inFile.map((s) => `${s} (in-file)`)];
            out.push(rows.length ? rows.join("\n") : "(none found; tests_for lists suggested paths)");
          }
        }

        if (isGitRepo(root)) {
          const commits = commitsForPath(root, rel, { max: 3 });
          out.push("\n## Recent commits");
          out.push(commits.length ? commits.join("\n") : "(untracked or no history)");
        }

        return truncateOutput(out.join("\n"));
      },
    },
  ];
}
