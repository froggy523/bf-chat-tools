/**
 * Read-only git helpers for answering "when / who / what changed" questions.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { resolveWithinRoot, toRel, truncateOutput } from "../workspace.mjs";

function runGit(root, args, { timeoutMs = 10_000 } = {}) {
  const result = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1_000_000,
  });
  if (result.error) {
    throw new Error(`git failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim() || `git exited ${result.status}`;
    throw new Error(err);
  }
  return (result.stdout ?? "").trimEnd();
}

function ensureGitRepo(root) {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new Error("Workspace is not inside a git work tree.");
  }
}

/**
 * @param {{workspaceRoot: string}} ctx
 * @returns {import("../mcp-server.mjs").McpTool[]}
 */
export function createGitTools({ workspaceRoot }) {
  const root = path.resolve(workspaceRoot);

  return [
    {
      name: "git_history",
      description:
        "Read-only git information for the workspace. Modes: " +
        "'log' (recent commits, optionally for a path), " +
        "'blame' (line authors for a file), " +
        "'show' (one commit's patch, optionally limited to a path), " +
        "'diff' (unstaged/staged or between refs). " +
        "Use to answer when something changed or who last touched a file.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            description: "One of: log, blame, show, diff (default log).",
            enum: ["log", "blame", "show", "diff"],
          },
          path: {
            type: "string",
            description: "File or directory relative to workspace (for log/blame/show/diff).",
          },
          ref: {
            type: "string",
            description: "Commit ref for show, or 'A..B' / ref for diff.",
          },
          max_count: {
            type: "integer",
            description: "For log: how many commits (default 15, max 50).",
          },
        },
      },
      async execute({ mode = "log", path: relPath, ref, max_count } = {}) {
        ensureGitRepo(root);
        const m = String(mode || "log").toLowerCase();

        if (m === "log") {
          const n = Math.min(Math.max(1, max_count ?? 15), 50);
          const args = ["log", `-n`, String(n), "--date=short", "--format=%h %ad %an %s"];
          if (relPath) {
            const abs = resolveWithinRoot(root, relPath);
            args.push("--", toRel(root, abs));
          }
          const out = runGit(root, args);
          return out || "(no commits)";
        }

        if (m === "blame") {
          if (!relPath) throw new Error("path is required for blame mode.");
          const abs = resolveWithinRoot(root, relPath);
          const out = runGit(root, ["blame", "-e", "--date=short", "--", toRel(root, abs)], {
            timeoutMs: 20_000,
          });
          return truncateOutput(out || "(empty blame)");
        }

        if (m === "show") {
          if (!ref) throw new Error("ref is required for show mode (e.g. a commit hash).");
          const args = ["show", "--stat", "-p", "--format=fuller", String(ref)];
          if (relPath) {
            const abs = resolveWithinRoot(root, relPath);
            args.push("--", toRel(root, abs));
          }
          const out = runGit(root, args, { timeoutMs: 20_000 });
          return truncateOutput(out || "(empty)");
        }

        if (m === "diff") {
          const args = ["diff", "--stat", "-p"];
          if (ref) args.push(String(ref));
          if (relPath) {
            const abs = resolveWithinRoot(root, relPath);
            args.push("--", toRel(root, abs));
          }
          const out = runGit(root, args, { timeoutMs: 20_000 });
          return truncateOutput(out || "(no diff)");
        }

        throw new Error(`Unknown mode '${mode}'. Use log, blame, show, or diff.`);
      },
    },
  ];
}
