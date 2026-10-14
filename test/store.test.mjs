import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  ENCYCLOPEDIA_TOOL,
  LEGACY_STORE_RELS,
  STORE_REL,
  STORE_ROOT_REL,
  ensureProjectStore,
  storeArtifactPath,
  storeDir,
  toolStoreRel,
} from "../src/store.mjs";

/** @type {string[]} */
const temps = [];

afterEach(async () => {
  while (temps.length) {
    const dir = temps.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "halo-scan-store-"));
  temps.push(dir);
  return dir;
}

async function seedLegacy(root, rel, body = '{"schemaVersion":1}\n') {
  const dir = path.join(root, rel);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "encircle.json"), body);
  await writeFile(path.join(dir, "keep.txt"), "sidecar\n");
  return dir;
}

test("tool stores live under .bf/bf-chat-tools/<tool>", async () => {
  const root = await tempRoot();
  assert.match(toolStoreRel("encyclopedia").replace(/\\/g, "/"), /\.bf\/bf-chat-tools\/encyclopedia$/);
  assert.equal(STORE_REL, toolStoreRel(ENCYCLOPEDIA_TOOL));
  assert.equal(storeDir(root), path.join(root, STORE_REL));
  assert.equal(storeArtifactPath(root), path.join(root, STORE_REL, "encircle.json"));
});

test("ensureProjectStore migrates flat .bf/bf-chat-tools into encyclopedia/", async () => {
  const root = await tempRoot();
  await seedLegacy(root, STORE_ROOT_REL, '{"from":"flat-root"}\n');

  const result = await ensureProjectStore(root);
  assert.equal(result.migratedFrom, STORE_ROOT_REL);
  assert.equal(result.storeDir, path.join(root, STORE_REL));
  assert.ok(!existsSync(path.join(root, STORE_ROOT_REL, "encircle.json")));
  assert.equal(
    await readFile(path.join(result.storeDir, "encircle.json"), "utf8"),
    '{"from":"flat-root"}\n',
  );
  assert.equal(await readFile(path.join(result.storeDir, "keep.txt"), "utf8"), "sidecar\n");
});

test("ensureProjectStore migrates .bitfield/bf-chat-tools on first use", async () => {
  const root = await tempRoot();
  const legacyRel = path.join(".bitfield", "bf-chat-tools");
  await seedLegacy(root, legacyRel, '{"from":"bitfield-bf-chat-tools"}\n');

  const result = await ensureProjectStore(root);
  assert.equal(result.migratedFrom, legacyRel);
  assert.ok(!existsSync(path.join(root, legacyRel)));
  assert.equal(
    await readFile(path.join(result.storeDir, "encircle.json"), "utf8"),
    '{"from":"bitfield-bf-chat-tools"}\n',
  );
});

test("ensureProjectStore migrates .bitfield/encircle on first use", async () => {
  const root = await tempRoot();
  const legacyRel = path.join(".bitfield", "encircle");
  await seedLegacy(root, legacyRel, '{"from":"bitfield-encircle"}\n');

  const result = await ensureProjectStore(root);
  assert.equal(result.migratedFrom, legacyRel);
  assert.ok(!existsSync(path.join(root, legacyRel)));
  assert.equal(
    await readFile(path.join(result.storeDir, "encircle.json"), "utf8"),
    '{"from":"bitfield-encircle"}\n',
  );
});

test("ensureProjectStore migrates .encircle when bitfield legacy is absent", async () => {
  const root = await tempRoot();
  await seedLegacy(root, ".encircle", '{"from":"dot-encircle"}\n');

  const result = await ensureProjectStore(root);
  assert.equal(result.migratedFrom, ".encircle");
  assert.ok(!existsSync(path.join(root, ".encircle")));
  assert.equal(
    await readFile(path.join(result.storeDir, "encircle.json"), "utf8"),
    '{"from":"dot-encircle"}\n',
  );
});

test("ensureProjectStore prefers flat .bf/bf-chat-tools over older legacy paths", async () => {
  const root = await tempRoot();
  assert.equal(LEGACY_STORE_RELS[0], STORE_ROOT_REL);
  await seedLegacy(root, STORE_ROOT_REL, '{"from":"preferred"}\n');
  await seedLegacy(root, ".encircle", '{"from":"other"}\n');

  const result = await ensureProjectStore(root);
  assert.equal(result.migratedFrom, STORE_ROOT_REL);
  assert.equal(
    await readFile(path.join(result.storeDir, "encircle.json"), "utf8"),
    '{"from":"preferred"}\n',
  );
  assert.ok(existsSync(path.join(root, ".encircle", "encircle.json")));
});

test("ensureProjectStore is a no-op when canonical store already exists", async () => {
  const root = await tempRoot();
  const dest = path.join(root, STORE_REL);
  await mkdir(dest, { recursive: true });
  await writeFile(path.join(dest, "encircle.json"), '{"from":"canonical"}\n');
  await seedLegacy(root, path.join(".bitfield", "encircle"), '{"from":"legacy"}\n');

  const result = await ensureProjectStore(root);
  assert.equal(result.migratedFrom, null);
  assert.equal(
    await readFile(path.join(dest, "encircle.json"), "utf8"),
    '{"from":"canonical"}\n',
  );
  assert.ok(existsSync(path.join(root, ".bitfield", "encircle", "encircle.json")));
});

test("ensureProjectStore with no legacy store reports null migration", async () => {
  const root = await tempRoot();
  const result = await ensureProjectStore(root);
  assert.equal(result.migratedFrom, null);
  assert.equal(result.artifactPath, path.join(root, STORE_REL, "encircle.json"));
  assert.ok(!existsSync(result.storeDir));
});
