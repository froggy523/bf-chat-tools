#!/usr/bin/env node
/**
 * Halo Scan — stdio MCP server for read-only codebase Q&A.
 *
 * Usage:
 *   halo-scan [--cwd <dir>]
 *   node src/cli.mjs --cwd /path/to/repo
 *
 * Attach from Bitfield Agent:
 *   bf-agent --mcp "halo-scan --cwd ."
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createToolset } from "./tools/index.mjs";
import { runMcpServer } from "./mcp-server.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const SERVER_INFO = { name: "halo-scan", version: pkg.version };

function printHelp() {
  process.stderr.write(`Halo Scan — read-only codebase Q&A MCP server (stdio)

Usage:
  halo-scan [--cwd <dir>] [--tools <a,b,…>] [--exclude-tools <a,b,…>] [--stats <file>]
  halo-scan --help

Options:
  --cwd <dir>             Workspace root (default: HALO_SCAN_ROOT or process cwd)
  --tools <a,b,…>         Expose only these tools (allowlist)
  --exclude-tools <a,b,…> Hide these tools
  --stats <file>          Append one JSON line per tools/call (name, args, ms, chars,
                          isError) and print a per-tool summary to stderr on exit
  --help                  Show this help

Tools:
  orient    repo_overview, project_conventions, entrypoint_map, config_surface, dir_digest
  navigate  file_brief, file_outline, get_symbol, symbol_context, symbol_search, locate, who_imports
  search    grep_search, find_files, find_symbol, find_references, markers
  change    changed_symbols, git_history
  quality   tests_for, test_inventory, unused_exports, config_key_usage, http_surface
  read      read_file, list_dir
  Unlisted aliases (search, open_file, get_symbols, read_many, symbol_history, …) map onto these.

Attach with Bitfield Agent:
  bf-agent --mcp "halo-scan --cwd ."
`);
}

function splitList(value, flag) {
  const names = String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) throw new Error(`${flag} requires a comma-separated list of tool names.`);
  return names;
}

export function parseArgs(argv) {
  const options = {
    cwd: process.env.HALO_SCAN_ROOT || process.cwd(),
    help: false,
    include: [],
    exclude: [],
    stats: null,
  };
  const takeValue = (arg, i) => {
    const next = argv[i + 1];
    if (next === undefined) throw new Error(`${arg} requires a value.`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
    const inlineValue = flag === arg ? undefined : arg.slice(eq + 1);
    const value = () => (inlineValue !== undefined ? inlineValue : takeValue(arg, i++));

    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--cwd" || flag === "--root") {
      options.cwd = value();
      if (!options.cwd) throw new Error(`${flag} requires a directory path.`);
    } else if (flag === "--tools") {
      options.include.push(...splitList(value(), flag));
    } else if (flag === "--exclude-tools") {
      options.exclude.push(...splitList(value(), flag));
    } else if (flag === "--stats") {
      options.stats = value();
      if (!options.stats) throw new Error(`${flag} requires a file path.`);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Build the `--stats` sink: appends a JSON line per call and returns a
 * summary printer for shutdown.
 */
function createStatsSink(file) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  /** @type {Map<string, {calls: number, errors: number, ms: number, chars: number}>} */
  const totals = new Map();
  return {
    onToolCall(record) {
      const line = {
        ts: new Date().toISOString(),
        tool: record.name,
        alias: record.alias ?? undefined,
        ms: record.ms,
        chars: record.chars,
        isError: record.isError,
        unknown: record.unknown,
        args: record.args,
      };
      fs.appendFileSync(abs, `${JSON.stringify(line)}\n`);
      const t = totals.get(record.name) ?? { calls: 0, errors: 0, ms: 0, chars: 0 };
      t.calls++;
      if (record.isError) t.errors++;
      t.ms += record.ms;
      t.chars += record.chars;
      totals.set(record.name, t);
    },
    summary() {
      if (!totals.size) return "halo-scan stats: no tool calls";
      const rows = [...totals.entries()].sort((a, b) => b[1].calls - a[1].calls);
      const lines = [`halo-scan stats (${rows.reduce((n, [, t]) => n + t.calls, 0)} calls):`];
      for (const [name, t] of rows) {
        lines.push(
          `  ${name.padEnd(20)} calls=${t.calls} errors=${t.errors} ms=${t.ms} chars=${t.chars}`,
        );
      }
      return lines.join("\n");
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  const root = path.resolve(options.cwd);
  let tools;
  try {
    tools = createToolset({
      workspaceRoot: root,
      include: options.include,
      exclude: options.exclude,
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const stats = options.stats ? createStatsSink(options.stats) : null;

  await runMcpServer({
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    tools,
    onStderr: (line) => process.stderr.write(`${line}\n`),
    onToolCall: stats?.onToolCall,
  });

  if (stats) process.stderr.write(`${stats.summary()}\n`);
}

const isDirect =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirect) {
  main().catch((err) => {
    process.stderr.write(`halo-scan failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}
