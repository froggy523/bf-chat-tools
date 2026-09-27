# /ct-publish - commit pending work, bump version, publish @bitfieldcreek/halo-scan to npm.
#
# Usage (from repo root):
#   .\scripts\commands\ct-publish.ps1 [-Message "<msg>"] [-Bump patch|minor|major] [-DryRun] [-SkipPush]

param(
    [string] $Message = '',
    [ValidateSet('patch', 'minor', 'major')]
    [string] $Bump = 'patch',
    [switch] $DryRun,
    [switch] $SkipPush
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LastExit([string] $Label) {
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "$Label failed (exit $LASTEXITCODE)."
    }
}

function Invoke-Step {
    param(
        [string] $Label,
        [scriptblock] $Action
    )
    Write-Host ""
    Write-Host "==> $Label" -ForegroundColor Cyan
    if ($DryRun) {
        Write-Host "[dry-run] skipped" -ForegroundColor Yellow
        return
    }
    & $Action
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot

$PkgPath = Join-Path $RepoRoot 'package.json'
if (-not (Test-Path $PkgPath)) {
    throw "No package.json at $RepoRoot"
}

$pkg = Get-Content -Raw -Path $PkgPath | ConvertFrom-Json
$expectedName = '@bitfieldcreek/halo-scan'
if ($pkg.name -ne $expectedName) {
    throw "Refusing to publish: package name is '$($pkg.name)', expected '$expectedName'."
}

$beforeVersion = [string] $pkg.version
Write-Host ("halo-scan /ct-publish - {0}@{1} -> bump {2}" -f $expectedName, $beforeVersion, $Bump) -ForegroundColor Cyan
if ($DryRun) {
    Write-Host "Dry-run: no commit, bump, push, or publish." -ForegroundColor Yellow
}

# Block obvious secrets from ever being staged.
$blocked = @(
    '.env',
    '.env.local',
    '.env.release',
    'credentials.json',
    '.npmrc'
)

$status = & git status --porcelain
Assert-LastExit 'git status'
$dirty = -not [string]::IsNullOrWhiteSpace($status)

if ($dirty) {
    Write-Host ""
    Write-Host "Pending changes:" -ForegroundColor Cyan
    Write-Host $status

    foreach ($line in ($status -split "`n")) {
        $line = $line.TrimEnd()
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $path = $line.Substring(3).Trim().Trim('"')
        $leaf = Split-Path -Leaf $path
        if ($blocked -contains $leaf -or $path -match '(^|[\\/])\.env(\.|$)') {
            throw "Refusing to publish with secret/credential file present: $path"
        }
    }

    if ([string]::IsNullOrWhiteSpace($Message)) {
        throw 'Working tree is dirty. Pass -Message "<descriptive commit message>" (or commit first).'
    }

    Invoke-Step -Label "Commit pending changes" -Action {
        & git add -A
        Assert-LastExit 'git add'
        foreach ($name in $blocked) {
            & git reset HEAD -- $name 2>$null
        }
        & git reset HEAD -- .env 2>$null
        & git status --short
        & git commit -m $Message
        Assert-LastExit 'git commit'
    }

    if (-not $SkipPush) {
        Invoke-Step -Label "Push branch" -Action {
            $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
            Assert-LastExit 'git rev-parse'
            & git push -u origin $branch
            Assert-LastExit 'git push'
        }
    }
    else {
        Write-Host "Skipping branch push (-SkipPush)." -ForegroundColor Yellow
    }
}
else {
    Write-Host "Working tree clean - skipping pending commit." -ForegroundColor DarkGray
}

Invoke-Step -Label "Run tests" -Action {
    & npm test
    Assert-LastExit 'npm test'
}

Invoke-Step -Label "Bump $Bump version (npm version)" -Action {
    # Creates a version commit and annotated tag vX.Y.Z
    & npm version $Bump -m "chore: release %s"
    Assert-LastExit 'npm version'
}

$pkgAfter = Get-Content -Raw -Path $PkgPath | ConvertFrom-Json
$afterVersion = [string] $pkgAfter.version
if ($DryRun) {
    # Approximate next version for the summary only.
    $parts = $beforeVersion.Split('.')
    if ($parts.Count -ge 3) {
        $major = [int]$parts[0]; $minor = [int]$parts[1]; $patch = [int]$parts[2]
        switch ($Bump) {
            'major' { $major++; $minor = 0; $patch = 0 }
            'minor' { $minor++; $patch = 0 }
            default { $patch++ }
        }
        $afterVersion = "$major.$minor.$patch (projected)"
    }
}

Invoke-Step -Label "npm publish" -Action {
    & npm whoami
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "Not logged in to npm. Run npm login (or set NPM_TOKEN), then retry."
    }
    & npm publish
    Assert-LastExit 'npm publish'
}

if (-not $SkipPush) {
    Invoke-Step -Label "Push branch and tags" -Action {
        $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
        Assert-LastExit 'git rev-parse'
        & git push origin $branch
        Assert-LastExit 'git push branch'
        & git push origin --tags
        Assert-LastExit 'git push tags'
    }
}
else {
    Write-Host "Skipping post-release push (-SkipPush)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done: $expectedName@$afterVersion" -ForegroundColor Green
Write-Host "Install: npm install -g $expectedName"
