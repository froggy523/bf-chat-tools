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
        if (msg.id === undefined) continue;
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
  for (const expected of [
    "repo_overview",
    "read_file",
    "list_dir",
    "grep_search",
    "find_files",
    "get_symbol",
    "file_outline",
    "find_symbol",
    "find_references",
    "git_history",
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

test("path escape is rejected", async () => {
  await assert.rejects(
    () => client.callTool("read_file", { path: "../outside.txt" }),
    /outside the workspace/,
  );
});

test("unknown tool returns isError", async () => {
  await assert.rejects(() => client.callTool("nope", {}), /Unknown tool/);
});
