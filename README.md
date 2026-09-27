# Halo Scan

Stdio [MCP](https://modelcontextprotocol.io) server that gives an AI model a
small, read-only toolset for answering questions about a codebase in a working
directory.

Zero npm dependencies. Compatible with Bitfield Agent (`bf-agent --mcp`) and
other MCP clients that speak newline-delimited JSON-RPC over stdio.

Package: [`@bitfieldcreek/halo-scan`](https://www.npmjs.com/package/@bitfieldcreek/halo-scan) ·
Source: [froggy523/bf-chat-tools](https://github.com/froggy523/bf-chat-tools)

## Why

Coding agents already have generic `list` / `grep` / `read` tools. Those work,
but they burn context on discovery: hunting for `AGENTS.md`, guessing how to
start the app, mapping source to tests, and re-reading whole files to find one
function.

Halo Scan exists to make that cheap and intentional:

- **Orient first.** `repo_overview` and the project-context tools answer “what
  is this repo and how do I work in it?” in one or two calls.
- **Navigate by structure.** Prefer `file_outline` → `get_symbol` over dumping
  entire files. Symbol extents are heuristic (no language server), cached by
  mtime/size.
- **Stay read-only and local.** Paths are confined to `--cwd`. No write/edit,
  no test runners, no secret values from env files — only names and structure.
- **Stay small.** Zero npm dependencies, stdio MCP only. Easy to attach to
  Bitfield Agent or any host that speaks newline-delimited JSON-RPC.

## Tools

### Orient

| Tool | Purpose |
| --- | --- |
| `repo_overview` | Top-level listing, languages, README head, git snapshot, plus manifest summaries (direct deps, engines, workspaces, lockfiles for `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle(.kts)`, `*.sln` / `*.csproj`) and a packages / projects map for monorepos and solutions. `manifest: <path>` narrows to one manifest |
| `project_conventions` | AGENTS/CONTRIBUTING, editorconfig, lint/format configs, CI workflow names |
| `entrypoint_map` | How to run the project: scripts, bins, Makefile/just targets, Dockerfile CMD, Maven/Gradle `mainClass`, `.csproj` output type + launch profiles, and the files that define `main()` |
| `config_surface` | Env key names and compose services/ports (names only, no secrets) |
| `dir_digest` | Depth-limited tree with file counts and language mix per folder |

### Navigate

| Tool | Purpose |
| --- | --- |
| `file_brief` | One-call file summary: header comment, top-level symbols, one-hop import graph (resolved imports + importers, language-aware — see below), likely tests, recent commits |
| `file_outline` | Structure of a file (or directory) without reading it: symbols, line ranges, nesting, imports |
| `get_symbol` | Full source of a function / class / method / type by name (`parse` or `Parser.parse`), with line numbers. `names: [...]` fetches 2–12 in one call |
| `symbol_context` | Everything about one symbol: body, callers grouped by enclosing function, workspace callees, referencing tests, last commit. Classes / interfaces / traits also get supertypes and (recursive) subtypes / implementers; `history: N` expands the last commit into a `git log -L` history |
| `symbol_search` | Regex over symbol *names* with kind / exported filters (`^handle`, exported classes under `src/` = public API) |
| `locate` | Explain `path:line` (enclosing chain + marked body) or resolve a pasted stack trace to workspace symbols |
| `who_imports` | Which files import a package / module specifier (or a workspace file path), and which manifest declares it (`package.json`, `pyproject`, `go.mod`, `Cargo.toml`, `*.csproj`, `pom.xml`, Gradle) |

### Search

| Tool | Purpose |
| --- | --- |
| `grep_search` | Regex content search; code hits tagged `[in Class.method]`. `expand: "symbol"` returns the enclosing bodies instead of lines |
| `find_files` | Glob / name search |
| `find_symbol` | Heuristic definition lookup (JS/TS/Python/Go/Rust/…) |
| `find_references` | Identifier references tagged with the enclosing symbol. `group_by: "caller"` collapses to one row per caller |
| `markers` | TODO / FIXME / HACK / XXX … with enclosing symbol and per-tag counts |

### Change

| Tool | Purpose |
| --- | --- |
| `changed_symbols` | Which functions/classes a diff touches (added / modified / deleted) plus affected tests. Working tree, staged, `since` branch, `ref` range, or `commits: N` for “what was worked on recently” |
| `git_history` | `log` / `blame` / `show` / `diff` (read-only) |

### Quality

| Tool | Purpose |
| --- | --- |
| `tests_for` | Map source ↔ tests via per-ecosystem naming conventions, mirrored test trees, reverse imports, and Rust `#[cfg(test)]` modules |
| `test_inventory` | Test files with their case names (JS/TS, Python, Go, Rust, C#/Java/Kotlin grouped by class, PHPUnit/Pest, Ruby) |
| `unused_exports` | Exported / public top-level symbols with no references outside their own file (descends into C#/TS namespaces; entry files flagged) |
| `config_key_usage` | Where an env/config key is read in code and where it is defined in config files |
| `http_surface` | Route table for Express/Fastify/Hapi/NestJS, Flask/FastAPI/Django, Go, ASP.NET (attributes, minimal APIs), Spring, JAX-RS, Micronaut, Ktor, axum/actix, Rails, Laravel, Next.js file routes |

### Read

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a file (optional line offset/limit). `paths: [...]` reads 2–12 files in one call, each capped at `limit` lines with a `read_file` hint for the rest |
| `list_dir` | List a directory |

All paths are confined to the workspace root (`--cwd`).

26 tools are listed. A handful of **unlisted aliases** are accepted by
`tools/call` at zero schema cost, because models reach for them anyway:
`search` / `grep` / `rg` / `search_code` → `grep_search` (`query` → `pattern`),
`open_file` / `view_file` / `cat` → `read_file` (`start_line`/`end_line` →
`offset`/`limit`), `list_files` / `glob` → `find_files`, `ls` → `list_dir`,
`tree` → `dir_digest`, `search_symbol` → `symbol_search`, and the pre-merge
names `get_symbols`, `read_many`, `symbol_history`, `type_hierarchy`,
`imports_of`, `manifest_summary`, `packages_map`, `recent_focus`. An alias only
resolves when its target is in the active toolset; `--stats` records the alias
next to the tool that ran.

`--tools a,b,c` exposes only an allowlist, `--exclude-tools a,b` hides tools,
and `--stats <file>` appends one JSON line per `tools/call` (name, args, ms,
chars, isError) and prints a per-tool summary to stderr on exit. The same
`include` / `exclude` options are accepted by `createToolset()`.

### Suggested flow

Pick the entry point that matches the question, then narrow:

- **"What is this repo?"** `repo_overview` (manifests and packages included) →
  `project_conventions` / `entrypoint_map`.
- **"Tell me about this file."** `file_brief`, then `get_symbol` (`name` or
  `names[]`) for the parts you need.
- **"Explain this error / line."** `locate` with a stack trace or `path` +
  `line`.
- **"What changed and what does it touch?"** `changed_symbols` (`since: main`
  for a branch), then `symbol_context` on the interesting ones.
- **"I'm about to change X."** `symbol_context` (hierarchy included;
  `history: N` for its commit log).
- **"What exists?"** `symbol_search`, `test_inventory`, `http_surface`,
  `markers`, `unused_exports`.

Fall back to `grep_search` (with `expand: "symbol"`), `find_references`
(`group_by: "caller"`), and `read_file` with `offset`/`limit` when the
structured tools do not cover a range.

Symbol extents are computed heuristically (brace balancing or indentation) for
JS/TS, Python, Go, Rust, C#/Java, Kotlin/Swift/Scala, Ruby, PHP, and C/C++.

### Language coverage

Reference scanning (`find_references`, `symbol_context` callers, `unused_exports`)
is word-boundary text matching and works the same in every language. Symbol
names accept `Foo.bar`, `Foo::bar`, `Foo#bar`, `bar()` and Ruby `admin?` /
`save!`. The parts that need language knowledge are handled per ecosystem:

| Area | JS / TS | Python | Go | Rust | Java / Kotlin | C# |
| --- | --- | --- | --- | --- | --- | --- |
| Import resolution | relative, `.js`→`.ts`, `tsconfig` `paths` / `baseUrl`, `package.json` `imports` | relative dots, dotted modules over `src/`, `lib/`, `app/` roots, `__init__.py` | `go.mod` module path → package dir | `crate::`, `self::`, `super::`, `mod foo;`, `mod.rs` | `package` index: `import a.b.C` / `a.b.*` → files declaring that type / package | `namespace` index (block and file-scoped): `using A.B;` → files in that namespace |
| Importers of a file | resolved import graph | resolved import graph | package-dir imports | module paths | word-match on the file's type names | word-match on the file's type names |
| Test mapping | `x.test.ts`, `x.spec.ts`, `__tests__/` | `test_x.py`, `x_test.py`, `tests/` | `x_test.go` | `#[cfg(test)]` modules, `tests/` | `XTest`, `XTests`, `XIT`, `TestX` in `src/test/<lang>` mirroring `src/main` | `XTests.cs`, `XTest.cs` in `Proj.Tests/` mirroring `Proj/` |
| Orient | `package.json` | `pyproject.toml` | `go.mod` / `go.work` | `Cargo.toml` | `pom.xml` (modules, deps, `mainClass`), `build.gradle(.kts)`, `settings.gradle` | `*.sln`, `*.csproj` (`PackageReference`, `ProjectReference`, `OutputType`), `launchSettings.json` |

Ruby (`require_relative`, `x_spec.rb`), PHP (composer PSR-4, `XTest.php`) and
C/C++ (`#include "…"`, `class A : public B`) are covered at a lighter level.
Type hierarchies strip nested generics (`Base<Map<K, V>>`) before reading
parents. When a method name is looked up (`Order.total`), `symbol_context`
separates `x.total(` member calls from bare `total(` hits that may belong to an
unrelated symbol.

## Install / run

```bash
npm install -g @bitfieldcreek/halo-scan
halo-scan --cwd /path/to/repo
```

Or without a global install:

```bash
npx @bitfieldcreek/halo-scan --cwd /path/to/repo
```

From a clone of this repo:

```bash
git clone https://github.com/froggy523/bf-chat-tools.git
cd bf-chat-tools
node src/cli.mjs --cwd /path/to/repo
# or
npm link
halo-scan --cwd .
```

### Bitfield Agent

```bash
bf-agent --mcp "halo-scan --cwd ."
# or, from this repo:
bf-agent --mcp "node d:/source/repos/halo/bf-chat-tools/src/cli.mjs --cwd ."
```

### Cursor / other MCP hosts

```json
{
  "mcpServers": {
    "halo-scan": {
      "command": "npx",
      "args": ["-y", "@bitfieldcreek/halo-scan", "--cwd", "."]
    }
  }
}
```

## Library use

```js
import { createToolset, runMcpServer } from "@bitfieldcreek/halo-scan";

const tools = createToolset({ workspaceRoot: process.cwd() });
await runMcpServer({
  protocolVersion: "2024-11-05",
  serverInfo: { name: "halo-scan", version: "0.1.0" }, // match package.json
  tools,
});
```

## Develop

```bash
npm test
npm run pack:check
```

### Tool-usage benchmark

`scripts/bench/run-bench.mjs` runs a fixed question set (`bench.config.json`)
against local repos with different toolsets and reports calls per question,
prompt/completion tokens, and per-tool pick counts. Tools the model never picks
are cull candidates; tools picked only with `--hints` have a description
problem rather than a usefulness problem. The historical `baseline19` toolset
still runs; names it lists that no longer exist are skipped with a warning.

#### Results (Sep 2026)

22 questions (orient / change / quality / file / symbol / debug / deps /
surface) over three local repos: a Node MCP host (`halo-agent`), a C# ASP.NET
solution (`aura-redirector`) and this repo. Ollama cloud models, no hints,
`maxSteps` 20. *Calls* are tool calls per question; *prompt tok* is the total
prompt tokens per question across every turn (what you wait for and pay for);
*schema tok* is the first-turn prompt, i.e. the fixed per-turn cost of
exposing the toolset.

**Step 1 — did the shortcut tools help?** `baseline19` (the surface before the
shortcut tools) vs the 35-tool set, paired per question cell:

| model | toolset | tools | answered | calls | prompt tok | schema tok | error calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-oss:20b | baseline19 | 19 | 62/78 | 11.8 | 85.0k | 2.4k | 61 |
| gpt-oss:20b | full | 35 | 67/78 | **7.8** (−34%) | 71.1k (−16%) | 4.8k | 36 |
| gpt-oss:120b | baseline19 | 19 | 33/39 | 11.5 | 106.7k | 2.4k | 19 |
| gpt-oss:120b | full | 35 | 36/39 | **7.4** (−36%) | 66.9k (−37%) | 4.9k | 14 |
| kimi-k2.7-code | baseline19 | 19 | 36/39 | 17.7 | 79.6k | 2.3k | 4 |
| kimi-k2.7-code | full | 35 | 39/39 | **4.6** (−74%) | 27.5k (−65%) | 4.8k | 0 |

The savings are concentrated where one structured call replaces a
grep → read → outline loop: *change* questions went 11.1 → 2.3 calls and
*quality* 12.9 → 4.8 on gpt-oss:20b; *orient* barely moved (9.4 → 8.6) because
`repo_overview` was already doing that job. A stronger model leans on the
shortcuts harder, not less. Injecting the “Suggested flow” as a hint
(`--hints`, gpt-oss:20b) brought calls to 6.9 and errors to 18 but did not
rescue any never-picked tool.

**Step 2 — what to cull.** Across all three models with the 35-tool set,
`type_hierarchy`, `doc_toc`, `recent_focus` and `packages_map` were never or
almost never picked, and `get_symbols`, `read_many`, `imports_of`,
`manifest_summary` and `symbol_history` were used rarely enough that folding
them into their parent tools as parameters costs nothing. 97 tool errors on
gpt-oss:20b, roughly 60 of them calls to names that do not exist (`search`,
`open_file`, `search_file`, …); that is where the unlisted aliases come from.

**Step 3 — parity check.** Same questions, the 26-tool set:

| model | tools | answered | calls | prompt tok | schema tok | error calls | alias calls absorbed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-oss:20b | 35 → 26 | 67/78 → 67/78 | 7.8 → 7.9 | 71.1k → 64.0k (−10%) | 4.8k → 4.1k | 36 → 32 | 32 (`open_file` ×21, `search` ×9) |
| gpt-oss:120b | 35 → 26 | 36/39 → 38/39 | 7.4 → 7.9 | 66.9k → 71.8k (+7%) | 4.9k → 4.1k | 14 → 13 | 20 (`search_file` ×7, `open_file` ×7, `print_tree` ×2) |

Calls per question are within run-to-run noise (the 120b set is a single
repeat), answer rate held or improved, schema overhead dropped 14%, and the
aliases turned most of the hallucinated-name errors into successful calls.
Still never picked by either gpt-oss model without hints: `symbol_context`,
`locate`, `symbol_search`, `config_key_usage` — kept because kimi does reach
for `symbol_context`, but they are the next candidates if the surface needs to
shrink further.

**Real host caveat.** With the `bf-agent` driver (gpt-oss:20b, 16 runs) the
agent made 10.2 calls per question but only 0.2 reached halo-scan: bf-agent
registers MCP tools lazily behind `describe_tool` / `call_mcp_tool` and its own
`read_file` / `grep` built-ins win the name collision. The numbers above
measure tool selection when the toolset is exposed natively; a host that hides
MCP tools behind a bridge will not see the same gains.

```bash
# baseline19 vs full on every configured repo, via Ollama /api/chat
npm run bench -- --repeat 2
# one model, one toolset, with the README flow injected as guidance
npm run bench -- --model gpt-oss:120b-cloud --toolset full --hints
# what a real host does (bf-agent's lazy MCP bridge + its own built-ins)
npm run bench -- --driver bf-agent --toolset full
# re-render a report
node scripts/bench/run-bench.mjs report scripts/bench/out/<run-dir>
```

Output lands in `scripts/bench/out/<driver>-<timestamp>/` (`runs.jsonl` +
`report.md`, git-ignored). Edit `repos` / `questions` in the config to point at
your own codebases.

The `ollama` driver is read-only. The `bf-agent` driver runs a full agent in
`--mode agent`, which has no read-only switch and has been seen writing helper
scripts into the target repo despite being told not to; point it at a
throwaway clone.

## Publish

Scoped public package. Requires an npm account with publish rights on the
`@bitfieldcreek` org (or user) scope, plus 2FA or a granular token with
“Bypass 2FA” enabled.

```bash
npm login
npm whoami
npm publish
```

`publishConfig.access` is already `public`, so the first publish does not need
`--access public`. `prepublishOnly` runs the test suite before the tarball is
uploaded.

Bump version before subsequent releases (`npm version patch|minor|major`).

## License

Proprietary — see [LICENSE](./LICENSE) and https://halosoftworks.com/eula.
