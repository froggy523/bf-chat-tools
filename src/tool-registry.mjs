/**
 * Mutable active-tool list for profiles + activate_pack.
 */

/**
 * @typedef {import("./mcp-server.mjs").McpTool} McpTool
 */

/**
 * @typedef {object} ToolRegistry
 * @property {(() => void)|null} onChange
 * @property {() => McpTool[]} list
 * @property {(name: string) => boolean} has
 * @property {() => Map<string, McpTool>} map
 * @property {(tool: McpTool) => void} add
 * @property {(catalog: Map<string, McpTool>, names: string[]) => string[]} addFromCatalog
 * @property {() => void} notifyChange
 */

/**
 * @param {McpTool[]} [tools]
 * @returns {ToolRegistry}
 */
export function createToolRegistry(tools = []) {
  /** @type {Map<string, McpTool>} */
  const byName = new Map();
  /** @type {string[]} */
  const order = [];

  /** @type {ToolRegistry} */
  const registry = {
    onChange: null,
    list() {
      return order.map((n) => byName.get(n)).filter(Boolean);
    },
    has(name) {
      return byName.has(name);
    },
    map() {
      return new Map(registry.list().map((t) => [t.name, t]));
    },
    add(tool) {
      if (!tool?.name) return;
      if (!byName.has(tool.name)) order.push(tool.name);
      byName.set(tool.name, tool);
    },
    addFromCatalog(catalog, names) {
      const added = [];
      for (const name of names) {
        if (byName.has(name)) continue;
        const tool = catalog.get(name);
        if (!tool) continue;
        order.push(name);
        byName.set(name, tool);
        added.push(name);
      }
      return added;
    },
    notifyChange() {
      try {
        registry.onChange?.();
      } catch {
        // notifications must never break tools/call
      }
    },
  };

  for (const tool of tools) registry.add(tool);
  return registry;
}
