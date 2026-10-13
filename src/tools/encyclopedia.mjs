/**
 * Encyclopedia pack — bridges Halo Scan to @bitfieldcreek/encircle tools.
 *
 * Encircle stays the deterministic artifact/CLI; these tools expose the same
 * MCP surface as a Halo Scan pack (`activate_pack encyclopedia` / profile).
 *
 * Resolves the sibling checkout first (Halo monorepo), then the published
 * package name. Call-time load keeps Halo Scan installable without Encircle.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @type {readonly string[]} */
export const ENCYCLOPEDIA_TOOL_NAMES = Object.freeze([
  "encyclopedia_overview",
  "encyclopedia_query",
  "encyclopedia_fact",
  "encyclopedia_view",
  "encyclopedia_scan",
  "encyclopedia_analyze",
]);

const MISSING_MSG =
  "Encyclopedia tools require @bitfieldcreek/encircle (sibling checkout at ../encircle or npm package).";

/**
 * @param {string} workspaceRoot
 * @returns {Promise<import("../mcp-server.mjs").McpTool[]>}
 */
async function loadEncircleTools(workspaceRoot) {
  const mod = await importEncircle();
  if (!mod?.createEncyclopediaTools) {
    throw new Error(MISSING_MSG);
  }
  return mod.createEncyclopediaTools({ workspaceRoot });
}

async function importEncircle() {
  const override = process.env.ENCIRCLE_MODULE?.trim();
  if (override) {
    return import(override);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(here, "../../../encircle/src/index.mjs");
  if (existsSync(sibling)) {
    return import(pathToFileURL(sibling).href);
  }

  try {
    return await import("@bitfieldcreek/encircle");
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createEncyclopediaTools({ workspaceRoot } = {}) {
  /** @type {Map<string, Promise<import("../mcp-server.mjs").McpTool[]>>} */
  const byRoot = new Map();

  function toolsFor(root) {
    const key = path.resolve(root ?? workspaceRoot ?? process.cwd());
    let pending = byRoot.get(key);
    if (!pending) {
      pending = loadEncircleTools(key);
      byRoot.set(key, pending);
    }
    return pending;
  }

  /**
   * @param {string} name
   * @param {string} description
   * @param {object} inputSchema
   */
  function wrap(name, description, inputSchema) {
    return {
      name,
      description,
      inputSchema,
      async execute(args = {}) {
        let tools;
        try {
          tools = await toolsFor(workspaceRoot);
        } catch (err) {
          return { ok: false, error: err?.message ?? String(err) };
        }
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          return { ok: false, error: `${MISSING_MSG} (missing tool '${name}')` };
        }
        return tool.execute(args ?? {});
      },
    };
  }

  return [
    wrap(
      "encyclopedia_overview",
      "Summary of the repo encyclopedia: content hash, entity counts by kind, edge/fact totals. " +
        "Reads the existing store; call encyclopedia_scan first to refresh after file changes. " +
        "Requires @bitfieldcreek/encircle.",
      { type: "object", properties: {} },
    ),
    wrap(
      "encyclopedia_query",
      "Query encyclopedia entities by kind (Package, Module, Route, Symbol, DataModel, DeployTarget, AuthGuard, DriftFinding, …), id, or name substring. " +
        "Reads the existing store; call encyclopedia_scan to refresh. Requires @bitfieldcreek/encircle.",
      {
        type: "object",
        properties: {
          kind: { type: "string" },
          id: { type: "string" },
          name: { type: "string" },
          limit: { type: "number" },
        },
      },
    ),
    wrap(
      "encyclopedia_fact",
      "Return a named encyclopedia fact (ecosystems, routes, symbols, dataModels, deploy, auth, drift, …). " +
        "Reads the existing store; call encyclopedia_scan to refresh. Requires @bitfieldcreek/encircle.",
      {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    ),
    wrap(
      "encyclopedia_view",
      "Render a markdown encyclopedia view: passport | atlas | operator | product | risk | data | deploy (aliases accepted). " +
        "Reads the existing store; call encyclopedia_scan to refresh. Requires @bitfieldcreek/encircle.",
      {
        type: "object",
        properties: { view: { type: "string" } },
        required: ["view"],
      },
    ),
    wrap(
      "encyclopedia_scan",
      "Refresh the encyclopedia: run scanners and write .encircle/encircle.json, markdown views, " +
        "scan-index.json, and slices. Default is incremental. Pass full=true to force every scanner. " +
        "Requires @bitfieldcreek/encircle.",
      {
        type: "object",
        properties: {
          out: {
            type: "string",
            description: "Output directory (default: <cwd>/.encircle)",
          },
          full: {
            type: "boolean",
            description: "Force every scanner (ignore provenance index / slice cache).",
          },
        },
      },
    ),
    wrap(
      "encyclopedia_analyze",
      "Subjective local-LLM analysis via Ollama over the encyclopedia briefing (not raw source). " +
        "Writes analysis.md / analysis.json / analysis-index.json. Skips Ollama when analysis-index is fresh. " +
        "Requires a running Ollama daemon and @bitfieldcreek/encircle. Pass scan=true to refresh first; force=true to regen.",
      {
        type: "object",
        properties: {
          model: {
            type: "string",
            description: "Ollama model name (default: OLLAMA_MODEL or llama3.2).",
          },
          host: {
            type: "string",
            description: "Ollama base URL (default: OLLAMA_HOST or http://127.0.0.1:11434).",
          },
          scan: {
            type: "boolean",
            description: "Refresh encyclopedia (incremental) before analyzing.",
          },
          full: {
            type: "boolean",
            description: "With scan=true, force every scanner.",
          },
          force: {
            type: "boolean",
            description: "Regen analysis even when analysis-index is fresh.",
          },
          out: {
            type: "string",
            description: "Output directory (default: <cwd>/.encircle).",
          },
        },
      },
    ),
  ];
}
