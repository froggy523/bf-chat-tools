/**
 * Manifest and package-layout summaries shared by repo_overview, entrypoint_map
 * and who_imports: package.json, pyproject, Cargo, go.mod, Gemfile, composer,
 * pom.xml, Gradle, .sln / .csproj, plus declared workspace members and nested
 * manifests for monorepos.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { exists } from "./analysis.mjs";
import { globToRegExp, readTextFile, resolveWithinRoot, SKIP_DIRS, toRel } from "./workspace.mjs";

export const LOCKFILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
];

export const MANIFEST_NAMES = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
]);
export const PROJ_FILE = /\.(csproj|fsproj|vbproj)$/i;

export async function readJson(abs) {
  const text = await readTextFile(abs);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listMatching(root, names) {
  const found = [];
  for (const name of names) {
    if (await exists(path.join(root, name))) found.push(name);
  }
  return found;
}

export const xmlText = (xml, tag) => xml.match(new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`))?.[1];

/** Maven pom.xml: coordinates, packaging, modules, properties of note, dependencies. */
export function summarizePom(text) {
  const lines = [];
  const noParent = text.replace(/<parent>[\s\S]*?<\/parent>/, "");
  const head = noParent.replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "").replace(/<build>[\s\S]*?<\/build>/g, "").replace(/<profiles>[\s\S]*?<\/profiles>/g, "");
  const parent = text.match(/<parent>([\s\S]*?)<\/parent>/)?.[1];
  const g = xmlText(head, "groupId") ?? (parent ? xmlText(parent, "groupId") : undefined);
  lines.push(`artifact: ${g ?? "?"}:${xmlText(head, "artifactId") ?? "?"}:${xmlText(head, "version") ?? (parent ? xmlText(parent, "version") : undefined) ?? "?"}`);
  if (parent) lines.push(`parent: ${xmlText(parent, "groupId")}:${xmlText(parent, "artifactId")}:${xmlText(parent, "version") ?? "?"}`);
  const packaging = xmlText(head, "packaging");
  if (packaging) lines.push(`packaging: ${packaging}`);
  const props = text.match(/<properties>([\s\S]*?)<\/properties>/)?.[1] ?? "";
  const interesting = [...props.matchAll(/<([\w.-]+)>([^<]+)<\/\1>/g)].filter((m) => /java|kotlin|source|target|release|spring|encoding/i.test(m[1]));
  if (interesting.length) lines.push(`properties: ${interesting.slice(0, 8).map((m) => `${m[1]}=${m[2].trim()}`).join(", ")}`);
  const modules = [...text.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map((m) => m[1]);
  if (modules.length) lines.push(`modules (${modules.length}): ${modules.slice(0, 20).join(", ")}${modules.length > 20 ? ", …" : ""}`);
  const mainClass = text.match(/<mainClass>\s*([^<\s]+)\s*<\/mainClass>/)?.[1] ?? text.match(/<start-class>\s*([^<\s]+)\s*<\/start-class>/)?.[1];
  if (mainClass) lines.push(`mainClass: ${mainClass}`);
  const depsBlock = text.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "");
  const deps = [];
  for (const m of depsBlock.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const scope = xmlText(m[1], "scope");
    deps.push(`${xmlText(m[1], "groupId") ?? "?"}:${xmlText(m[1], "artifactId") ?? "?"}${xmlText(m[1], "version") ? `:${xmlText(m[1], "version")}` : ""}${scope && scope !== "compile" ? ` (${scope})` : ""}`);
  }
  const managed = [...(text.match(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/)?.[0] ?? "").matchAll(/<dependency>/g)].length;
  lines.push(`dependencies (${deps.length}${managed ? `, ${managed} managed` : ""}):`);
  lines.push(...deps.slice(0, 60).map((d) => `  ${d}`));
  if (deps.length > 60) lines.push(`  … ${deps.length - 60} more`);
  const plugins = [...(text.match(/<build>[\s\S]*?<\/build>/)?.[0] ?? "").matchAll(/<plugin>[\s\S]*?<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)].map((m) => m[1]);
  if (plugins.length) lines.push(`build plugins: ${[...new Set(plugins)].slice(0, 12).join(", ")}`);
  return lines.join("\n");
}

/** Gradle build script (Groovy or Kotlin DSL): plugins, java/kotlin toolchain, application main, dependencies. */
export function summarizeGradle(text) {
  const lines = [];
  const plugins = [...text.matchAll(/^\s*(?:id|kotlin|alias)\s*\(?\s*["']([^"']+)["']\s*\)?(?:\s*version\s*\(?\s*["']([^"']+)["'])?/gm)].map((m) => `${m[1]}${m[2] ? `@${m[2]}` : ""}`);
  const applied = [...text.matchAll(/apply\s+plugin:\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const all = [...new Set([...plugins, ...applied])];
  if (all.length) lines.push(`plugins: ${all.slice(0, 15).join(", ")}`);
  const group = text.match(/^\s*group\s*=?\s*["']([^"']+)["']/m)?.[1];
  const version = text.match(/^\s*version\s*=?\s*["']([^"']+)["']/m)?.[1];
  if (group || version) lines.push(`coordinates: ${group ?? "?"}:${version ?? "?"}`);
  const jvm = text.match(/(?:sourceCompatibility|targetCompatibility|jvmTarget|languageVersion(?:\.set)?\s*\(?\s*JavaLanguageVersion\.of)\s*\(?\s*=?\s*["']?(?:JavaVersion\.VERSION_)?([\w.]+)/)?.[1];
  if (jvm) lines.push(`jvm target: ${jvm.replace(/_/g, ".")}`);
  const mainClass = text.match(/mainClass(?:Name)?(?:\.set)?\s*\(?\s*=?\s*["']([^"']+)["']/)?.[1];
  if (mainClass) lines.push(`mainClass: ${mainClass}`);
  const deps = [];
  const re = /^\s*(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|testCompileOnly|kapt|ksp|annotationProcessor|developmentOnly|detektPlugins|platform)\s*\(?\s*(?:platform|enforcedPlatform|project)?\s*\(?\s*(?:["']([^"']+)["']|(libs\.[\w.]+)|(:[\w:-]+))/gm;
  for (const m of text.matchAll(re)) deps.push(`${m[2] ?? m[3] ?? m[4]}${m[1] === "implementation" || m[1] === "api" ? "" : ` (${m[1]})`}`);
  lines.push(`dependencies (${deps.length}):`);
  lines.push(...deps.slice(0, 60).map((d) => `  ${d}`));
  if (deps.length > 60) lines.push(`  … ${deps.length - 60} more`);
  return lines.join("\n");
}

/** .NET SDK-style project file: framework, output type, package and project references. */
export function summarizeCsproj(text) {
  const lines = [];
  const sdk = text.match(/<Project\s+Sdk="([^"]+)"/)?.[1];
  if (sdk) lines.push(`sdk: ${sdk}`);
  const props = [];
  for (const tag of ["TargetFramework", "TargetFrameworks", "OutputType", "AssemblyName", "RootNamespace", "LangVersion", "Nullable", "ImplicitUsings", "IsPackable", "IsTestProject", "Version", "PackageId"]) {
    const v = xmlText(text, tag);
    if (v) props.push(`${tag}=${v}`);
  }
  if (props.length) lines.push(`properties: ${props.join(", ")}`);
  const pkgs = [...text.matchAll(/<PackageReference\s+([^>]*?)\/?>/g)].map((m) => {
    const inc = m[1].match(/Include="([^"]+)"/)?.[1] ?? "?";
    const ver = m[1].match(/Version="([^"]+)"/)?.[1];
    return ver ? `${inc}@${ver}` : inc;
  });
  const projs = [...text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)].map((m) => m[1].replace(/\\/g, "/"));
  const frameworkRefs = [...text.matchAll(/<FrameworkReference\s+Include="([^"]+)"/g)].map((m) => m[1]);
  if (frameworkRefs.length) lines.push(`framework references: ${frameworkRefs.join(", ")}`);
  lines.push(`package references (${pkgs.length}):`);
  lines.push(...pkgs.slice(0, 60).map((p) => `  ${p}`));
  if (pkgs.length > 60) lines.push(`  … ${pkgs.length - 60} more`);
  if (projs.length) {
    lines.push(`project references (${projs.length}):`);
    lines.push(...projs.slice(0, 40).map((p) => `  ${p}`));
  }
  return lines.join("\n");
}

/** Solution file: list of projects with paths. */
export function summarizeSln(text) {
  const projects = [];
  for (const m of text.matchAll(/Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/g)) {
    if (/\.\w+proj$/i.test(m[2])) projects.push(`${m[1]}  (${m[2].replace(/\\/g, "/")})`);
  }
  for (const m of text.matchAll(/<Project\s+Path="([^"]+)"/g)) projects.push(`${path.posix.basename(m[1].replace(/\\/g, "/")).replace(/\.\w+proj$/, "")}  (${m[1].replace(/\\/g, "/")})`);
  return projects.length ? `projects (${projects.length}):\n${projects.slice(0, 60).map((p) => `  ${p}`).join("\n")}${projects.length > 60 ? `\n  … ${projects.length - 60} more` : ""}` : "(no projects found)";
}

/** Root-level (or one-level-deep) .NET / JVM manifests, in preference order. */
export async function detectBuildManifests(root) {
  const out = [];
  let top = [];
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  const topFiles = top.filter((d) => d.isFile()).map((d) => d.name);
  for (const n of topFiles) if (/\.slnx?$/i.test(n)) out.push(n);
  for (const n of topFiles) if (/\.(csproj|fsproj|vbproj)$/i.test(n)) out.push(n);
  for (const n of ["pom.xml", "build.gradle.kts", "build.gradle"]) if (topFiles.includes(n)) out.push(n);
  if (!out.some((n) => /\.(csproj|fsproj|vbproj)$/i.test(n)) && out.some((n) => /\.slnx?$/i.test(n))) {
    // Solution at root; pull in project files one level down for the auto summary.
    for (const d of top) {
      if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
      try {
        for (const f of await readdir(path.join(root, d.name))) {
          if (/\.(csproj|fsproj|vbproj)$/i.test(f)) out.push(`${d.name}/${f}`);
        }
      } catch {
        // ignore
      }
    }
  }
  return out;
}

export function summarizePkgManifest(pkg) {
  const lines = [];
  if (pkg.name) lines.push(`name: ${pkg.name}`);
  if (pkg.version) lines.push(`version: ${pkg.version}`);
  if (pkg.description) lines.push(`description: ${pkg.description}`);
  if (pkg.type) lines.push(`type: ${pkg.type}`);
  if (pkg.engines && typeof pkg.engines === "object") {
    lines.push(`engines: ${Object.entries(pkg.engines).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (pkg.packageManager) lines.push(`packageManager: ${pkg.packageManager}`);
  if (pkg.workspaces) {
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages ?? Object.keys(pkg.workspaces);
    lines.push(`workspaces: ${ws.join(", ")}`);
  }
  if (pkg.bin) {
    const bins = typeof pkg.bin === "string" ? [`${pkg.name ?? "bin"} → ${pkg.bin}`] : Object.entries(pkg.bin).map(([k, v]) => `${k} → ${v}`);
    lines.push(`bin: ${bins.join(", ")}`);
  }
  if (pkg.scripts && typeof pkg.scripts === "object") {
    const names = Object.keys(pkg.scripts);
    lines.push(`scripts (${names.length}): ${names.slice(0, 16).join(", ")}${names.length > 16 ? ", …" : ""}`);
  }
  const depGroups = [
    ["dependencies", pkg.dependencies],
    ["devDependencies", pkg.devDependencies],
    ["peerDependencies", pkg.peerDependencies],
    ["optionalDependencies", pkg.optionalDependencies],
  ];
  for (const [label, deps] of depGroups) {
    if (!deps || typeof deps !== "object") continue;
    const entries = Object.entries(deps);
    if (!entries.length) continue;
    lines.push(`${label} (${entries.length}):`);
    for (const [name, ver] of entries.slice(0, 40)) lines.push(`  ${name}@${ver}`);
    if (entries.length > 40) lines.push(`  … ${entries.length - 40} more`);
  }
  return lines.join("\n");
}

/**
 * Summarise the primary manifest(s) at the root. Auto-detect picks the first of the
 * common single-manifest ecosystems, or every root .NET / JVM build file.
 *
 * @param {string} root
 * @param {{manifest?: string}} [options]
 * @returns {Promise<{sections: string[], found: boolean, lockfiles: string[]}>}
 */
export async function manifestSummary(root, { manifest } = {}) {
  const sections = [];
  const lockfiles = await listMatching(root, LOCKFILES);

  const buildManifests = manifest ? [] : await detectBuildManifests(root);
  const candidates = manifest
    ? [manifest]
    : ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "composer.json", ...buildManifests];
  // .NET solutions and multi-project JVM builds: summarise every detected build file, not just the first.
  const multi = !manifest && buildManifests.length > 0;

  let found = false;
  for (const name of candidates) {
    const abs = resolveWithinRoot(root, name);
    const text = await readTextFile(abs);
    if (text == null) {
      if (manifest) throw new Error(`Manifest '${name}' not found or unreadable.`);
      continue;
    }
    found = true;
    sections.push(`\n## ${toRel(root, abs)}`);
    const base = path.basename(name);
    if (base === "package.json") {
      try {
        sections.push(summarizePkgManifest(JSON.parse(text)));
      } catch {
        sections.push("(unparseable JSON)");
      }
    } else if (base === "pom.xml") {
      sections.push(summarizePom(text));
    } else if (/^build\.gradle(\.kts)?$/.test(base)) {
      sections.push(summarizeGradle(text));
    } else if (PROJ_FILE.test(base)) {
      sections.push(summarizeCsproj(text));
    } else if (/\.slnx?$/i.test(base)) {
      sections.push(summarizeSln(text));
    } else if (base === "go.mod") {
      const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith("//"));
      sections.push(lines.slice(0, 60).join("\n"));
    } else if (base === "Cargo.toml") {
      const keep = [];
      let inDeps = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^\[/.test(line)) inDeps = /dependenc/i.test(line) || /^\[package\]/.test(line);
        if (inDeps || /^\[package\]/.test(line) || keep.length < 15) keep.push(line);
        if (keep.length > 80) break;
      }
      sections.push(keep.join("\n"));
    } else if (base === "pyproject.toml") {
      const keep = [];
      let hot = false;
      for (const line of text.split(/\r?\n/)) {
        if (/^\[/.test(line)) hot = /project|dependenc|tool\.poetry/i.test(line);
        if (hot) keep.push(line);
        if (keep.length > 100) break;
      }
      sections.push(keep.length ? keep.join("\n") : text.slice(0, 3000));
    } else {
      sections.push(text.length > 3000 ? text.slice(0, 3000) + "\n… [truncated]" : text);
    }
    if (!manifest && !multi) break; // auto: first hit only, unless this is a .NET / JVM multi-file build
    if (multi && sections.length > 40) {
      sections.push("\n… more build files omitted.");
      break;
    }
  }
  return { sections, found, lockfiles };
}

/** Declared workspace globs from the usual monorepo manifests. */
export async function workspaceGlobs(root, allFiles) {
  const globs = [];
  const pkg = await readJson(path.join(root, "package.json"));
  if (pkg?.workspaces) {
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages ?? [];
    for (const g of ws) globs.push({ source: "package.json", glob: String(g) });
  }
  const pnpm = await readTextFile(path.join(root, "pnpm-workspace.yaml"));
  if (pnpm) {
    for (const line of pnpm.split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
      if (m && !m[1].startsWith("!")) globs.push({ source: "pnpm-workspace.yaml", glob: m[1] });
    }
  }
  const lerna = await readJson(path.join(root, "lerna.json"));
  if (Array.isArray(lerna?.packages)) for (const g of lerna.packages) globs.push({ source: "lerna.json", glob: String(g) });
  const cargo = await readTextFile(path.join(root, "Cargo.toml"));
  if (cargo) {
    const m = cargo.match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/);
    if (m) {
      for (const g of m[1].split(",")) {
        const v = g.trim().replace(/^["']|["']$/g, "");
        if (v) globs.push({ source: "Cargo.toml", glob: v });
      }
    }
  }
  const gowork = await readTextFile(path.join(root, "go.work"));
  if (gowork) {
    for (const m of gowork.matchAll(/^\s*(?:use\s+)?(?:\(\s*)?\.?\/?([\w./-]+)\s*$/gm)) {
      if (m[1] && m[1] !== "go" && !/^\d/.test(m[1])) globs.push({ source: "go.work", glob: m[1] });
    }
  }
  // .NET solutions: Project("{GUID}") = "Name", "Path\To\Name.csproj", "{GUID}"
  for (const sln of allFiles.filter((f) => !f.includes("/") && /\.slnx?$/i.test(f))) {
    const text = (await readTextFile(path.join(root, sln))) ?? "";
    for (const m of text.matchAll(/Project\("\{[^}]+\}"\)\s*=\s*"[^"]+",\s*"([^"]+\.\w+proj)"/g)) {
      globs.push({ source: sln, glob: path.posix.dirname(m[1].replace(/\\/g, "/")) });
    }
    for (const m of text.matchAll(/<Project\s+Path="([^"]+\.\w+proj)"/g)) {
      globs.push({ source: sln, glob: path.posix.dirname(m[1].replace(/\\/g, "/")) });
    }
  }
  const pom = await readTextFile(path.join(root, "pom.xml"));
  if (pom) {
    for (const m of pom.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)) globs.push({ source: "pom.xml", glob: m[1].replace(/^\.\//, "") });
  }
  for (const name of ["settings.gradle", "settings.gradle.kts"]) {
    const text = await readTextFile(path.join(root, name));
    if (!text) continue;
    for (const m of text.matchAll(/\binclude\s*\(?\s*((?:["'][^"']+["']\s*,?\s*)+)\)?/g)) {
      for (const p of m[1].matchAll(/["']:?([^"']+)["']/g)) globs.push({ source: name, glob: p[1].replace(/:/g, "/") });
    }
    for (const m of text.matchAll(/project\(\s*["']:?([^"']+)["']\s*\)\.projectDir\s*=\s*(?:new\s+)?[Ff]ile\(\s*["']([^"']+)["']/g)) {
      globs.push({ source: name, glob: m[2].replace(/^\.\//, "") });
    }
  }
  return globs;
}

/** One-line description of a nested manifest. */
export async function describeManifest(root, rel) {
  const base = path.posix.basename(rel);
  const text = (await readTextFile(path.join(root, rel))) ?? "";
  const first = (re, dflt) => text.match(re)?.[1] ?? dflt;
  if (base === "package.json") {
    const pkg = await readJson(path.join(root, rel));
    if (!pkg) return "";
    const scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
    const deps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    return `${pkg.name ?? "(unnamed)"}@${pkg.version ?? "?"}${pkg.private ? " private" : ""}  deps=${deps}${scripts.length ? `  scripts: ${scripts.slice(0, 10).join(", ")}${scripts.length > 10 ? ", …" : ""}` : ""}`;
  }
  if (base === "Cargo.toml") return `${first(/^\s*name\s*=\s*"([^"]+)"/m, "(crate)")}@${first(/^\s*version\s*=\s*"([^"]+)"/m, "?")}`;
  if (base === "go.mod") return first(/^module\s+(\S+)/m, "(module)");
  if (base === "pyproject.toml") return `${first(/^\s*name\s*=\s*"([^"]+)"/m, "(project)")}@${first(/^\s*version\s*=\s*"([^"]+)"/m, "?")}`;
  if (base === "composer.json") {
    const c = await readJson(path.join(root, rel));
    return c ? `${c.name ?? "(package)"}${c.type ? ` (${c.type})` : ""}` : "";
  }
  if (base === "pom.xml") {
    const body = text.replace(/<parent>[\s\S]*?<\/parent>/, "").replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "").replace(/<build>[\s\S]*?<\/build>/g, "");
    const g = body.match(/<groupId>([^<]+)<\/groupId>/)?.[1] ?? text.match(/<groupId>([^<]+)<\/groupId>/)?.[1] ?? "?";
    const a = body.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1] ?? "(artifact)";
    const packaging = body.match(/<packaging>([^<]+)<\/packaging>/)?.[1];
    const modules = [...text.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].length;
    const deps = [...text.matchAll(/<dependency>/g)].length;
    return `${g}:${a}${packaging ? ` (${packaging})` : ""}  deps=${deps}${modules ? `  modules=${modules}` : ""}`;
  }
  if (/^build\.gradle/.test(base)) {
    const plugins = [...text.matchAll(/(?:id|kotlin|alias)\s*\(?\s*["']([^"']+)["']\s*\)?/g)].map((m) => m[1]).slice(0, 4);
    const deps = [...text.matchAll(/^\s*(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|kapt|ksp|annotationProcessor)\b/gm)].length;
    const app = /application\b|mainClass/.test(text) ? " application" : "";
    return `gradle${app}  deps=${deps}${plugins.length ? `  plugins: ${plugins.join(", ")}` : ""}`;
  }
  if (PROJ_FILE.test(base)) {
    const sdk = first(/<Project\s+Sdk="([^"]+)"/, "");
    const tfm = first(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/, "");
    const outType = first(/<OutputType>([^<]+)<\/OutputType>/, "");
    const pkgRefs = [...text.matchAll(/<PackageReference\b/g)].length;
    const projRefs = [...text.matchAll(/<ProjectReference\b/g)].length;
    const isTest = /Microsoft\.NET\.Test\.Sdk|<IsTestProject>true/i.test(text);
    return `${base.replace(PROJ_FILE, "")}${outType ? ` (${outType})` : ""}${isTest ? " [test]" : ""}${tfm ? `  ${tfm}` : ""}${sdk ? `  ${sdk}` : ""}  packages=${pkgRefs} projects=${projRefs}`;
  }
  return "";
}

/**
 * Monorepo / multi-package view: declared workspace members and every nested
 * manifest with a one-line description. Returns null when the workspace has
 * neither, so callers can skip the section.
 *
 * @param {string} root
 * @param {string[]} files Workspace-relative file list (from collectFiles).
 * @param {{max?: number}} [options]
 * @returns {Promise<string[]|null>}
 */
export async function packagesMap(root, files, { max = 60 } = {}) {
  const globs = await workspaceGlobs(root, files);
  // Nested manifests, plus .NET project files anywhere (they are the unit of a .NET "package").
  const manifests = files.filter((f) => (f.includes("/") && MANIFEST_NAMES.has(path.posix.basename(f))) || PROJ_FILE.test(f));
  if (!globs.length && !manifests.length) return null;

  const out = [];
  if (globs.length) {
    out.push("declared workspaces:");
    out.push(...globs.slice(0, 40).map((g) => `  ${g.source}: ${g.glob}`));
    if (globs.length > 40) out.push(`  … ${globs.length - 40} more`);
  }
  const globRes = globs.map((g) => globToRegExp(g.glob.replace(/\/$/, "")));
  const rows = [];
  for (const rel of manifests) {
    if (rows.length >= max) break;
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel);
    const declared = globRes.some((re) => re.test(dir));
    const info = await describeManifest(root, rel);
    rows.push(`${dir}/  [${base}]${declared ? " ✓" : ""}  ${info}`);
  }
  out.push(`packages (${rows.length}${manifests.length > rows.length ? ` of ${manifests.length}` : ""}):`);
  out.push(...(rows.length ? rows : ["  (no nested manifests found)"]));
  if (globs.length && rows.length) out.push("✓ = matches a declared workspace glob");
  return out;
}
