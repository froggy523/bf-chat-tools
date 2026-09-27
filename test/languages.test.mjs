/**
 * Cross-language coverage: import resolution, test mapping, name normalisation,
 * hierarchy parsing, orient tools and pattern tables for Python, Go, Rust,
 * TypeScript (tsconfig paths), Java (Maven) and C# (.sln / .csproj).
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createResolver, isTestPath, normalizeSymbolName, parentsFromSignature, stripGenerics, wordRegex } from "../src/analysis.mjs";
import { createToolset } from "../src/tools/index.mjs";
import { collectFiles } from "../src/workspace.mjs";

const roots = {};
const toolsets = {};

async function fixture(name, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `halo-scan-lang-${name}-`));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
  roots[name] = dir;
  toolsets[name] = Object.fromEntries(createToolset({ workspaceRoot: dir }).map((t) => [t.name, t]));
}

async function resolverFor(name) {
  const { files } = await collectFiles(roots[name], roots[name]);
  return createResolver(roots[name], files);
}

before(async () => {
  await fixture("py", {
    "pyproject.toml": '[project]\nname = "pyfx"\nversion = "0.1.0"\ndependencies = ["requests>=2"]\n',
    "src/pkg/__init__.py": "",
    "src/pkg/core.py": "def compute(x):\n    return x * 2\n\n\nclass Engine:\n    def run(self):\n        return compute(1)\n",
    "src/pkg/util/__init__.py": "",
    "src/pkg/util/helpers.py": "from ..core import compute\nfrom . import helpers as _self\nimport os.path\n\n\ndef helper():\n    return compute(2)\n",
    "src/pkg/cli.py": 'from pkg.core import Engine\nimport requests\n\n\ndef main():\n    Engine().run()\n\n\nif __name__ == "__main__":\n    main()\n',
    "tests/test_core.py": "from pkg.core import compute, Engine\n\n\ndef test_compute():\n    assert compute(2) == 4\n\n\nclass TestEngine:\n    def test_run(self):\n        assert Engine().run() == 2\n",
    "tests/helpers_test.py": "from pkg.util.helpers import helper\n\n\ndef test_helper():\n    assert helper() == 4\n",
  });

  await fixture("go", {
    "go.mod": "module example.com/app\n\ngo 1.22\n\nrequire github.com/gorilla/mux v1.8.1\n",
    "cmd/server/main.go": 'package main\n\nimport (\n\t"example.com/app/internal/store"\n\t"github.com/gorilla/mux"\n)\n\nfunc main() {\n\ts := store.New()\n\tr := mux.NewRouter()\n\tr.HandleFunc("/items", s.List)\n\t_ = r\n}\n',
    "internal/store/store.go": 'package store\n\nimport "net/http"\n\ntype Store struct{}\n\nfunc New() *Store { return &Store{} }\n\nfunc (s *Store) List(w http.ResponseWriter, r *http.Request) {}\n',
    "internal/store/store_test.go": 'package store\n\nimport "testing"\n\nfunc TestNew(t *testing.T) {\n\tif New() == nil {\n\t\tt.Fatal("nil")\n\t}\n}\n',
    "latest.go": "package app\n\nfunc Latest() int { return 1 }\n",
  });

  await fixture("rs", {
    "Cargo.toml": '[package]\nname = "rsfx"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
    "src/main.rs": "mod config;\nmod net;\n\nuse crate::config::Settings;\n\nfn main() {\n    let s = Settings::load();\n    net::client::ping(&s);\n}\n",
    "src/config.rs": "pub struct Settings;\n\nimpl Settings {\n    pub fn load() -> Self {\n        Settings\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn loads() {\n        let _ = Settings::load();\n    }\n}\n",
    "src/net/mod.rs": "pub mod client;\n",
    "src/net/client.rs": "use super::super::config::Settings;\nuse serde::Serialize;\n\npub fn ping(_s: &Settings) {}\n",
  });

  await fixture("ts", {
    "package.json": JSON.stringify({ name: "tsfx", type: "module", main: "src/index.ts", devDependencies: { typescript: "5.4.0" } }),
    "tsconfig.json": '{\n  // comment allowed\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@app/*": ["src/*"], "@shared": ["src/shared/index.ts"] }\n  },\n}\n',
    "src/index.ts": 'import { Service } from "@app/service";\nimport { helper } from "@shared";\nimport { fmt } from "./util/fmt.js";\n\nexport function boot() {\n  return new Service().run(helper(), fmt(1));\n}\n',
    "src/service.ts": "export class Service {\n  run(a: string, b: string): string {\n    return a + b;\n  }\n}\n",
    "src/shared/index.ts": 'export function helper(): string {\n  return "h";\n}\n',
    "src/util/fmt.ts": "export function fmt(n: number): string {\n  return String(n);\n}\n",
    "src/util/fmt.test.ts": 'import { fmt } from "./fmt.js";\n\ntest("fmt", () => {\n  expect(fmt(1)).toBe("1");\n});\n',
  });

  await fixture("java", {
    "pom.xml": [
      '<?xml version="1.0"?>',
      "<project>",
      "  <groupId>com.acme</groupId>",
      "  <artifactId>shop</artifactId>",
      "  <version>1.0.0</version>",
      "  <packaging>jar</packaging>",
      "  <properties><java.version>21</java.version></properties>",
      "  <modules><module>api</module><module>core</module></modules>",
      "  <dependencies>",
      "    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.3.0</version></dependency>",
      "    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.0</version><scope>test</scope></dependency>",
      "  </dependencies>",
      "  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId>",
      "    <configuration><mainClass>com.acme.shop.Application</mainClass></configuration></plugin></plugins></build>",
      "</project>",
      "",
    ].join("\n"),
    "api/pom.xml": "<project><parent><groupId>com.acme</groupId><artifactId>shop</artifactId><version>1.0.0</version></parent><artifactId>api</artifactId></project>\n",
    "core/pom.xml": "<project><parent><groupId>com.acme</groupId><artifactId>shop</artifactId><version>1.0.0</version></parent><artifactId>core</artifactId></project>\n",
    "core/src/main/java/com/acme/shop/Application.java": [
      "package com.acme.shop;",
      "",
      "import org.springframework.boot.SpringApplication;",
      "import org.springframework.boot.autoconfigure.SpringBootApplication;",
      "",
      "@SpringBootApplication",
      "public class Application {",
      "    public static void main(String[] args) {",
      "        SpringApplication.run(Application.class, args);",
      "    }",
      "}",
      "",
    ].join("\n"),
    "core/src/main/java/com/acme/shop/model/Order.java": [
      "package com.acme.shop.model;",
      "",
      "import java.util.List;",
      "import java.util.Map;",
      "",
      "public class Order extends BaseEntity<Long, Map<String, List<String>>> implements Comparable<Order>, Auditable {",
      "    private final List<String> lines;",
      "",
      "    public Order(List<String> lines) {",
      "        this.lines = lines;",
      "    }",
      "",
      "    public int total() {",
      "        return lines.size();",
      "    }",
      "",
      "    @Override",
      "    public int compareTo(Order o) {",
      "        return Integer.compare(total(), o.total());",
      "    }",
      "}",
      "",
    ].join("\n"),
    "core/src/main/java/com/acme/shop/model/BaseEntity.java": "package com.acme.shop.model;\n\npublic abstract class BaseEntity<ID, M> {\n    protected ID id;\n}\n",
    "core/src/main/java/com/acme/shop/model/Auditable.java": "package com.acme.shop.model;\n\npublic interface Auditable {\n}\n",
    "core/src/main/java/com/acme/shop/service/OrderService.java": [
      "package com.acme.shop.service;",
      "",
      "import com.acme.shop.model.Order;",
      "import java.util.List;",
      "",
      "public class OrderService {",
      "    public int sum(List<Order> orders) {",
      "        int t = 0;",
      "        for (Order o : orders) {",
      "            t += o.total();",
      "        }",
      "        return t;",
      "    }",
      "}",
      "",
    ].join("\n"),
    "api/src/main/java/com/acme/shop/api/OrderResource.java": [
      "package com.acme.shop.api;",
      "",
      "import com.acme.shop.model.*;",
      "import com.acme.shop.service.OrderService;",
      "import jakarta.ws.rs.GET;",
      "import jakarta.ws.rs.POST;",
      "import jakarta.ws.rs.Path;",
      "",
      '@Path("/orders")',
      "public class OrderResource {",
      "    private final OrderService service = new OrderService();",
      "",
      "    @GET",
      "    public int total() {",
      "        return service.sum(List.of());",
      "    }",
      "",
      "    @POST",
      '    @Path("/{id}")',
      "    public void create(Order order) {",
      "        order.total();",
      "    }",
      "}",
      "",
    ].join("\n"),
    "core/src/test/java/com/acme/shop/model/OrderTest.java": [
      "package com.acme.shop.model;",
      "",
      "import org.junit.jupiter.api.Test;",
      "import org.junit.jupiter.params.ParameterizedTest;",
      "import org.junit.jupiter.params.provider.ValueSource;",
      "import java.util.List;",
      "",
      "class OrderTest {",
      "    @Test",
      "    void totalCountsLines() {",
      '        new Order(List.of("a")).total();',
      "    }",
      "",
      "    @ParameterizedTest",
      "    @ValueSource(ints = {1, 2})",
      "    void compares(int n) {",
      "    }",
      "}",
      "",
    ].join("\n"),
    "core/src/test/java/com/acme/shop/service/OrderServiceIT.java": "package com.acme.shop.service;\n\nimport org.junit.jupiter.api.Test;\n\nclass OrderServiceIT {\n    @Test void sums() { new OrderService(); }\n}\n",
  });

  await fixture("cs", {
    "Shop.sln": [
      "Microsoft Visual Studio Solution File, Format Version 12.00",
      'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop.Core", "Shop.Core\\Shop.Core.csproj", "{11111111-1111-1111-1111-111111111111}"',
      "EndProject",
      'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop.Api", "Shop.Api\\Shop.Api.csproj", "{22222222-2222-2222-2222-222222222222}"',
      "EndProject",
      'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop.Core.Tests", "Shop.Core.Tests\\Shop.Core.Tests.csproj", "{33333333-3333-3333-3333-333333333333}"',
      "EndProject",
      "",
    ].join("\n"),
    "Shop.Core/Shop.Core.csproj": [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup><TargetFramework>net8.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup>",
      '  <ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup>',
      "</Project>",
      "",
    ].join("\n"),
    "Shop.Api/Shop.Api.csproj": [
      '<Project Sdk="Microsoft.NET.Sdk.Web">',
      "  <PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup>",
      '  <ItemGroup><ProjectReference Include="..\\Shop.Core\\Shop.Core.csproj" /></ItemGroup>',
      "</Project>",
      "",
    ].join("\n"),
    "Shop.Api/Properties/launchSettings.json": JSON.stringify({ profiles: { http: { applicationUrl: "http://localhost:5000" } } }),
    "Shop.Core.Tests/Shop.Core.Tests.csproj": [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup><TargetFramework>net8.0</TargetFramework><IsTestProject>true</IsTestProject></PropertyGroup>",
      '  <ItemGroup><PackageReference Include="xunit" Version="2.8.0" /><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.10.0" /></ItemGroup>',
      '  <ItemGroup><ProjectReference Include="..\\Shop.Core\\Shop.Core.csproj" /></ItemGroup>',
      "</Project>",
      "",
    ].join("\n"),
    "Shop.Core/Orders/Order.cs": [
      "namespace Shop.Core.Orders;",
      "",
      "public class Order : EntityBase<Guid, Dictionary<string, List<int>>>, IComparable<Order>",
      "{",
      "    public List<int> Lines { get; } = new();",
      "",
      "    public int Total()",
      "    {",
      "        return Lines.Count;",
      "    }",
      "",
      "    public int CompareTo(Order? other) => Total().CompareTo(other?.Total() ?? 0);",
      "}",
      "",
    ].join("\n"),
    "Shop.Core/Orders/EntityBase.cs": "namespace Shop.Core.Orders;\n\npublic abstract class EntityBase<TId, TMeta>\n{\n    public TId Id { get; set; } = default!;\n}\n",
    "Shop.Core/Pricing/PriceService.cs": [
      "using Shop.Core.Orders;",
      "",
      "namespace Shop.Core.Pricing",
      "{",
      "    public class PriceService",
      "    {",
      "        public int Sum(IEnumerable<Order> orders)",
      "        {",
      "            var t = 0;",
      "            foreach (var o in orders) t += o.Total();",
      "            return t;",
      "        }",
      "",
      "        internal int Unreferenced() => 0;",
      "    }",
      "",
      "    public static class LegacyDiscount",
      "    {",
      "        public static int Apply(int v) => v;",
      "    }",
      "}",
      "",
    ].join("\n"),
    "Shop.Api/Program.cs": [
      "using Shop.Core.Pricing;",
      "",
      "var builder = WebApplication.CreateBuilder(args);",
      "var app = builder.Build();",
      'app.MapGet("/orders", () => new PriceService().Sum([]));',
      "app.Run();",
      "",
    ].join("\n"),
    "Shop.Api/Controllers/OrdersController.cs": [
      "using Microsoft.AspNetCore.Mvc;",
      "using Shop.Core.Orders;",
      "",
      "namespace Shop.Api.Controllers;",
      "",
      "[ApiController]",
      '[Route("api/[controller]")]',
      "public class OrdersController : ControllerBase",
      "{",
      '    [HttpGet("{id}")]',
      "    public int Get(int id) => new Order().Total();",
      "}",
      "",
    ].join("\n"),
    "Shop.Core.Tests/Orders/OrderTests.cs": [
      "using Shop.Core.Orders;",
      "using Xunit;",
      "",
      "namespace Shop.Core.Tests.Orders;",
      "",
      "public class OrderTests",
      "{",
      "    [Fact]",
      "    public void TotalCountsLines()",
      "    {",
      "        Assert.Equal(0, new Order().Total());",
      "    }",
      "",
      "    [Theory, InlineData(1), InlineData(2)]",
      "    public void ComparesByTotal(int n) { }",
      "",
      "    [Fact] public void SameLineAttribute() { }",
      "}",
      "",
    ].join("\n"),
    "Shop.Core.Tests/Pricing/PriceServiceTests.cs": "using Shop.Core.Pricing;\nusing Xunit;\n\nnamespace Shop.Core.Tests.Pricing;\n\npublic class PriceServiceTests\n{\n    [Fact]\n    public void SumsTotals() => Assert.Equal(0, new PriceService().Sum([]));\n}\n",
  });

  await fixture("misc", {
    "app/models/user.rb": "class User < ApplicationRecord\n  def admin?\n    role == 'admin'\n  end\n\n  def promote!\n    update role: 'admin'\n  end\nend\n",
    "app/services/auth.rb": "class Auth\n  def allowed?(user)\n    return false unless user.admin?\n    log_access user\n    true\n  end\nend\n",
    "spec/models/user_spec.rb": "require 'rails_helper'\n\nRSpec.describe User do\n  it 'is admin' do\n    expect(User.new.admin?).to be(false)\n  end\nend\n",
    "src/shape.hpp": "class Shape {\npublic:\n  virtual double area() const = 0;\n};\n\nclass Circle : public Shape, private Tagged<int, std::string> {\npublic:\n  double area() const override { return 3.14; }\n};\n",
    "tests/ShapeTest.php": "<?php\n\nuse PHPUnit\\Framework\\TestCase;\nuse PHPUnit\\Framework\\Attributes\\Test;\n\nfinal class ShapeTest extends TestCase\n{\n    public function testArea(): void\n    {\n        $this->assertTrue(true);\n    }\n\n    #[Test]\n    public function perimeterIsPositive(): void\n    {\n    }\n}\n",
    "routes/server.js": "server.route({ method: 'GET', path: '/health', handler: () => 'ok' });\nserver.route({ path: '/items', method: ['GET', 'POST'], handler });\n",
  });
});

after(async () => {
  for (const dir of Object.values(roots)) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure helpers

test("normalizeSymbolName accepts :: / # / trailing () and Ruby predicates", () => {
  assert.equal(normalizeSymbolName("Foo::Bar::baz"), "Foo.Bar.baz");
  assert.equal(normalizeSymbolName("User#admin?"), "User.admin?");
  assert.equal(normalizeSymbolName("run()"), "run");
  assert.equal(normalizeSymbolName("  save!  "), "save!");
  assert.throws(() => normalizeSymbolName(""), /empty/);
  assert.throws(() => normalizeSymbolName("a b"), /identifier/i);
});

test("wordRegex handles ? and ! suffixes without swallowing longer names", () => {
  const re = wordRegex("admin?");
  assert.ok(re.test("user.admin?"));
  assert.ok(!re.test("user.admin"));
  const plain = wordRegex("admin");
  assert.ok(!plain.test("user.admin?"), "plain name must not match the predicate form");
  assert.ok(plain.test("user.admin "));
});

test("stripGenerics removes nested generic lists and keeps arrows", () => {
  assert.equal(stripGenerics("class A extends B<Map<K, V>> implements C<D>"), "class A extends B implements C");
  assert.equal(stripGenerics("fn f(x: Vec<u8>) -> Result<(), E>"), "fn f(x: Vec) -> Result");
  assert.equal(stripGenerics("if (a < b && c > d)"), "if (a < b && c > d)");
});

test("parentsFromSignature copes with nested generics and C++ access specifiers", () => {
  const java = { signature: "public class Order extends BaseEntity<Long, Map<String, List<String>>> implements Comparable<Order>, Auditable {" };
  assert.deepEqual(parentsFromSignature(java, "clike-oo"), ["BaseEntity", "Comparable", "Auditable"]);
  const cs = { signature: "public class Order : EntityBase<Guid, Dictionary<string, List<int>>>, IComparable<Order>" };
  assert.deepEqual(parentsFromSignature(cs, "clike-oo"), ["EntityBase", "IComparable"]);
  const cpp = { signature: "class Circle : public Shape, private Tagged<int, std::string> {" };
  assert.deepEqual(parentsFromSignature(cpp, "c"), ["Shape", "Tagged"]);
});

test("isTestPath follows per-ecosystem conventions and avoids false positives", () => {
  for (const p of [
    "tests/test_core.py",
    "tests/helpers_test.py",
    "internal/store/store_test.go",
    "src/util/fmt.test.ts",
    "core/src/test/java/com/acme/OrderTest.java",
    "core/src/test/java/com/acme/OrderServiceIT.java",
    "Shop.Core.Tests/Orders/OrderTests.cs",
    "spec/models/user_spec.rb",
    "tests/ShapeTest.php",
    "Tests/ShopTests/OrderTests.swift",
  ]) {
    assert.ok(isTestPath(p), `${p} should be a test path`);
  }
  for (const p of ["latest.go", "src/contest.ts", "src/Attest.java", "app/protest.rb", "Shop.Core/Orders/Order.cs", "src/testing_utils_impl.ts"]) {
    assert.ok(!isTestPath(p), `${p} should not be a test path`);
  }
});

// ---------------------------------------------------------------------------
// Python

test("python: relative and absolute imports resolve through source roots", async () => {
  const r = await resolverFor("py");
  assert.deepEqual(await r.resolve("src/pkg/util/helpers.py", "..core"), ["src/pkg/core.py"]);
  assert.deepEqual(await r.resolve("src/pkg/cli.py", "pkg.core"), ["src/pkg/core.py"]);
  assert.deepEqual(await r.resolve("src/pkg/util/helpers.py", "."), ["src/pkg/util/__init__.py"]);
  assert.equal(await r.resolve("src/pkg/cli.py", "requests"), null, "third-party is external");
  assert.equal(await r.resolve("src/pkg/util/helpers.py", "os.path"), null);
});

test("python: file_brief shows resolved import targets and importers", async () => {
  const text = await toolsets.py.file_brief.execute({ path: "src/pkg/core.py" });
  assert.match(text, /src\/pkg\/util\/helpers\.py/);
  assert.match(text, /src\/pkg\/cli\.py/);
  assert.match(text, /tests\/test_core\.py/);
  const helpers = await toolsets.py.file_brief.execute({ path: "src/pkg/util/helpers.py" });
  assert.match(helpers, /\.\.core → src\/pkg\/core\.py/);
  assert.match(helpers, /- os\.path\n/);
});

test("python: tests_for maps test_<stem>.py and <stem>_test.py both ways", async () => {
  const forCore = await toolsets.py.tests_for.execute({ path: "src/pkg/core.py" });
  assert.match(forCore, /tests\/test_core\.py/);
  const forHelpers = await toolsets.py.tests_for.execute({ path: "src/pkg/util/helpers.py" });
  assert.match(forHelpers, /tests\/helpers_test\.py/);
  const reverse = await toolsets.py.tests_for.execute({ path: "tests/test_core.py" });
  assert.match(reverse, /src\/pkg\/core\.py/);
});

test("python: entrypoint_map finds __main__ guard; test_inventory lists classes and functions", async () => {
  const ep = await toolsets.py.entrypoint_map.execute({});
  assert.match(ep, /src\/pkg\/cli\.py\s+\(Python __main__ guard\)/);
  const inv = await toolsets.py.test_inventory.execute({});
  assert.match(inv, /test: test_compute/);
  assert.match(inv, /class: TestEngine/);
});

// ---------------------------------------------------------------------------
// Go

test("go: module path imports resolve to package directories and importers use go.mod", async () => {
  const r = await resolverFor("go");
  assert.deepEqual(await r.resolve("cmd/server/main.go", "example.com/app/internal/store"), ["internal/store/store.go"]);
  assert.equal(await r.resolve("cmd/server/main.go", "github.com/gorilla/mux"), null);
  const importers = await r.importersOf("internal/store/store.go");
  assert.deepEqual(importers.map((i) => i.file), ["cmd/server/main.go"]);
});

test("go: tests_for pairs store.go with store_test.go; entrypoint_map finds package main", async () => {
  const t = await toolsets.go.tests_for.execute({ path: "internal/store/store.go" });
  assert.match(t, /internal\/store\/store_test\.go/);
  const ep = await toolsets.go.entrypoint_map.execute({});
  assert.match(ep, /cmd\/server\/main\.go\s+\(Go package main\)/);
  const who = await toolsets.go.who_imports.execute({ specifier: "github.com/gorilla/mux" });
  assert.match(who, /go\.mod: require github\.com\/gorilla\/mux v1\.8\.1/);
  assert.match(who, /cmd\/server\/main\.go/);
});

// ---------------------------------------------------------------------------
// Rust

test("rust: crate::, super:: and mod declarations resolve; cfg(test) modules count as in-file tests", async () => {
  const r = await resolverFor("rs");
  assert.deepEqual(await r.resolve("src/main.rs", "crate::config::Settings"), ["src/config.rs"]);
  assert.deepEqual(await r.resolve("src/main.rs", "config"), ["src/config.rs"]);
  assert.deepEqual(await r.resolve("src/net/mod.rs", "client"), ["src/net/client.rs"]);
  assert.deepEqual(await r.resolve("src/net/client.rs", "super::super::config::Settings"), ["src/config.rs"]);
  assert.equal(await r.resolve("src/net/client.rs", "serde::Serialize"), null);

  const imports = await toolsets.rs.file_brief.execute({ path: "src/config.rs" });
  assert.match(imports, /## Imported by \(2\)[\s\S]*src\/main\.rs/);
  assert.match(imports, /src\/net\/client\.rs/);
  const tests = await toolsets.rs.tests_for.execute({ path: "src/config.rs" });
  assert.match(tests, /In-file tests/);
  assert.match(tests, /src\/config\.rs:\d+ mod tests/);
});

test("rust: entrypoint_map finds src/main.rs and Cargo package", async () => {
  const ep = await toolsets.rs.entrypoint_map.execute({});
  assert.match(ep, /package: rsfx/);
  assert.match(ep, /src\/main\.rs\s+\(Rust fn main\)/);
});

// ---------------------------------------------------------------------------
// TypeScript

test("typescript: tsconfig paths, baseUrl and .js→.ts swaps resolve", async () => {
  const r = await resolverFor("ts");
  assert.deepEqual(await r.resolve("src/index.ts", "@app/service"), ["src/service.ts"]);
  assert.deepEqual(await r.resolve("src/index.ts", "@shared"), ["src/shared/index.ts"]);
  assert.deepEqual(await r.resolve("src/index.ts", "./util/fmt.js"), ["src/util/fmt.ts"]);
  assert.equal(await r.resolve("src/index.ts", "typescript"), null);
  const importers = await r.importersOf("src/service.ts");
  assert.deepEqual(importers.map((i) => i.file), ["src/index.ts"]);
});

test("typescript: tests_for finds fmt.test.ts via .js import of the .ts source", async () => {
  const t = await toolsets.ts.tests_for.execute({ path: "src/util/fmt.ts" });
  assert.match(t, /src\/util\/fmt\.test\.ts/);
  const who = await toolsets.ts.who_imports.execute({ specifier: "src/service" });
  assert.match(who, /workspace file/);
  assert.match(who, /src\/index\.ts/);
});

// ---------------------------------------------------------------------------
// Java

test("java: package imports resolve through the namespace index, wildcard imports too", async () => {
  const r = await resolverFor("java");
  assert.deepEqual(await r.resolve("core/src/main/java/com/acme/shop/service/OrderService.java", "com.acme.shop.model.Order"), [
    "core/src/main/java/com/acme/shop/model/Order.java",
  ]);
  const star = await r.resolve("api/src/main/java/com/acme/shop/api/OrderResource.java", "com.acme.shop.model.*");
  assert.ok(star.includes("core/src/main/java/com/acme/shop/model/Order.java"));
  assert.ok(star.includes("core/src/main/java/com/acme/shop/model/BaseEntity.java"));
  assert.equal(await r.resolve("core/src/main/java/com/acme/shop/Application.java", "org.springframework.boot.SpringApplication"), null);
});

test("java: file_brief lists files referencing the type; tests_for maps src/main ↔ src/test with Test/IT suffixes", async () => {
  const imports = await toolsets.java.file_brief.execute({ path: "core/src/main/java/com/acme/shop/model/Order.java" });
  assert.match(imports, /Referenced by \(type names\)/);
  assert.match(imports, /OrderService\.java/);
  assert.match(imports, /OrderResource\.java/);
  assert.match(imports, /OrderTest\.java/);

  const t = await toolsets.java.tests_for.execute({ path: "core/src/main/java/com/acme/shop/model/Order.java" });
  assert.match(t, /core\/src\/test\/java\/com\/acme\/shop\/model\/OrderTest\.java/);
  const it = await toolsets.java.tests_for.execute({ path: "core/src/main/java/com/acme/shop/service/OrderService.java" });
  assert.match(it, /OrderServiceIT\.java/);
  const reverse = await toolsets.java.tests_for.execute({ path: "core/src/test/java/com/acme/shop/model/OrderTest.java" });
  assert.match(reverse, /core\/src\/main\/java\/com\/acme\/shop\/model\/Order\.java/);
});

test("java: symbol_context hierarchy parses nested generics and ranks member callers", async () => {
  const h = await toolsets.java.symbol_context.execute({ name: "Order" });
  assert.match(h, /## Supertypes/);
  assert.match(h, /↑ BaseEntity/);
  assert.match(h, /↑ Auditable/);
  assert.doesNotMatch(h, /↑ (Map|List|Long|String)\b/, "generic arguments must not be treated as parents");

  const ctx = await toolsets.java.symbol_context.execute({ name: "Order.total" });
  assert.match(ctx, /## Definition/);
  assert.match(ctx, /OrderService\.java/);
  assert.match(ctx, /OrderResource\.java/);
});

test("java: repo_overview (manifests + packages) and entrypoint_map understand Maven", async () => {
  const m = await toolsets.java.repo_overview.execute({ include_readme: false });
  assert.match(m, /### pom\.xml/);
  assert.match(m, /artifact: com\.acme:shop:1\.0\.0/);
  assert.match(m, /modules \(2\): api, core/);
  assert.match(m, /spring-boot-starter-web:3\.3\.0/);
  assert.match(m, /junit-jupiter:5\.10\.0 \(test\)/);
  assert.match(m, /mainClass: com\.acme\.shop\.Application/);

  assert.match(m, /## Packages \/ projects/);
  assert.match(m, /pom\.xml: api/);
  assert.match(m, /api\/\s+\[pom\.xml\] ✓/);
  assert.match(m, /core\/\s+\[pom\.xml\] ✓/);

  const ep = await toolsets.java.entrypoint_map.execute({});
  assert.match(ep, /mainClass: com\.acme\.shop\.Application/);
  assert.match(ep, /run: mvn spring-boot:run/);
  assert.match(ep, /Application\.java\s+\(Java main \+ @SpringBootApplication\)/);

  const who = await toolsets.java.who_imports.execute({ specifier: "org.springframework.boot" });
  assert.match(who, /pom\.xml: org\.springframework\.boot:spring-boot-starter-web:3\.3\.0/);
  assert.match(who, /Application\.java/);
});

test("java: test_inventory groups JUnit methods by class; http_surface sees JAX-RS", async () => {
  const inv = await toolsets.java.test_inventory.execute({});
  assert.match(inv, /class: OrderTest/);
  assert.match(inv, /test: totalCountsLines/);
  assert.match(inv, /test: compares/);
  assert.match(inv, /test: sums/);

  const http = await toolsets.java.http_surface.execute({});
  assert.match(http, /PATH\s+\/orders/);
  assert.match(http, /GET\s+\/ /);
  assert.match(http, /POST\s+\/\{id\}/);
});

// ---------------------------------------------------------------------------
// C#

test("csharp: using directives resolve via namespace index (file-scoped and block namespaces)", async () => {
  const r = await resolverFor("cs");
  const orders = await r.resolve("Shop.Core/Pricing/PriceService.cs", "Shop.Core.Orders");
  assert.ok(orders.includes("Shop.Core/Orders/Order.cs"));
  assert.ok(orders.includes("Shop.Core/Orders/EntityBase.cs"));
  assert.deepEqual(await r.resolve("Shop.Api/Program.cs", "Shop.Core.Pricing"), ["Shop.Core/Pricing/PriceService.cs"]);
  assert.equal(await r.resolve("Shop.Core.Tests/Orders/OrderTests.cs", "Xunit"), null);
});

test("csharp: file_brief / tests_for follow Foo.Tests project mirrors and *Tests.cs suffix", async () => {
  const imports = await toolsets.cs.file_brief.execute({ path: "Shop.Core/Orders/Order.cs" });
  assert.match(imports, /PriceService\.cs/);
  assert.match(imports, /OrdersController\.cs/);
  assert.match(imports, /OrderTests\.cs/);

  const t = await toolsets.cs.tests_for.execute({ path: "Shop.Core/Orders/Order.cs" });
  assert.match(t, /Shop\.Core\.Tests\/Orders\/OrderTests\.cs/);
  const t2 = await toolsets.cs.tests_for.execute({ path: "Shop.Core/Pricing/PriceService.cs" });
  assert.match(t2, /Shop\.Core\.Tests\/Pricing\/PriceServiceTests\.cs/);
  const reverse = await toolsets.cs.tests_for.execute({ path: "Shop.Core.Tests/Orders/OrderTests.cs" });
  assert.match(reverse, /Shop\.Core\/Orders\/Order\.cs/);
});

test("csharp: unused_exports descends into namespaces; symbol_context hierarchy strips generics", async () => {
  const u = await toolsets.cs.unused_exports.execute({ path: "Shop.Core" });
  assert.match(u, /class LegacyDiscount/, "public class nested in a block namespace must be audited");
  assert.match(u, /of 4 exported symbol/);
  assert.doesNotMatch(u, /class PriceService/);
  assert.doesNotMatch(u, /class Order\b/);

  const h = await toolsets.cs.symbol_context.execute({ name: "Order", path: "Shop.Core/Orders/Order.cs" });
  assert.match(h, /↑ EntityBase/);
  assert.match(h, /↑ IComparable/);
  assert.doesNotMatch(h, /↑ (Dictionary|Guid|List)\b/);
});

test("csharp: repo_overview (manifests + projects) and entrypoint_map understand .sln / .csproj", async () => {
  const m = await toolsets.cs.repo_overview.execute({ include_readme: false });
  assert.match(m, /### Shop\.sln/);
  assert.match(m, /projects \(3\)/);
  assert.match(m, /### Shop\.Core\/Shop\.Core\.csproj/);
  assert.match(m, /Newtonsoft\.Json@13\.0\.3/);
  assert.match(m, /TargetFramework=net8\.0/);
  assert.match(m, /project references \(1\)/);

  assert.match(m, /Shop\.sln: Shop\.Core/);
  assert.match(m, /Shop\.Api\/\s+\[Shop\.Api\.csproj\] ✓\s+Shop\.Api \(Exe\)/);
  assert.match(m, /Shop\.Core\.Tests \[test\]/);

  const ep = await toolsets.cs.entrypoint_map.execute({});
  assert.match(ep, /dotnet build Shop\.sln/);
  assert.match(ep, /run: dotnet run --project Shop\.Api\/Shop\.Api\.csproj/);
  assert.match(ep, /launch profiles: http \(http:\/\/localhost:5000\)/);
  assert.match(ep, /Shop\.Api\/Program\.cs\s+\(C# top-level statements \(ASP\.NET host\)\)/);

  const who = await toolsets.cs.who_imports.execute({ specifier: "Xunit" });
  assert.match(who, /PackageReference xunit 2\.8\.0/);
  assert.match(who, /OrderTests\.cs/);
});

test("csharp: test_inventory handles stacked and same-line attributes; http_surface sees attributes + minimal API", async () => {
  const inv = await toolsets.cs.test_inventory.execute({});
  assert.match(inv, /class: OrderTests/);
  assert.match(inv, /test: TotalCountsLines/);
  assert.match(inv, /test: ComparesByTotal/);
  assert.match(inv, /test: SameLineAttribute/);
  assert.match(inv, /test: SumsTotals/);

  const http = await toolsets.cs.http_surface.execute({});
  assert.match(http, /ROUTE\s+api\/\[controller\]/);
  assert.match(http, /GET\s+\{id\}/);
  assert.match(http, /GET\s+\/orders/);
});

test("csharp: symbol_context with a qualified name separates member hits from bare-name hits", async () => {
  const ctx = await toolsets.cs.symbol_context.execute({ name: "Order.Total" });
  assert.match(ctx, /## Definition/);
  assert.match(ctx, /## Callers/);
  assert.match(ctx, /PriceService\.cs/);
  const ctx2 = await toolsets.cs.symbol_context.execute({ name: "Shop.Core.Pricing::PriceService" });
  assert.match(ctx2, /class PriceService/);
});

// ---------------------------------------------------------------------------
// Ruby / C++ / PHP / Hapi

test("ruby: predicate method names round-trip through find_references and symbol_context callees", async () => {
  const refs = await toolsets.misc.find_references.execute({ name: "admin?" });
  assert.match(refs, /app\/services\/auth\.rb/);
  assert.match(refs, /spec\/models\/user_spec\.rb/);
  const ctx = await toolsets.misc.symbol_context.execute({ name: "Auth#allowed?" });
  assert.match(ctx, /## Definition/);
  assert.match(ctx, /admin\? → app\/models\/user\.rb/);
  const t = await toolsets.misc.tests_for.execute({ path: "app/models/user.rb" });
  assert.match(t, /spec\/models\/user_spec\.rb/);
});

test("c++: symbol_context hierarchy reads access-specified base classes", async () => {
  const h = await toolsets.misc.symbol_context.execute({ name: "Circle" });
  assert.match(h, /## Supertypes\n↑ Shape/);
});

test("php: PHPUnit test methods and #[Test] attributes are inventoried", async () => {
  const inv = await toolsets.misc.test_inventory.execute({ path: "tests/ShapeTest.php" });
  assert.match(inv, /test: testArea/);
  assert.match(inv, /test: perimeterIsPositive/);
});

test("hapi: server.route({ method, path }) in either key order", async () => {
  const http = await toolsets.misc.http_surface.execute({ path: "routes" });
  assert.match(http, /GET\s+\/health/);
  assert.match(http, /GET,POST\s+\/items/);
});

test("locate: parses .NET, PHP, Ruby and Java frames with function names", async () => {
  const trace = [
    "   at Shop.Core.Pricing.PriceService.Sum(IEnumerable`1 orders) in D:\\src\\Shop.Core\\Pricing\\PriceService.cs:line 10",
    "#0 /var/www/tests/ShapeTest.php(9): ShapeTest->testArea()",
    "/app/app/models/user.rb:3:in `admin?'",
    "\tat com.acme.shop.model.Order.total(Order.java:14)",
  ].join("\n");
  const cs = await toolsets.cs.locate.execute({ trace });
  assert.match(cs, /Shop\.Core\/Pricing\/PriceService\.cs:10/);
  assert.match(cs, /Shop\.Core\.Pricing\.PriceService\.Sum/);
  const misc = await toolsets.misc.locate.execute({ trace });
  assert.match(misc, /tests\/ShapeTest\.php:9/);
  assert.match(misc, /ShapeTest->testArea/);
  assert.match(misc, /app\/models\/user\.rb:3/);
  assert.match(misc, /admin\?/);
  const java = await toolsets.java.locate.execute({ trace });
  assert.match(java, /Order\.java:14/);
  assert.match(java, /com\.acme\.shop\.model\.Order\.total/);
});
