/**
 * Per-workspace import resolver.
 *
 * Maps an import specifier, as captured by the outline parser, to the
 * workspace file(s) it refers to. One resolver is created per tool call with
 * the already-collected file list; language contexts (tsconfig paths, go.mod
 * module names, Python source roots, Cargo crate roots, Java/C# namespace
 * index, composer PSR-4 map) are loaded lazily and only once per instance.
 *
 * `resolve()` returns an array of workspace-relative files, or null when the
 * specifier is external (npm package, stdlib, other crate, …).
 */

import path from "node:path";

import { getOutline, languageFor } from "./outline.mjs";
import { readTextFile } from "./workspace.mjs";

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".vue", ".svelte", ".json"];
const JS_SWAP = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"], ".jsx": [".tsx"] };
const PY_ROOTS = [".", "src", "lib", "app", "python"];
const CLIKE_EXT = /\.(java|kt|kts|scala|cs)$/i;

const posix = path.posix;
const dirOf = (rel) => {
  const d = posix.dirname(rel);
  return d === "." ? "" : d;
};
const join = (...parts) => {
  const kept = parts.filter((p) => p !== "" && p != null);
  if (!kept.length) return "";
  const r = posix.normalize(posix.join(...kept)).replace(/^\.\//, "");
  return r === "." ? "" : r;
};

/** Lenient JSON (comments, trailing commas) as found in tsconfig / jsconfig. */
export function parseJsonc(text) {
  if (text == null) return null;
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * @param {string} root      Absolute workspace root.
 * @param {string[]} files   Workspace-relative posix file paths (from collectFiles).
 */
export function createResolver(root, files) {
  const fileSet = new Set(files);
  const lowerMap = new Map();
  for (const f of files) lowerMap.set(f.toLowerCase(), f);
  const dirSet = new Set();
  for (const f of files) {
    let d = dirOf(f);
    while (d && !dirSet.has(d)) {
      dirSet.add(d);
      d = dirOf(d);
    }
  }
  const has = (rel) => fileSet.has(rel) || lowerMap.has(rel.toLowerCase());
  const canon = (rel) => (fileSet.has(rel) ? rel : lowerMap.get(rel.toLowerCase()) ?? rel);
  const filesIn = (dir, filter) => files.filter((f) => dirOf(f) === dir && (!filter || filter(f)));
  const read = (rel) => readTextFile(path.join(root, rel));

  const lazy = {};
  const once = (key, fn) => (lazy[key] ??= Promise.resolve().then(fn));

  // ---------------------------------------------------------------------
  // JS / TS

  const tsContext = () =>
    once("ts", async () => {
      const configs = [];
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        for (const f of files) {
          if (posix.basename(f) !== name) continue;
          const cfg = parseJsonc(await read(f));
          const co = cfg?.compilerOptions ?? {};
          if (!co.paths && !co.baseUrl) continue;
          const dir = dirOf(f);
          const baseUrl = co.baseUrl ? join(dir, co.baseUrl) : dir;
          const paths = [];
          for (const [pattern, targets] of Object.entries(co.paths ?? {})) {
            if (!Array.isArray(targets)) continue;
            const star = pattern.indexOf("*");
            paths.push({
              prefix: star === -1 ? pattern : pattern.slice(0, star),
              suffix: star === -1 ? "" : pattern.slice(star + 1),
              exact: star === -1,
              targets: targets.map(String),
            });
          }
          configs.push({ dir, baseUrl, paths, hasBaseUrl: Boolean(co.baseUrl) });
        }
      }
      // package.json "imports" (#subpath)
      const pkgImports = [];
      const pkg = parseJsonc(await read("package.json"));
      for (const [key, value] of Object.entries(pkg?.imports ?? {})) {
        if (!key.startsWith("#")) continue;
        const target = typeof value === "string" ? value : value?.default ?? Object.values(value ?? {})[0];
        if (typeof target !== "string" || !target.startsWith(".")) continue;
        const star = key.indexOf("*");
        pkgImports.push({
          prefix: star === -1 ? key : key.slice(0, star),
          suffix: star === -1 ? "" : key.slice(star + 1),
          exact: star === -1,
          targets: [target],
        });
      }
      return { configs, pkgImports };
    });

  function probeJs(base) {
    const out = [];
    const tryOne = (p) => {
      if (has(p) && !out.includes(canon(p))) out.push(canon(p));
    };
    tryOne(base);
    const ext = posix.extname(base);
    if (ext && JS_SWAP[ext]) {
      const stem = base.slice(0, -ext.length);
      for (const alt of JS_SWAP[ext]) tryOne(stem + alt);
    }
    if (!ext || !JS_EXTS.includes(ext)) {
      for (const e of JS_EXTS) tryOne(base + e);
    }
    for (const e of JS_EXTS) tryOne(join(base, "index" + e));
    return out;
  }

  function applyMapping(spec, mapping) {
    if (mapping.exact) return spec === mapping.prefix ? mapping.targets.map((t) => t) : null;
    if (!spec.startsWith(mapping.prefix) || !spec.endsWith(mapping.suffix)) return null;
    if (spec.length < mapping.prefix.length + mapping.suffix.length) return null;
    const middle = spec.slice(mapping.prefix.length, spec.length - mapping.suffix.length || undefined);
    return mapping.targets.map((t) => t.replace("*", middle));
  }

  async function resolveJs(fromRel, spec) {
    const clean = spec.split("?")[0];
    if (clean.startsWith(".")) {
      const found = probeJs(join(dirOf(fromRel), clean));
      return found.length ? found : [];
    }
    const { configs, pkgImports } = await tsContext();
    if (clean.startsWith("#")) {
      for (const m of pkgImports) {
        const targets = applyMapping(clean, m);
        if (!targets) continue;
        for (const t of targets) {
          const found = probeJs(join(t));
          if (found.length) return found;
        }
      }
      return [];
    }
    for (const cfg of configs) {
      for (const m of cfg.paths) {
        const targets = applyMapping(clean, m);
        if (!targets) continue;
        for (const t of targets) {
          const found = probeJs(join(cfg.baseUrl, t));
          if (found.length) return found;
        }
      }
      if (cfg.hasBaseUrl && !clean.startsWith("@") && !clean.includes(":")) {
        const found = probeJs(join(cfg.baseUrl, clean));
        if (found.length) return found;
      }
    }
    return null; // external package
  }

  // ---------------------------------------------------------------------
  // Python

  const pyRoots = () =>
    once("py", () => {
      const roots = PY_ROOTS.filter((r) => r === "." || dirSet.has(r));
      // pyproject [tool.setuptools.package-dir] / [tool.poetry] packages from = "src" are common; src/ is already tried.
      return roots;
    });

  function probePy(base) {
    const out = [];
    for (const p of [base + ".py", base + ".pyi", join(base, "__init__.py")]) {
      if (has(p) && !out.includes(canon(p))) out.push(canon(p));
    }
    return out;
  }

  async function resolvePy(fromRel, spec) {
    const results = [];
    let external = true;
    for (let part of spec.split(",")) {
      part = part.trim().replace(/\s+as\s+\w+$/, "");
      if (!part) continue;
      const dots = part.match(/^\.+/)?.[0].length ?? 0;
      const rest = part.slice(dots).split(".").filter(Boolean);
      if (dots > 0) {
        external = false;
        let base = dirOf(fromRel);
        for (let i = 1; i < dots; i++) base = dirOf(base);
        const found = rest.length ? probePy(join(base, ...rest)) : probePy(join(base));
        results.push(...found);
        continue;
      }
      const roots = await pyRoots();
      let found = [];
      for (const r of roots) {
        found = probePy(join(r === "." ? "" : r, ...rest));
        if (found.length) break;
      }
      // `from pkg import name` where name is itself a module: try one segment deeper is not knowable; accept pkg.
      if (found.length) {
        external = false;
        results.push(...found);
      }
    }
    if (results.length) return [...new Set(results)];
    return external ? null : [];
  }

  // ---------------------------------------------------------------------
  // Go

  const goModules = () =>
    once("go", async () => {
      const mods = [];
      for (const f of files) {
        if (posix.basename(f) !== "go.mod") continue;
        const text = await read(f);
        const m = text?.match(/^module\s+(\S+)/m);
        if (m) mods.push({ dir: dirOf(f), module: m[1] });
      }
      mods.sort((a, b) => b.module.length - a.module.length);
      return mods;
    });

  async function resolveGo(fromRel, spec) {
    const mods = await goModules();
    for (const m of mods) {
      if (spec !== m.module && !spec.startsWith(m.module + "/")) continue;
      const sub = spec === m.module ? "" : spec.slice(m.module.length + 1);
      const dir = join(m.dir, sub);
      const found = filesIn(dir, (f) => f.endsWith(".go") && !f.endsWith("_test.go"));
      return found.length ? found : filesIn(dir, (f) => f.endsWith(".go"));
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Rust

  function crateSrcDir(fromRel) {
    let d = dirOf(fromRel);
    for (;;) {
      if (has(join(d, "Cargo.toml"))) return join(d, "src");
      if (!d) break;
      d = dirOf(d);
    }
    return "src";
  }

  function rustModuleDir(fromRel) {
    const base = posix.basename(fromRel);
    if (["mod.rs", "lib.rs", "main.rs"].includes(base)) return dirOf(fromRel);
    return join(dirOf(fromRel), base.replace(/\.rs$/, ""));
  }

  /**
   * Longest-prefix probe for `base/a/b.rs` or `base/a/b/mod.rs`. With `rootFallback` (crate::/self::/super::
   * paths) an item that lives directly in the module root resolves to that root's mod.rs / lib.rs / main.rs.
   */
  function probeRust(base, parts, { rootFallback = false } = {}) {
    for (let k = parts.length; k >= 1; k--) {
      const p = join(base, ...parts.slice(0, k));
      for (const cand of [p + ".rs", join(p, "mod.rs")]) if (has(cand)) return [canon(cand)];
    }
    if (rootFallback) {
      for (const cand of [join(base, "mod.rs"), join(base, "lib.rs"), join(base, "main.rs"), base + ".rs"]) if (has(cand)) return [canon(cand)];
    }
    return [];
  }

  function resolveRust(fromRel, spec) {
    const clean = spec.replace(/::\{[\s\S]*$/, "").replace(/::\*$/, "").replace(/\s+as\s+\w+$/, "");
    const parts = clean.split("::").filter(Boolean);
    if (!parts.length) return null;
    let base;
    if (parts[0] === "crate") {
      base = crateSrcDir(fromRel);
      parts.shift();
    } else if (parts[0] === "self") {
      base = rustModuleDir(fromRel);
      parts.shift();
    } else if (parts[0] === "super") {
      base = rustModuleDir(fromRel);
      while (parts[0] === "super") {
        base = dirOf(base);
        parts.shift();
      }
    } else {
      // `mod foo;` or `use foo::bar` for a sibling module
      const local = probeRust(rustModuleDir(fromRel), parts);
      if (local.length) return local;
      const fromSrc = probeRust(crateSrcDir(fromRel), parts);
      return fromSrc.length ? fromSrc : null; // external crate
    }
    return probeRust(base, parts, { rootFallback: true });
  }

  // ---------------------------------------------------------------------
  // Java / C# / Kotlin / Scala — namespace index

  const nsIndex = () =>
    once("ns", async () => {
      /** @type {Map<string, string[]>} fqn type → files */
      const types = new Map();
      /** @type {Map<string, Set<string>>} namespace → files */
      const namespaces = new Map();
      /** @type {Map<string, string[]>} file → its type leaf names */
      const fileTypes = new Map();
      const addType = (fqn, rel) => {
        const arr = types.get(fqn) ?? [];
        if (!arr.includes(rel)) arr.push(rel);
        types.set(fqn, arr);
      };
      const addNs = (ns, rel) => {
        if (!ns) return;
        const set = namespaces.get(ns) ?? new Set();
        set.add(rel);
        namespaces.set(ns, set);
      };
      const TYPE_KINDS = new Set(["class", "interface", "struct", "enum", "record", "object", "trait", "type"]);
      for (const rel of files) {
        if (!CLIKE_EXT.test(rel)) continue;
        const outline = await getOutline(path.join(root, rel));
        if (!outline) continue;
        const leafNames = [];
        if (/\.cs$/i.test(rel)) {
          const nsSyms = outline.symbols.filter((s) => s.kind === "namespace");
          const blockNs = nsSyms.filter((s) => s.children.length);
          for (const ns of blockNs) {
            addNs(ns.name, rel);
            for (const c of ns.children) {
              if (!TYPE_KINDS.has(c.kind)) continue;
              addType(`${ns.name}.${c.leaf}`, rel);
              leafNames.push(c.leaf);
            }
          }
          // file-scoped `namespace X;` (no braces) → every other root type is inside it
          const fileNs = nsSyms.find((s) => !s.children.length);
          const looseRoots = outline.roots.filter((s) => s.kind !== "namespace" && TYPE_KINDS.has(s.kind));
          if (looseRoots.length) {
            const nsName = fileNs?.name ?? "";
            addNs(nsName, rel);
            for (const c of looseRoots) {
              addType(nsName ? `${nsName}.${c.leaf}` : c.leaf, rel);
              leafNames.push(c.leaf);
            }
          }
        } else {
          const text = await read(rel);
          const pkg = text?.match(/^\s*package\s+([\w.]+)/m)?.[1] ?? "";
          addNs(pkg, rel);
          for (const s of outline.roots) {
            if (!TYPE_KINDS.has(s.kind) && !(s.kind === "function" && /\.kt$/.test(rel))) continue;
            addType(pkg ? `${pkg}.${s.leaf}` : s.leaf, rel);
            if (TYPE_KINDS.has(s.kind)) leafNames.push(s.leaf);
          }
          // Kotlin top-level functions are imported by name too; leafNames stay type-only for reference scans.
        }
        fileTypes.set(rel, leafNames);
      }
      return { types, namespaces, fileTypes };
    });

  async function resolveClike(spec) {
    const idx = await nsIndex();
    let s = spec.replace(/\.\*?$/, "").replace(/\s+as\s+\w+$/, "");
    if (!s || s === "var" || s === "static") return null;
    if (idx.types.has(s)) return idx.types.get(s);
    if (idx.namespaces.has(s)) return [...idx.namespaces.get(s)].slice(0, 50);
    // static import of a member / nested type: strip trailing segments until a type matches
    const parts = s.split(".");
    while (parts.length > 1) {
      parts.pop();
      const t = parts.join(".");
      if (idx.types.has(t)) return idx.types.get(t);
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Ruby / PHP / C

  function resolveRuby(fromRel, spec) {
    const cands = [join(dirOf(fromRel), spec), join(dirOf(fromRel), spec + ".rb"), join("lib", spec + ".rb"), spec + ".rb", join("app", spec + ".rb")];
    for (const c of cands) if (has(c)) return [canon(c)];
    return spec.startsWith(".") ? [] : null;
  }

  const composerMap = () =>
    once("composer", async () => {
      const pkg = parseJsonc(await read("composer.json"));
      const out = [];
      for (const key of ["autoload", "autoload-dev"]) {
        for (const [prefix, dirs] of Object.entries(pkg?.[key]?.["psr-4"] ?? {})) {
          for (const d of Array.isArray(dirs) ? dirs : [dirs]) out.push({ prefix: prefix.replace(/\\+$/, ""), dir: String(d).replace(/\/$/, "") });
        }
      }
      out.sort((a, b) => b.prefix.length - a.prefix.length);
      return out;
    });

  async function resolvePhp(fromRel, spec) {
    if (/\.php$/i.test(spec)) {
      for (const c of [join(dirOf(fromRel), spec), spec]) if (has(c)) return [canon(c)];
      return [];
    }
    const clean = spec.replace(/^\\/, "").replace(/\s+as\s+\w+$/, "");
    const map = await composerMap();
    for (const m of map) {
      if (clean !== m.prefix && !clean.startsWith(m.prefix + "\\")) continue;
      const rest = clean.slice(m.prefix.length).replace(/^\\/, "").split("\\").join("/");
      const c = join(m.dir, rest + ".php");
      if (has(c)) return [canon(c)];
    }
    for (const base of ["src", "app", "lib", ""]) {
      const c = join(base, clean.split("\\").join("/") + ".php");
      if (has(c)) return [canon(c)];
    }
    return null;
  }

  function resolveC(fromRel, spec) {
    for (const c of [join(dirOf(fromRel), spec), spec, join("include", spec), join("src", spec), join("inc", spec)]) if (has(c)) return [canon(c)];
    return spec.includes("/") || has(join(dirOf(fromRel), spec)) ? [] : null;
  }

  // ---------------------------------------------------------------------

  /**
   * @param {string} fromRel  Importing file (workspace-relative).
   * @param {string} spec     Specifier as captured by the outline parser.
   * @param {string} [lang]   Language family (defaults to languageFor(fromRel)).
   * @returns {Promise<string[]|null>}  Workspace files, [] if internal-but-unresolved, null if external.
   */
  async function resolve(fromRel, spec, lang = languageFor(fromRel)) {
    if (!spec) return null;
    switch (lang) {
      case "js":
        return resolveJs(fromRel, spec);
      case "python":
        return resolvePy(fromRel, spec);
      case "go":
        return resolveGo(fromRel, spec);
      case "rust":
        return resolveRust(fromRel, spec);
      case "clike-oo":
      case "kotlin":
        return resolveClike(spec);
      case "ruby":
        return resolveRuby(fromRel, spec);
      case "php":
        return resolvePhp(fromRel, spec);
      case "c":
        return resolveC(fromRel, spec);
      default:
        return null;
    }
  }

  /**
   * Files that import `rel`. For Java/C#/Kotlin (namespace-based, no file
   * imports) this is files that reference one of `rel`'s type names.
   * @returns {Promise<{file: string, via: string}[]>}
   */
  async function importersOf(rel, { max = 80, candidates = files } = {}) {
    const lang = languageFor(rel);
    const out = [];
    if (lang === "clike-oo" || lang === "kotlin") {
      const idx = await nsIndex();
      const names = idx.fileTypes.get(rel) ?? [];
      if (!names.length) return out;
      const re = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);
      for (const f of candidates) {
        if (f === rel || !CLIKE_EXT.test(f)) continue;
        const text = await read(f);
        if (text == null) continue;
        const m = text.match(re);
        if (m) out.push({ file: f, via: `type ${m[1]}` });
        if (out.length >= max) break;
      }
      return out;
    }
    const targetDir = dirOf(rel);
    for (const f of candidates) {
      if (f === rel) continue;
      const fl = languageFor(f);
      if (!fl) continue;
      const outline = await getOutline(path.join(root, f));
      if (!outline?.imports?.length) continue;
      for (const spec of outline.imports) {
        const resolved = await resolve(f, spec, fl);
        if (!resolved?.length) continue;
        const hit = lang === "go" ? resolved.some((r) => dirOf(r) === targetDir) : resolved.includes(rel);
        if (hit) {
          out.push({ file: f, via: spec });
          break;
        }
      }
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * Resolve every import of a file for display.
   * @returns {Promise<{spec: string, files: string[]|null}[]>}
   */
  async function importsOf(rel) {
    const outline = await getOutline(path.join(root, rel));
    const out = [];
    for (const spec of outline?.imports ?? []) out.push({ spec, files: await resolve(rel, spec) });
    return out;
  }

  return { resolve, importersOf, importsOf, files };
}
