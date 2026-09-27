/**
 * Surface inventories: test names, HTTP routes, and TODO-style markers.
 * All regex-based; each is a "what exists" listing agents otherwise grep for.
 */

import path from "node:path";

import { codeFilesUnder, isTestPath } from "../analysis.mjs";
import { enclosingTag, getOutline, isCodeFile } from "../outline.mjs";
import { MAX_FILES_SCANNED, readTextFile, truncateOutput } from "../workspace.mjs";

const clamp = (v, lo, hi, dflt) => Math.min(Math.max(lo, v ?? dflt), hi);

// ---------------------------------------------------------------------------
// Test inventory

const JS_TEST_RE = /^(\s*)(describe|context|suite|it|test|specify)(?:\.(?:only|skip|todo|each|concurrent|serial))?\s*\(\s*(['"`])((?:\\.|(?!\3).)*)\3/;
const PY_TEST_RE = /^(\s*)(?:async\s+)?def\s+(test_\w+)|^(\s*)class\s+(Test\w+)/;
const GO_TEST_RE = /^func\s+((?:Test|Benchmark|Example|Fuzz)\w*)\s*\(|^\s*t\.Run\(\s*"([^"]+)"/;
const RUST_ATTR_RE = /^\s*#\[(?:tokio::|async_std::)?test/;
const RUST_FN_RE = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/;
const DOTNET_ATTR_RE = /^\s*\[(?:Fact|Theory|Test|TestMethod|TestCase|TestCaseSource|DataTestMethod|SkippableFact|SkippableTheory)\b[^\]]*\]/;
const JAVA_ATTR_RE = /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|org\.junit\.(?:jupiter\.api\.)?Test)\b(?:\([^)]*\))?/;
const PHP_ATTR_RE = /^\s*#\[(?:\\?PHPUnit\\Framework\\Attributes\\)?(?:Test|DataProvider|TestWith)\b[^\]]*\]/;
const METHOD_NAME_RE = /^\s*(?:(?:public|private|protected|internal|static|async|virtual|override|fun|void|Task|[\w<>\[\],.?]+)\s+)*(\w+|`[^`]+`)\s*\(/;
const RUBY_TEST_RE = /^(\s*)(?:(describe|context|it|specify|scenario|feature)\s+(['"])(.+?)\3|def\s+(test_\w+)|test\s+(['"])(.+?)\6)/;
const PHP_TEST_METHOD_RE = /^\s*(?:public\s+)?(?:static\s+)?function\s+(test\w+)\s*\(/;
const CLASS_LINE_RE = /^\s*(?:(?:public|internal|private|abstract|final|sealed|static|open|data|partial)\s+)*(?:class|object)\s+(\w+)/;

/**
 * Extract test names from one file. Returns [{indent, kind, name}].
 */
function extractTests(rel, lines) {
  const ext = path.posix.extname(rel).toLowerCase();
  const out = [];
  const push = (indent, kind, name) => out.push({ indent, kind, name: name.slice(0, 120) });

  if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts"].includes(ext)) {
    for (const line of lines) {
      const m = line.match(JS_TEST_RE);
      if (m) push(m[1].length, m[2], m[4]);
    }
  } else if (ext === ".py") {
    for (const line of lines) {
      const m = line.match(PY_TEST_RE);
      if (!m) continue;
      if (m[2]) push(m[1].length, "test", m[2]);
      else push(m[3].length, "class", m[4]);
    }
  } else if (ext === ".go") {
    for (const line of lines) {
      const m = line.match(GO_TEST_RE);
      if (!m) continue;
      if (m[1]) push(0, "func", m[1]);
      else push(2, "t.Run", m[2]);
    }
  } else if (ext === ".rs") {
    let pending = false;
    for (const line of lines) {
      if (RUST_ATTR_RE.test(line)) {
        pending = true;
        continue;
      }
      if (!pending) continue;
      if (/^\s*#\[/.test(line)) continue; // stacked attributes
      const m = line.match(RUST_FN_RE);
      if (m) push(0, "test", m[1]);
      pending = false;
    }
  } else if ([".cs", ".java", ".kt", ".scala", ".swift", ".groovy"].includes(ext)) {
    // Attribute / annotation driven frameworks (xUnit, NUnit, MSTest, JUnit, Kotest-JUnit). Handles the
    // attribute on its own line, stacked attributes, and `[Fact] public void X()` on one line.
    let pending = false;
    let classDepth = 0;
    for (const raw of lines) {
      let line = raw;
      const cls = line.match(CLASS_LINE_RE);
      if (cls && !/^\s*(?:\[|@)/.test(line)) {
        classDepth = (line.match(/^\s*/)?.[0].length ?? 0) / 2;
        push(classDepth, "class", cls[1]);
        pending = false;
        continue;
      }
      let attr = false;
      while (DOTNET_ATTR_RE.test(line) || JAVA_ATTR_RE.test(line)) {
        attr = true;
        line = line.replace(DOTNET_ATTR_RE, "").replace(JAVA_ATTR_RE, "");
      }
      if (attr) {
        pending = true;
        if (!/\S/.test(line)) continue;
        // same-line member after the attribute(s) — fall through with the remainder
      }
      if (pending) {
        if (/^\s*[\[@]/.test(line)) continue; // other stacked attributes/annotations (DisplayName, InlineData …)
        const m = line.match(METHOD_NAME_RE);
        if (m) push(classDepth + 1, "test", m[1].replace(/^`|`$/g, ""));
        pending = false;
      }
    }
    if (!out.some((t) => t.kind === "test")) {
      if (ext === ".swift") {
        for (const line of lines) {
          const m = line.match(/^\s*func\s+(test\w+)\s*\(/);
          if (m) push(1, "test", m[1]);
        }
      } else if (ext === ".java" || ext === ".groovy") {
        // JUnit 3 / Spock: public void testX() / def "feature name"()
        for (const line of lines) {
          const m = line.match(/^\s*public\s+void\s+(test\w+)\s*\(/) ?? line.match(/^\s*def\s+"([^"]+)"\s*\(\s*\)/);
          if (m) push(1, "test", m[1]);
        }
      }
    }
    // A class with no tests inside it is just noise; drop bare class rows when nothing follows them.
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].kind === "class" && (i === out.length - 1 || out[i + 1].kind === "class")) out.splice(i, 1);
    }
  } else if (ext === ".php") {
    // PHPUnit: `public function testX()` and `#[Test]` attribute methods; Pest: test('…') / it('…')
    let pending = false;
    for (const line of lines) {
      if (PHP_ATTR_RE.test(line)) {
        pending = true;
        continue;
      }
      let m = line.match(PHP_TEST_METHOD_RE);
      if (m) {
        push(1, "test", m[1]);
        pending = false;
        continue;
      }
      if (pending) {
        if (/^\s*#\[/.test(line)) continue;
        m = line.match(/^\s*(?:public\s+)?(?:static\s+)?function\s+(\w+)\s*\(/);
        if (m) push(1, "test", m[1]);
        pending = false;
        continue;
      }
      m = line.match(/^(\s*)(test|it|describe)\s*\(\s*(['"])((?:\\.|(?!\3).)*)\3/);
      if (m) push(m[1].length, m[2], m[4]);
    }
  } else if (ext === ".rb") {
    for (const line of lines) {
      const m = line.match(RUBY_TEST_RE);
      if (!m) continue;
      if (m[2]) push(m[1].length, m[2], m[4]);
      else if (m[5]) push(m[1].length, "test", m[5]);
      else if (m[7]) push(m[1].length, "test", m[7]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP routes

const HTTP_METHODS = "get|post|put|patch|delete|options|head|all|any";
/** Quoted string without backreferences (so group numbering stays predictable); one capture = value. */
const STR = String.raw`['"\x60]([^'"\x60]+)['"\x60]`;

/**
 * Each entry: regex + extractor(match) → {method, route}.
 */
const ROUTE_PATTERNS = [
  // Express / Koa-router / Fastify / Hono / Hapi-style: app.get('/x', …)
  {
    re: new RegExp(String.raw`\b[\w$.]+\.(${HTTP_METHODS})\s*\(\s*${STR}`, "i"),
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["js"],
    requireSlash: true, // keeps map.get('key') / headers.get('x') out
  },
  // Express: app.route('/x')
  { re: new RegExp(String.raw`\b[\w$.]+\.route\s*\(\s*${STR}`), pick: (m) => ({ method: "ROUTE", route: m[1] }), langs: ["js"] },
  // Fastify: fastify.route({ method: 'GET', url: '/x' }); Hapi: server.route({ method: 'GET', path: '/x' })
  {
    re: /method\s*:\s*['"](\w+)['"][^}]*?(?:url|path)\s*:\s*['"]([^'"]+)['"]/,
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["js"],
  },
  // Hapi with path first: { path: '/x', method: 'GET' } — or method as an array
  {
    re: /path\s*:\s*['"](\/[^'"]*)['"]\s*,\s*method\s*:\s*(?:['"](\w+)['"]|\[([^\]]*)\])/,
    pick: (m) => ({ method: (m[2] ?? m[3].replace(/['"\s]/g, "")).toUpperCase(), route: m[1] }),
    langs: ["js"],
  },
  // NestJS decorators: @Get('x') / @Controller('users')
  {
    re: /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:(['"])([^'"]*)\2)?\s*\)/,
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[3] ?? "" }),
    langs: ["js"],
  },
  { re: /@Controller\s*\(\s*(?:(['"])([^'"]*)\1)?\s*\)/, pick: (m) => ({ method: "CONTROLLER", route: m[2] ?? "/" }), langs: ["js"] },
  // Flask / FastAPI / Sanic / Quart: @app.route('/x', methods=[…]) or @router.get('/x')
  {
    re: /@[\w.]+\.route\s*\(\s*(['"])([^'"]+)\1(?:.*?methods\s*=\s*\[([^\]]*)\])?/,
    pick: (m) => ({ method: m[3] ? m[3].replace(/['"\s]/g, "").toUpperCase() : "GET", route: m[2] }),
    langs: ["python"],
  },
  {
    re: new RegExp(String.raw`@[\w.]+\.(${HTTP_METHODS}|websocket|api_route)\s*\(\s*(['"])([^'"]+)\2`, "i"),
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[3] }),
    langs: ["python"],
  },
  // Django urls.py: path('x/', view), re_path(r'^x$', view)
  {
    re: /\b(?:re_)?path\s*\(\s*r?(['"])([^'"]*)\1\s*,/,
    pick: (m) => ({ method: "PATH", route: m[2] }),
    langs: ["python"],
    fileHint: /urls\.py$/,
  },
  // Go net/http (1.22 "GET /x" form too), chi, gin, echo, fiber, gorilla
  {
    re: /\.(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"/,
    pick: (m) => {
      const mm = m[1].match(/^([A-Z]+)\s+(.+)$/);
      return mm ? { method: mm[1], route: mm[2] } : { method: "HANDLE", route: m[1] };
    },
    langs: ["go"],
  },
  {
    re: /\b[\w.]+\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*"([^"]+)"/,
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["go"],
    requireSlash: true,
  },
  // ASP.NET attributes and minimal APIs
  {
    re: /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpHead|HttpOptions)(?:\s*\(\s*"([^"]*)"\s*\))?\]/,
    pick: (m) => ({ method: m[1].replace(/^Http/, "").toUpperCase(), route: m[2] ?? "" }),
    langs: ["clike-oo"],
  },
  { re: /\[Route\s*\(\s*"([^"]*)"\s*\)\]/, pick: (m) => ({ method: "ROUTE", route: m[1] }), langs: ["clike-oo"] },
  {
    re: /\b\w+\.Map(Get|Post|Put|Patch|Delete|Methods|Group)\s*\(\s*"([^"]*)"/,
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["clike-oo"],
  },
  // ASP.NET: [Route] on its own, [ApiController] class-level [Route("api/[controller]")] both caught above.
  // Spring
  {
    re: /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?(?:\{\s*)?"([^"]*)")?/,
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] ?? "" }),
    langs: ["clike-oo", "kotlin"],
  },
  // JAX-RS (Jakarta / Quarkus / Dropwizard / Micronaut-ish): @Path("/x") with @GET/@POST on the method
  {
    re: /@Path\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/,
    pick: (m) => ({ method: "PATH", route: m[1] }),
    langs: ["clike-oo", "kotlin"],
  },
  {
    re: /^\s*@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(?!\w)(?!\s*Mapping)(?:\s*(?:@Path\s*\(\s*"([^"]*)"\s*\))?)/,
    pick: (m) => ({ method: m[1], route: m[2] ?? "" }),
    langs: ["clike-oo", "kotlin"],
    // @GET on one line, @Path("/x") on the next (or the line before): merge them into one row.
    lookaround: /^\s*@Path\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/,
  },
  // Micronaut / Ktor / http4k: @Get("/x"), @Post(uri = "/x"); Ktor get("/x") { }
  {
    re: /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(?:uri\s*=\s*|value\s*=\s*)?"([^"]*)"/,
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["clike-oo", "kotlin"],
  },
  {
    re: /^\s*(get|post|put|patch|delete|head|options)\s*\(\s*"(\/[^"]*)"\s*\)\s*\{/,
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["kotlin"],
  },
  // ASP.NET Carter / FastEndpoints-style: Get("/x") / Post("/x") inside Configure(); Nancy Get["/x"]
  {
    re: /^\s*(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*"(\/[^"]*)"\s*\)\s*;/,
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["clike-oo"],
    fileHint: /\.cs$/,
  },
  // Rust: axum .route("/x", get(h)), actix #[get("/x")], rocket #[get("/x")]
  {
    re: new RegExp(String.raw`\.route\s*\(\s*"([^"]+)"\s*,\s*(${HTTP_METHODS})\s*\(`),
    pick: (m) => ({ method: m[2].toUpperCase(), route: m[1] }),
    langs: ["rust"],
  },
  {
    re: new RegExp(String.raw`#\[(${HTTP_METHODS})\s*\(\s*"([^"]+)"`),
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["rust"],
  },
  // Rails routes.rb / Sinatra
  {
    re: new RegExp(String.raw`^\s*(${HTTP_METHODS}|match|resources?|namespace|scope)\s+['":]([^'",\s]+)`),
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["ruby"],
  },
  // PHP: Laravel Route::get('/x'), Slim $app->get('/x'), Symfony #[Route('/x', methods: ['GET'])]
  {
    re: new RegExp(String.raw`(?:Route::|\$\w+->)(${HTTP_METHODS}|match|any)\s*\(\s*${STR}`, "i"),
    pick: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
    langs: ["php"],
  },
  {
    re: /#\[Route\s*\(\s*(['"])([^'"]+)\1(?:.*?methods\s*:\s*\[([^\]]*)\])?/,
    pick: (m) => ({ method: m[3] ? m[3].replace(/['"\s]/g, "").toUpperCase() : "ANY", route: m[2] }),
    langs: ["php"],
  },
];

const LANG_OF_EXT = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".tsx": "js", ".jsx": "js", ".mts": "js", ".cts": "js",
  ".py": "python", ".go": "go", ".rs": "rust", ".cs": "clike-oo", ".java": "clike-oo", ".kt": "kotlin", ".kts": "kotlin",
  ".rb": "ruby", ".php": "php",
};

/** Next.js / SvelteKit / Remix style file-based routes. */
function fileBasedRoute(rel) {
  let m;
  if ((m = rel.match(/(?:^|\/)(?:src\/)?app\/(.*?)(?:\/)?route\.(?:[cm]?[jt]sx?)$/))) {
    return { framework: "next-app", route: "/" + m[1].replace(/\/$/, "").replace(/\([^)]*\)\/?/g, "") };
  }
  if ((m = rel.match(/(?:^|\/)(?:src\/)?pages\/api\/(.+?)\.(?:[cm]?[jt]sx?)$/))) {
    return { framework: "next-pages", route: "/api/" + m[1].replace(/\/index$/, "") };
  }
  if ((m = rel.match(/(?:^|\/)src\/routes\/(.*?)(?:\/)?\+server\.[jt]s$/))) {
    return { framework: "sveltekit", route: "/" + m[1] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Markers

const DEFAULT_TAGS = ["TODO", "FIXME", "HACK", "XXX", "BUG", "OPTIMIZE", "DEPRECATED"];

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createSurfaceTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "test_inventory",
      description:
        "What the test suite covers: every test file with its describe/it/test names (JS/TS), test_* functions " +
        "(Python), TestX funcs and t.Run names (Go), #[test] fns (Rust), [Fact]/[Theory]/[Test]/[TestMethod] and " +
        "@Test/@ParameterizedTest methods grouped by class (C#/Java/Kotlin, same-line attributes too), PHPUnit " +
        "testX/#[Test] and Pest cases (PHP), and RSpec/minitest names (Ruby). " +
        "Complements tests_for (file mapping) with the actual case names.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory or file to inventory (relative). Defaults to whole workspace." },
          filter: { type: "string", description: "Regex; keep only test names matching it (case-insensitive)." },
          max_files: { type: "integer", description: "Max test files (default 40, max 200)." },
          max_per_file: { type: "integer", description: "Max names per file (default 40, max 200)." },
        },
      },
      async execute({ path: searchPath, filter, max_files, max_per_file } = {}) {
        const maxFiles = clamp(max_files, 1, 200, 40);
        const maxPer = clamp(max_per_file, 1, 200, 40);
        let filterRe = null;
        if (filter) {
          try {
            filterRe = new RegExp(filter, "i");
          } catch (err) {
            throw new Error(`Invalid filter regex: ${err.message}`);
          }
        }
        const { files, truncated, kind } = await codeFilesUnder(root, searchPath);
        const candidates = kind === "file" ? files : files.filter(isTestPath);
        const out = [`# Test inventory${searchPath ? ` under ${searchPath}` : ""}`];
        let totalTests = 0;
        let shownFiles = 0;
        const body = [];
        for (const rel of candidates) {
          if (shownFiles >= maxFiles) break;
          const text = await readTextFile(path.join(root, rel));
          if (text == null) continue;
          let tests = extractTests(rel, text.split(/\r?\n/));
          if (filterRe) tests = tests.filter((t) => filterRe.test(t.name));
          if (!tests.length) {
            if (!filterRe && kind === "file") body.push(`\n${rel}: (no test cases recognised)`);
            continue;
          }
          shownFiles++;
          totalTests += tests.length;
          const minIndent = Math.min(...tests.map((t) => t.indent));
          body.push(`\n${rel} (${tests.length})`);
          for (const t of tests.slice(0, maxPer)) {
            const depth = Math.max(0, Math.round((t.indent - minIndent) / 2));
            body.push(`${"  ".repeat(Math.min(depth, 6))}${t.kind}: ${t.name}`);
          }
          if (tests.length > maxPer) body.push(`  … ${tests.length - maxPer} more`);
        }
        out.push(`${shownFiles} test file(s), ${totalTests} case(s)${candidates.length > shownFiles && shownFiles >= maxFiles ? ` (showing first ${maxFiles} files of ${candidates.length})` : ""}`);
        if (truncated) out.push(`(only first ${MAX_FILES_SCANNED} files scanned)`);
        out.push(...body);
        if (!shownFiles) out.push("\n(no test files with recognised cases found)");
        return truncateOutput(out.join("\n"));
      },
    },

    {
      name: "http_surface",
      description:
        "HTTP route table: method + path + handler location for Express/Fastify/Hapi/Koa/Hono/NestJS, Flask/FastAPI/Django, " +
        "Go net/http/chi/gin/echo, ASP.NET (attributes, minimal APIs, Carter), Spring, JAX-RS/Quarkus, Micronaut, Ktor, " +
        "axum/actix/rocket, Rails/Sinatra, Laravel/Symfony, plus Next.js/SvelteKit file routes. " +
        "Answers 'what endpoints exist' without grepping.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to scan (relative). Defaults to whole workspace." },
          max_results: { type: "integer", description: "Max routes (default 150, max 400)." },
        },
      },
      async execute({ path: searchPath, max_results } = {}) {
        const max = clamp(max_results, 1, 400, 150);
        const { files, truncated } = await codeFilesUnder(root, searchPath);
        const rows = [];
        const byMethod = new Map();
        let total = 0;
        const add = (row) => {
          total++;
          byMethod.set(row.method, (byMethod.get(row.method) ?? 0) + 1);
          if (rows.length < max) rows.push(row);
        };
        for (const rel of files) {
          const fb = fileBasedRoute(rel);
          if (fb) {
            const text = await readTextFile(path.join(root, rel));
            const methods = text ? [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]) : [];
            if (methods.length) methods.forEach((mth) => add({ method: mth, route: fb.route, rel, line: 1, where: fb.framework }));
            else add({ method: "FILE", route: fb.route, rel, line: 1, where: fb.framework });
          }
          const lang = LANG_OF_EXT[path.posix.extname(rel).toLowerCase()];
          if (!lang) continue;
          const patterns = ROUTE_PATTERNS.filter((p) => p.langs.includes(lang) && (!p.fileHint || p.fileHint.test(rel)));
          if (!patterns.length) continue;
          const text = await readTextFile(path.join(root, rel));
          if (text == null) continue;
          if (!/route|Route|Mapping|Http|Map(Get|Post|Put|Delete|Patch|Group|Methods)|\.(get|post|put|patch|delete|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Delete|Patch)\s*\(|@(Get|Post|Put|Patch|Delete|Controller|Path|GET|POST|PUT|PATCH|DELETE)\b|HandleFunc|#\[(get|post|put|patch|delete)|\bpath\s*:|^\s*(get|post|put|patch|delete|Get|Post|Put|Patch|Delete)\s*\(\s*"\//m.test(text)) continue;
          const lines = text.split(/\r?\n/);
          let outline;
          const consumed = new Set();
          for (let i = 0; i < lines.length; i++) {
            if (consumed.has(i)) continue;
            const line = lines[i];
            for (const p of patterns) {
              const m = line.match(p.re);
              if (!m) continue;
              let { method, route } = p.pick(m);
              if (route === undefined) continue;
              if (p.requireSlash && !/^[/*]/.test(route)) continue;
              if (p.lookaround && !route) {
                // Sibling annotation lines (within 3 lines, skipping other annotations) carry the path.
                const tryLine = (j) => {
                  if (j < 0 || j >= lines.length || consumed.has(j)) return false;
                  const mm = lines[j].match(p.lookaround);
                  if (!mm) return false;
                  route = mm[1];
                  consumed.add(j);
                  return true;
                };
                let hit = false;
                for (let j = i + 1; j <= i + 3 && j < lines.length && /^\s*@/.test(lines[j]); j++) {
                  if ((hit = tryLine(j))) break;
                }
                if (!hit) for (let j = i - 1; j >= i - 2 && j >= 0 && /^\s*@/.test(lines[j]); j--) if (tryLine(j)) break;
              }
              if (outline === undefined) outline = isCodeFile(rel) ? await getOutline(path.join(root, rel)) : null;
              add({ method, route: route || "/", rel, line: i + 1, where: enclosingTag(outline, i + 1).trim() });
              break;
            }
          }
        }
        if (!total) return `No HTTP routes recognised in ${files.length} code file(s)${searchPath ? ` under ${searchPath}` : ""}.`;
        const summary = [...byMethod.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}:${n}`).join(", ");
        const out = [`# HTTP surface (${total} route(s); ${summary})`];
        if (total > rows.length) out.push(`(showing first ${rows.length})`);
        if (truncated) out.push(`(only first ${MAX_FILES_SCANNED} files scanned)`);
        out.push("");
        let currentFile = null;
        for (const r of rows.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
          if (r.rel !== currentFile) {
            currentFile = r.rel;
            out.push(`${r.rel}`);
          }
          out.push(`  ${r.method.padEnd(10)} ${r.route}  :${r.line}${r.where ? `  ${r.where}` : ""}`);
        }
        return truncateOutput(out.join("\n"));
      },
    },

    {
      name: "markers",
      description:
        "TODO / FIXME / HACK / XXX / BUG / OPTIMIZE / DEPRECATED markers with the enclosing function/class, " +
        "grouped counts by tag. Pass tags to customise.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory or file to scan (relative). Defaults to whole workspace." },
          tags: { type: "string", description: `Comma-separated tags (default ${DEFAULT_TAGS.join(",")}).` },
          max_results: { type: "integer", description: "Max hits (default 80, max 300)." },
        },
      },
      async execute({ path: searchPath, tags, max_results } = {}) {
        const max = clamp(max_results, 1, 300, 80);
        const tagList = tags ? String(tags).split(",").map((t) => t.trim()).filter((t) => /^[A-Za-z_][\w-]*$/.test(t)) : DEFAULT_TAGS;
        if (!tagList.length) throw new Error("tags must contain at least one word.");
        const re = new RegExp(`(?:^|[^\\w])(${tagList.map((t) => t.replace(/[-]/g, "\\-")).join("|")})\\b[:(!\\s-]`);
        const { allFiles, truncated } = await codeFilesUnder(root, searchPath);
        const counts = new Map();
        const hits = [];
        let total = 0;
        for (const rel of allFiles) {
          if (/\.(lock|min\.js|map|svg|png|jpg|gif|pdf)$/i.test(rel)) continue;
          const text = await readTextFile(path.join(root, rel));
          if (text == null) continue;
          if (!re.test(text)) continue;
          const lines = text.split(/\r?\n/);
          let outline;
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(re);
            if (!m) continue;
            total++;
            counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
            if (hits.length >= max) continue;
            if (outline === undefined) outline = isCodeFile(rel) ? await getOutline(path.join(root, rel)) : null;
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}${enclosingTag(outline, i + 1)}`);
          }
        }
        if (!total) return `No ${tagList.join("/")} markers in ${allFiles.length} file(s).`;
        const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}:${n}`).join(", ");
        const out = [`# Markers (${total}; ${summary})`];
        if (total > hits.length) out.push(`(showing first ${hits.length}; narrow with path or tags)`);
        if (truncated) out.push(`(only first ${MAX_FILES_SCANNED} files scanned)`);
        out.push("", ...hits);
        return truncateOutput(out.join("\n"));
      },
    },
  ];
}
