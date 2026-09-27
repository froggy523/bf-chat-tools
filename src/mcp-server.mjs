/**
 * Minimal stdio MCP server: newline-delimited JSON-RPC 2.0.
 * Compatible with Bitfield Agent's McpClient (initialize, tools/list, tools/call).
 */

import readline from "node:readline";

import { resolveToolCall } from "./tools/index.mjs";

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
 * @param {(record: ToolCallRecord) => void} [options.onToolCall] Called after
 *   every tools/call (including unknown-tool and thrown errors) with timing
 *   and output size; used by `--stats`.
 * @returns {Promise<void>} Resolves when stdin closes.
 */

/**
 * @typedef {object} ToolCallRecord
 * @property {string} name
 * @property {object} args
 * @property {number} ms
 * @property {number} chars Length of the text returned to the client.
 * @property {boolean} isError
 * @property {boolean} unknown True when no tool with that name is registered.
 * @property {string|null} alias The name the client asked for when it was an
 *   alias (see TOOL_ALIASES); `name` is then the tool that actually ran.
 */
export function runMcpServer({
  protocolVersion,
  serverInfo,
  tools,
  stdin = process.stdin,
  stdout = process.stdout,
  onStderr,
  onToolCall,
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
      const requested = String(msg.params?.name ?? "");
      const resolved = resolveToolCall(byName, requested, msg.params?.arguments ?? {});
      const tool = resolved?.tool;
      const args = resolved?.args ?? msg.params?.arguments ?? {};
      const started = Date.now();
      const record = (text, isError, unknown = false) => {
        if (!onToolCall) return;
        try {
          onToolCall({
            name: tool?.name ?? requested,
            alias: resolved?.alias ?? null,
            args: args ?? {},
            ms: Date.now() - started,
            chars: text.length,
            isError,
            unknown,
          });
        } catch {
          // stats must never break the protocol
        }
      };
      if (!tool) {
        const text = `Unknown tool '${requested}'. Available tools: ${[...byName.keys()].join(", ")}.`;
        reply(msg.id, textResult(text, true));
        record(text, true, true);
        return;
      }
      try {
        const text = formatToolResult(await tool.execute(args ?? {}));
        reply(msg.id, textResult(text));
        record(text, false);
      } catch (err) {
        const text = err?.message ?? String(err);
        reply(msg.id, textResult(text, true));
        record(text, true);
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
