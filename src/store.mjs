/**
 * On-disk tool metadata for user projects.
 *
 * Convention: `<cwd>/.bf/bf-chat-tools/<tool>/`
 * Each tool that persists data gets a folder named after that tool
 * (e.g. encyclopedia → `.bf/bf-chat-tools/encyclopedia/`).
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Umbrella cache root for Bitfield tools under a scanned repo. */
export const BF_DIRNAME = ".bf";

/** Alias of BF_DIRNAME. */
export const BITFIELD_DIRNAME = BF_DIRNAME;

/** Product directory under `.bf/`. */
export const PRODUCT_DIRNAME = "bf-chat-tools";

/** Root for all Halo Scan tool stores: `.bf/bf-chat-tools`. */
export const STORE_ROOT_REL = path.join(BF_DIRNAME, PRODUCT_DIRNAME);

/** Encyclopedia pack store folder name (tool name, not upstream encircle). */
export const ENCYCLOPEDIA_TOOL = "encyclopedia";

/**
 * Relative store path for a named tool: `.bf/bf-chat-tools/<tool>`.
 * @param {string} toolName
 */
export function toolStoreRel(toolName) {
  const name = String(toolName ?? "")
    .trim()
    .replace(/[/\\]/g, "");
  if (!name) throw new Error("toolStoreRel requires a tool name.");
  return path.join(STORE_ROOT_REL, name);
}

/** Encyclopedia store relative to workspace root. */
export const STORE_REL = toolStoreRel(ENCYCLOPEDIA_TOOL);

/**
 * Absolute directory for a tool's project store.
 * @param {string} rootAbs
 * @param {string} toolName
 */
export function toolStoreDir(rootAbs, toolName) {
  return path.join(path.resolve(rootAbs), toolStoreRel(toolName));
}

/**
 * Absolute path to the encyclopedia store directory.
 * @param {string} rootAbs
 */
export function storeDir(rootAbs) {
  return toolStoreDir(rootAbs, ENCYCLOPEDIA_TOOL);
}

/**
 * Absolute path to the encyclopedia artifact (`encircle.json` kept for
 * compatibility with @bitfieldcreek/encircle writers).
 * @param {string} rootAbs
 */
export function storeArtifactPath(rootAbs) {
  return path.join(storeDir(rootAbs), "encircle.json");
}

/** Legacy encyclopedia store locations (first match wins when migrating). */
export const LEGACY_STORE_RELS = Object.freeze([
  // Prior flat layout before per-tool folders.
  STORE_ROOT_REL,
  path.join(".bitfield", "bf-chat-tools"),
  path.join(".bitfield", "encircle"),
  ".encircle",
]);

/**
 * @param {string} dirAbs
 * @param {string} artifactFile
 */
function hasArtifact(dirAbs, artifactFile) {
  return existsSync(path.join(dirAbs, artifactFile));
}

/**
 * @param {string} srcAbs
 * @param {string} destAbs
 */
function isNestedDest(srcAbs, destAbs) {
  const src = path.resolve(srcAbs);
  const dest = path.resolve(destAbs);
  const rel = path.relative(src, dest);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Move a legacy store directory to the canonical location.
 * Prefer rename; fall back to copy+remove when rename cannot replace/cross-device.
 *
 * @param {string} srcAbs
 * @param {string} destAbs
 */
async function moveStoreTree(srcAbs, destAbs) {
  await mkdir(path.dirname(destAbs), { recursive: true });
  if (!existsSync(destAbs)) {
    try {
      await rename(srcAbs, destAbs);
      return;
    } catch {
      /* fall through */
    }
  }
  await cp(srcAbs, destAbs, { recursive: true, force: true });
  await rm(srcAbs, { recursive: true, force: true });
}

/**
 * Move children of `srcAbs` into `destAbs` when dest is nested under src
 * (e.g. flat `.bf/bf-chat-tools` → `.bf/bf-chat-tools/encyclopedia`).
 *
 * @param {string} srcAbs
 * @param {string} destAbs
 */
async function moveStoreContents(srcAbs, destAbs) {
  await mkdir(destAbs, { recursive: true });
  const skip = path.basename(destAbs);
  for (const name of await readdir(srcAbs)) {
    if (name === skip) continue;
    await moveStoreTree(path.join(srcAbs, name), path.join(destAbs, name));
  }
}

/**
 * Ensure a tool's metadata lives under `.bf/bf-chat-tools/<tool>/`.
 * When missing, migrates from `legacyRels` if an artifact is found there.
 *
 * @param {string} rootAbs
 * @param {string} toolName
 * @param {{ artifactFile?: string, legacyRels?: readonly string[] }} [opts]
 * @returns {Promise<{ storeDir: string, artifactPath: string, migratedFrom: string|null }>}
 */
export async function ensureToolStore(rootAbs, toolName, opts = {}) {
  const root = path.resolve(rootAbs);
  const artifactFile = opts.artifactFile ?? `${toolName}.json`;
  const legacyRels = opts.legacyRels ?? [];
  const dest = toolStoreDir(root, toolName);
  const artifact = path.join(dest, artifactFile);

  if (hasArtifact(dest, artifactFile)) {
    return { storeDir: dest, artifactPath: artifact, migratedFrom: null };
  }

  for (const rel of legacyRels) {
    const src = path.join(root, rel);
    if (path.resolve(src) === path.resolve(dest)) continue;
    if (!hasArtifact(src, artifactFile)) continue;
    if (isNestedDest(src, dest)) {
      await moveStoreContents(src, dest);
    } else {
      await moveStoreTree(src, dest);
    }
    return { storeDir: dest, artifactPath: artifact, migratedFrom: rel };
  }

  return { storeDir: dest, artifactPath: artifact, migratedFrom: null };
}

/**
 * Ensure encyclopedia metadata lives under `.bf/bf-chat-tools/encyclopedia/`.
 * Migrates flat / encircle-named legacy stores on first access.
 *
 * @param {string} rootAbs
 * @returns {Promise<{ storeDir: string, artifactPath: string, migratedFrom: string|null }>}
 */
export async function ensureProjectStore(rootAbs) {
  return ensureToolStore(rootAbs, ENCYCLOPEDIA_TOOL, {
    artifactFile: "encircle.json",
    legacyRels: LEGACY_STORE_RELS,
  });
}
