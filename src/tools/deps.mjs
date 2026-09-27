/**
 * Dependency and configuration shortcuts: who imports a package, where an env
 * key is read, and exports nobody references.
 */

import path from "node:path";

import { codeFilesUnder, createResolver, effectiveRoots, escapeRe, wordRegex } from "../analysis.mjs";
import { readJson } from "../manifests.mjs";
import { enclosingTag, getOutline, isCodeFile } from "../outline.mjs";
import { collectFiles, MAX_FILES_SCANNED, readTextFile, truncateOutput } from "../workspace.mjs";

const clamp = (v, lo, hi, dflt) => Math.min(Math.max(lo, v ?? dflt), hi);

function specMatches(spec, wanted) {
  if (spec === wanted) return true;
  const strip = (s) => s.replace(/^node:/, "");
  if (strip(spec) === strip(wanted)) return true;
  return (
    spec.startsWith(wanted + "/") ||
    spec.startsWith(wanted + ".") ||
    spec.startsWith(wanted + "::") ||
    spec.startsWith(wanted + "\\")
  );
}

/**
 * Which manifests declare a dependency matching `wanted` (package.json, pyproject/requirements,
 * go.mod, Cargo.toml, *.csproj, pom.xml, build.gradle[.kts]). Returns human-readable notes.
 */
async function manifestDeclarations(root, allFiles, wanted) {
  const notes = [];
  const lower = wanted.toLowerCase();
  const pkg = await readJson(path.join(root, "package.json"));
  if (pkg) {
    const base = wanted.replace(/^node:/, "").split("/").slice(0, wanted.startsWith("@") ? 2 : 1).join("/");
    let any = false;
    for (const group of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (pkg[group]?.[base]) {
        notes.push(`package.json ${group}: ${base}@${pkg[group][base]}`);
        any = true;
      }
    }
    if (!any && /^[@a-z]/.test(wanted) && !/^node:/.test(wanted) && !wanted.includes(".") && !wanted.includes("::")) {
      notes.push("not declared in package.json (builtin, transitive, or missing)");
    }
  }
  const pyBase = wanted.split(".")[0].replace(/_/g, "-").toLowerCase();
  for (const rel of allFiles.filter((f) => /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|Pipfile|setup\.cfg)$/.test(f)).slice(0, 10)) {
    const text = (await readTextFile(path.join(root, rel))) ?? "";
    const re = new RegExp(`^\\s*["']?${escapeRe(pyBase)}\\b`, "im");
    const alt = new RegExp(`^\\s*["']?${escapeRe(pyBase.replace(/-/g, "_"))}\\b`, "im");
    if (re.test(text) || alt.test(text)) notes.push(`${rel}: declares ${pyBase}`);
  }
  for (const rel of allFiles.filter((f) => /(^|\/)go\.mod$/.test(f)).slice(0, 10)) {
    const text = (await readTextFile(path.join(root, rel))) ?? "";
    const m = text.match(new RegExp(`^\\s*(?:require\\s+)?(${escapeRe(wanted).replace(/\\\//g, "/")}(?:/\\S*)?)\\s+(v\\S+)`, "m"));
    if (m) notes.push(`${rel}: require ${m[1]} ${m[2]}`);
  }
  const crate = wanted.split("::")[0].replace(/-/g, "_");
  for (const rel of allFiles.filter((f) => /(^|\/)Cargo\.toml$/.test(f)).slice(0, 10)) {
    const text = (await readTextFile(path.join(root, rel))) ?? "";
    const m = text.match(new RegExp(`^\\s*${escapeRe(crate).replace(/_/g, "[-_]")}\\s*=\\s*(.+)$`, "m"));
    if (m) notes.push(`${rel}: ${crate} = ${m[1].trim().slice(0, 80)}`);
  }
  for (const rel of allFiles.filter((f) => /\.(csproj|fsproj|vbproj|props)$/i.test(f)).slice(0, 40)) {
    const text = (await readTextFile(path.join(root, rel))) ?? "";
    for (const m of text.matchAll(/<PackageReference\s+([^>]*?)\/?>/g)) {
      const inc = m[1].match(/Include="([^"]+)"/)?.[1];
      if (!inc) continue;
      const ver = m[1].match(/Version="([^"]+)"/)?.[1];
      const id = inc.toLowerCase();
      if (id === lower || lower.startsWith(id + ".")) notes.push(`${rel}: PackageReference ${inc}${ver ? ` ${ver}` : ""}`);
    }
    for (const m of text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
      const name = path.posix.basename(m[1].replace(/\\/g, "/")).replace(/\.\w+proj$/, "");
      if (name.toLowerCase() === lower || lower.startsWith(name.toLowerCase() + ".")) notes.push(`${rel}: ProjectReference ${name}`);
    }
  }
  for (const rel of allFiles.filter((f) => /(^|\/)pom\.xml$/.test(f)).slice(0, 20)) {
    const text = (await readTextFile(path.join(root, rel))) ?? "";
    for (const m of text.matchAll(/<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g)) {
      const g = m[1].trim();
      if (lower === g.toLowerCase() || lower.startsWith(g.toLowerCase() + ".") || lower === m[2].trim().toLowerCase()) {
        notes.push(`${rel}: ${g}:${m[2].trim()}${m[3] ? `:${m[3].trim()}` : ""}`);
      }
    }
  }
  for (const rel of allFiles.filter((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f)).slice(0, 20)) {
    const text = (await readTextFile(path.join(root, rel))) ?? "";
    for (const m of text.matchAll(/^\s*(\w+)\s*\(?\s*["']([^"':]+):([^"':]+)(?::([^"']+))?["']/gm)) {
      const g = m[2].toLowerCase();
      if (lower === g || lower.startsWith(g + ".") || lower === m[3].toLowerCase()) notes.push(`${rel}: ${m[1]} ${m[2]}:${m[3]}${m[4] ? `:${m[4]}` : ""}`);
    }
  }
  return notes.slice(0, 20);
}

const ENV_READ_PATTERNS = [
  /process\.env(?:\.|\[)/,
  /import\.meta\.env/,
  /Deno\.env|Bun\.env/,
  /os\.environ|os\.getenv|\bgetenv\s*\(|environ\.get/,
  /os\.Getenv|os\.LookupEnv/,
  /env::var|std::env/,
  /GetEnvironmentVariable/,
  /System\.getenv/,
  /\bENV\[|ENV\.fetch/,
  /\bconfig\(["'][A-Z_]+["']/,
];

/** Key-specific read shapes: `$KEY`, `${KEY}`, `env.KEY`, `$env:KEY`. */
function keyReadPatterns(k) {
  return [new RegExp(`\\$\\{?${k}\\b`), new RegExp(`\\benv\\.${k}\\b`), new RegExp(`\\$env:${k}\\b`, "i")];
}

const CONFIGISH_FILE = /(^|\/)(\.env[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Dockerfile[^/]*|Containerfile|[^/]*\.(ya?ml|toml|ini|cfg|conf|properties|json|env|sh|ps1|bat|cmd|tf|tfvars|Procfile))$/i;

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createDepsTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "who_imports",
      description:
        "Workspace files that import a package or module specifier: 'zod', 'node:fs', 'react/jsx-runtime', " +
        "'os.path', 'github.com/x/y', 'serde::Deserialize', 'System.Text'. Subpaths count. Also says whether " +
        "the manifest declares it. Use before removing or upgrading a dependency.",
      inputSchema: {
        type: "object",
        properties: {
          specifier: { type: "string", description: "Package / module specifier as written in imports." },
          path: { type: "string", description: "Directory to search under (relative). Defaults to whole workspace." },
          max_results: { type: "integer", description: "Max files listed (default 80, max 300)." },
        },
        required: ["specifier"],
      },
      async execute({ specifier, path: searchPath, max_results }) {
        const wanted = String(specifier ?? "").trim().replace(/^['"]|['"]$/g, "");
        if (!wanted) throw new Error("specifier must not be empty.");
        const max = clamp(max_results, 1, 300, 80);
        const { files, truncated } = await codeFilesUnder(root, searchPath);
        const { files: all } = await collectFiles(root, root);

        // A workspace file path ("src/util.ts", "./src/util") → resolve importers through the module resolver
        // so `.js`→`.ts`, tsconfig paths, Python dotted modules, Go package paths etc. all count.
        const asFile = wanted.replace(/^\.\//, "").replace(/\\/g, "/");
        const pathLike = wanted.startsWith(".") || (asFile.includes("/") && !/^(@|github\.com|golang\.org|gopkg\.in)/.test(asFile));
        const fileTarget = all.includes(asFile) ? asFile : pathLike ? all.find((f) => f.replace(/\.[^./]+$/, "") === asFile) ?? null : null;
        if (fileTarget) {
          const resolver = createResolver(root, all);
          const scopeSet = new Set(files);
          const importers = (await resolver.importersOf(fileTarget, { max: 5000 })).filter((i) => scopeSet.has(i.file));
          const out = [`# Who imports '${fileTarget}' (workspace file)`];
          out.push(`${importers.length} file(s)${truncated ? ` (only first ${MAX_FILES_SCANNED} files scanned)` : ""}`);
          out.push("");
          out.push(importers.length ? importers.slice(0, max).map((i) => `${i.file}  (${i.via})`).join("\n") : "(no importers found)");
          if (importers.length > max) out.push(`… ${importers.length - max} more`);
          return truncateOutput(out.join("\n"));
        }

        const rows = [];
        let total = 0;
        for (const rel of files) {
          const outline = await getOutline(path.join(root, rel));
          if (!outline?.imports?.length) continue;
          const hits = outline.imports.filter((s) => specMatches(s, wanted));
          if (!hits.length) continue;
          total++;
          if (rows.length < max) rows.push(`${rel}  (${[...new Set(hits)].slice(0, 4).join(", ")})`);
        }

        const notes = await manifestDeclarations(root, all, wanted);
        const out = [`# Who imports '${wanted}'`];
        out.push(`${total} file(s)${truncated ? ` (only first ${MAX_FILES_SCANNED} files scanned)` : ""}`);
        if (notes.length) out.push(notes.join("\n"));
        out.push("");
        out.push(rows.length ? rows.join("\n") : "(no importers found)");
        if (total > rows.length) out.push(`… ${total - rows.length} more`);
        return truncateOutput(out.join("\n"));
      },
    },

    {
      name: "config_key_usage",
      description:
        "Where an environment/config key is read in code (process.env, os.environ, os.Getenv, env::var, " +
        "GetEnvironmentVariable, $KEY …) and where it is defined in config files (.env*, compose, Dockerfile, " +
        "CI yaml, shell). Bridges config_surface to the code that consumes it. Never prints values from .env files.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name, e.g. DATABASE_URL." },
          path: { type: "string", description: "Directory to search under (relative). Defaults to whole workspace." },
          max_results: { type: "integer", description: "Max hits per section (default 40, max 150)." },
        },
        required: ["key"],
      },
      async execute({ key, path: searchPath, max_results }) {
        const k = String(key ?? "").trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error("key must be an identifier like DATABASE_URL.");
        const max = clamp(max_results, 1, 150, 40);
        const { allFiles, truncated } = await codeFilesUnder(root, searchPath);
        const wordRe = wordRegex(k);
        const readPatterns = [...ENV_READ_PATTERNS, ...keyReadPatterns(k)];
        const reads = [];
        const defs = [];
        const other = [];
        for (const rel of allFiles) {
          const text = await readTextFile(path.join(root, rel));
          if (text == null || !wordRe.test(text)) continue;
          const lines = text.split(/\r?\n/);
          const code = isCodeFile(rel);
          const configish = CONFIGISH_FILE.test(rel);
          const isEnvFile = /(^|\/)\.env(\.|$)/i.test(rel) && !/example|sample|template/i.test(rel);
          let outline;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!wordRe.test(line)) continue;
            const shown = isEnvFile ? `${k}=<redacted>` : line.trim().slice(0, 240);
            if (code && readPatterns.some((re) => re.test(line))) {
              if (outline === undefined) outline = await getOutline(path.join(root, rel));
              if (reads.length < max) reads.push(`${rel}:${i + 1}: ${shown}${enclosingTag(outline, i + 1)}`);
            } else if (configish || /^\s*(?:export\s+|ENV\s+|ARG\s+|set\s+|\$env:)?\w+\s*[=:]/.test(line)) {
              if (defs.length < max) defs.push(`${rel}:${i + 1}: ${shown}`);
            } else if (other.length < 15) {
              other.push(`${rel}:${i + 1}: ${shown}`);
            }
          }
        }
        const out = [`# Config key usage: ${k}`];
        out.push(`\n## Read in code (${reads.length})`);
        out.push(reads.length ? reads.join("\n") : "(no env reads found)");
        out.push(`\n## Config files / scripts (${defs.length})`);
        out.push(defs.length ? defs.join("\n") : "(not found in config files)");
        if (other.length) {
          out.push(`\n## Other mentions (${other.length})`);
          out.push(other.join("\n"));
        }
        if (truncated) out.push(`\n(only first ${MAX_FILES_SCANNED} files scanned)`);
        return truncateOutput(out.join("\n"));
      },
    },

    {
      name: "unused_exports",
      description:
        "Exported/public top-level symbols under a path that no other workspace file references by name. " +
        "Candidates for deletion or un-exporting; entry-point files (package.json main/bin/exports) are " +
        "flagged since their exports are consumed externally. Heuristic: word-boundary match, so dynamic " +
        "access and string-based lookups are not seen.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory or file to audit (relative). Defaults to whole workspace; prefer a directory." },
          max_results: { type: "integer", description: "Max rows (default 80, max 300)." },
        },
      },
      async execute({ path: searchPath, max_results } = {}) {
        const max = clamp(max_results, 1, 300, 80);
        const { files: scope, truncated } = await codeFilesUnder(root, searchPath);
        const { files: all } = await collectFiles(root, root);
        const allCode = all.filter(isCodeFile);

        // Entry files from package.json.
        const entry = new Set();
        const pkg = await readJson(path.join(root, "package.json"));
        if (pkg) {
          const push = (v) => {
            if (typeof v === "string") entry.add(v.replace(/^\.\//, ""));
            else if (v && typeof v === "object") Object.values(v).forEach(push);
          };
          push(pkg.main);
          push(pkg.module);
          push(pkg.bin);
          push(pkg.exports);
        }

        /** @type {Map<string, {rel: string, sym: any}[]>} */
        const byName = new Map();
        let collected = 0;
        let capped = false;
        for (const rel of scope) {
          const outline = await getOutline(path.join(root, rel));
          if (!outline) continue;
          // Descend through namespace/module wrappers (C#, TS namespaces, Ruby modules) to the real declarations.
          for (const s of effectiveRoots(outline)) {
            if (!s.exported || s.kind === "impl" || s.leaf.length < 2 || s.leaf === "default") continue;
            let arr = byName.get(s.leaf);
            if (!arr) {
              arr = [];
              byName.set(s.leaf, arr);
            }
            arr.push({ rel, sym: s });
            if (++collected >= 600) {
              capped = true;
              break;
            }
          }
          if (capped) break;
        }
        if (!byName.size) return `No exported symbols found under '${searchPath ?? "."}'.`;

        const names = [...byName.keys()];
        const combined = new RegExp(`\\b(${names.map(escapeRe).join("|")})\\b`, "g");
        const used = new Set();
        for (const rel of allCode) {
          if (used.size === names.length) break;
          const text = await readTextFile(path.join(root, rel));
          if (text == null) continue;
          combined.lastIndex = 0;
          let m;
          while ((m = combined.exec(text))) {
            const name = m[1];
            if (used.has(name)) continue;
            const defs = byName.get(name);
            if (defs.some((d) => d.rel === rel)) continue; // own file does not count
            used.add(name);
          }
        }

        const rows = [];
        for (const [name, defs] of byName) {
          if (used.has(name)) continue;
          for (const { rel, sym } of defs) {
            const range = sym.line === sym.endLine ? `${sym.line}` : `${sym.line}-${sym.endLine}`;
            rows.push(`${rel}:${range} ${sym.kind} ${name}${entry.has(rel) ? "  [entry file]" : ""}`);
          }
        }
        rows.sort();
        const out = [`# Unused exports under ${searchPath ?? "."}`];
        out.push(`${rows.length} of ${collected} exported symbol(s) have no references outside their own file${capped ? " (symbol collection capped at 600)" : ""}.`);
        if (truncated) out.push(`(only first ${MAX_FILES_SCANNED} files scanned)`);
        out.push("");
        out.push(rows.length ? rows.slice(0, max).join("\n") : "(every export is referenced somewhere)");
        if (rows.length > max) out.push(`… ${rows.length - max} more`);
        return truncateOutput(out.join("\n"));
      },
    },
  ];
}
