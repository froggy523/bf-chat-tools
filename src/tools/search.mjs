/**
 * Content and name search: grep_search, find_files.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { enclosingTag, getOutline, isCodeFile } from "../outline.mjs";
import {
  collectFiles,
  globToRegExp,
  looksBinary,
  MAX_FILE_BYTES,
  MAX_FILES_SCANNED,
  resolveWithinRoot,
  truncateOutput,
} from "../workspace.mjs";

const DEFAULT_MAX_MATCHES = 50;
const MAX_MATCHES_CAP = 200;
const MAX_LINE_CHARS = 300;
const MAX_FOUND_FILES = 200;

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createSearchTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "grep_search",
      description:
        "Search file contents with a regular expression. Returns 'path:line: text', and for code files tags each hit " +
        "with the enclosing function/class ('[in Class.method]'). Skips node_modules, .git, and other heavy directories. " +
        "For a known symbol's definition use get_symbol; for its usages use find_references; use grep for strings, " +
        "config keys, comments, and fuzzy names.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression (JavaScript syntax)." },
          path: {
            type: "string",
            description: "Directory or file to search, relative to workspace root. Defaults to whole workspace.",
          },
          glob: {
            type: "string",
            description: "Only search files matching this glob, e.g. '*.mjs' or 'src/**/*.ts'.",
          },
          case_insensitive: { type: "boolean", description: "Ignore case (default false)." },
          max_results: {
            type: "integer",
            description: `Stop after this many matches (default ${DEFAULT_MAX_MATCHES}, max ${MAX_MATCHES_CAP}).`,
          },
        },
        required: ["pattern"],
      },
      async execute({ pattern, path: searchPath, glob, case_insensitive, max_results }) {
        if (!pattern) throw new Error("pattern must not be empty.");
        let regex;
        try {
          regex = new RegExp(pattern, case_insensitive ? "i" : "");
        } catch (err) {
          throw new Error(`Invalid regular expression '${pattern}': ${err.message}`);
        }
        const maxMatches = Math.min(Math.max(1, max_results ?? DEFAULT_MAX_MATCHES), MAX_MATCHES_CAP);
        const start = resolveWithinRoot(root, searchPath);

        let candidates;
        let scanTruncated = false;
        const startStat = await stat(start);
        if (startStat.isFile()) {
          candidates = [path.relative(root, start).split(path.sep).join("/")];
        } else {
          ({ files: candidates, truncated: scanTruncated } = await collectFiles(root, start));
        }

        const scannedBeforeGlob = candidates.length;
        let globFallbackNote = "";
        if (glob) {
          const globRe = globToRegExp(glob);
          const matchWholePath = glob.includes("/");
          const afterGlob = candidates.filter((rel) =>
            matchWholePath ? globRe.test(rel) : globRe.test(rel.split("/").pop()),
          );
          if (afterGlob.length === 0) {
            globFallbackNote = `Note: glob '${glob}' matched 0 of ${scannedBeforeGlob} file(s); searched all files instead.`;
          } else {
            candidates = afterGlob;
          }
        }

        const matches = [];
        let filesWithMatches = 0;
        let hitLimit = false;
        for (const rel of candidates) {
          if (hitLimit) break;
          let buf;
          try {
            buf = await readFile(path.join(root, rel));
          } catch {
            continue;
          }
          if (buf.length > MAX_FILE_BYTES || looksBinary(buf)) continue;
          const lines = buf.toString("utf8").split(/\r?\n/);
          let matchedThisFile = false;
          let outline; // resolved lazily, only for code files that actually match
          for (let i = 0; i < lines.length; i++) {
            if (!regex.test(lines[i])) continue;
            matchedThisFile = true;
            if (outline === undefined) {
              outline = isCodeFile(rel) ? await getOutline(path.join(root, rel)) : null;
            }
            matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_CHARS)}${enclosingTag(outline, i + 1)}`);
            if (matches.length >= maxMatches) {
              hitLimit = true;
              break;
            }
          }
          if (matchedThisFile) filesWithMatches++;
        }

        if (matches.length === 0) {
          const prefix = globFallbackNote ? `${globFallbackNote} ` : "";
          return `${prefix}No matches for /${pattern}/ in ${candidates.length} file(s) searched.`;
        }
        const notes = [];
        if (hitLimit) {
          notes.push(
            `stopped at ${maxMatches} matches — more may exist; narrow pattern/path or raise max_results`,
          );
        }
        if (scanTruncated) notes.push(`only the first ${MAX_FILES_SCANNED} files were scanned`);
        const header = `${matches.length} match(es) in ${filesWithMatches} file(s)${notes.length ? ` (${notes.join("; ")})` : ""}:`;
        const out = globFallbackNote ? [globFallbackNote, header, ...matches] : [header, ...matches];
        return truncateOutput(out.join("\n"));
      },
    },
    {
      name: "find_files",
      description:
        "Find files by name. Glob: '*' one segment, '**' across segments, '?' one char. " +
        "A pattern without '/' matches file names anywhere; with '/' it matches the relative path. " +
        "Plain text is a case-insensitive substring of the file name.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob or substring to match." },
          path: {
            type: "string",
            description: "Directory to search under, relative to workspace root. Defaults to whole workspace.",
          },
        },
        required: ["pattern"],
      },
      async execute({ pattern, path: searchPath }) {
        if (!pattern) throw new Error("pattern must not be empty.");
        const start = resolveWithinRoot(root, searchPath);
        const { files, truncated } = await collectFiles(root, start);
        const globRe = globToRegExp(pattern);
        const matchWholePath = pattern.includes("/");
        const globMeta = /[*?\[]/.test(pattern);
        const needle = pattern.replace(/\\/g, "/").toLowerCase();
        const found = files
          .filter((rel) => {
            const base = rel.split("/").pop() ?? rel;
            if (globMeta) {
              return matchWholePath ? globRe.test(rel) : globRe.test(base);
            }
            if (matchWholePath) return rel.toLowerCase().includes(needle);
            return base.toLowerCase().includes(needle);
          })
          .slice(0, MAX_FOUND_FILES);
        if (found.length === 0) {
          return `No files matching '${pattern}' in ${files.length} file(s) scanned.`;
        }
        const notes = [];
        if (found.length === MAX_FOUND_FILES) notes.push(`showing the first ${MAX_FOUND_FILES}`);
        if (truncated) notes.push(`only the first ${MAX_FILES_SCANNED} files were scanned`);
        const header = `${found.length} file(s)${notes.length ? ` (${notes.join("; ")})` : ""}:`;
        return [header, ...found].join("\n");
      },
    },
  ];
}
