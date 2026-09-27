/**
 * Assemble the Halo Scan toolset for a workspace root.
 */

import { createChangeTools } from "./changes.mjs";
import { createContextTools } from "./context.mjs";
import { createDepsTools } from "./deps.mjs";
import { createFsTools } from "./fs.mjs";
import { createGitTools } from "./git.mjs";
import { createNavigateTools } from "./navigate.mjs";
import { createOverviewTools } from "./overview.mjs";
import { createSearchTools } from "./search.mjs";
import { createSurfaceTools } from "./surface.mjs";
import { createSymbolTools } from "./symbols.mjs";

/**
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {string[]} [options.include] Only expose these tool names. Unknown
 *   names throw so a typo in an allowlist is loud instead of silently
 *   shrinking the toolset.
 * @param {string[]} [options.exclude] Hide these tool names (applied after
 *   include).
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createToolset({ workspaceRoot, include, exclude } = {}) {
  const all = createAllTools({ workspaceRoot });
  if (!include?.length && !exclude?.length) return all;

  const known = new Set(all.map((t) => t.name));
  for (const name of [...(include ?? []), ...(exclude ?? [])]) {
    if (!known.has(name)) throw new Error(`Unknown tool '${name}'.`);
  }
  const keep = include?.length ? new Set(include) : known;
  const drop = new Set(exclude ?? []);
  return all.filter((t) => keep.has(t.name) && !drop.has(t.name));
}

/** @returns {string[]} Every tool name in registration order. */
export function listToolNames() {
  return createAllTools({ workspaceRoot: process.cwd() }).map((t) => t.name);
}

const grepArgs = (a) => {
  const o = { ...a };
  if (o.query != null && o.pattern == null) o.pattern = o.query;
  if (o.regex != null && o.pattern == null) o.pattern = o.regex;
  delete o.query;
  delete o.regex;
  return o;
};
const readArgs = (a) => {
  const o = { ...a };
  if (o.line_start != null && o.offset == null) {
    o.offset = o.line_start;
    if (o.line_end != null && o.limit == null) o.limit = Math.max(1, o.line_end - o.line_start + 1);
  }
  if (o.start_line != null && o.offset == null) {
    o.offset = o.start_line;
    if (o.end_line != null && o.limit == null) o.limit = Math.max(1, o.end_line - o.start_line + 1);
  }
  for (const k of ["line_start", "line_end", "start_line", "end_line"]) delete o[k];
  return o;
};

/**
 * Names models reach for that are not in tools/list, mapped onto real tools.
 * Two groups: hallucinated generic names seen in benchmarks (`search`,
 * `open_file`, `print_tree`, …) and former tools that were merged into a
 * sibling (`get_symbols` → `get_symbol names[]`, `read_many` → `read_file
 * paths[]`, `symbol_history` → `symbol_context history`, …). Aliases cost no
 * schema tokens; they only apply when the target is in the active toolset.
 *
 * @type {Record<string, {target: string, args?: (a: object) => object}>}
 */
export const TOOL_ALIASES = {
  // hallucinated generics
  search: { target: "grep_search", args: grepArgs },
  search_file: { target: "grep_search", args: grepArgs },
  search_files: { target: "grep_search", args: grepArgs },
  search_code: { target: "grep_search", args: grepArgs },
  search_text: { target: "grep_search", args: grepArgs },
  grep: { target: "grep_search", args: grepArgs },
  rg: { target: "grep_search", args: grepArgs },
  open_file: { target: "read_file", args: readArgs },
  view_file: { target: "read_file", args: readArgs },
  cat: { target: "read_file", args: readArgs },
  print_tree: { target: "dir_digest" },
  tree: { target: "dir_digest" },
  list_files: { target: "find_files" },
  glob: { target: "find_files" },
  ls: { target: "list_dir" },
  search_symbol: { target: "symbol_search" },
  // merged former tools
  get_symbols: { target: "get_symbol" },
  read_many: { target: "read_file" },
  symbol_history: { target: "symbol_context", args: (a) => ({ ...a, history: a.history ?? a.max_count ?? 10 }) },
  type_hierarchy: { target: "symbol_context" },
  imports_of: { target: "file_brief" },
  manifest_summary: { target: "repo_overview", args: (a) => ({ manifest: a.manifest, include_readme: false }) },
  packages_map: { target: "repo_overview", args: () => ({ include_readme: false }) },
  recent_focus: { target: "changed_symbols", args: (a) => ({ since: a.since, commits: a.since ? undefined : a.commits ?? 15, max_files: a.max_files }) },
};

/**
 * Find the tool for a tools/call name, following aliases when the requested
 * name is not registered but its alias target is.
 *
 * @param {Map<string, import("../mcp-server.mjs").McpTool>|import("../mcp-server.mjs").McpTool[]} tools
 * @param {string} name
 * @param {object} [args]
 * @returns {{tool: import("../mcp-server.mjs").McpTool, args: object, alias: string|null}|null}
 */
export function resolveToolCall(tools, name, args = {}) {
  const byName = tools instanceof Map ? tools : new Map(tools.map((t) => [t.name, t]));
  const direct = byName.get(name);
  if (direct) return { tool: direct, args: args ?? {}, alias: null };
  const alias = TOOL_ALIASES[name];
  if (!alias) return null;
  const target = byName.get(alias.target);
  if (!target) return null;
  return { tool: target, args: alias.args ? alias.args(args ?? {}) : args ?? {}, alias: name };
}

function createAllTools({ workspaceRoot }) {
  return [
    ...createOverviewTools({ workspaceRoot }),
    ...createContextTools({ workspaceRoot }),
    ...createChangeTools({ workspaceRoot }),
    ...createFsTools({ workspaceRoot }),
    ...createSearchTools({ workspaceRoot }),
    ...createSymbolTools({ workspaceRoot }),
    ...createNavigateTools({ workspaceRoot }),
    ...createDepsTools({ workspaceRoot }),
    ...createSurfaceTools({ workspaceRoot }),
    ...createGitTools({ workspaceRoot }),
  ];
}
