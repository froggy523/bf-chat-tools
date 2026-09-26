/**
 * Filesystem read tools: read_file, list_dir.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { resolveWithinRoot, toRel, truncateOutput } from "../workspace.mjs";

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
        "For code files, prefer file_outline (structure) or get_symbol (one definition) and read only the range you need.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          offset: { type: "integer", description: "1-based line number to start reading from (optional)." },
          limit: { type: "integer", description: "Maximum number of lines to read (optional)." },
        },
        required: ["path"],
      },
      async execute({ path: filePath, offset, limit }) {
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
