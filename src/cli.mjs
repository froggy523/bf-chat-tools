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

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createToolset } from "./tools/index.mjs";
import { runMcpServer } from "./mcp-server.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "halo-scan", version: "0.1.0" };

function printHelp() {
  process.stderr.write(`Halo Scan — read-only codebase Q&A MCP server (stdio)

Usage:
  halo-scan [--cwd <dir>]
  halo-scan --help

Options:
  --cwd <dir>   Workspace root (default: HALO_SCAN_ROOT or process cwd)
  --help        Show this help

Tools: repo_overview, read_file, list_dir, grep_search, find_files,
       get_symbol, file_outline, find_symbol, find_references, git_history

Attach with Bitfield Agent:
  bf-agent --mcp "halo-scan --cwd ."
`);
}

function parseArgs(argv) {
  const options = { cwd: process.env.HALO_SCAN_ROOT || process.cwd(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--cwd" || arg === "--root") {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} requires a directory path.`);
      options.cwd = next;
    } else if (arg.startsWith("--cwd=")) {
      options.cwd = arg.slice("--cwd=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
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
  const tools = createToolset({ workspaceRoot: root });

  await runMcpServer({
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    tools,
    onStderr: (line) => process.stderr.write(`${line}\n`),
  });
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
