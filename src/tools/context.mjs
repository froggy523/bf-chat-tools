/**
 * Project-context tools: conventions, entrypoints, tests, digests, config surface.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { createResolver, exists, findSourceForTest, findTestsFor, isTestPath } from "../analysis.mjs";
import { detectBuildManifests, listMatching, xmlText } from "../manifests.mjs";
import {
  SKIP_DIRS,
  collectFiles,
  pathKind,
  readTextFile,
  resolveWithinRoot,
  toRel,
  truncateOutput,
} from "../workspace.mjs";

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

const CONVENTION_FILES = [
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  ".editorconfig",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierignore",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".flake8",
  "ruff.toml",
  ".rubocop.yml",
  "rustfmt.toml",
  ".rustfmt.toml",
  "pyproject.toml",
  "tsconfig.json",
  "jsconfig.json",
  ".nvmrc",
  ".node-version",
  ".python-version",
  "biome.json",
  "biome.jsonc",
];

const ENV_EXAMPLE_GLOBS = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults",
  "env.example",
];

async function safeReadHead(abs, maxChars = 2500) {
  const text = await readTextFile(abs);
  if (text == null) return null;
  return text.length > maxChars ? text.slice(0, maxChars) + "\n… [truncated]" : text;
}

async function listCiWorkflows(root) {
  const dirs = [".github/workflows", ".gitlab-ci.yml", "azure-pipelines.yml", ".circleci", "Jenkinsfile"];
  const out = [];
  for (const rel of dirs) {
    const abs = path.join(root, rel);
    const kind = await pathKind(abs);
    if (kind === "file") {
      out.push(rel);
      continue;
    }
    if (kind !== "directory") continue;
    try {
      const entries = await readdir(abs);
      for (const name of entries.sort()) {
        if (/\.(ya?ml)$/i.test(name)) out.push(`${rel}/${name}`);
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function parseMakefileTargets(text) {
  const targets = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_./%-]+)\s*:/);
    if (!m) continue;
    const name = m[1];
    if (name.startsWith(".") || seen.has(name)) continue;
    seen.add(name);
    targets.push(name);
  }
  return targets;
}

function parseJustTargets(text) {
  const targets = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*(?:[:+]|:=)/);
    if (!m || seen.has(m[1])) continue;
    if (line.trimStart().startsWith("#")) continue;
    seen.add(m[1]);
    targets.push(m[1]);
  }
  return targets;
}

function dockerfileCommands(text) {
  const cmds = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(ENTRYPOINT|CMD|EXPOSE)\b(.*)$/i);
    if (m) cmds.push(`${m[1].toUpperCase()}${m[2]}`.trim());
  }
  return cmds;
}

function extractEnvKeys(text) {
  const keys = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      keys.push(m[1]);
    }
  }
  return keys;
}

function extractComposeSurface(text) {
  const services = [];
  const ports = [];
  const lines = text.split(/\r?\n/);
  let inServices = false;
  let currentService = null;
  let inPorts = false;
  for (const line of lines) {
    if (/^services\s*:/.test(line)) {
      inServices = true;
      currentService = null;
      inPorts = false;
      continue;
    }
    if (inServices && /^\S/.test(line) && !/^\s/.test(line)) {
      // top-level key after services
      if (!/^services\s*:/.test(line)) {
        inServices = false;
        currentService = null;
        inPorts = false;
      }
    }
    if (!inServices) continue;
    const svc = line.match(/^  ([A-Za-z0-9_.-]+)\s*:/);
    if (svc) {
      currentService = svc[1];
      services.push(currentService);
      inPorts = false;
      continue;
    }
    if (/^\s+ports\s*:/.test(line)) {
      inPorts = true;
      continue;
    }
    if (inPorts) {
      if (/^\s{2}\S/.test(line) && !/^\s{4}/.test(line)) {
        inPorts = false;
      } else {
        const portHit = line.match(/['"]?(\d{2,5})(?::\d{2,5})?['"]?/);
        if (portHit) ports.push(currentService ? `${currentService}:${portHit[1]}` : portHit[1]);
      }
    }
    const expose = line.match(/^\s+container_port\s*:\s*(\d+)/i) || line.match(/EXPOSE\s+(\d+)/i);
    if (expose) ports.push(currentService ? `${currentService}:${expose[1]}` : expose[1]);
  }
  return { services, ports: [...new Set(ports)] };
}

const MAIN_CANDIDATE = /\.(go|java|kt|cs|py|rs|scala|fs)$/;
const MAIN_NAME_HINT = /(^|\/)(main|program|app|application|cmd|__main__|startup)[^/]*\.\w+$|(^|\/)cmd\//i;

/**
 * Files that contain a program entry point. Content-scans a bounded set of likely files
 * (name-hinted first, then the rest, up to a cap) so large repos stay fast.
 */
async function scanMainFunctions(root, files) {
  const code = files.filter((f) => MAIN_CANDIDATE.test(f) && !isTestPath(f));
  const hinted = code.filter((f) => MAIN_NAME_HINT.test(f));
  const rest = code.filter((f) => !MAIN_NAME_HINT.test(f));
  const scan = [...hinted, ...rest].slice(0, 1500);
  const out = [];
  for (const rel of scan) {
    const text = await readTextFile(path.join(root, rel));
    if (text == null) continue;
    const ext = path.posix.extname(rel);
    let how = null;
    if (ext === ".go") {
      if (/^package\s+main\b/m.test(text) && /^func\s+main\s*\(\s*\)/m.test(text)) how = "Go package main";
    } else if (ext === ".java" || ext === ".scala") {
      if (/\bpublic\s+static\s+void\s+main\s*\(\s*(?:final\s+)?String(?:\[\]|\.\.\.)\s*\w+\s*\)/.test(text)) {
        how = /@SpringBootApplication/.test(text) ? "Java main + @SpringBootApplication" : "Java main";
      } else if (/@SpringBootApplication/.test(text)) how = "@SpringBootApplication";
      else if (ext === ".scala" && /\bextends\s+App\b|def\s+main\s*\(\s*\w+\s*:\s*Array\[String\]/.test(text)) how = "Scala main";
    } else if (ext === ".kt") {
      if (/^\s*(?:suspend\s+)?fun\s+main\s*\(/m.test(text)) how = /@SpringBootApplication/.test(text) ? "Kotlin main + @SpringBootApplication" : "Kotlin main";
      else if (/@SpringBootApplication/.test(text)) how = "@SpringBootApplication";
    } else if (ext === ".cs" || ext === ".fs") {
      if (/\bstatic\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/.test(text)) how = "C# static Main";
      else if (/WebApplication\.CreateBuilder|Host\.CreateDefaultBuilder|CreateHostBuilder|WebHost\.CreateDefaultBuilder/.test(text)) {
        how = /(^|\/)Program\.cs$/.test(rel) ? "C# top-level statements (ASP.NET host)" : "ASP.NET host builder";
      } else if (/(^|\/)Program\.cs$/.test(rel) && !/\bclass\s+\w+/.test(text)) how = "C# top-level statements";
      else if (ext === ".fs" && /\[<EntryPoint>\]/.test(text)) how = "F# [<EntryPoint>]";
    } else if (ext === ".py") {
      if (/(^|\/)__main__\.py$/.test(rel)) how = "Python __main__.py";
      else if (/^if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(text)) how = "Python __main__ guard";
    } else if (ext === ".rs") {
      if (/(^|\/)src\/main\.rs$|(^|\/)src\/bin\/[^/]+\.rs$/.test(rel) && /^\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+main\s*\(/m.test(text)) how = "Rust fn main";
    }
    if (how) out.push({ rel, how });
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createContextTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "project_conventions",
      description:
        "One-shot view of agent/human project rules: AGENTS.md, CONTRIBUTING, editorconfig, lint/format " +
        "configs, and CI workflow names. Prefer this over hunting for each file separately.",
      inputSchema: {
        type: "object",
        properties: {
          include_excerpts: {
            type: "boolean",
            description: "Include short excerpts of markdown/rule files (default true).",
          },
        },
      },
      async execute({ include_excerpts = true } = {}) {
        const sections = ["# Project conventions"];
        const present = await listMatching(root, CONVENTION_FILES);
        if (present.length) {
          sections.push("\n## Config / rule files");
          sections.push(present.join(", "));
        } else {
          sections.push("\n## Config / rule files\n(none of the common names found)");
        }

        const ci = await listCiWorkflows(root);
        if (ci.length) {
          sections.push("\n## CI");
          sections.push(ci.join("\n"));
        }

        if (include_excerpts !== false) {
          const excerptNames = [
            "AGENTS.md",
            "AGENT.md",
            "CLAUDE.md",
            "CONTRIBUTING.md",
            ".editorconfig",
          ];
          for (const name of excerptNames) {
            if (!present.includes(name) && name !== ".editorconfig") continue;
            if (!(await exists(path.join(root, name)))) continue;
            const text = await safeReadHead(path.join(root, name), name.endsWith(".md") ? 4000 : 1500);
            if (text) {
              sections.push(`\n## ${name}`);
              sections.push(text);
            }
          }
        }

        return truncateOutput(sections.join("\n"));
      },
    },

    {
      name: "entrypoint_map",
      description:
        "How the project runs: package.json scripts/bin/main, Makefile or just targets, Dockerfile " +
        "CMD/ENTRYPOINT, pyproject scripts, Cargo bins, pom.xml/Gradle mainClass and run/test commands, " +
        ".sln/.csproj (OutputType, launchSettings profiles), plus the source files that define main() " +
        "(Go package main, Java/Kotlin main, C# Main / top-level Program.cs, Python __main__, Rust). " +
        "Use when asking how to start, test, or invoke the CLI.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const sections = ["# Entrypoint map"];

        const pkgText = await readTextFile(path.join(root, "package.json"));
        if (pkgText) {
          try {
            const pkg = JSON.parse(pkgText);
            sections.push("\n## package.json");
            if (pkg.main) sections.push(`main: ${pkg.main}`);
            if (pkg.module) sections.push(`module: ${pkg.module}`);
            if (pkg.exports) {
              const keys = typeof pkg.exports === "string" ? [pkg.exports] : Object.keys(pkg.exports);
              sections.push(`exports: ${keys.slice(0, 20).join(", ")}${keys.length > 20 ? "…" : ""}`);
            }
            if (pkg.bin) {
              if (typeof pkg.bin === "string") sections.push(`bin: ${pkg.name ?? "bin"} → ${pkg.bin}`);
              else {
                for (const [name, target] of Object.entries(pkg.bin)) {
                  sections.push(`bin: ${name} → ${target}`);
                }
              }
            }
            if (pkg.scripts && typeof pkg.scripts === "object") {
              sections.push("scripts:");
              for (const [name, cmd] of Object.entries(pkg.scripts)) {
                sections.push(`  ${name}: ${cmd}`);
              }
            }
          } catch {
            sections.push("\n## package.json\n(unparseable)");
          }
        }

        for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
          const text = await readTextFile(path.join(root, name));
          if (!text) continue;
          const targets = parseMakefileTargets(text).slice(0, 40);
          sections.push(`\n## ${name}`);
          sections.push(targets.length ? `targets: ${targets.join(", ")}` : "(no targets found)");
          break;
        }

        const justText = await readTextFile(path.join(root, "justfile"));
        if (justText) {
          const targets = parseJustTargets(justText).slice(0, 40);
          sections.push("\n## justfile");
          sections.push(targets.length ? `targets: ${targets.join(", ")}` : "(no targets found)");
        }

        for (const name of ["Dockerfile", "dockerfile", "Containerfile"]) {
          const text = await readTextFile(path.join(root, name));
          if (!text) continue;
          const cmds = dockerfileCommands(text);
          sections.push(`\n## ${name}`);
          sections.push(cmds.length ? cmds.join("\n") : "(no CMD/ENTRYPOINT/EXPOSE)");
          break;
        }

        const pyproject = await readTextFile(path.join(root, "pyproject.toml"));
        if (pyproject) {
          const scripts = [];
          let inScripts = false;
          for (const line of pyproject.split(/\r?\n/)) {
            if (/^\[project\.scripts\]/.test(line) || /^\[tool\.poetry\.scripts\]/.test(line)) {
              inScripts = true;
              continue;
            }
            if (inScripts) {
              if (/^\[/.test(line)) break;
              const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/);
              if (m) scripts.push(`${m[1]} → ${m[2]}`);
            }
          }
          if (scripts.length) {
            sections.push("\n## pyproject.toml scripts");
            sections.push(scripts.join("\n"));
          }
        }

        const cargo = await readTextFile(path.join(root, "Cargo.toml"));
        if (cargo) {
          const bins = [];
          if (/\[\[bin\]\]/.test(cargo) || /name\s*=/.test(cargo)) {
            for (const block of cargo.split(/\[\[bin\]\]/).slice(1)) {
              const name = block.match(/name\s*=\s*"([^"]+)"/);
              const p = block.match(/path\s*=\s*"([^"]+)"/);
              if (name) bins.push(p ? `${name[1]} (${p[1]})` : name[1]);
            }
          }
          const pkgName = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m);
          sections.push("\n## Cargo.toml");
          if (pkgName) sections.push(`package: ${pkgName[1]}`);
          if (bins.length) sections.push(`bins: ${bins.join(", ")}`);
          else if (/\[lib\]/.test(cargo)) sections.push("lib: yes");
        }

        // JVM / .NET build files.
        for (const name of await detectBuildManifests(root)) {
          const text = await readTextFile(path.join(root, name));
          if (!text) continue;
          const base = path.basename(name);
          if (base === "pom.xml") {
            const rows = [];
            const mainClass = text.match(/<mainClass>\s*([^<\s]+)\s*<\/mainClass>/)?.[1] ?? text.match(/<start-class>\s*([^<\s]+)\s*<\/start-class>/)?.[1];
            if (mainClass) rows.push(`mainClass: ${mainClass}`);
            const packaging = xmlText(text.replace(/<parent>[\s\S]*?<\/parent>/, ""), "packaging");
            if (packaging) rows.push(`packaging: ${packaging}`);
            if (/spring-boot-maven-plugin/.test(text)) rows.push("run: mvn spring-boot:run");
            if (/<module>/.test(text)) rows.push(`modules: ${[...text.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map((m) => m[1]).slice(0, 20).join(", ")}`);
            rows.push(`build: mvn ${await exists(path.join(root, "mvnw")) ? "(./mvnw) " : ""}package · test: mvn test`);
            sections.push(`\n## ${name}`, rows.join("\n"));
          } else if (/^build\.gradle/.test(base)) {
            const rows = [];
            const mainClass = text.match(/mainClass(?:Name)?(?:\.set)?\s*\(?\s*=?\s*["']([^"']+)["']/)?.[1];
            if (mainClass) rows.push(`mainClass: ${mainClass}`);
            const plugins = [...text.matchAll(/^\s*(?:id|kotlin|alias)\s*\(?\s*["']([^"']+)["']/gm)].map((m) => m[1]);
            if (plugins.length) rows.push(`plugins: ${plugins.slice(0, 10).join(", ")}`);
            const wrapper = (await exists(path.join(root, "gradlew"))) ? "./gradlew" : "gradle";
            const tasks = [...text.matchAll(/(?:tasks\.register|task)\s*\(?\s*["'](\w+)["']/g)].map((m) => m[1]);
            rows.push(`run: ${wrapper} ${/application|springframework\.boot/.test(text) ? (/springframework\.boot/.test(text) ? "bootRun" : "run") : "build"} · test: ${wrapper} test${tasks.length ? ` · custom tasks: ${[...new Set(tasks)].slice(0, 12).join(", ")}` : ""}`);
            sections.push(`\n## ${name}`, rows.join("\n"));
          } else if (/\.slnx?$/i.test(base)) {
            sections.push(`\n## ${name}`, `build: dotnet build ${name} · test: dotnet test ${name}`);
          } else if (/\.(csproj|fsproj|vbproj)$/i.test(base)) {
            const rows = [];
            const outType = xmlText(text, "OutputType");
            const tfm = xmlText(text, "TargetFramework") ?? xmlText(text, "TargetFrameworks");
            const sdk = text.match(/<Project\s+Sdk="([^"]+)"/)?.[1] ?? "";
            const isTest = /Microsoft\.NET\.Test\.Sdk|<IsTestProject>true/i.test(text);
            const isWeb = /Microsoft\.NET\.Sdk\.Web/.test(sdk);
            const kind = isTest ? "test project" : isWeb ? "web app" : outType ? outType.toLowerCase() : "library";
            rows.push(`${kind}${tfm ? `  ${tfm}` : ""}`);
            if (isTest) rows.push(`test: dotnet test ${name}`);
            else if (isWeb || /^exe$/i.test(outType ?? "")) rows.push(`run: dotnet run --project ${name}`);
            const dir = path.posix.dirname(name);
            const launch = await readTextFile(path.join(root, dir === "." ? "" : dir, "Properties", "launchSettings.json"));
            if (launch) {
              try {
                const profiles = Object.entries(JSON.parse(launch).profiles ?? {});
                if (profiles.length) rows.push(`launch profiles: ${profiles.map(([n, p]) => `${n}${p.applicationUrl ? ` (${p.applicationUrl})` : ""}`).slice(0, 6).join(", ")}`);
              } catch {
                // ignore
              }
            }
            sections.push(`\n## ${name}`, rows.join("\n"));
          }
        }

        // Source-level main functions (Go, Java/Kotlin, C#, Python, Rust) — where the program actually starts.
        const { files } = await collectFiles(root, root);
        const mains = await scanMainFunctions(root, files);
        if (mains.length) {
          sections.push("\n## main() / program entry files");
          sections.push(mains.slice(0, 30).map((m) => `${m.rel}  (${m.how})`).join("\n"));
          if (mains.length > 30) sections.push(`… ${mains.length - 30} more`);
        }

        if (sections.length === 1) sections.push("\n(no common entrypoints found)");
        return truncateOutput(sections.join("\n"));
      },
    },

    {
      name: "tests_for",
      description:
        "Map a source file to likely tests (and a test file back to source) via per-ecosystem naming " +
        "conventions (x.test.ts, test_x.py, x_test.go, XTest.java in src/test, XTests.cs in Proj.Tests, " +
        "x_spec.rb, XTest.php), mirrored test trees, reverse imports, and Rust #[cfg(test)] modules. " +
        "Returns existing matches plus suggested paths that are missing.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Source or test file relative to the workspace root." },
        },
        required: ["path"],
      },
      async execute({ path: filePath }) {
        const abs = resolveWithinRoot(root, filePath);
        const kind = await pathKind(abs);
        if (kind !== "file") throw new Error(`Path '${filePath}' is not a file.`);
        const rel = toRel(root, abs);
        const sections = [`# Tests for ${rel}`];

        const { files } = await collectFiles(root, root);
        const resolver = createResolver(root, files);

        if (isTestPath(rel)) {
          sections.push("\n## Direction\ntest → source");
          const { found, missing } = await findSourceForTest(root, rel, files, { resolver });
          sections.push("\n## Likely source");
          sections.push(found.length ? found.join("\n") : "(none found)");
          if (missing.length) {
            sections.push("\n## Suggested paths (missing)");
            sections.push(missing.join("\n"));
          }
        } else {
          sections.push("\n## Direction\nsource → test");
          const { found, missing, inFile } = await findTestsFor(root, rel, files, { resolver });
          sections.push("\n## Likely tests");
          sections.push(found.length ? found.join("\n") : "(none found)");
          if (inFile.length) {
            sections.push("\n## In-file tests");
            sections.push(inFile.join("\n"));
          }
          if (missing.length) {
            sections.push("\n## Suggested paths (missing)");
            sections.push(missing.join("\n"));
          }
        }

        return truncateOutput(sections.join("\n"));
      },
    },

    {
      name: "dir_digest",
      description:
        "Depth-limited directory digest: child folders with file counts and language mix. " +
        "Bridges shallow list_dir and expensive full-repo greps.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory relative to workspace root (default '.').",
          },
          depth: {
            type: "integer",
            description: "How many directory levels to summarize (default 2, max 4).",
          },
          max_entries: {
            type: "integer",
            description: "Max rows to return (default 60, max 150).",
          },
        },
      },
      async execute({ path: dirPath, depth, max_entries } = {}) {
        const abs = resolveWithinRoot(root, dirPath ?? ".");
        const kind = await pathKind(abs);
        if (kind !== "directory") throw new Error(`Path '${dirPath ?? "."}' is not a directory.`);
        const maxDepth = Math.min(Math.max(1, depth ?? 2), 4);
        const maxRows = Math.min(Math.max(1, max_entries ?? 60), 150);
        const startRel = toRel(root, abs);

        /** @type {Map<string, {files: number, langs: Map<string, number>}>} */
        const buckets = new Map();
        let scanned = 0;
        const queue = [{ abs, depth: 0 }];

        while (queue.length && scanned < 8000) {
          const { abs: dir, depth: d } = queue.shift();
          let entries;
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const e of entries) {
            if (e.name === ".git" || (e.isDirectory() && SKIP_DIRS.has(e.name))) continue;
            const childAbs = path.join(dir, e.name);
            const childRel = toRel(root, childAbs);
            if (e.isDirectory()) {
              if (d + 1 < maxDepth) queue.push({ abs: childAbs, depth: d + 1 });
              // ensure bucket exists for the directory itself
              if (!buckets.has(childRel)) buckets.set(childRel, { files: 0, langs: new Map() });
              continue;
            }
            if (!e.isFile()) continue;
            scanned++;
            // Attribute file to its containing directory (relative to start), capped at maxDepth
            const parts = childRel.split("/");
            const startParts = startRel === "." ? [] : startRel.split("/");
            const relParts = parts.slice(startParts.length);
            const bucketParts = relParts.slice(0, Math.min(maxDepth, Math.max(1, relParts.length - 1)));
            const bucket =
              startRel === "."
                ? bucketParts.join("/") || "."
                : [startRel, ...bucketParts].filter(Boolean).join("/") || startRel;
            let b = buckets.get(bucket);
            if (!b) {
              b = { files: 0, langs: new Map() };
              buckets.set(bucket, b);
            }
            b.files++;
            const lang = EXT_LANG[path.extname(e.name).toLowerCase()];
            if (lang) b.langs.set(lang, (b.langs.get(lang) ?? 0) + 1);
          }
        }

        const rows = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        const lines = [`# Dir digest ${startRel} (depth ${maxDepth})`, `scanned_files: ${scanned}`, ""];
        let shown = 0;
        for (const [name, info] of rows) {
          if (shown >= maxRows) {
            lines.push(`… ${rows.length - shown} more entries omitted`);
            break;
          }
          const langs = [...info.langs.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([l, n]) => `${l}:${n}`)
            .join(", ");
          lines.push(`${name}/  files=${info.files}${langs ? `  [${langs}]` : ""}`);
          shown++;
        }
        if (!rows.length) lines.push("(empty)");
        return truncateOutput(lines.join("\n"));
      },
    },

    {
      name: "config_surface",
      description:
        "Named configuration surface only: env var names from .env.example (and similar), " +
        "compose service names, and published ports. Never returns secret values.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const sections = ["# Config surface (names only)"];

        const envFiles = [];
        for (const name of ENV_EXAMPLE_GLOBS) {
          if (await exists(path.join(root, name))) envFiles.push(name);
        }
        // also scan shallow for *.env.example
        try {
          const top = await readdir(root);
          for (const name of top) {
            if (/\.env\.(example|sample|template)$/i.test(name) && !envFiles.includes(name)) {
              envFiles.push(name);
            }
          }
        } catch {
          // ignore
        }

        const allKeys = [];
        const seen = new Set();
        for (const name of envFiles) {
          const text = await readTextFile(path.join(root, name));
          if (text == null) continue;
          const keys = extractEnvKeys(text);
          sections.push(`\n## ${name}`);
          sections.push(keys.length ? keys.join("\n") : "(no keys)");
          for (const k of keys) {
            if (!seen.has(k)) {
              seen.add(k);
              allKeys.push(k);
            }
          }
        }

        for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
          const text = await readTextFile(path.join(root, name));
          if (text == null) continue;
          const { services, ports } = extractComposeSurface(text);
          sections.push(`\n## ${name}`);
          if (services.length) sections.push(`services: ${services.join(", ")}`);
          if (ports.length) sections.push(`ports: ${ports.join(", ")}`);
          if (!services.length && !ports.length) sections.push("(no services/ports detected)");
        }

        // Dockerfile EXPOSE
        for (const name of ["Dockerfile", "dockerfile", "Containerfile"]) {
          const text = await readTextFile(path.join(root, name));
          if (!text) continue;
          const exposes = [];
          for (const line of text.split(/\r?\n/)) {
            const m = line.match(/^\s*EXPOSE\s+(.+)$/i);
            if (m) exposes.push(m[1].trim());
          }
          if (exposes.length) {
            sections.push(`\n## ${name} EXPOSE`);
            sections.push(exposes.join("\n"));
          }
          break;
        }

        if (allKeys.length) {
          sections.push(`\n## All env keys (${allKeys.length})`);
          sections.push(allKeys.join(", "));
        }

        if (sections.length === 1) sections.push("\n(no .env.example or compose files found)");
        return truncateOutput(sections.join("\n"));
      },
    },
  ];
}
