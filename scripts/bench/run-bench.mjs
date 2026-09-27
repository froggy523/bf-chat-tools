#!/usr/bin/env node
/**
 * Tool-usage benchmark for halo-scan.
 *
 * Runs a fixed question set against one or more repos with different
 * toolsets (e.g. the 19-tool baseline vs the full set) and reports tool calls
 * per question, prompt/completion tokens, and per-tool pick counts. Tools the
 * model never picks are cull candidates.
 *
 * Drivers:
 *   ollama   (default) Direct /api/chat loop with the toolset exposed as native
 *            function tools, executed in-process. Fair for tool *selection*
 *            and gives token counts.
 *   bf-agent Spawns `bf-agent` with the MCP server attached. Shows what a real
 *            host does (bf-agent registers MCP tools lazily behind
 *            describe_tool/call_mcp_tool and has its own read/grep built-ins).
 *
 * Usage:
 *   node scripts/bench/run-bench.mjs run [--config <file>] [--repo <name>]... [--toolset <name>]...
 *        [--question <id>]... [--model <m>] [--driver ollama|bf-agent] [--repeat <n>]
 *        [--concurrency <n>] [--limit <n>] [--hints] [--max-steps <n>] [--out <dir>]
 *   node scripts/bench/run-bench.mjs report <out-dir>
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createToolset, listToolNames, resolveToolCall } from "../../src/tools/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.mjs");
const DEFAULT_CONFIG = path.join(HERE, "bench.config.json");

const HINTS = `Tool guidance:
- "What is this repo?" -> repo_overview (manifests + packages included), then project_conventions / entrypoint_map.
- "Tell me about this file." -> file_brief, then get_symbol (name or names[]) for the parts you need.
- "Explain this error / line." -> locate with the stack trace or path + line.
- "What changed?" -> changed_symbols (commits: N for recent work), then symbol_context on the interesting ones.
- "Everything about symbol X." -> symbol_context (hierarchy included; history: N for its commit log).
- "What exists?" -> symbol_search, test_inventory, http_surface, markers, unused_exports.
Fall back to grep_search / find_references / read_file only when a structured tool does not cover it.`;

// ---------------------------------------------------------------------------
// args

function parseArgs(argv) {
  const o = {
    cmd: argv[0],
    config: DEFAULT_CONFIG,
    repos: [],
    toolsets: [],
    questions: [],
    model: null,
    driver: "ollama",
    repeat: 1,
    concurrency: 2,
    limit: Infinity,
    hints: false,
    maxSteps: null,
    out: null,
    reportDir: null,
  };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    if (o.cmd === "report" && !a.startsWith("--")) o.reportDir = a;
    else if (a === "--config") o.config = next();
    else if (a === "--repo") o.repos.push(next());
    else if (a === "--toolset") o.toolsets.push(next());
    else if (a === "--question") o.questions.push(next());
    else if (a === "--model") o.model = next();
    else if (a === "--driver") o.driver = next();
    else if (a === "--repeat") o.repeat = Number(next());
    else if (a === "--concurrency") o.concurrency = Number(next());
    else if (a === "--limit") o.limit = Number(next());
    else if (a === "--hints") o.hints = true;
    else if (a === "--max-steps") o.maxSteps = Number(next());
    else if (a === "--out") o.out = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

// ---------------------------------------------------------------------------
// toolsets

const warnedToolsets = new Set();

/**
 * Historical toolsets (baseline19, original10) may name tools that have since
 * been culled or merged; keep them runnable by dropping unknown names with a
 * one-time warning instead of failing.
 */
function resolveToolsetNames(config, name) {
  const spec = config.toolsets?.[name];
  if (spec === undefined) throw new Error(`Unknown toolset '${name}'. Known: ${Object.keys(config.toolsets ?? {}).join(", ")}`);
  if (spec === "*") return null; // everything
  const known = new Set(listToolNames());
  const missing = spec.filter((n) => !known.has(n));
  if (missing.length && !warnedToolsets.has(name)) {
    warnedToolsets.add(name);
    console.error(`[bench] toolset '${name}': skipping tools no longer registered: ${missing.join(", ")}`);
  }
  return spec.filter((n) => known.has(n));
}

/** Build the in-process McpTool[] for a repo + toolset, stripping baseline options. */
function buildTools(config, repoPath, toolsetName) {
  const include = resolveToolsetNames(config, toolsetName);
  const tools = createToolset({ workspaceRoot: repoPath, include: include ?? undefined });
  if (include === null) return tools;
  const strip = config.baselineStripOptions ?? {};
  return tools.map((t) => {
    const props = strip[t.name];
    if (!props?.length || !t.inputSchema?.properties) return t;
    const schema = structuredClone(t.inputSchema);
    for (const p of props) delete schema.properties[p];
    if (Array.isArray(schema.required)) schema.required = schema.required.filter((r) => !props.includes(r));
    return { ...t, inputSchema: schema };
  });
}

function toOllamaTools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

function formatToolResult(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function systemPrompt(repoPath, hints) {
  const lines = [
    `You are answering questions about the code repository at ${repoPath}.`,
    "You have read-only tools that inspect it. Call tools to gather facts, then answer in plain text.",
    "Be efficient: use the fewest tool calls that answer the question well, and do not re-read information you already have.",
    "When you have enough, stop calling tools and give the final answer.",
  ];
  if (hints) lines.push("", HINTS);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ollama driver

async function ollamaChat(baseUrl, body, timeoutMs = 180_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function runOllama({ config, repo, toolsetName, question, opts }) {
  const tools = buildTools(config, repo.path, toolsetName);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const ollamaTools = toOllamaTools(tools);
  const schemaChars = JSON.stringify(ollamaTools).length;
  const model = opts.model ?? config.model;
  const baseUrl = config.baseUrl ?? "http://127.0.0.1:11434";
  const maxSteps = opts.maxSteps ?? config.maxSteps ?? 20;
  const wallClockMs = (config.wallClockSec ?? 240) * 1000;

  const messages = [
    { role: "system", content: systemPrompt(repo.path, opts.hints) },
    { role: "user", content: question.prompt },
  ];
  const calls = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let firstPromptTokens = null;
  let stopReason = "answer";
  let answer = "";
  let error = null;
  const started = Date.now();

  try {
    for (let step = 1; ; step++) {
      if (step > maxSteps) {
        stopReason = "max-steps";
        break;
      }
      if (Date.now() - started > wallClockMs) {
        stopReason = "wall-clock";
        break;
      }
      const res = await ollamaChat(baseUrl, {
        model,
        messages,
        tools: ollamaTools,
        stream: false,
        options: { num_ctx: 65536 },
      });
      promptTokens += res.prompt_eval_count ?? 0;
      completionTokens += res.eval_count ?? 0;
      if (firstPromptTokens == null) firstPromptTokens = res.prompt_eval_count ?? null;

      const msg = res.message ?? {};
      messages.push(msg);
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!toolCalls.length) {
        answer = msg.content ?? "";
        break;
      }
      for (const tc of toolCalls) {
        const name = tc.function?.name ?? "";
        let args = tc.function?.arguments ?? {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        const t0 = Date.now();
        // Mirror the MCP server: unlisted aliases (search, open_file, read_many, …) resolve
        // onto registered tools; the record keeps the requested name under `alias`.
        const resolved = resolveToolCall(tools, name, args ?? {});
        const tool = resolved?.tool;
        let text;
        let isError = false;
        if (!tool) {
          text = `Unknown tool '${name}'. Available tools: ${[...byName.keys()].join(", ")}`;
          isError = true;
        } else {
          try {
            text = formatToolResult(await tool.execute(resolved.args));
          } catch (err) {
            text = err?.message ?? String(err);
            isError = true;
          }
        }
        calls.push({
          step,
          tool: tool ? tool.name : name,
          alias: resolved?.alias ?? undefined,
          args,
          ms: Date.now() - t0,
          chars: text.length,
          isError,
          unknown: !tool,
        });
        messages.push({ role: "tool", content: text, tool_name: name });
      }
    }
  } catch (err) {
    stopReason = "error";
    error = err?.message ?? String(err);
  }

  return {
    calls,
    promptTokens,
    completionTokens,
    firstPromptTokens,
    schemaChars,
    toolCount: tools.length,
    answer,
    stopReason,
    error,
    elapsedMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// bf-agent driver

function findBfAgent() {
  const candidates = [
    process.env.BF_AGENT_CLI,
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@bitfieldcreek", "bf-agent", "src", "cli.mjs"),
    "/usr/local/lib/node_modules/@bitfieldcreek/bf-agent/src/cli.mjs",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("bf-agent CLI not found; set BF_AGENT_CLI to its src/cli.mjs");
}

async function runBfAgent({ config, repo, toolsetName, question, opts, outDir, runId }) {
  const include = resolveToolsetNames(config, toolsetName);
  const statsFile = path.join(outDir, "mcp-stats", `${runId}.jsonl`);
  fs.mkdirSync(path.dirname(statsFile), { recursive: true });
  const mcpParts = ["node", JSON.stringify(CLI), "--cwd", JSON.stringify(repo.path), "--stats", JSON.stringify(statsFile)];
  if (include) mcpParts.push("--tools", include.join(","));
  const model = opts.model ?? config.model;
  const wallClockSec = config.wallClockSec ?? 240;
  const maxSteps = opts.maxSteps ?? config.maxSteps ?? 20;
  // bf-agent has no read-only mode; in --mode agent it will happily write
  // helper scripts into the target repo. Say so in the prompt and refuse
  // auto-approval of gated tools. Still prefer a throwaway clone.
  const readOnly = "This is a read-only question: do not create, modify, rename or delete any files, and do not run commands that change the repository.";
  const prompt = [question.prompt, readOnly, opts.hints ? HINTS : null].filter(Boolean).join("\n\n");

  const args = [
    findBfAgent(),
    prompt,
    "--mode",
    "agent",
    "--no-auto-approve",
    "--no-index",
    "--cwd",
    repo.path,
    "--model",
    model,
    "--max-steps",
    String(maxSteps),
    "--wall-clock",
    String(wallClockSec),
    "--mcp",
    mcpParts.join(" "),
  ];
  const started = Date.now();
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((resolve) => child.on("close", resolve));

  // Agent-side steps: every tool the model invoked, built-ins included.
  const agentCalls = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = line.match(/^\[step (\d+)\] ([\w-]+)\((.*)\) -> (ok|error: .*)$/);
    if (!m) continue;
    let args = {};
    try {
      args = JSON.parse(m[3]);
    } catch {
      // leave empty
    }
    agentCalls.push({ step: Number(m[1]), tool: m[2], args, isError: m[4] !== "ok" });
  }
  // Server-side: which halo-scan tools actually ran.
  const calls = [];
  if (fs.existsSync(statsFile)) {
    for (const line of fs.readFileSync(statsFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      calls.push({ step: null, tool: r.tool, args: r.args, ms: r.ms, chars: r.chars, isError: r.isError, unknown: r.unknown });
    }
  }
  return {
    calls,
    agentCalls,
    promptTokens: null,
    completionTokens: null,
    firstPromptTokens: null,
    schemaChars: null,
    toolCount: include ? include.length : null,
    answer: stdout.trim(),
    stopReason: code === 0 ? "answer" : code === 2 ? "max-steps" : "error",
    error: code === 0 || code === 2 ? null : stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" | "),
    elapsedMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// run

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function cmdRun(opts) {
  const config = JSON.parse(fs.readFileSync(opts.config, "utf8"));
  const repoNames = opts.repos.length ? opts.repos : Object.keys(config.repos);
  const toolsetNames = opts.toolsets.length ? opts.toolsets : ["baseline19", "full"];
  for (const t of toolsetNames) resolveToolsetNames(config, t);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.resolve(opts.out ?? path.join(HERE, "out", `${opts.driver}-${stamp}`));
  fs.mkdirSync(outDir, { recursive: true });
  const runsFile = path.join(outDir, "runs.jsonl");

  const cells = [];
  for (const repoName of repoNames) {
    const repo = config.repos[repoName];
    if (!repo) throw new Error(`Unknown repo '${repoName}'`);
    if (!fs.existsSync(repo.path)) throw new Error(`Repo path missing: ${repo.path}`);
    let qs = config.questions.filter((q) => !q.repos || q.repos.includes(repoName));
    if (opts.questions.length) qs = qs.filter((q) => opts.questions.includes(q.id));
    qs = qs.slice(0, opts.limit);
    for (const q of qs) {
      for (const toolsetName of toolsetNames) {
        for (let rep = 0; rep < opts.repeat; rep++) {
          cells.push({ repoName, repo: { name: repoName, ...repo }, question: q, toolsetName, rep });
        }
      }
    }
  }

  console.error(
    `bench: ${cells.length} runs (${repoNames.length} repo(s) x toolsets [${toolsetNames.join(", ")}] x repeat ${opts.repeat}), driver=${opts.driver}, model=${opts.model ?? config.model}, out=${outDir}`,
  );

  let done = 0;
  await mapLimit(cells, opts.concurrency, async (cell) => {
    const runId = `${cell.repoName}__${cell.question.id}__${cell.toolsetName}__${cell.rep}`;
    const t0 = Date.now();
    let result;
    try {
      result =
        opts.driver === "bf-agent"
          ? await runBfAgent({ config, repo: cell.repo, toolsetName: cell.toolsetName, question: cell.question, opts, outDir, runId })
          : await runOllama({ config, repo: cell.repo, toolsetName: cell.toolsetName, question: cell.question, opts });
    } catch (err) {
      result = { calls: [], stopReason: "error", error: err?.message ?? String(err), elapsedMs: Date.now() - t0 };
    }
    const record = {
      runId,
      driver: opts.driver,
      model: opts.model ?? config.model,
      hints: opts.hints,
      repo: cell.repoName,
      question: cell.question.id,
      category: cell.question.category,
      toolset: cell.toolsetName,
      rep: cell.rep,
      ...result,
    };
    fs.appendFileSync(runsFile, `${JSON.stringify(record)}\n`);
    done++;
    const summary = `${record.calls.length} calls${record.promptTokens != null ? `, ${record.promptTokens} prompt tok` : ""}, ${Math.round(record.elapsedMs / 1000)}s, ${record.stopReason}`;
    console.error(`[${done}/${cells.length}] ${runId}: ${summary}${record.error ? ` (${record.error.slice(0, 120)})` : ""}`);
  });

  const report = buildReport(readRuns(runsFile), config);
  fs.writeFileSync(path.join(outDir, "report.md"), report);
  console.log(report);
  console.error(`\nwritten: ${outDir}`);
}

// ---------------------------------------------------------------------------
// report

function readRuns(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? "-" : Number(n).toFixed(d));
const pct = (a, b) => (b ? `${(((b - a) / b) * 100).toFixed(0)}%` : "-");

function table(headers, rows) {
  const out = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const r of rows) out.push(`| ${r.map((c) => String(c ?? "")).join(" | ")} |`);
  return out.join("\n");
}

export function buildReport(runs, config) {
  const toolsets = [...new Set(runs.map((r) => r.toolset))];
  const driver = runs[0]?.driver ?? "ollama";
  const lines = [`# halo-scan tool-usage benchmark`, ""];
  lines.push(`driver: ${driver} · model: ${runs[0]?.model ?? "?"} · hints: ${runs[0]?.hints ? "yes" : "no"} · runs: ${runs.length} · repos: ${[...new Set(runs.map((r) => r.repo))].join(", ")}`);
  lines.push("");

  // -- per toolset summary
  lines.push("## Per toolset", "");
  const summaryRows = toolsets.map((ts) => {
    const rs = runs.filter((r) => r.toolset === ts);
    const calls = rs.map((r) => r.calls.length);
    const errCalls = rs.reduce((n, r) => n + r.calls.filter((c) => c.isError).length, 0);
    const answered = rs.filter((r) => r.stopReason === "answer").length;
    const hasTok = rs.some((r) => r.promptTokens != null);
    return [
      ts,
      rs[0]?.toolCount ?? "-",
      rs.length,
      `${answered}/${rs.length}`,
      fmt(mean(calls)),
      fmt(median(calls), 0),
      errCalls,
      hasTok ? fmt(mean(rs.map((r) => r.promptTokens ?? 0)), 0) : "-",
      hasTok ? fmt(mean(rs.map((r) => r.completionTokens ?? 0)), 0) : "-",
      hasTok ? fmt(mean(rs.map((r) => r.firstPromptTokens ?? 0)), 0) : "-",
      fmt(mean(rs.map((r) => r.calls.reduce((n, c) => n + (c.chars ?? 0), 0))), 0),
      fmt(mean(rs.map((r) => r.elapsedMs / 1000)), 0),
    ];
  });
  lines.push(
    table(
      ["toolset", "tools", "runs", "answered", "calls/run (mean)", "median", "error calls", "prompt tok/run", "completion tok/run", "first-turn prompt tok", "tool chars/run", "sec/run"],
      summaryRows,
    ),
    "",
  );
  lines.push(
    "`first-turn prompt tok` ≈ system prompt + tool schemas + question: the fixed per-turn cost of the toolset. `prompt tok/run` is the sum over all turns (what you are billed / wait for).",
    "",
  );

  // -- pairwise
  if (toolsets.length >= 2) {
    const [a, b] = toolsets.includes("baseline19") && toolsets.includes("full") ? ["baseline19", "full"] : toolsets.slice(0, 2);
    const keyOf = (r) => `${r.repo}::${r.question}`;
    const byKey = (ts) => {
      const m = new Map();
      for (const r of runs.filter((r) => r.toolset === ts)) {
        if (!m.has(keyOf(r))) m.set(keyOf(r), []);
        m.get(keyOf(r)).push(r);
      }
      return m;
    };
    const A = byKey(a);
    const B = byKey(b);
    const keys = [...A.keys()].filter((k) => B.has(k));
    if (keys.length) {
      const dCalls = keys.map((k) => mean(B.get(k).map((r) => r.calls.length)) - mean(A.get(k).map((r) => r.calls.length)));
      const totA = mean(keys.map((k) => mean(A.get(k).map((r) => r.calls.length))));
      const totB = mean(keys.map((k) => mean(B.get(k).map((r) => r.calls.length))));
      const tokA = mean(keys.map((k) => mean(A.get(k).map((r) => r.promptTokens ?? 0))));
      const tokB = mean(keys.map((k) => mean(B.get(k).map((r) => r.promptTokens ?? 0))));
      lines.push(`## ${a} → ${b} (paired on ${keys.length} question cells)`, "");
      lines.push(`- calls/question: ${fmt(totA)} → ${fmt(totB)} (${pct(totB, totA)} fewer), mean Δ ${fmt(mean(dCalls))}, cells improved ${dCalls.filter((d) => d < 0).length}, same ${dCalls.filter((d) => d === 0).length}, worse ${dCalls.filter((d) => d > 0).length}`);
      if (tokA || tokB) lines.push(`- prompt tokens/question: ${fmt(tokA, 0)} → ${fmt(tokB, 0)} (${pct(tokB, tokA)} fewer)`);
      lines.push("");

      const cats = [...new Set(runs.map((r) => r.category))];
      lines.push(
        table(
          ["category", "cells", `${a} calls`, `${b} calls`, "Δ", `${a} prompt tok`, `${b} prompt tok`],
          cats.map((cat) => {
            const ks = keys.filter((k) => A.get(k)[0].category === cat);
            if (!ks.length) return null;
            const ca = mean(ks.map((k) => mean(A.get(k).map((r) => r.calls.length))));
            const cb = mean(ks.map((k) => mean(B.get(k).map((r) => r.calls.length))));
            const ta = mean(ks.map((k) => mean(A.get(k).map((r) => r.promptTokens ?? 0))));
            const tb = mean(ks.map((k) => mean(B.get(k).map((r) => r.promptTokens ?? 0))));
            return [cat, ks.length, fmt(ca), fmt(cb), fmt(cb - ca), fmt(ta, 0), fmt(tb, 0)];
          }).filter(Boolean),
        ),
        "",
      );
    }
  }

  // -- per tool usage
  const allToolNames = createToolset({ workspaceRoot: REPO_ROOT }).map((t) => t.name);
  const shortcutNames = new Set(allToolNames.filter((n) => !(config?.toolsets?.baseline19 ?? []).includes(n)));
  lines.push("## Per-tool picks", "");
  for (const ts of toolsets) {
    const rs = runs.filter((r) => r.toolset === ts);
    const counts = new Map();
    for (const r of rs) {
      const seen = new Set();
      for (const c of r.calls) {
        const e = counts.get(c.tool) ?? { calls: 0, runs: 0, errors: 0, chars: 0 };
        e.calls++;
        e.errors += c.isError ? 1 : 0;
        e.chars += c.chars ?? 0;
        if (!seen.has(c.tool)) {
          e.runs++;
          seen.add(c.tool);
        }
        counts.set(c.tool, e);
      }
    }
    const exposed = ts === "full" || config?.toolsets?.[ts] === "*" ? allToolNames : (config?.toolsets?.[ts] ?? [...counts.keys()]);
    const rows = [...counts.entries()]
      .sort((x, y) => y[1].calls - x[1].calls)
      .map(([name, e]) => [name, shortcutNames.has(name) ? "shortcut" : "base", e.calls, `${e.runs}/${rs.length}`, e.errors, fmt(e.chars / e.calls, 0)]);
    lines.push(`### ${ts} (${rs.length} runs)`, "");
    lines.push(table(["tool", "kind", "calls", "runs using", "errors", "avg chars"], rows), "");
    const never = exposed.filter((n) => !counts.has(n));
    if (never.length) lines.push(`Never picked (${never.length}): ${never.join(", ")}`, "");
    const once = exposed.filter((n) => counts.get(n)?.calls === 1);
    if (once.length) lines.push(`Picked exactly once: ${once.join(", ")}`, "");
    const aliasCounts = new Map();
    for (const r of rs) for (const c of r.calls) if (c.alias) aliasCounts.set(`${c.alias}→${c.tool}`, (aliasCounts.get(`${c.alias}→${c.tool}`) ?? 0) + 1);
    if (aliasCounts.size) {
      const total = [...aliasCounts.values()].reduce((n, v) => n + v, 0);
      lines.push(`Alias calls (${total}): ${[...aliasCounts.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ×${v}`).join(", ")}`, "");
    }
    if (ts === "full" || config?.toolsets?.[ts] === "*") {
      const total = [...counts.values()].reduce((n, e) => n + e.calls, 0);
      const sc = [...counts.entries()].filter(([n]) => shortcutNames.has(n)).reduce((n, [, e]) => n + e.calls, 0);
      lines.push(`Shortcut share of calls: ${sc}/${total} (${total ? Math.round((sc / total) * 100) : 0}%)`, "");
    }
  }

  // -- bf-agent: agent-side calls incl. built-ins
  if (driver === "bf-agent") {
    lines.push("## bf-agent agent-side calls (built-ins + MCP bridge)", "");
    for (const ts of toolsets) {
      const rs = runs.filter((r) => r.toolset === ts);
      const counts = new Map();
      for (const r of rs) for (const c of r.agentCalls ?? []) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1);
      const rows = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([n, c]) => [n, c]);
      lines.push(`### ${ts}: ${fmt(mean(rs.map((r) => (r.agentCalls ?? []).length)))} agent calls/run, of which ${fmt(mean(rs.map((r) => r.calls.length)))} reached halo-scan`, "");
      lines.push(table(["agent tool", "calls"], rows), "");
    }
  }

  // -- per question
  lines.push("## Per question", "");
  const qKeys = [...new Set(runs.map((r) => `${r.repo}::${r.question}`))];
  lines.push(
    table(
      ["repo", "question", ...toolsets.flatMap((ts) => [`${ts} calls`, `${ts} tools used`, `${ts} stop`])],
      qKeys.map((k) => {
        const [repo, q] = k.split("::");
        const cols = toolsets.flatMap((ts) => {
          const rs = runs.filter((r) => r.repo === repo && r.question === q && r.toolset === ts);
          if (!rs.length) return ["-", "-", "-"];
          const used = [...new Set(rs.flatMap((r) => r.calls.map((c) => c.tool)))];
          return [fmt(mean(rs.map((r) => r.calls.length))), used.join(" "), [...new Set(rs.map((r) => r.stopReason))].join("/")];
        });
        return [repo, q, ...cols];
      }),
    ),
    "",
  );

  // -- errors / misuse
  const errRuns = runs.filter((r) => r.error);
  if (errRuns.length) {
    lines.push("## Run errors", "");
    for (const r of errRuns) lines.push(`- ${r.runId}: ${r.error}`);
    lines.push("");
  }
  const misuse = runs.flatMap((r) => r.calls.filter((c) => c.isError).map((c) => `${r.runId}: ${c.tool}(${JSON.stringify(c.args).slice(0, 100)})`));
  if (misuse.length) {
    lines.push(`## Tool errors (${misuse.length})`, "");
    for (const m of misuse.slice(0, 60)) lines.push(`- ${m}`);
    if (misuse.length > 60) lines.push(`- … ${misuse.length - 60} more`);
    lines.push("");
  }

  return lines.join("\n");
}

function cmdReport(opts) {
  const dir = path.resolve(opts.reportDir ?? "");
  const runsFile = fs.statSync(dir).isDirectory() ? path.join(dir, "runs.jsonl") : dir;
  const config = JSON.parse(fs.readFileSync(opts.config, "utf8"));
  const report = buildReport(readRuns(runsFile), config);
  fs.writeFileSync(path.join(path.dirname(runsFile), "report.md"), report);
  console.log(report);
}

// ---------------------------------------------------------------------------

const isDirect = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isDirect) {
  const opts = parseArgs(process.argv.slice(2));
  const run = opts.cmd === "run" ? cmdRun(opts) : opts.cmd === "report" ? Promise.resolve(cmdReport(opts)) : null;
  if (!run) {
    console.error("usage: run-bench.mjs run [options] | report <out-dir>");
    process.exitCode = 1;
  } else {
    run.catch((err) => {
      console.error(`bench failed: ${err.stack ?? err.message}`);
      process.exitCode = 1;
    });
  }
}
