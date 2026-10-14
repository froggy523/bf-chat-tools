/**
 * Public library entry — toolset factory for embedding without the MCP CLI.
 */

export {
  createToolset,
  createManagedToolset,
  listToolNames,
  resolveToolCall,
  TOOL_ALIASES,
  ACTIVATE_PACK,
  PACKS,
  SECONDARY_PACKS,
  createActivatePackTool,
  fingerprintWorkspace,
  listPackNames,
  resolveProfileNames,
  unionPackTools,
} from "./tools/index.mjs";
export { runMcpServer, createToolRegistry } from "./mcp-server.mjs";
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
export {
  BF_DIRNAME,
  BITFIELD_DIRNAME,
  PRODUCT_DIRNAME,
  STORE_ROOT_REL,
  ENCYCLOPEDIA_TOOL,
  STORE_REL,
  LEGACY_STORE_RELS,
  toolStoreRel,
  toolStoreDir,
  storeDir,
  storeArtifactPath,
  ensureToolStore,
  ensureProjectStore,
} from "./store.mjs";
