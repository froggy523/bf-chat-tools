/**
 * Assemble the Halo Scan toolset for a workspace root.
 */

import { createToolRegistry } from "../tool-registry.mjs";
import { createChangeTools } from "./changes.mjs";
import { createContextTools } from "./context.mjs";
import { createDepsTools } from "./deps.mjs";
import { createFsTools } from "./fs.mjs";
import { createGitTools } from "./git.mjs";
import { createNavigateTools } from "./navigate.mjs";
import { createOverviewTools } from "./overview.mjs";
import {
  ACTIVATE_PACK,
  PACKS,
  createActivatePackTool,
  resolveProfileNames,
  unionPackTools,
} from "./packs.mjs";
import { createSearchTools } from "./search.mjs";
import { createSurfaceTools } from "./surface.mjs";
import { createSymbolTools } from "./symbols.mjs";

export {
  ACTIVATE_PACK,
  PACKS,
  SECONDARY_PACKS,
  createActivatePackTool,
  fingerprintWorkspace,
  listPackNames,
  resolveProfileNames,
  unionPackTools,
} from "./packs.mjs";

/**
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {string[]} [options.include] Only expose these tool names. Unknown
 *   names throw so a typo in an allowlist is loud instead of silently
 *   shrinking the toolset.
 * @param {string[]} [options.exclude] Hide these tool names (applied after
 *   include).
 * @param {string} [options.profile] Named pack profile (`base`, `symbols`,
 *   `quality`, `web`, `config`, `full`). Use `createManagedToolset` for
 *   `auto` (async fingerprint) and for live `activate_pack`.
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createToolset({ workspaceRoot, include, exclude, profile } = {}) {
  const all = createAllTools({ workspaceRoot });
  let names = include;

  if (profile) {
    const p = String(profile).trim().toLowerCase();
    if (p === "auto") {
      throw new Error(
        "profile 'auto' requires createManagedToolset() (async fingerprint).",
      );
    }
    names = profileNamesSync(p);
    if (names && include?.length) {
      const allow = new Set(include);
      names = names.filter((n) => allow.has(n));
    }
  }

  if (!names?.length && !exclude?.length) return all;

  const known = new Set(all.map((t) => t.name));
  for (const name of [...(names ?? []), ...(exclude ?? [])]) {
    if (name === ACTIVATE_PACK) continue;
    if (!known.has(name)) throw new Error(`Unknown tool '${name}'.`);
  }
  const keep = names?.length ? new Set(names) : known;
  const drop = new Set(exclude ?? []);
  return all.filter((t) => keep.has(t.name) && !drop.has(t.name));
}

/**
 * Async toolset with optional `--profile` fingerprint and a live
 * `activate_pack` meta-tool when the profile is not `full`.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {string} [options.profile]
 * @param {string[]} [options.include]
 * @param {string[]} [options.exclude]
 * @returns {Promise<{
 *   registry: import("../tool-registry.mjs").ToolRegistry,
 *   catalog: Map<string, import("../mcp-server.mjs").McpTool>,
 *   profile: string|null,
 *   listChanged: boolean,
 * }>}
 */
export async function createManagedToolset({
  workspaceRoot,
  profile = null,
  include,
  exclude,
} = {}) {
  const all = createAllTools({ workspaceRoot });
  const catalog = new Map(all.map((t) => [t.name, t]));

  const profileKey = profile ? String(profile).trim().toLowerCase() : null;
  let names = include?.length ? [...include] : null;

  if (profileKey) {
    const resolved = await resolveProfileNames(profileKey, { workspaceRoot });
    names = resolved === null ? [...catalog.keys()] : resolved;
    if (include?.length) {
      const allow = new Set(include);
      names = names.filter((n) => allow.has(n));
    }
  }

  if (exclude?.length) {
    const drop = new Set(exclude);
    if (!names) names = [...catalog.keys()];
    names = names.filter((n) => !drop.has(n));
  }

  if (names) {
    for (const name of names) {
      if (name === ACTIVATE_PACK) continue;
      if (!catalog.has(name)) throw new Error(`Unknown tool '${name}'.`);
    }
  }

  const initial = names ? names.map((n) => catalog.get(n)).filter(Boolean) : all;
  const registry = createToolRegistry(initial);

  const listChanged = Boolean(profileKey && profileKey !== "full");
  if (listChanged) {
    registry.add(createActivatePackTool({ catalog, registry }));
  }

  return { registry, catalog, profile: profileKey, listChanged };
}

/** Sync profile → names for non-auto profiles. `null` means full set. */
function profileNamesSync(profile) {
  const p = String(profile ?? "")
    .trim()
    .toLowerCase();
  if (!p || p === "full") return null;
  if (p === "base") return [...PACKS.base];
  if (PACKS[p]) return unionPackTools(["base", p]);
  const known = ["base", "full", ...Object.keys(PACKS).filter((k) => k !== "base")].join(", ");
  throw new Error(`Unknown profile '${profile}'. Known: ${known} (use createManagedToolset for auto).`);
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
