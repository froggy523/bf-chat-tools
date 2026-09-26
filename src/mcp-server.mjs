/**
 * Minimal stdio MCP server: newline-delimited JSON-RPC 2.0.
 * Compatible with Bitfield Agent's McpClient (initialize, tools/list, tools/call).
 */

import readline from "node:readline";

/**
 * @typedef {object} McpTool
 * @property {string} name
 * @property {string} [description]
 * @property {object} [inputSchema]
 * @property {(args: object) => Promise<unknown>|unknown} execute
 */

/**
 * @param {object} options
 * @param {string} options.protocolVersion
 * @param {{name: string, version: string}} options.serverInfo
 * @param {McpTool[]} options.tools
 * @param {NodeJS.ReadableStream} [options.stdin]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {(line: string) => void} [options.onStderr]
 * @returns {Promise<void>} Resolves when stdin closes.
 */
export function runMcpServer({
  protocolVersion,
  serverInfo,
  tools,
  stdin = process.stdin,
  stdout = process.stdout,
  onStderr,
}) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  function write(payload) {
    stdout.write(`${JSON.stringify(payload)}\n`);
  }

  function reply(id, result) {
    write({ jsonrpc: "2.0", id, result });
  }

  function replyError(id, code, message) {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function textResult(text, isError = false) {
    return {
      content: [{ type: "text", text: String(text ?? "") }],
      ...(isError ? { isError: true } : {}),
    };
  }

  function formatToolResult(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }

  async function handle(msg) {
    if (!msg || typeof msg !== "object") return;

    // Notifications (no id)
    if (msg.id === undefined) {
      if (msg.method === "notifications/initialized") return;
      return;
    }

    if (msg.method === "initialize") {
      reply(msg.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo,
      });
      return;
    }

    if (msg.method === "ping") {
      reply(msg.id, {});
      return;
    }

    if (msg.method === "tools/list") {
      reply(msg.id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        })),
      });
      return;
    }

    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const tool = byName.get(name);
      if (!tool) {
        reply(msg.id, textResult(`Unknown tool '${name}'.`, true));
        return;
      }
      try {
        const value = await tool.execute(args ?? {});
        reply(msg.id, textResult(formatToolResult(value)));
      } catch (err) {
        reply(msg.id, textResult(err?.message ?? String(err), true));
      }
      return;
    }

    replyError(msg.id, -32601, `Method not found: ${msg.method}`);
  }

  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });

  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        onStderr?.(`ignored non-JSON line: ${line.slice(0, 80)}`);
        return;
      }
      handle(msg).catch((err) => {
        onStderr?.(`handler error: ${err.message}`);
        if (msg?.id !== undefined) {
          replyError(msg.id, -32603, err.message);
        }
      });
    });
    rl.on("close", resolve);
  });
}
