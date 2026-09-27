/**
 * Filesystem read tools: read_file, list_dir.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { pathKind, readTextFile, resolveWithinRoot, toRel, truncateOutput } from "../workspace.mjs";

/** Batch mode of read_file: one section per path, each capped, misses reported inline. */
async function readManyFiles(root, paths, maxEach) {
  const out = [];
  for (const p of paths) {
    let rel;
    try {
      const abs = resolveWithinRoot(root, p);
      rel = toRel(root, abs);
      const kind = await pathKind(abs);
      if (kind !== "file") {
        out.push(`## ${rel}\n(${kind === "directory" ? "is a directory" : "not found"})`);
        continue;
      }
      const text = await readTextFile(abs);
      if (text == null) {
        out.push(`## ${rel}\n(binary or too large)`);
        continue;
      }
      const lines = text.split(/\r?\n/);
      const shown = lines.slice(0, maxEach).map((l, i) => `${i + 1}|${l}`);
      const tail = lines.length > maxEach ? `\n… ${lines.length - maxEach} more line(s); read_file path='${rel}' offset=${maxEach + 1} for the rest.` : "";
      out.push(`## ${rel} (${lines.length} lines)\n${shown.join("\n")}${tail}`);
    } catch (err) {
      out.push(`## ${rel ?? p}\n(${err.message})`);
    }
  }
  return truncateOutput(out.join("\n\n"));
}

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createFsTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "read_file",
      description:
        "Read a text file inside the workspace. Returns the whole file, or a line range when offset/limit are given. " +
        "Pass 'paths' (2-12) instead of 'path' to read several small files in one call, each capped by limit. " +
        "For code files, prefer file_outline (structure) or get_symbol (one definition) and read only the range you need.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Batch: several file paths (2-12) read in one call, each capped to limit lines (default 150). Use instead of path.",
          },
          offset: { type: "integer", description: "1-based line number to start reading from (optional)." },
          limit: { type: "integer", description: "Maximum number of lines to read (optional; per file in batch mode)." },
        },
      },
      async execute({ path: filePath, paths, offset, limit }) {
        if (Array.isArray(paths) && paths.length) {
          if (paths.length > 12) throw new Error("At most 12 paths per call.");
          return readManyFiles(root, paths, Math.min(Math.max(5, limit ?? 150), 600));
        }
        if (!filePath) throw new Error("Provide path (one file) or paths (a batch).");
        const target = resolveWithinRoot(root, filePath);
        let text = await readFile(target, "utf8");
        if (offset || limit) {
          const lines = text.split(/\r?\n/);
          const start = Math.max(0, (offset ?? 1) - 1);
          const end = limit ? start + limit : lines.length;
          const slice = lines.slice(start, end);
          const numbered = slice.map((line, i) => `${start + i + 1}|${line}`).join("\n");
          return truncateOutput(
            `File ${toRel(root, target)} lines ${start + 1}-${start + slice.length} of ${lines.length}:\n${numbered}`,
          );
        }
        return truncateOutput(text);
      },
    },
    {
      name: "list_dir",
      description:
        "List the contents of a directory inside the workspace. Directory names end with '/'.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to the workspace root. Defaults to the root.",
          },
        },
      },
      async execute({ path: dirPath }) {
        const target = resolveWithinRoot(root, dirPath);
        const entries = await readdir(target, { withFileTypes: true });
        const names = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort((a, b) => a.localeCompare(b));
        return { path: toRel(root, target), entries: names };
      },
    },
  ];
}
