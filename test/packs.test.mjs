import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  ACTIVATE_PACK,
  PACKS,
  createManagedToolset,
  createToolset,
  fingerprintWorkspace,
  resolveProfileNames,
  unionPackTools,
} from "../src/tools/index.mjs";

let dir;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "halo-scan-packs-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "test"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "pack-fixture",
        dependencies: { express: "^4.0.0" },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(dir, ".env.example"), "PORT=\n");
  await writeFile(path.join(dir, "src", "app.mjs"), "export const x = 1;\n");
  await writeFile(path.join(dir, "test", "app.test.mjs"), "import test from 'node:test';\n");
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("unionPackTools keeps base tools first and dedupes", () => {
  const names = unionPackTools(["symbols", "base", "web"]);
  assert.equal(names[0], "repo_overview");
  assert.ok(names.includes("symbol_context"));
  assert.ok(names.includes("http_surface"));
  assert.equal(names.length, new Set(names).size);
});

test("resolveProfileNames base and named packs", async () => {
  assert.deepEqual(await resolveProfileNames("base"), [...PACKS.base]);
  assert.deepEqual(await resolveProfileNames("web"), unionPackTools(["base", "web"]));
  assert.equal(await resolveProfileNames("full"), null);
  await assert.rejects(() => resolveProfileNames("nope"), /Unknown profile/);
});

test("fingerprintWorkspace caps at two secondary packs by priority", async () => {
  const packs = await fingerprintWorkspace(dir);
  // JS + test/ + express + .env.example → symbols, quality preferred over web/config
  assert.deepEqual(packs, ["symbols", "quality"]);
  assert.ok(packs.length <= 2);
});

test("createToolset profile=base filters without activate_pack", () => {
  const tools = createToolset({ workspaceRoot: dir, profile: "base" });
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.sort(), [...PACKS.base].sort());
  assert.ok(!names.includes(ACTIVATE_PACK));
  assert.throws(
    () => createToolset({ workspaceRoot: dir, profile: "auto" }),
    /createManagedToolset/,
  );
});

test("createManagedToolset profile=base includes activate_pack and can expand", async () => {
  const { registry, listChanged } = await createManagedToolset({
    workspaceRoot: dir,
    profile: "base",
  });
  assert.equal(listChanged, true);
  const before = registry.list().map((t) => t.name);
  assert.ok(before.includes(ACTIVATE_PACK));
  assert.ok(before.includes("repo_overview"));
  assert.ok(!before.includes("http_surface"));

  let notified = 0;
  registry.onChange = () => {
    notified++;
  };
  const activate = registry.list().find((t) => t.name === ACTIVATE_PACK);
  const text = await activate.execute({ pack: "web" });
  const body = JSON.parse(text);
  assert.deepEqual(body.added, ["http_surface"]);
  assert.equal(notified, 1);
  assert.ok(registry.has("http_surface"));
});

test("createManagedToolset auto uses fingerprint", async () => {
  const { registry } = await createManagedToolset({
    workspaceRoot: dir,
    profile: "auto",
  });
  const names = new Set(registry.list().map((t) => t.name));
  assert.ok(names.has(ACTIVATE_PACK));
  assert.ok(names.has("symbol_context")); // symbols pack
  assert.ok(names.has("tests_for")); // quality pack
  assert.ok(!names.has("http_surface")); // capped out
  assert.ok(!names.has("config_surface"));
});

test("createManagedToolset full has no activate_pack", async () => {
  const { registry, listChanged } = await createManagedToolset({
    workspaceRoot: dir,
    profile: "full",
  });
  assert.equal(listChanged, false);
  assert.ok(!registry.list().some((t) => t.name === ACTIVATE_PACK));
  assert.equal(registry.list().length, 26);
});
