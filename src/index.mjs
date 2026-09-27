/**
 * Public library entry — toolset factory for embedding without the MCP CLI.
 */

export { createToolset, listToolNames, resolveToolCall, TOOL_ALIASES } from "./tools/index.mjs";
export { runMcpServer } from "./mcp-server.mjs";
export {
  parseOutline,
  getOutline,
  formatOutline,
  enclosingSymbol,
  languageFor,
  isCodeFile,
} from "./outline.mjs";
export {
  resolveWithinRoot,
  normalizeWorkspaceRelativePath,
  collectFiles,
  globToRegExp,
  truncateOutput,
} from "./workspace.mjs";
