/**
 * Workspace path safety and directory walking for Halo Scan tools.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Directories never worth scanning (and often enormous). */
export const SKIP_DIRS = new Set([
  ".git",
  ".halo-agent",
  ".halo-scan",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "target",
  "vendor",
]);

export const MAX_FILE_BYTES = 512_000;
export const MAX_FILES_SCANNED = 5000;
export const MAX_OUTPUT_CHARS = 48_000;

/**
 * Strip workspace-folder prefixes so absolute or double-prefixed paths resolve
 * cleanly inside the root.
 */
export function normalizeWorkspaceRelativePath(root, relativePath) {
  const raw = String(relativePath ?? ".").trim() || ".";
  const rootAbs = path.resolve(root);
  const unix = raw.replace(/\\/g, "/");
  const posixRoot = rootAbs.replace(/\\/g, "/").replace(/\/$/, "");
  const base = path.basename(rootAbs);

  if (unix === posixRoot || unix === posixRoot + "/") return ".";
  if (unix.startsWith(posixRoot + "/")) return unix.slice(posixRoot.length + 1) || ".";

  if (path.isAbsolute(raw)) {
    const abs = path.resolve(raw);
    const rel = path.relative(rootAbs, abs);
    if (rel === "") return ".";
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  }

  let rel = unix.replace(/^\.\//, "");
  if (base && (rel === base || rel.startsWith(`${base}/`))) {
    rel = rel === base ? "." : rel.slice(base.length + 1);
  }
  return rel || ".";
}

/**
 * Resolve a model-supplied path against the workspace root, rejecting escapes.
 * @returns {string} Absolute path inside the root.
 */
export function resolveWithinRoot(root, relativePath) {
  const normalized = normalizeWorkspaceRelativePath(root, relativePath ?? ".");
  const target = path.resolve(root, normalized);
  const rel = path.relative(root, target);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(
      `Path '${relativePath}' is outside the workspace root. Use paths relative to the workspace.`,
    );
  }
  return target;
}

/** Relative posix path from root. */
export function toRel(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join("/") || ".";
}

/** True when the buffer looks binary (NUL in the first 8 KB). */
export function looksBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

/**
 * Cap long tool output with a head + tail so the model still sees both ends.
 */
export function truncateOutput(text, maxChars = MAX_OUTPUT_CHARS) {
  const s = String(text ?? "");
  if (s.length <= maxChars) return s;
  const keep = Math.floor((maxChars - 80) / 2);
  return (
    s.slice(0, keep) +
    `\n\n… [${s.length - keep * 2} chars omitted] …\n\n` +
    s.slice(-keep)
  );
}

/**
 * Convert a glob to a case-insensitive RegExp. Supports `*`, `**`, `?`.
 */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      source += `\\${c}`;
    } else {
      source += c;
    }
  }
  return new RegExp(`^${source}$`, "i");
}

/**
 * Walk under startAbs, yield `/`-separated paths relative to rootAbs.
 * @returns {Promise<{files: string[], truncated: boolean}>}
 */
export async function collectFiles(rootAbs, startAbs, maxFiles = MAX_FILES_SCANNED) {
  const files = [];
  let truncated = false;
  const queue = [startAbs];

  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, truncated };
      }
      files.push(toRel(rootAbs, path.join(dir, entry.name)));
    }
  }
  return { files, truncated };
}

/**
 * Read a text file if it exists and is not binary / oversized.
 * @returns {Promise<string|null>}
 */
export async function readTextFile(absPath, maxBytes = MAX_FILE_BYTES) {
  let buf;
  try {
    buf = await readFile(absPath);
  } catch {
    return null;
  }
  if (buf.length > maxBytes || looksBinary(buf)) return null;
  return buf.toString("utf8");
}

/**
 * @returns {Promise<'file'|'directory'|null>}
 */
export async function pathKind(absPath) {
  try {
    const s = await stat(absPath);
    if (s.isFile()) return "file";
    if (s.isDirectory()) return "directory";
    return null;
  } catch {
    return null;
  }
}
