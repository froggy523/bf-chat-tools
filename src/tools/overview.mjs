/**
 * Repo overview — cheap first-turn context for codebase Q&A.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { manifestSummary, packagesMap } from "../manifests.mjs";
import { collectFiles, SKIP_DIRS, truncateOutput } from "../workspace.mjs";

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
        "High-level snapshot of the workspace: top-level listing, detected languages, manifest summary " +
        "(direct dependencies, engines, scripts, lockfile — package.json, pyproject, Cargo, go.mod, pom.xml, " +
        "Gradle, .sln/.csproj), monorepo packages / solution projects when present, README head, and a " +
        "short git status. Call this first for an unfamiliar codebase; pass manifest to summarise one " +
        "specific manifest file instead.",
      inputSchema: {
        type: "object",
        properties: {
          include_readme: {
            type: "boolean",
            description: "Include the first ~40 lines of README (default true).",
          },
          manifest: {
            type: "string",
            description: "Summarise this manifest file (relative path) instead of auto-detecting the root ones.",
          },
        },
      },
      async execute({ include_readme = true, manifest } = {}) {
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

        try {
          const { sections: manifestSections, found, lockfiles } = await manifestSummary(root, { manifest });
          if (found) {
            sections.push(`\n## Manifests${lockfiles.length ? `  (lockfiles: ${lockfiles.join(", ")})` : ""}`);
            sections.push(...manifestSections.map((s) => s.replace(/^\n## /, "\n### ")));
          }
        } catch (err) {
          sections.push(`\n## Manifests\n(${err.message})`);
        }

        if (!manifest) {
          const { files } = await collectFiles(root, root);
          const packages = await packagesMap(root, files, { max: 40 });
          if (packages) {
            sections.push("\n## Packages / projects");
            sections.push(packages.join("\n"));
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
