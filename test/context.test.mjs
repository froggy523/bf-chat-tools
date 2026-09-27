import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createToolset } from "../src/tools/index.mjs";

let dir;
let tools;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || `git ${args.join(" ")} failed`);
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "halo-scan-ctx-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "test"), { recursive: true });
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });

  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "ctx-fixture",
        version: "1.2.3",
        type: "module",
        engines: { node: ">=20" },
        bin: { "ctx-cli": "src/cli.mjs" },
        scripts: { start: "node src/cli.mjs", test: "node --test" },
        dependencies: { leftpad: "1.0.0" },
        devDependencies: { prettier: "3.0.0" },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(dir, "package-lock.json"), "{}\n");
  await writeFile(path.join(dir, "AGENTS.md"), "# Agents\n\nUse tests.\n");
  await writeFile(path.join(dir, ".editorconfig"), "root = true\n[*]\nindent_size = 2\n");
  await writeFile(path.join(dir, ".env.example"), "# sample\nAPI_KEY=\nPORT=3000\nDATABASE_URL=\n");
  await writeFile(
    path.join(dir, "docker-compose.yml"),
    ["services:", "  web:", "    ports:", '      - "8080:80"', "  db:", "    image: postgres"].join("\n"),
  );
  await writeFile(path.join(dir, "Dockerfile"), "FROM node:20\nEXPOSE 3000\nCMD [\"node\",\"src/cli.mjs\"]\n");
  await writeFile(path.join(dir, "Makefile"), "build:\n\techo build\ntest:\n\techo test\n");
  await writeFile(
    path.join(dir, ".github", "workflows", "ci.yml"),
    "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
  );
  await writeFile(
    path.join(dir, "README.md"),
    "# Fixture\n\n## Install\n\nsteps\n\n## Usage\n\n### CLI\n\nrun it\n",
  );
  await writeFile(path.join(dir, "docs", "guide.md"), "# Guide\n\n## Setup\n\n## Advanced\n");

  await writeFile(path.join(dir, "src", "cli.mjs"), 'import { add } from "./math.mjs";\nconsole.log(add(1, 2));\n');
  await writeFile(path.join(dir, "src", "math.mjs"), "export function add(a, b) {\n  return a + b;\n}\n");
  await writeFile(
    path.join(dir, "test", "math.test.mjs"),
    'import { add } from "../src/math.mjs";\nif (add(1, 2) !== 3) throw new Error("fail");\n',
  );

  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  await writeFile(path.join(dir, "src", "math.mjs"), "export function add(a, b) {\n  return a + b;\n}\nexport const VERSION = 1;\n");
  git(dir, ["add", "src/math.mjs"]);
  git(dir, ["commit", "-m", "touch math"]);

  tools = Object.fromEntries(createToolset({ workspaceRoot: dir }).map((t) => [t.name, t]));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("project_conventions lists rules and CI", async () => {
  const text = await tools.project_conventions.execute({});
  assert.match(text, /AGENTS\.md/);
  assert.match(text, /\.editorconfig/);
  assert.match(text, /\.github\/workflows\/ci\.yml/);
  assert.match(text, /Use tests/);
});

test("entrypoint_map surfaces scripts, bin, Makefile, Dockerfile", async () => {
  const text = await tools.entrypoint_map.execute();
  assert.match(text, /bin: ctx-cli → src\/cli\.mjs/);
  assert.match(text, /start: node src\/cli\.mjs/);
  assert.match(text, /targets:.*\bbuild\b/);
  assert.match(text, /CMD \["node","src\/cli\.mjs"\]/);
});

test("file_brief shows imports and importers (imports_of merged in)", async () => {
  const text = await tools.file_brief.execute({ path: "src/math.mjs" });
  assert.match(text, /Imported by/);
  assert.match(text, /src\/cli\.mjs/);
  assert.match(text, /test\/math\.test\.mjs/);
});

test("tests_for maps source to test and reverse", async () => {
  const forward = await tools.tests_for.execute({ path: "src/math.mjs" });
  assert.match(forward, /source → test/);
  assert.match(forward, /test\/math\.test\.mjs/);

  const reverse = await tools.tests_for.execute({ path: "test/math.test.mjs" });
  assert.match(reverse, /test → source/);
  assert.match(reverse, /src\/math\.mjs/);
});

test("changed_symbols commits mode lists recently touched files (recent_focus merged in)", async () => {
  const text = await tools.changed_symbols.execute({ commits: 5, include_tests: false });
  assert.match(text, /src\/math\.mjs/);
});

test("dir_digest summarizes folders", async () => {
  const text = await tools.dir_digest.execute({ path: ".", depth: 2 });
  assert.match(text, /src\//);
  assert.match(text, /files=/);
});

test("repo_overview lists deps and lockfile (manifest_summary merged in)", async () => {
  const text = await tools.repo_overview.execute({ include_readme: false });
  assert.match(text, /## Manifests\s+\(lockfiles: package-lock\.json\)/);
  assert.match(text, /### package\.json/);
  assert.match(text, /engines: node=>=20/);
  assert.match(text, /leftpad@1\.0\.0/);
  assert.match(text, /prettier@3\.0\.0/);
  const one = await tools.repo_overview.execute({ manifest: "package.json", include_readme: false });
  assert.match(one, /### package\.json/);
  const missing = await tools.repo_overview.execute({ manifest: "nope.json", include_readme: false });
  assert.match(missing, /## Manifests\n\(Manifest 'nope\.json' not found or unreadable\.\)/);
});

test("config_surface returns env names and compose services only", async () => {
  const text = await tools.config_surface.execute();
  assert.match(text, /API_KEY/);
  assert.match(text, /PORT/);
  assert.match(text, /services: web, db/);
  assert.match(text, /ports:.*8080/);
  assert.doesNotMatch(text, /API_KEY=.+/);
});

