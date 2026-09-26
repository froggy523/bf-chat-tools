/**
 * Assemble the Halo Scan toolset for a workspace root.
 */

import { createFsTools } from "./fs.mjs";
import { createGitTools } from "./git.mjs";
import { createOverviewTools } from "./overview.mjs";
import { createSearchTools } from "./search.mjs";
import { createSymbolTools } from "./symbols.mjs";

/**
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createToolset({ workspaceRoot }) {
  return [
    ...createOverviewTools({ workspaceRoot }),
    ...createFsTools({ workspaceRoot }),
    ...createSearchTools({ workspaceRoot }),
    ...createSymbolTools({ workspaceRoot }),
    ...createGitTools({ workspaceRoot }),
  ];
}
