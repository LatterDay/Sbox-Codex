<#
.SYNOPSIS
    Installs the s&box Claude Bridge into your project's Libraries folder.

.DESCRIPTION
    The bridge addon MUST live inside an s&box PROJECT's Libraries folder.
    Putting it in s&box's global addons folder will NOT work — those addons
    are built-in only and will not compile custom C#.

    This installer:
      1. Locates your s&box project (auto-detects or use -ProjectPath)
      2. Creates <Project>/Libraries/claudebridge/{Editor/}
      3. Copies the .sbproj and MyEditorMenu.cs into it
      4. Tells s&box to regenerate its .csproj files on next launch
      5. Optionally cleans up any old broken install under sbox/addons/

.EXAMPLE
    .\install.ps1
    # Auto-detects the project (works if you have exactly one in Documents\s&box projects)

.EXAMPLE
    .\install.ps1 -ProjectPath "D:\sbox-projects\my-game"

.EXAMPLE
    .\install.ps1 -ListProjects
    # Lists all projects it can see, then exits

.EXAMPLE
    .\install.ps1 -RemoveStaleAddons
    # Also deletes any old install under <sbox>/addons/sbox-bridge-addon
#>

param(
    [string]$ProjectPath = "",
    [switch]$ListProjects,
    [switch]$RemoveStaleAddons
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== s&box Claude Bridge Installer ===" -ForegroundColor Cyan
Write-Host ""

# ── Locate the s&box projects directory ────────────────────────────
$projectsRoot = Join-Path $env:USERPROFILE "Documents\s&box projects"

if ($ListProjects) {
    if (-not (Test-Path $projectsRoot)) {
        Write-Host "No projects directory at: $projectsRoot" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "Projects under $projectsRoot :" -ForegroundColor Cyan
    Get-ChildItem $projectsRoot -Directory | ForEach-Object {
        $sbproj = Get-ChildItem $_.FullName -Filter "*.sbproj" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($sbproj) { Write-Host ("  {0}" -f $_.Name) -ForegroundColor White }
    }
    exit 0
}

# ── Auto-detect the project if none was passed ─────────────────────
if (-not $ProjectPath) {
    if (-not (Test-Path $projectsRoot)) {
        Write-Host "Could not find $projectsRoot" -ForegroundColor Red
        Write-Host "Specify your project explicitly:" -ForegroundColor Yellow
        Write-Host '  .\install.ps1 -ProjectPath "C:\path\to\your\sbox\project"' -ForegroundColor White
        exit 1
    }

    $candidates = @()
    Get-ChildItem $projectsRoot -Directory | ForEach-Object {
        $sbproj = Get-ChildItem $_.FullName -Filter "*.sbproj" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($sbproj) { $candidates += $_ }
    }

    if ($candidates.Count -eq 0) {
        Write-Host "No s&box projects found under $projectsRoot" -ForegroundColor Red
        Write-Host "Open s&box and create or load a project first, then re-run." -ForegroundColor Yellow
        exit 1
    }

    if ($candidates.Count -eq 1) {
        $ProjectPath = $candidates[0].FullName
        Write-Host ("Auto-detected project: {0}" -f $candidates[0].Name) -ForegroundColor Green
    }
    else {
        Write-Host "Multiple s&box projects found. Pick one and pass it explicitly:" -ForegroundColor Yellow
        $candidates | ForEach-Object {
            Write-Host ("  -ProjectPath ""{0}""" -f $_.FullName) -ForegroundColor White
        }
        exit 1
    }
}

# ── Validate the project ───────────────────────────────────────────
if (-not (Test-Path $ProjectPath)) {
    Write-Host "Project path not found: $ProjectPath" -ForegroundColor Red
    exit 1
}

$sbprojFile = Get-ChildItem $ProjectPath -Filter "*.sbproj" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $sbprojFile) {
    Write-Host "No .sbproj found in: $ProjectPath" -ForegroundColor Red
    Write-Host "This does not look like an s&box project folder." -ForegroundColor Yellow
    exit 1
}

Write-Host ("Project: {0}" -f $sbprojFile.BaseName) -ForegroundColor Green
Write-Host ("Path:    {0}" -f $ProjectPath) -ForegroundColor Green
Write-Host ""

# ── Locate addon source ───────────────────────────────────────────
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$addonSource = Join-Path $scriptDir "sbox-bridge-addon"

if (-not (Test-Path $addonSource)) {
    Write-Host "Cannot find sbox-bridge-addon folder beside install.ps1." -ForegroundColor Red
    Write-Host "Run this script from the root of the sbox-claude repo." -ForegroundColor Yellow
    exit 1
}

$srcSbproj = Join-Path $addonSource "claudebridge.sbproj"
$srcCs     = Join-Path $addonSource "Editor\MyEditorMenu.cs"

if (-not (Test-Path $srcSbproj)) { Write-Host "Missing: $srcSbproj" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $srcCs))     { Write-Host "Missing: $srcCs"     -ForegroundColor Red; exit 1 }

# ── Install into project's Libraries folder ───────────────────────
$libsDir   = Join-Path $ProjectPath "Libraries"
$destDir   = Join-Path $libsDir "claudebridge"
$editorDir = Join-Path $destDir "Editor"

New-Item -ItemType Directory -Force -Path $libsDir   | Out-Null
New-Item -ItemType Directory -Force -Path $destDir   | Out-Null
New-Item -ItemType Directory -Force -Path $editorDir | Out-Null

Copy-Item $srcSbproj (Join-Path $destDir "claudebridge.sbproj")  -Force
Copy-Item $srcCs     (Join-Path $editorDir "MyEditorMenu.cs")    -Force

# If s&box previously scaffolded a stale .csproj here, delete it so the editor regenerates
# one against the local s&box install path. This is the file that has hardcoded "A:\SteamLibrary"
# paths and is the #1 source of "Compile of local.<project>.editor Failed" errors after a move.
$staleCsproj = Join-Path $editorDir "claudebridge.editor.csproj"
if (Test-Path $staleCsproj) {
    Remove-Item $staleCsproj -Force
    Write-Host "Removed stale claudebridge.editor.csproj (s&box will regenerate it)" -ForegroundColor Yellow
}

Write-Host "Installed:" -ForegroundColor Green
Write-Host ("  {0}" -f (Join-Path $destDir "claudebridge.sbproj")) -ForegroundColor White
Write-Host ("  {0}" -f (Join-Path $editorDir "MyEditorMenu.cs")) -ForegroundColor White
Write-Host ""

# ── Detect and warn about old wrong-location installs ─────────────
$badInstalls = @()
$drives = @("C", "D", "E", "F", "A", "G", "H")
foreach ($d in $drives) {
    $paths = @(
        "${d}:\SteamLibrary\steamapps\common\sbox\addons\sbox-bridge-addon",
        "${d}:\Program Files\Steam\steamapps\common\sbox\addons\sbox-bridge-addon",
        "${d}:\Program Files (x86)\Steam\steamapps\common\sbox\addons\sbox-bridge-addon"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { $badInstalls += $p }
    }
}

if ($badInstalls.Count -gt 0) {
    Write-Host "Found prior install in s&box's global addons folder (these never compile):" -ForegroundColor Yellow
    $badInstalls | ForEach-Object { Write-Host ("  {0}" -f $_) -ForegroundColor White }
    if ($RemoveStaleAddons) {
        $badInstalls | ForEach-Object {
            Remove-Item -Recurse -Force $_
            Write-Host ("Removed: {0}" -f $_) -ForegroundColor Green
        }
    } else {
        Write-Host "Re-run with -RemoveStaleAddons to delete them." -ForegroundColor Yellow
    }
    Write-Host ""
}

# ── Done ──────────────────────────────────────────────────────────
Write-Host "Installation successful." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Open or restart s&box and load this project." -ForegroundColor White
Write-Host "  2. Open the dock: View -> Claude Bridge." -ForegroundColor White
Write-Host "     The dock MUST be visible for the bridge to process requests." -ForegroundColor Yellow
Write-Host "  3. Register the MCP server with Claude Code (one-time):" -ForegroundColor White
Write-Host ('       claude mcp add sbox -- node "{0}\sbox-mcp-server\dist\index.js"' -f $scriptDir) -ForegroundColor Green
Write-Host "     (or, if you prefer npm: claude mcp add sbox -- npx sbox-mcp-server)" -ForegroundColor White
Write-Host "  4. In Claude Code, ask: 'check the bridge status'" -ForegroundColor White
Write-Host ""
Write-Host "If the dock doesn't appear after restart, check:" -ForegroundColor Yellow
Write-Host "  <sbox>\logs\sbox-dev.log" -ForegroundColor White
Write-Host "  for any 'Compile of local.<project>.editor Failed' lines and report" -ForegroundColor White
Write-Host "  them at https://github.com/lousputthole/sbox-claude/issues" -ForegroundColor White
Write-Host ""
