# /ct-publish

Commit and push any pending work, bump the **patch** version, and publish **@bitfieldcreek/halo-scan** to npm.

Bare `/ct-publish` always does a patch bump. This command implies permission to commit, push, tag, and publish (not for `dry-run`).

## Parse intent

| Input | Action |
| --- | --- |
| *(none)* | Commit pending → push → patch bump → `npm publish` → push tags |
| `minor` / `major` | Same flow with that bump type instead of patch |
| `dry-run` | Show what would happen; do not commit, bump, push, or publish |
| `skip push` | Commit and publish locally; do not `git push` (pass `-SkipPush`) |

## Run

From the **bf-chat-tools** repo root (PowerShell):

1. Inspect pending changes and draft a commit message that reflects the work (not the version bump).
2. Run the script, passing the message when the tree is dirty:

```powershell
.\scripts\commands\ct-publish.ps1 -Message "<descriptive commit message>"
```

Optional:

```powershell
.\scripts\commands\ct-publish.ps1 -Message "<msg>" -Bump minor
.\scripts\commands\ct-publish.ps1 -Message "<msg>" -DryRun
.\scripts\commands\ct-publish.ps1 -Message "<msg>" -SkipPush
.\scripts\commands\ct-publish.ps1   # clean tree only — bump + publish + push tags
```

If the working tree is dirty and `-Message` is omitted, stop and ask for a message (or supply one from the diff). Do not invent a vague message like "update" or "wip".

## What the script does

1. Refuse secrets (`.env`, credentials) and refuse if not on a git repo with `package.json` name `@bitfieldcreek/halo-scan`
2. `npm test` (also re-run by `prepublishOnly`)
3. If dirty: stage safe paths, commit with `-Message`, push branch (unless `-SkipPush` / `-DryRun`)
4. `npm version <bump>` (commits version + creates `v*` tag)
5. `npm publish` (`publishConfig.access` is already `public`)
6. `git push` + `git push --tags` (unless `-SkipPush` / `-DryRun`)

## After success

Report:

- New version from `package.json`
- npm: `npm install -g @bitfieldcreek/halo-scan` / `npx @bitfieldcreek/halo-scan`
- Whether the branch and tag were pushed

On failure, stop and report the failing step; do not force-push or skip hooks.

## Prerequisites

| Need | Notes |
| --- | --- |
| Node.js 20+ | `node` / `npm` on PATH |
| npm login | `npm whoami` must succeed for a real publish (or `NPM_TOKEN` in the environment) |
| Git remote | `origin` reachable for push |
| Clean publish rights | Account can publish under `@bitfieldcreek` |
