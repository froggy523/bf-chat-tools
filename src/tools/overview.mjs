/**
 * Repo overview — cheap first-turn context for codebase Q&A.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { SKIP_DIRS, truncateOutput } from "../workspace.mjs";

const KEY_FILES = [
  "README.md",
  "README",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "tsconfig.json",
  "Dockerfile",
];

const EXT_LANG = {
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".cs": "C#",
  ".rb": "Ruby",
  ".php": "PHP",
  ".swift": "Swift",
  ".c": "C",
  ".h": "C/C++",
  ".cpp": "C++",
  ".cc": "C++",
  ".md": "Markdown",
  ".json": "JSON",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".toml": "TOML",
  ".sh": "Shell",
  ".ps1": "PowerShell",
};

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 256_000,
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

async function safeRead(root, rel, max = 4000) {
  try {
    const text = await readFile(path.join(root, rel), "utf8");
    return text.length > max ? text.slice(0, max) + "\n… [truncated]" : text;
  } catch {
    return null;
  }
}

async function topLevelListing(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const lines = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === ".git") continue;
    if (e.isDirectory()) {
      lines.push(`${e.name}/`);
    } else {
      lines.push(e.name);
    }
  }
  return lines;
}

async function sampleLanguages(root, maxFiles = 800) {
  const counts = new Map();
  let scanned = 0;
  const queue = [root];
  while (queue.length && scanned < maxFiles) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) queue.push(path.join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      scanned++;
      const ext = path.extname(e.name).toLowerCase();
      const lang = EXT_LANG[ext];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
      if (scanned >= maxFiles) break;
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([lang, n]) => `${lang} (${n})`);
}

function summarizePackageJson(text) {
  try {
    const pkg = JSON.parse(text);
    const lines = [];
    if (pkg.name) lines.push(`name: ${pkg.name}`);
    if (pkg.version) lines.push(`version: ${pkg.version}`);
    if (pkg.description) lines.push(`description: ${pkg.description}`);
    if (pkg.type) lines.push(`type: ${pkg.type}`);
    if (pkg.bin) {
      const bins = typeof pkg.bin === "string" ? [pkg.name ?? "bin"] : Object.keys(pkg.bin);
      lines.push(`bin: ${bins.join(", ")}`);
    }
    if (pkg.scripts && typeof pkg.scripts === "object") {
      lines.push(`scripts: ${Object.keys(pkg.scripts).slice(0, 12).join(", ")}`);
    }
    const deps = Object.keys(pkg.dependencies ?? {});
    const dev = Object.keys(pkg.devDependencies ?? {});
    if (deps.length) lines.push(`dependencies (${deps.length}): ${deps.slice(0, 15).join(", ")}${deps.length > 15 ? "…" : ""}`);
    if (dev.length) lines.push(`devDependencies (${dev.length}): ${dev.slice(0, 10).join(", ")}${dev.length > 10 ? "…" : ""}`);
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createOverviewTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "repo_overview",
      description:
        "High-level snapshot of the workspace: top-level listing, detected languages, key manifest " +
        "summaries (package.json etc.), README head, and a short git status. Call this first when " +
        "answering questions about an unfamiliar codebase.",
      inputSchema: {
        type: "object",
        properties: {
          include_readme: {
            type: "boolean",
            description: "Include the first ~40 lines of README (default true).",
          },
        },
      },
      async execute({ include_readme = true } = {}) {
        const sections = [];
        sections.push(`# Workspace overview`);
        sections.push(`root: ${root}`);

        try {
          const listing = await topLevelListing(root);
          sections.push(`\n## Top-level (${listing.length} entries)`);
          sections.push(listing.slice(0, 80).join("\n") + (listing.length > 80 ? "\n…" : ""));
        } catch (err) {
          sections.push(`\n## Top-level\n(error: ${err.message})`);
        }

        const langs = await sampleLanguages(root);
        if (langs.length) {
          sections.push(`\n## Languages (sampled file counts)`);
          sections.push(langs.join(", "));
        }

        const present = [];
        for (const name of KEY_FILES) {
          try {
            await stat(path.join(root, name));
            present.push(name);
          } catch {
            // missing
          }
        }
        if (present.length) {
          sections.push(`\n## Key files present`);
          sections.push(present.join(", "));
        }

        const pkgText = await safeRead(root, "package.json", 100_000);
        if (pkgText) {
          const summary = summarizePackageJson(pkgText);
          if (summary) {
            sections.push(`\n## package.json`);
            sections.push(summary);
          }
        }

        for (const manifest of ["pyproject.toml", "Cargo.toml", "go.mod"]) {
          const text = await safeRead(root, manifest, 2500);
          if (text) {
            sections.push(`\n## ${manifest}`);
            sections.push(text);
          }
        }

        if (include_readme !== false) {
          for (const name of ["README.md", "README"]) {
            const text = await safeRead(root, name, 6000);
            if (text) {
              const lines = text.split(/\r?\n/).slice(0, 40);
              sections.push(`\n## ${name} (first ${lines.length} lines)`);
              sections.push(lines.join("\n"));
              break;
            }
          }
        }

        const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
        const status = runGit(root, ["status", "--short", "--branch"]);
        const recent = runGit(root, ["log", "-5", "--oneline"]);
        if (branch || status || recent) {
          sections.push(`\n## Git`);
          if (branch) sections.push(`branch: ${branch}`);
          if (status) sections.push(status);
          if (recent) {
            sections.push(`recent commits:`);
            sections.push(recent);
          }
        } else {
          sections.push(`\n## Git\n(not a git repository or git unavailable)`);
        }

        return truncateOutput(sections.join("\n"));
      },
    },
  ];
}
