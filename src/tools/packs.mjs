/**
 * Named tool packs and profile resolution for schema-tiered Halo Scan.
 *
 * Profiles shrink tools/list; `activate_pack` (injected by the managed
 * toolset when a non-full profile is active) expands the live set later.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { SKIP_DIRS } from "../workspace.mjs";

/** Meta-tool name injected when a non-full profile is active. */
export const ACTIVATE_PACK = "activate_pack";

/**
 * Secondary packs plus the always-on base. `activate_pack` is not listed
 * here — the managed toolset adds it when `profile !== "full"`.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const PACKS = Object.freeze({
  base: Object.freeze([
    "repo_overview",
    "project_conventions",
    "entrypoint_map",
    "read_file",
    "list_dir",
    "grep_search",
    "find_files",
    "dir_digest",
    "get_symbol",
    "file_outline",
    "find_references",
    "git_history",
  ]),
  symbols: Object.freeze([
    "find_symbol",
    "symbol_context",
    "locate",
    "symbol_search",
    "file_brief",
  ]),
  quality: Object.freeze([
    "tests_for",
    "test_inventory",
    "markers",
    "changed_symbols",
    "unused_exports",
  ]),
  web: Object.freeze(["http_surface"]),
  config: Object.freeze(["config_surface", "config_key_usage", "who_imports"]),
});

/** Secondary packs only (fingerprint / activate_pack targets). */
export const SECONDARY_PACKS = Object.freeze(
  Object.keys(PACKS).filter((k) => k !== "base"),
);

/** Fingerprint priority when capping auto at base + 2 secondary packs. */
const FINGERPRINT_PRIORITY = Object.freeze(["symbols", "quality", "web", "config"]);

const CODE_LANGS = new Set([
  "JavaScript",
  "TypeScript",
  "Python",
  "Go",
  "Rust",
  "Java",
  "Kotlin",
  "C#",
  "Ruby",
  "PHP",
  "Swift",
  "C",
  "C/C++",
  "C++",
]);

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
};

const TEST_DIR_NAMES = new Set(["test", "tests", "spec", "specs", "__tests__"]);
const TEST_FILE_RE = /(?:^|[/\\])(?:test_[^/\\]+|[^/\\]+_test\.[^/\\]+|[^/\\]+\.(?:test|spec)\.[^/\\]+)$/i;

const WEB_DEP_RE =
  /\b(express|fastify|koa|hapi|@hapi\/hapi|hono|nestjs|next|nuxt|sveltekit|remix|flask|django|fastapi|starlette|gin-gonic\/gin|echo|fiber|gorilla\/mux|rails|sinatra|laravel|symfony|aspnet|microsoft\.aspnetcore|spring-boot|spring-web|jax-rs|quarkus|ktor|axum|actix-web|rocket)\b/i;

const WEB_FILE_HINTS = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuxt.config.ts",
  "nuxt.config.js",
  "svelte.config.js",
  "remix.config.js",
  "manage.py",
  "config/routes.rb",
  "artisan",
];

const CONFIG_FILE_HINTS = [
  ".env.example",
  ".env.sample",
  ".env.template",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

/** @returns {string[]} */
export function listPackNames() {
  return Object.keys(PACKS);
}

/**
 * Union of pack tool names in stable pack order (base first, then secondary
 * in FINGERPRINT_PRIORITY order).
 * @param {string[]} packNames
 * @returns {string[]}
 */
export function unionPackTools(packNames) {
  const out = [];
  const seen = new Set();
  const ordered = ["base", ...FINGERPRINT_PRIORITY.filter((p) => packNames.includes(p))];
  for (const extra of packNames) {
    if (!ordered.includes(extra)) ordered.push(extra);
  }
  for (const pack of ordered) {
    const tools = PACKS[pack];
    if (!tools) continue;
    for (const name of tools) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * @param {string} profile
 * @param {{ workspaceRoot?: string }} [opts]
 * @returns {Promise<string[]|null>} Tool names, or `null` for the full set.
 */
export async function resolveProfileNames(profile, { workspaceRoot } = {}) {
  const p = String(profile ?? "")
    .trim()
    .toLowerCase();
  if (!p || p === "full") return null;
  if (p === "auto") {
    if (!workspaceRoot) throw new Error("profile 'auto' requires workspaceRoot.");
    const secondary = await fingerprintWorkspace(workspaceRoot);
    return unionPackTools(["base", ...secondary]);
  }
  if (p === "base") return [...PACKS.base];
  if (PACKS[p]) return unionPackTools(["base", p]);
  const known = ["auto", "base", "full", ...SECONDARY_PACKS].join(", ");
  throw new Error(`Unknown profile '${profile}'. Known: ${known}.`);
}

/**
 * Pick secondary packs for `--profile auto`. Always candidates in priority
 * order; hard-capped at two.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function fingerprintWorkspace(root) {
  const abs = path.resolve(root);
  const wanted = new Set();

  const langs = await sampleCodeLanguages(abs);
  if (langs.some((l) => CODE_LANGS.has(l))) wanted.add("symbols");

  if (await hasTestSignals(abs)) wanted.add("quality");
  if (await hasWebSignals(abs)) wanted.add("web");
  if (await hasConfigSignals(abs)) wanted.add("config");

  const selected = [];
  for (const pack of FINGERPRINT_PRIORITY) {
    if (!wanted.has(pack)) continue;
    selected.push(pack);
    if (selected.length >= 2) break;
  }
  return selected;
}

async function sampleCodeLanguages(root, maxFiles = 800) {
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
      const lang = EXT_LANG[path.extname(e.name).toLowerCase()];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
      if (scanned >= maxFiles) break;
    }
  }
  return [...counts.keys()];
}

async function hasTestSignals(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isDirectory() && TEST_DIR_NAMES.has(e.name.toLowerCase())) return true;
    if (e.isFile() && TEST_FILE_RE.test(e.name)) return true;
  }
  // Cheap one-level peek into src/ for co-located *.test.*
  for (const sub of ["src", "lib", "app"]) {
    let kids;
    try {
      kids = await readdir(path.join(root, sub), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of kids) {
      if (e.isDirectory() && TEST_DIR_NAMES.has(e.name.toLowerCase())) return true;
      if (e.isFile() && TEST_FILE_RE.test(path.join(sub, e.name))) return true;
    }
  }
  return false;
}

async function hasWebSignals(root) {
  for (const hint of WEB_FILE_HINTS) {
    try {
      await readFile(path.join(root, hint));
      return true;
    } catch {
      /* missing */
    }
  }
  const manifestText = await readManifestBlobs(root);
  return WEB_DEP_RE.test(manifestText);
}

async function hasConfigSignals(root) {
  for (const hint of CONFIG_FILE_HINTS) {
    try {
      await readFile(path.join(root, hint));
      return true;
    } catch {
      /* missing */
    }
  }
  let entries;
  try {
    entries = await readdir(root);
  } catch {
    return false;
  }
  return entries.some((n) => /^\.env(\.|$)/i.test(n) && /example|sample|template/i.test(n));
}

async function readManifestBlobs(root) {
  const parts = [];
  for (const rel of [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "composer.json",
    "requirements.txt",
  ]) {
    try {
      parts.push(await readFile(path.join(root, rel), "utf8"));
    } catch {
      /* missing */
    }
  }
  // .csproj / pom at top level only
  try {
    const entries = await readdir(root);
    for (const name of entries) {
      if (/\.(csproj|fsproj)$/i.test(name) || /^pom\.xml$/i.test(name) || /^build\.gradle/i.test(name)) {
        try {
          parts.push(await readFile(path.join(root, name), "utf8"));
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* skip */
  }
  return parts.join("\n");
}

/**
 * Build the `activate_pack` meta-tool against a live registry + full catalog.
 *
 * @param {object} opts
 * @param {Map<string, import("../mcp-server.mjs").McpTool>} opts.catalog
 * @param {import("../tool-registry.mjs").ToolRegistry} opts.registry
 * @returns {import("../mcp-server.mjs").McpTool}
 */
export function createActivatePackTool({ catalog, registry }) {
  const known = SECONDARY_PACKS.join(", ");
  return {
    name: ACTIVATE_PACK,
    description:
      "Expose an additional Halo Scan tool pack that was not selected for this session. " +
      `Packs: ${known}, or full. Newly added tools appear on the next tools/list (next turn). ` +
      "Call when you need tools that are not in the current list.",
    inputSchema: {
      type: "object",
      properties: {
        pack: {
          type: "string",
          description: `Pack to activate: ${known}, or full.`,
        },
      },
      required: ["pack"],
    },
    execute({ pack } = {}) {
      const key = String(pack ?? "")
        .trim()
        .toLowerCase();
      if (!key) {
        return `Missing pack. Known: ${known}, full.`;
      }
      if (key === "base") {
        return JSON.stringify(
          {
            pack: "base",
            added: [],
            note: "Pack 'base' is always active.",
            active: registry.list().map((t) => t.name),
          },
          null,
          2,
        );
      }

      /** @type {string[]} */
      let want;
      if (key === "full") {
        want = [...catalog.keys()].filter((n) => n !== ACTIVATE_PACK);
      } else if (PACKS[key]) {
        want = [...PACKS[key]];
      } else {
        return `Unknown pack '${pack}'. Known: ${known}, full.`;
      }

      const already = want.filter((n) => registry.has(n));
      const added = registry.addFromCatalog(catalog, want);
      if (added.length) registry.notifyChange();

      return JSON.stringify(
        {
          pack: key,
          added,
          already,
          active: registry.list().map((t) => t.name),
        },
        null,
        2,
      );
    },
  };
}
