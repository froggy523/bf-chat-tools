import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.mjs");

/**
 * Tiny stdio MCP client for tests (mirrors Bitfield Agent's wire format).
 */
class TestClient {
  static async connect(command, args, { cwd, env } = {}) {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const client = new TestClient(child);
    const result = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "halo-scan-test", version: "0.0.0" },
    });
    client.serverInfo = result?.serverInfo ?? null;
    client.notify("notifications/initialized", {});
    return client;
  }

  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.notifications = [];
    this._listChangedWaiters = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) {
          this.notifications.push(msg);
          if (msg.method === "notifications/tools/list_changed") {
            for (const w of this._listChangedWaiters.splice(0)) w();
          }
          continue;
        }
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      }
    });
    child.stderr.resume();
    child.on("close", () => {
      this.closed = true;
      for (const [, e] of this.pending) {
        clearTimeout(e.timer);
        e.reject(new Error("server exited"));
      }
      this.pending.clear();
    });
  }

  waitListChanged(ms = 5_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for list_changed")), ms);
      this._listChangedWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  write(payload) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return result?.tools ?? [];
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args ?? {} });
    const text = (result?.content ?? [])
      .filter((p) => p?.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (result?.isError) throw new Error(text);
    return text;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await new Promise((resolve) => this.child.once("close", resolve));
  }
}

let fixtureDir;
let client;

before(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), "halo-scan-"));
  await mkdir(path.join(fixtureDir, "src"), { recursive: true });
  await writeFile(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.2.3", description: "test fixture" }, null, 2),
  );
  await writeFile(
    path.join(fixtureDir, "README.md"),
    "# Fixture\n\nA tiny repo for halo-scan tests.\n",
  );
  await writeFile(
    path.join(fixtureDir, "src", "math.mjs"),
    `export function add(a, b) {\n  return a + b;\n}\n\nexport function boom() {\n  throw new Error("kaboom");\n}\n\nexport const TOTAL = add(1, 2);\n`,
  );
  await writeFile(
    path.join(fixtureDir, "src", "main.mjs"),
    `import { add, boom } from "./math.mjs";\n\nconsole.log(add(2, 3));\nif (false) boom();\n`,
  );

  client = await TestClient.connect(process.execPath, [CLI, "--cwd", fixtureDir]);
});

after(async () => {
  await client?.close();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("initialize handshake reports halo-scan", () => {
  assert.equal(client.serverInfo?.name, "halo-scan");
});

test("tools/list includes Q&A surface", async () => {
  const tools = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.equal(names.length, 26, `expected 26 tools, got ${names.length}: ${names.join(", ")}`);
  for (const culled of ["imports_of", "recent_focus", "manifest_summary", "doc_toc", "type_hierarchy", "symbol_history", "get_symbols", "read_many", "packages_map"]) {
    assert.ok(!names.includes(culled), `culled tool ${culled} still listed`);
  }
  for (const expected of [
    "repo_overview",
    "project_conventions",
    "entrypoint_map",
    "tests_for",
    "dir_digest",
    "config_surface",
    "read_file",
    "list_dir",
    "grep_search",
    "find_files",
    "get_symbol",
    "file_outline",
    "find_symbol",
    "find_references",
    "git_history",
    "changed_symbols",
    "file_brief",
    "symbol_context",
    "locate",
    "symbol_search",
    "who_imports",
    "config_key_usage",
    "unused_exports",
    "test_inventory",
    "http_surface",
    "markers",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
});

test("repo_overview summarizes the fixture", async () => {
  const text = await client.callTool("repo_overview", {});
  assert.match(text, /fixture-app/);
  assert.match(text, /README/);
  assert.match(text, /Top-level/);
});

test("read_file and list_dir work", async () => {
  const listing = JSON.parse(await client.callTool("list_dir", { path: "src" }));
  assert.deepEqual(listing.entries.sort(), ["main.mjs", "math.mjs"]);
  const body = await client.callTool("read_file", { path: "src/math.mjs", offset: 1, limit: 3 });
  assert.match(body, /function add/);
});

test("grep_search and find_files", async () => {
  const grep = await client.callTool("grep_search", { pattern: "function add" });
  assert.match(grep, /src\/math\.mjs:1:/);
  const found = await client.callTool("find_files", { pattern: "*.mjs" });
  assert.match(found, /math\.mjs/);
});

test("find_symbol and find_references", async () => {
  const defs = await client.callTool("find_symbol", { name: "add" });
  assert.match(defs, /src\/math\.mjs:1/);
  const refs = await client.callTool("find_references", { name: "add" });
  assert.match(refs, /main\.mjs/);
});

test("get_symbol and file_outline over the wire", async () => {
  const body = await client.callTool("get_symbol", { name: "boom" });
  assert.match(body, /^src\/math\.mjs:5-7 function boom \[exported\]$/m);
  assert.match(body, /^6\|  throw new Error\("kaboom"\);$/m);

  const outline = await client.callTool("file_outline", { path: "src/math.mjs" });
  assert.match(outline, /^1-3 function add \[exported\]/m);
  assert.match(outline, /^5-7 function boom \[exported\]/m);
  assert.match(outline, /^9 const TOTAL \[exported\]/m);
});

test("shortcut tools work over the wire", async () => {
  const ctx = await client.callTool("symbol_context", { name: "add" });
  assert.match(ctx, /## Definition\nsrc\/math\.mjs:1-3 function add/);
  assert.match(ctx, /src\/main\.mjs\s+\(module level\)/);

  const loc = await client.callTool("locate", { path: "src/math.mjs", line: 6 });
  assert.match(loc, /in: function boom/);
  assert.match(loc, /^>6\|/m);

  const many = await client.callTool("read_file", { paths: ["package.json", "README.md"] });
  assert.match(many, /## package\.json/);
  assert.match(many, /## README\.md/);
});

test("unlisted aliases resolve over the wire", async () => {
  const search = await client.callTool("search", { query: "function add" });
  assert.match(search, /src\/math\.mjs:1:/);
  const opened = await client.callTool("open_file", { path: "src/math.mjs", start_line: 1, end_line: 3 });
  assert.match(opened, /function add/);
  const many = await client.callTool("read_many", { paths: ["package.json", "README.md"] });
  assert.match(many, /## package\.json/);
  const syms = await client.callTool("get_symbols", { names: ["add", "boom"] });
  assert.match(syms, /## add\n/);
  assert.match(syms, /## boom\n/);
});

test("path escape is rejected", async () => {
  await assert.rejects(
    () => client.callTool("read_file", { path: "../outside.txt" }),
    /outside the workspace/,
  );
});

test("unknown tool returns isError", async () => {
  await assert.rejects(() => client.callTool("nope", {}), /Unknown tool 'nope'\. Available tools: .*grep_search/);
});

test("--tools allowlist, --exclude-tools and --stats", async () => {
  const statsFile = path.join(fixtureDir, "stats", "calls.jsonl");
  const filtered = await TestClient.connect(process.execPath, [
    CLI,
    "--cwd",
    fixtureDir,
    "--tools",
    "read_file,list_dir,get_symbol",
    "--exclude-tools=get_symbol",
    "--stats",
    statsFile,
  ]);
  try {
    const names = (await filtered.listTools()).map((t) => t.name).sort();
    assert.deepEqual(names, ["list_dir", "read_file"]);

    await filtered.callTool("read_file", { path: "README.md" });
    await filtered.callTool("read_file", { path: "README.md", limit: 1 });
    await assert.rejects(() => filtered.callTool("get_symbol", { name: "add" }), /Unknown tool/);
    await assert.rejects(() => filtered.callTool("read_file", { path: "missing.txt" }));
    await filtered.callTool("open_file", { path: "README.md", limit: 1 });
    await assert.rejects(() => filtered.callTool("search", { query: "x" }), /Unknown tool/);
  } finally {
    await filtered.close();
  }

  const { readFile } = await import("node:fs/promises");
  const rows = (await readFile(statsFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((r) => [r.tool, r.isError, r.unknown, r.alias ?? null]),
    [
      ["read_file", false, false, null],
      ["read_file", false, false, null],
      ["get_symbol", true, true, null],
      ["read_file", true, false, null],
      ["read_file", false, false, "open_file"],
      ["search", true, true, null],
    ],
  );
  assert.ok(rows[0].chars > 0);
  assert.deepEqual(rows[1].args, { path: "README.md", limit: 1 });
  assert.equal(typeof rows[0].ms, "number");
});

test("--tools with an unknown name exits with a usage error", async () => {
  const child = spawn(process.execPath, [CLI, "--cwd", fixtureDir, "--tools", "read_file,nope"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.resume();
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 2);
  assert.match(stderr, /Unknown tool 'nope'/);
});

test("--profile base lists activate_pack; activate_pack expands tools/list", async () => {
  const profiled = await TestClient.connect(process.execPath, [
    CLI,
    "--cwd",
    fixtureDir,
    "--profile",
    "base",
  ]);
  try {
    const names = (await profiled.listTools()).map((t) => t.name);
    assert.ok(names.includes("activate_pack"));
    assert.ok(names.includes("repo_overview"));
    assert.ok(!names.includes("http_surface"));
    assert.ok(!names.includes("symbol_context"));

    const wait = profiled.waitListChanged();
    const result = await profiled.callTool("activate_pack", { pack: "web" });
    assert.match(result, /"added":\s\[\s*"http_surface"/);
    await wait;

    const after = (await profiled.listTools()).map((t) => t.name);
    assert.ok(after.includes("http_surface"));
    assert.ok(
      profiled.notifications.some((n) => n.method === "notifications/tools/list_changed"),
    );
  } finally {
    await profiled.close();
  }
});

test("initialize advertises listChanged under --profile base", async () => {
  const child = spawn(process.execPath, [CLI, "--cwd", fixtureDir, "--profile", "base"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const client = new TestClient(child);
  try {
    const result = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "halo-scan-test", version: "0.0.0" },
    });
    assert.equal(result.capabilities?.tools?.listChanged, true);
  } finally {
    await client.close();
  }
});
