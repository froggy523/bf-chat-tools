# Halo Scan

Stdio [MCP](https://modelcontextprotocol.io) server that gives an AI model a
small, read-only toolset for answering questions about a codebase in a working
directory.

Zero npm dependencies. Compatible with Bitfield Agent (`bf-agent --mcp`) and
other MCP clients that speak newline-delimited JSON-RPC over stdio.

## Tools

| Tool | Purpose |
| --- | --- |
| `repo_overview` | Top-level listing, languages, manifests, README head, git snapshot |
| `read_file` | Read a file (optional line offset/limit) |
| `list_dir` | List a directory |
| `grep_search` | Regex content search; code hits are tagged with the enclosing symbol (`[in Class.method]`) |
| `find_files` | Glob / name search |
| `get_symbol` | Full source of a function / class / method / type by name (`parse` or `Parser.parse`), with line numbers |
| `file_outline` | Structure of a file (or directory) without reading it: symbols, line ranges, nesting, imports |
| `find_symbol` | Heuristic definition lookup (JS/TS/Python/Go/Rust/…) |
| `find_references` | Call sites and other identifier references, tagged with the enclosing symbol |
| `git_history` | `log` / `blame` / `show` / `diff` (read-only) |

All paths are confined to the workspace root (`--cwd`).

### Token-efficient navigation

`get_symbol` and `file_outline` exist so a model can answer most questions
without pulling whole files into context. The suggested flow is
`repo_overview` → `file_outline` → `get_symbol`, falling back to `read_file`
with `offset`/`limit` only for ranges the outline does not cover. Symbol
extents are computed heuristically (brace balancing or indentation, no
language server) for JS/TS, Python, Go, Rust, C#/Java, Kotlin/Swift/Scala,
Ruby, PHP, and C/C++; outlines are cached per file by mtime and size.

## Install / run

```bash
node src/cli.mjs --cwd /path/to/repo
```

Or link locally:

```bash
npm link
halo-scan --cwd .
```

### Bitfield Agent

```bash
bf-agent --mcp "halo-scan --cwd ."
# or, from this repo:
bf-agent --mcp "node d:/source/repos/halo/halo-scan/src/cli.mjs --cwd ."
```

### Cursor / other MCP hosts

Point a stdio MCP server entry at `node path/to/halo-scan/src/cli.mjs` with
args `--cwd` and your project root.

## Library use

```js
import { createToolset, runMcpServer } from "@bitfieldcreek/halo-scan";

const tools = createToolset({ workspaceRoot: process.cwd() });
await runMcpServer({
  protocolVersion: "2024-11-05",
  serverInfo: { name: "halo-scan", version: "0.1.0" },
  tools,
});
```

## Develop

```bash
npm test
```

## License

Proprietary — see [LICENSE](./LICENSE) and https://halosoftworks.com/eula.
